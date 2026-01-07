/// <reference types="@cloudflare/workers-types" />

import { Hono } from 'hono';
import { getAgentByName } from 'agents';
import { Env, Meal } from '../types/env';
import { AIService } from '../services/ai';
import { AIGatewayService } from '../services/ai-gateway';
import { safeJsonParse, getNowInTimezone, getTodayInTimezone } from '../utils/error-handling';

export const mealsRoutes = new Hono<{ Bindings: Env }>();

// Helper to get AI service (prefer AI Gateway if configured)
function getAIService(env: Env): { 
  analyzeText: (desc: string) => Promise<any>; 
  analyzePhoto: (data: ArrayBuffer, description?: string) => Promise<any> 
} {
  // Log which AI service we're using
  const hasApiToken = !!env.CF_API_TOKEN;
  console.log(`AI Service: CF_API_TOKEN present: ${hasApiToken}, using ${hasApiToken ? 'AI Gateway (GPT-5)' : 'Workers AI (LLaMA)'}`);
  
  if (env.CF_API_TOKEN) {
    const gateway = new AIGatewayService(env);
    return {
      analyzeText: (desc: string) => gateway.analyzeFoodText(desc),
      analyzePhoto: async (data: ArrayBuffer, description?: string) => {
        // Convert ArrayBuffer to base64 in chunks to avoid stack overflow
        const bytes = new Uint8Array(data);
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const chunk = bytes.subarray(i, i + chunkSize);
          binary += String.fromCharCode.apply(null, Array.from(chunk));
        }
        const base64 = btoa(binary);
        return gateway.analyzeFoodPhoto(base64, 'image/jpeg', description);
      }
    };
  }
  // Fallback to Workers AI (doesn't support description - photo only)
  console.log('AI Service: Falling back to Workers AI');
  const ai = new AIService(env);
  return {
    analyzeText: (desc: string) => ai.analyzeTextFood(desc),
    analyzePhoto: (data: ArrayBuffer) => ai.analyzeFoodPhoto(data)
  };
}

// Get meals for a date range
mealsRoutes.get('/', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const startDate = c.req.query('start') || new Date().toISOString().split('T')[0];
  const endDate = c.req.query('end') || startDate;

  const meals = await c.env.DB.prepare(`
    SELECT * FROM meals 
    WHERE user_id = ? AND date(logged_at) BETWEEN ? AND ?
    ORDER BY logged_at DESC
  `).bind(userId, startDate, endDate).all();

  return c.json(meals.results);
});

// Get meals for today
mealsRoutes.get('/today', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const today = new Date().toISOString().split('T')[0];
  
  const meals = await c.env.DB.prepare(`
    SELECT * FROM meals 
    WHERE user_id = ? AND date(logged_at) = ?
    ORDER BY logged_at ASC
  `).bind(userId, today).all();

  // Calculate totals
  const totals = meals.results?.reduce((acc: { calories: number; protein: number; carbs: number; fat: number }, meal) => ({
    calories: acc.calories + (meal.calories as number),
    protein: acc.protein + (meal.protein as number),
    carbs: acc.carbs + (meal.carbs as number),
    fat: acc.fat + (meal.fat as number)
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

  return c.json({
    meals: meals.results,
    totals
  });
});

// Log a new meal (manual entry)
mealsRoutes.post('/', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const mealData = await c.req.json();
  const mealId = crypto.randomUUID();
  
  await c.env.DB.prepare(`
    INSERT INTO meals (id, user_id, name, description, meal_type, calories, protein, carbs, fat, 
      fiber, sugar, sodium, source, logged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    mealId,
    userId,
    mealData.name,
    mealData.description || null,
    mealData.meal_type,
    mealData.calories,
    mealData.protein,
    mealData.carbs,
    mealData.fat,
    mealData.fiber || null,
    mealData.sugar || null,
    mealData.sodium || null,
    mealData.source || 'manual',
    mealData.logged_at || new Date().toISOString()
  ).run();

  // Update daily tracker V2
  const date = (mealData.logged_at || new Date().toISOString()).split('T')[0];
  const trackerId = c.env.DAILY_TRACKER_V2.idFromName(`${userId}:${date}`);
  const tracker = c.env.DAILY_TRACKER_V2.get(trackerId);
  
  // Get user goals
  const user = await c.env.DB.prepare('SELECT goals FROM users WHERE id = ?').bind(userId).first();
  const goals = safeJsonParse(user?.goals, { daily_calories: 2000, daily_protein: 150 });
  
  await tracker.fetch(new Request('http://internal/meal', {
    method: 'POST',
    body: JSON.stringify({
      id: mealId,
      name: mealData.name,
      meal_type: mealData.meal_type,
      calories: mealData.calories,
      protein: mealData.protein,
      carbs: mealData.carbs,
      fat: mealData.fat,
      goals
    })
  }));

  // Track analytics
  c.env.ANALYTICS.writeDataPoint({
    blobs: [userId, 'meal_logged', mealData.source || 'manual'],
    doubles: [mealData.calories],
    indexes: [userId]
  });

  return c.json({ id: mealId, success: true });
});

// Log meal from photo - ASYNC version
// Uploads photo immediately, creates pending meal, processes AI analysis in background
mealsRoutes.post('/photo', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const timezone = c.req.header('X-Timezone');
  const formData = await c.req.formData();
  const photo = formData.get('photo');
  const mealType = formData.get('meal_type') as string || 'snack';
  const userDescription = formData.get('description') as string || '';
  
  if (!photo || typeof photo === 'string') {
    return c.json({ error: 'No photo provided' }, 400);
  }

  const photoFile = photo as unknown as File;
  
  // Upload photo to R2 first (this is fast)
  const photoKey = `meals/${userId}/${Date.now()}_${photoFile.name}`;
  const photoData = await photoFile.arrayBuffer();
  await c.env.PHOTOS.put(photoKey, photoData, {
    httpMetadata: { contentType: photoFile.type }
  });

  // Create pending meal immediately - use user's timezone
  const mealId = crypto.randomUUID();
  const now = getNowInTimezone(timezone);
  const pendingName = userDescription ? 
    (userDescription.length > 50 ? userDescription.substring(0, 47) + '...' : userDescription) : 
    'Analyzing photo...';
  
  // Insert pending meal with placeholder values
  await c.env.DB.prepare(`
    INSERT INTO meals (id, user_id, name, description, meal_type, calories, protein, carbs, fat, 
      photo_key, source, logged_at, pending)
    VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, ?, 'photo_ai', ?, 1)
  `).bind(
    mealId,
    userId,
    pendingName,
    userDescription || null,
    mealType,
    photoKey,
    now
  ).run();

  console.log(`[Photo upload] Created pending meal ${mealId} with photo ${photoKey}`);

  // Capture env reference for background processing
  const env = c.env;

  // Process AI analysis in background using waitUntil
  c.executionCtx.waitUntil((async () => {
    try {
      // Analyze photo with AI
      const aiService = getAIService(env);
      console.log('[Photo upload] Background: Analyzing photo with AI' + (userDescription ? ' + user description' : ''));
      const analysis = await aiService.analyzePhoto(photoData, userDescription || undefined);
      console.log('[Photo upload] Background: AI analysis successful');

      // Store ingredients breakdown as JSON
      const ingredientsJson = JSON.stringify(analysis.foods || []);
      
      // Use user's original description if provided, otherwise use AI-generated description
      const storedDescription = userDescription || analysis.meal_description || 
        analysis.foods?.map((f: { name: string; portion_size: string }) => `${f.name} (${f.portion_size})`).join(', ');
      
      // Update meal with actual data and remove pending flag
      await env.DB.prepare(`
        UPDATE meals SET
          name = ?,
          description = ?,
          calories = ?,
          protein = ?,
          carbs = ?,
          fat = ?,
          ingredients = ?,
          pending = 0
        WHERE id = ?
      `).bind(
        analysis.meal_name || 'Photo meal',
        storedDescription,
        analysis.total_calories,
        analysis.total_protein,
        analysis.total_carbs,
        analysis.total_fat,
        ingredientsJson,
        mealId
      ).run();

      // Update daily tracker V2
      try {
        const date = now.split('T')[0];
        const trackerId = env.DAILY_TRACKER_V2.idFromName(`${userId}:${date}`);
        const tracker = env.DAILY_TRACKER_V2.get(trackerId);
        
        const user = await env.DB.prepare('SELECT goals FROM users WHERE id = ?').bind(userId).first();
        const goals = safeJsonParse(user?.goals, { daily_calories: 2000, daily_protein: 150 });
        
        await tracker.fetch(new Request('http://internal/meal', {
          method: 'POST',
          body: JSON.stringify({
            id: mealId,
            name: analysis.meal_name || 'Photo meal',
            meal_type: mealType,
            calories: analysis.total_calories,
            protein: analysis.total_protein,
            carbs: analysis.total_carbs,
            fat: analysis.total_fat,
            goals
          })
        }));
      } catch (error) {
        console.error('[Photo upload] Background: Failed to update tracker:', error);
      }

      // Track analytics
      env.ANALYTICS.writeDataPoint({
        blobs: [userId, 'meal_logged', 'photo'],
        doubles: [analysis.total_calories],
        indexes: [userId]
      });

      console.log(`[Photo upload] Background: Complete - ${analysis.meal_name || 'Photo meal'}`);
    } catch (error) {
      console.error('[Photo upload] Background: AI analysis failed:', error);
      
      // Update meal to show error state (keep the photo)
      await env.DB.prepare(`
        UPDATE meals SET
          name = 'Photo analysis failed',
          pending = 0
        WHERE id = ?
      `).bind(mealId).run();
    }
  })());

  // Return immediately with the pending meal info
  return c.json({
    id: mealId,
    name: pendingName,
    photo_url: `/api/photos/${photoKey}`,
    pending: true,
    success: true
  });
});

// Quick add meal from text - ASYNC version
// Creates a pending meal immediately and processes AI analysis in background
mealsRoutes.post('/quick-add', async (c) => {
  const userId = c.req.header('X-User-Id');
  const timezone = c.req.header('X-Timezone');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { description, meal_type } = await c.req.json();
  
  if (!description) {
    return c.json({ error: 'Description required' }, 400);
  }

  // Create pending meal immediately - use user's timezone
  const mealId = crypto.randomUUID();
  const now = getNowInTimezone(timezone);
  const mealTypeValue = meal_type || 'snack';
  
  // Truncate description for display name (first 50 chars)
  const pendingName = description.length > 50 ? description.substring(0, 47) + '...' : description;
  
  // Insert pending meal with placeholder values
  await c.env.DB.prepare(`
    INSERT INTO meals (id, user_id, name, description, meal_type, calories, protein, carbs, fat, 
      source, logged_at, pending)
    VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 'quick_add', ?, 1)
  `).bind(
    mealId,
    userId,
    pendingName,
    description,
    mealTypeValue,
    now
  ).run();

  console.log(`[Quick-add] Created pending meal ${mealId} for: "${description.substring(0, 50)}..."`);

  // Capture env reference for background processing
  const env = c.env;

  // Process AI analysis in background using waitUntil
  c.executionCtx.waitUntil((async () => {
    try {
      // Analyze with AI
      const aiService = getAIService(env);
      console.log(`[Quick-add] Background: Analyzing "${description.substring(0, 50)}..." with AI`);
      const analysis = await aiService.analyzeText(description);
      console.log('[Quick-add] Background: AI analysis successful');

      // Store ingredients breakdown as JSON
      const ingredientsJson = JSON.stringify(analysis.foods || []);
      
      // Update meal with actual data and remove pending flag
      await env.DB.prepare(`
        UPDATE meals SET
          name = ?,
          calories = ?,
          protein = ?,
          carbs = ?,
          fat = ?,
          ingredients = ?,
          pending = 0
        WHERE id = ?
      `).bind(
        analysis.meal_name || description,
        analysis.total_calories,
        analysis.total_protein,
        analysis.total_carbs,
        analysis.total_fat,
        ingredientsJson,
        mealId
      ).run();

      // Update UserAgent (new Agents SDK)
      try {
        const agent = await getAgentByName(env.USER_AGENT, userId);
        await agent.addMeal({
          id: mealId,
          name: analysis.meal_name || description,
          mealType: mealTypeValue as 'breakfast' | 'lunch' | 'dinner' | 'snack',
          calories: analysis.total_calories,
          protein: analysis.total_protein,
          carbs: analysis.total_carbs,
          fat: analysis.total_fat
        });
      } catch (error) {
        console.error('[Quick-add] Background: Failed to update UserAgent:', error);
      }
      
      // Update daily tracker V2
      try {
        const date = now.split('T')[0];
        const trackerId = env.DAILY_TRACKER_V2.idFromName(`${userId}:${date}`);
        const tracker = env.DAILY_TRACKER_V2.get(trackerId);
        
        const user = await env.DB.prepare('SELECT goals FROM users WHERE id = ?').bind(userId).first();
        const goals = safeJsonParse(user?.goals, { daily_calories: 2000, daily_protein: 150 });
        
        await tracker.fetch(new Request('http://internal/meal', {
          method: 'POST',
          body: JSON.stringify({
            id: mealId,
            name: analysis.meal_name || description,
            meal_type: mealTypeValue,
            calories: analysis.total_calories,
            protein: analysis.total_protein,
            carbs: analysis.total_carbs,
            fat: analysis.total_fat,
            goals
          })
        }));
      } catch (error) {
        console.error('[Quick-add] Background: Failed to update tracker:', error);
      }

      console.log(`[Quick-add] Background: Complete - ${analysis.meal_name || description}`);
    } catch (error) {
      console.error('[Quick-add] Background: AI analysis failed:', error);
      
      // Update meal to show error state - wrap in try-catch to ensure pending is cleared
      try {
        await env.DB.prepare(`
          UPDATE meals SET
            name = ?,
            pending = 0
          WHERE id = ?
        `).bind(`Analysis failed: ${description.substring(0, 30)}...`, mealId).run();
      } catch (dbError) {
        console.error('[Quick-add] Background: Failed to update meal with error state:', dbError);
        // Last resort - just clear pending flag
        try {
          await env.DB.prepare(`UPDATE meals SET pending = 0 WHERE id = ?`).bind(mealId).run();
        } catch {
          console.error('[Quick-add] Background: Could not clear pending flag for meal:', mealId);
        }
      }
    }
  })());

  // Return immediately with the pending meal info
  return c.json({
    id: mealId,
    name: pendingName,
    pending: true,
    success: true
  });
});

// Update a meal with photo (for editing meals with new photos)
mealsRoutes.put('/:id/photo', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const mealId = c.req.param('id');
  
  // Get existing meal
  const existingMeal = await c.env.DB.prepare(
    'SELECT * FROM meals WHERE id = ? AND user_id = ?'
  ).bind(mealId, userId).first();

  if (!existingMeal) {
    return c.json({ error: 'Meal not found' }, 404);
  }

  const formData = await c.req.formData();
  const photo = formData.get('photo');
  const mealType = formData.get('meal_type') as string || existingMeal.meal_type as string;
  const userDescription = formData.get('description') as string || '';
  
  if (!photo || typeof photo === 'string') {
    return c.json({ error: 'No photo provided' }, 400);
  }

  const photoFile = photo as unknown as File;
  
  // Delete old photo from R2 if exists
  if (existingMeal.photo_key) {
    await c.env.PHOTOS.delete(existingMeal.photo_key as string);
  }
  
  // Upload new photo to R2
  const photoKey = `meals/${userId}/${Date.now()}_${photoFile.name}`;
  const photoData = await photoFile.arrayBuffer();
  await c.env.PHOTOS.put(photoKey, photoData, {
    httpMetadata: { contentType: photoFile.type }
  });

  // Analyze photo with AI (prefer AI Gateway for better accuracy)
  const aiService = getAIService(c.env);
  let analysis;
  try {
    console.log('Photo update: Analyzing photo with AI service' + (userDescription ? ' + user description' : ''));
    analysis = await aiService.analyzePhoto(photoData, userDescription || undefined);
    console.log('Photo update: AI analysis successful:', JSON.stringify(analysis));
  } catch (error) {
    console.error('Photo update: AI analysis failed:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      error: 'AI photo analysis failed', 
      details: errorMessage,
      hint: 'Check that CF_API_TOKEN is valid and AI Gateway is configured correctly'
    }, 500);
  }

  // Store ingredients breakdown as JSON
  const ingredientsJson = JSON.stringify(analysis.foods || []);
  
  // Use user's original description if provided, otherwise use AI-generated description
  const storedDescription = userDescription || analysis.meal_description || 
    analysis.foods?.map((f: { name: string; portion_size: string }) => `${f.name} (${f.portion_size})`).join(', ');

  // Calculate macro differences for daily tracker update
  const calorieDiff = analysis.total_calories - (existingMeal.calories as number);
  const proteinDiff = analysis.total_protein - (existingMeal.protein as number);
  const carbsDiff = analysis.total_carbs - (existingMeal.carbs as number);
  const fatDiff = analysis.total_fat - (existingMeal.fat as number);

  // Update meal
  await c.env.DB.prepare(`
    UPDATE meals SET 
      name = ?,
      description = ?,
      meal_type = ?,
      calories = ?,
      protein = ?,
      carbs = ?,
      fat = ?,
      photo_key = ?,
      source = 'photo_ai',
      ingredients = ?
    WHERE id = ? AND user_id = ?
  `).bind(
    analysis.meal_name || 'Photo meal',
    storedDescription,
    mealType,
    analysis.total_calories,
    analysis.total_protein,
    analysis.total_carbs,
    analysis.total_fat,
    photoKey,
    ingredientsJson,
    mealId,
    userId
  ).run();

  // Update daily tracker V2 with delta
  const date = (existingMeal.logged_at as string).split('T')[0];
  const trackerId = c.env.DAILY_TRACKER_V2.idFromName(`${userId}:${date}`);
  const tracker = c.env.DAILY_TRACKER_V2.get(trackerId);
  
  // Remove old values
  await tracker.fetch(new Request('http://internal/meal', {
    method: 'DELETE',
    body: JSON.stringify({
      mealId,
      calories: existingMeal.calories,
      protein: existingMeal.protein,
      carbs: existingMeal.carbs,
      fat: existingMeal.fat
    })
  }));
  
  // Add new values
  const user = await c.env.DB.prepare('SELECT goals FROM users WHERE id = ?').bind(userId).first();
  const goals = safeJsonParse(user?.goals, { daily_calories: 2000, daily_protein: 150 });
  
  await tracker.fetch(new Request('http://internal/meal', {
    method: 'POST',
    body: JSON.stringify({
      id: mealId,
      name: analysis.meal_name || 'Photo meal',
      meal_type: mealType,
      calories: analysis.total_calories,
      protein: analysis.total_protein,
      carbs: analysis.total_carbs,
      fat: analysis.total_fat,
      goals
    })
  }));

  return c.json({
    id: mealId,
    analysis,
    photo_url: `/api/photos/${photoKey}`,
    success: true
  });
});

// Update a meal
mealsRoutes.put('/:id', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const mealId = c.req.param('id');
  const updates = await c.req.json();

  // Get existing meal for daily tracker update
  const existingMeal = await c.env.DB.prepare(
    'SELECT * FROM meals WHERE id = ? AND user_id = ?'
  ).bind(mealId, userId).first();

  if (!existingMeal) {
    return c.json({ error: 'Meal not found' }, 404);
  }

  let finalUpdates = { ...updates };
  let analysis = null;

  // If description changed, re-analyze with AI
  let ingredientsJson: string | null = null;
  if (updates.description && updates.description !== existingMeal.description) {
    console.log('Meal update: Description changed, re-analyzing with AI');
    const aiService = getAIService(c.env);
    try {
      analysis = await aiService.analyzeText(updates.description);
      // Use AI-generated values
      finalUpdates = {
        ...updates,
        name: analysis.meal_name || updates.description,
        calories: analysis.total_calories,
        protein: analysis.total_protein,
        carbs: analysis.total_carbs,
        fat: analysis.total_fat
      };
      // Store ingredients breakdown for macro display
      ingredientsJson = JSON.stringify(analysis.foods || []);
    } catch (error) {
      console.error('AI re-analysis failed:', error);
      // Continue with manual updates if AI fails
    }
  }

  // Update meal
  await c.env.DB.prepare(`
    UPDATE meals SET 
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      meal_type = COALESCE(?, meal_type),
      calories = COALESCE(?, calories),
      protein = COALESCE(?, protein),
      carbs = COALESCE(?, carbs),
      fat = COALESCE(?, fat),
      ingredients = COALESCE(?, ingredients)
    WHERE id = ? AND user_id = ?
  `).bind(
    finalUpdates.name || null,
    finalUpdates.description || null,
    finalUpdates.meal_type || null,
    finalUpdates.calories || null,
    finalUpdates.protein || null,
    finalUpdates.carbs || null,
    finalUpdates.fat || null,
    ingredientsJson,
    mealId,
    userId
  ).run();

  // Update daily tracker V2 with delta
  if (finalUpdates.calories || finalUpdates.protein || finalUpdates.carbs || finalUpdates.fat) {
    const date = (existingMeal.logged_at as string).split('T')[0];
    const trackerId = c.env.DAILY_TRACKER_V2.idFromName(`${userId}:${date}`);
    const tracker = c.env.DAILY_TRACKER_V2.get(trackerId);
    
    // Remove old values
    await tracker.fetch(new Request('http://internal/meal', {
      method: 'DELETE',
      body: JSON.stringify({
        mealId,
        calories: existingMeal.calories,
        protein: existingMeal.protein,
        carbs: existingMeal.carbs,
        fat: existingMeal.fat
      })
    }));
    
    // Add new values
    const user = await c.env.DB.prepare('SELECT goals FROM users WHERE id = ?').bind(userId).first();
    const goals = safeJsonParse(user?.goals, { daily_calories: 2000, daily_protein: 150 });
    
    await tracker.fetch(new Request('http://internal/meal', {
      method: 'POST',
      body: JSON.stringify({
        id: mealId,
        name: finalUpdates.name || existingMeal.name,
        meal_type: finalUpdates.meal_type || existingMeal.meal_type,
        calories: finalUpdates.calories || existingMeal.calories,
        protein: finalUpdates.protein || existingMeal.protein,
        carbs: finalUpdates.carbs || existingMeal.carbs,
        fat: finalUpdates.fat || existingMeal.fat,
        goals
      })
    }));
  }

  return c.json({ 
    success: true,
    analysis: analysis,
    updated: {
      name: finalUpdates.name,
      description: finalUpdates.description,
      calories: finalUpdates.calories,
      protein: finalUpdates.protein,
      carbs: finalUpdates.carbs,
      fat: finalUpdates.fat
    }
  });
});

// Delete a meal
mealsRoutes.delete('/:id', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const mealId = c.req.param('id');

  // Get meal for daily tracker update
  const meal = await c.env.DB.prepare(
    'SELECT * FROM meals WHERE id = ? AND user_id = ?'
  ).bind(mealId, userId).first();

  if (!meal) {
    return c.json({ error: 'Meal not found' }, 404);
  }

  // Delete from DB
  await c.env.DB.prepare('DELETE FROM meals WHERE id = ?').bind(mealId).run();

  // Delete photo from R2 if exists
  if (meal.photo_key) {
    await c.env.PHOTOS.delete(meal.photo_key as string);
  }

  // Update daily tracker V2
  const date = (meal.logged_at as string).split('T')[0];
  const trackerId = c.env.DAILY_TRACKER_V2.idFromName(`${userId}:${date}`);
  const tracker = c.env.DAILY_TRACKER_V2.get(trackerId);
  
  await tracker.fetch(new Request('http://internal/meal', {
    method: 'DELETE',
    body: JSON.stringify({
      mealId,
      calories: meal.calories,
      protein: meal.protein,
      carbs: meal.carbs,
      fat: meal.fat
    })
  }));

  return c.json({ success: true });
});

// Get photo from R2
mealsRoutes.get('/photos/*', async (c) => {
  const path = c.req.path.replace('/api/meals/photos/', '');
  const object = await c.env.PHOTOS.get(path);
  
  if (!object) {
    return c.json({ error: 'Photo not found' }, 404);
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg');
  headers.set('Cache-Control', 'public, max-age=31536000');
  
  return new Response(object.body, { headers });
});

// ============ HISTORICAL / TRENDS ENDPOINTS ============

// Get meal trends over time
mealsRoutes.get('/trends', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const days = parseInt(c.req.query('days') || '30');
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startDateStr = startDate.toISOString().split('T')[0];

  // Daily averages
  const dailyTotals = await c.env.DB.prepare(`
    SELECT 
      date(logged_at) as date,
      COUNT(*) as meal_count,
      ROUND(SUM(calories), 0) as total_calories,
      ROUND(SUM(protein), 1) as total_protein,
      ROUND(SUM(carbs), 1) as total_carbs,
      ROUND(SUM(fat), 1) as total_fat
    FROM meals 
    WHERE user_id = ? AND date(logged_at) >= ?
    GROUP BY date(logged_at)
    ORDER BY date ASC
  `).bind(userId, startDateStr).all();

  // Overall averages
  const overallAvg = await c.env.DB.prepare(`
    SELECT 
      ROUND(AVG(daily_calories), 0) as avg_calories,
      ROUND(AVG(daily_protein), 1) as avg_protein,
      ROUND(AVG(daily_carbs), 1) as avg_carbs,
      ROUND(AVG(daily_fat), 1) as avg_fat,
      COUNT(DISTINCT date) as days_tracked
    FROM (
      SELECT 
        date(logged_at) as date,
        SUM(calories) as daily_calories,
        SUM(protein) as daily_protein,
        SUM(carbs) as daily_carbs,
        SUM(fat) as daily_fat
      FROM meals 
      WHERE user_id = ? AND date(logged_at) >= ?
      GROUP BY date(logged_at)
    )
  `).bind(userId, startDateStr).first();

  // Meal type distribution
  const mealTypeDistribution = await c.env.DB.prepare(`
    SELECT 
      meal_type,
      COUNT(*) as count,
      ROUND(AVG(calories), 0) as avg_calories,
      ROUND(AVG(protein), 1) as avg_protein
    FROM meals 
    WHERE user_id = ? AND date(logged_at) >= ?
    GROUP BY meal_type
    ORDER BY 
      CASE meal_type 
        WHEN 'breakfast' THEN 1 
        WHEN 'lunch' THEN 2 
        WHEN 'dinner' THEN 3 
        WHEN 'snack' THEN 4 
      END
  `).bind(userId, startDateStr).all();

  // Most common meals
  const commonMeals = await c.env.DB.prepare(`
    SELECT 
      name,
      COUNT(*) as times_logged,
      ROUND(AVG(calories), 0) as avg_calories,
      ROUND(AVG(protein), 1) as avg_protein
    FROM meals 
    WHERE user_id = ? AND date(logged_at) >= ?
    GROUP BY name
    ORDER BY times_logged DESC
    LIMIT 10
  `).bind(userId, startDateStr).all();

  return c.json({
    period: { days, start_date: startDateStr, end_date: new Date().toISOString().split('T')[0] },
    daily_totals: dailyTotals.results,
    averages: overallAvg,
    meal_type_distribution: mealTypeDistribution.results,
    common_meals: commonMeals.results
  });
});

// Get meal history with pagination
mealsRoutes.get('/history', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const from = c.req.query('from');
  const to = c.req.query('to') || new Date().toISOString().split('T')[0];
  const mealType = c.req.query('type');
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');

  let query = `
    SELECT * FROM meals 
    WHERE user_id = ?
  `;
  const bindings: (string | number)[] = [userId];

  if (from) {
    query += ` AND date(logged_at) >= ?`;
    bindings.push(from);
  }
  
  query += ` AND date(logged_at) <= ?`;
  bindings.push(to);

  if (mealType) {
    query += ` AND meal_type = ?`;
    bindings.push(mealType);
  }

  query += ` ORDER BY logged_at DESC LIMIT ? OFFSET ?`;
  bindings.push(limit, offset);

  const meals = await c.env.DB.prepare(query).bind(...bindings).all();

  // Get total count for pagination
  let countQuery = `SELECT COUNT(*) as total FROM meals WHERE user_id = ?`;
  const countBindings: (string | number)[] = [userId];
  
  if (from) {
    countQuery += ` AND date(logged_at) >= ?`;
    countBindings.push(from);
  }
  countQuery += ` AND date(logged_at) <= ?`;
  countBindings.push(to);
  if (mealType) {
    countQuery += ` AND meal_type = ?`;
    countBindings.push(mealType);
  }

  const countResult = await c.env.DB.prepare(countQuery).bind(...countBindings).first() as { total: number };

  return c.json({
    meals: meals.results,
    pagination: {
      total: countResult.total,
      limit,
      offset,
      has_more: offset + limit < countResult.total
    }
  });
});

// Clear stuck pending meals (older than 5 minutes)
// This is a recovery mechanism for meals that got stuck in pending state
mealsRoutes.post('/clear-stuck', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Find meals that have been pending for more than 5 minutes
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  
  const stuckMeals = await c.env.DB.prepare(`
    SELECT id, name, description FROM meals 
    WHERE user_id = ? AND pending = 1 AND created_at < ?
  `).bind(userId, fiveMinutesAgo).all();

  if (!stuckMeals.results || stuckMeals.results.length === 0) {
    return c.json({ cleared: 0, message: 'No stuck pending meals found' });
  }

  // Clear pending flag and set a meaningful name
  for (const meal of stuckMeals.results) {
    const desc = (meal.description as string) || 'Unknown';
    await c.env.DB.prepare(`
      UPDATE meals SET 
        name = ?,
        pending = 0,
        calories = 0,
        protein = 0,
        carbs = 0,
        fat = 0
      WHERE id = ?
    `).bind(`Failed: ${desc.substring(0, 40)}...`, meal.id).run();
  }

  return c.json({ 
    cleared: stuckMeals.results.length, 
    message: `Cleared ${stuckMeals.results.length} stuck meal(s)` 
  });
});

// Retry analysis for a specific meal
mealsRoutes.post('/:id/retry', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const mealId = c.req.param('id');
  const env = c.env;
  
  // Get the meal
  const meal = await env.DB.prepare(`
    SELECT * FROM meals WHERE id = ? AND user_id = ?
  `).bind(mealId, userId).first();

  if (!meal) {
    return c.json({ error: 'Meal not found' }, 404);
  }

  const description = meal.description as string;
  if (!description) {
    return c.json({ error: 'No description to analyze' }, 400);
  }

  // Set pending flag
  await env.DB.prepare(`UPDATE meals SET pending = 1 WHERE id = ?`).bind(mealId).run();

  // Run analysis in background
  c.executionCtx.waitUntil((async () => {
    try {
      const aiService = getAIService(env);
      console.log(`[Retry] Analyzing meal ${mealId}: "${description.substring(0, 50)}..."`);
      const analysis = await aiService.analyzeText(description);
      
      const ingredientsJson = JSON.stringify(analysis.foods || []);
      
      await env.DB.prepare(`
        UPDATE meals SET
          name = ?,
          calories = ?,
          protein = ?,
          carbs = ?,
          fat = ?,
          ingredients = ?,
          pending = 0
        WHERE id = ?
      `).bind(
        analysis.meal_name || description,
        analysis.total_calories,
        analysis.total_protein,
        analysis.total_carbs,
        analysis.total_fat,
        ingredientsJson,
        mealId
      ).run();
      
      console.log(`[Retry] Complete - ${analysis.meal_name || description}`);
    } catch (error) {
      console.error(`[Retry] Failed for meal ${mealId}:`, error);
      try {
        await env.DB.prepare(`
          UPDATE meals SET name = ?, pending = 0 WHERE id = ?
        `).bind(`Retry failed: ${description.substring(0, 30)}...`, mealId).run();
      } catch {
        await env.DB.prepare(`UPDATE meals SET pending = 0 WHERE id = ?`).bind(mealId).run();
      }
    }
  })());

  return c.json({ success: true, message: 'Retry started' });
});
