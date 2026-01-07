/// <reference types="@cloudflare/workers-types" />

import { Hono } from 'hono';
import { Env } from '../types/env';
import { AIService } from '../services/ai';
import { AIGatewayService } from '../services/ai-gateway';
import { scrapeRecipe } from '../services/browser-rendering';
import { getNowInTimezone } from '../utils/error-handling';

export const recipesRoutes = new Hono<{ Bindings: Env }>();

// Get saved recipes
recipesRoutes.get('/', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const limit = parseInt(c.req.query('limit') || '20');
  const offset = parseInt(c.req.query('offset') || '0');
  const search = c.req.query('search');

  let query = `
    SELECT * FROM recipes WHERE user_id = ?
  `;
  const bindings: (string | number)[] = [userId];

  if (search) {
    query += ` AND (name LIKE ? OR description LIKE ?)`;
    bindings.push(`%${search}%`, `%${search}%`);
  }

  query += ` ORDER BY times_logged DESC, created_at DESC LIMIT ? OFFSET ?`;
  bindings.push(limit, offset);

  const recipes = await c.env.DB.prepare(query).bind(...bindings).all();

  return c.json(recipes.results?.map(r => ({
    ...r,
    ingredients: JSON.parse(r.ingredients as string),
    instructions: r.instructions ? JSON.parse(r.instructions as string) : null,
    nutrition_per_serving: JSON.parse(r.nutrition_per_serving as string),
    tags: r.tags ? JSON.parse(r.tags as string) : [],
    is_favorite: r.is_favorite === 1
  })));
});

// Get single recipe
recipesRoutes.get('/:id', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const recipeId = c.req.param('id');
  const recipe = await c.env.DB.prepare(
    'SELECT * FROM recipes WHERE id = ? AND user_id = ?'
  ).bind(recipeId, userId).first();

  if (!recipe) {
    return c.json({ error: 'Recipe not found' }, 404);
  }

  return c.json({
    ...recipe,
    ingredients: JSON.parse(recipe.ingredients as string),
    instructions: recipe.instructions ? JSON.parse(recipe.instructions as string) : null,
    nutrition_per_serving: JSON.parse(recipe.nutrition_per_serving as string),
    tags: recipe.tags ? JSON.parse(recipe.tags as string) : [],
    is_favorite: recipe.is_favorite === 1
  });
});

// Import recipe from URL - ASYNC version
// Creates a pending meal immediately and processes in background
recipesRoutes.post('/import', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const timezone = c.req.header('X-Timezone');
  const { url, meal_type, save_to_recipes } = await c.req.json();
  
  if (!url) {
    return c.json({ error: 'URL required' }, 400);
  }

  // Check if Browser Rendering binding is configured
  if (!c.env.BROWSER) {
    return c.json({ error: 'Recipe scraping not available - Browser Rendering not configured' }, 503);
  }

  // Create pending meal immediately - use user's timezone
  const mealId = crypto.randomUUID();
  const now = getNowInTimezone(timezone);
  const hostname = new URL(url).hostname.replace('www.', '');
  const pendingName = `Recipe from ${hostname}`;
  
  // Insert pending meal with placeholder values
  await c.env.DB.prepare(`
    INSERT INTO meals (id, user_id, name, description, meal_type, calories, protein, carbs, fat,
      source, recipe_url, logged_at, pending)
    VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 'recipe_import', ?, ?, 1)
  `).bind(
    mealId,
    userId,
    pendingName,
    'Importing recipe...',
    meal_type || 'lunch',
    url,
    now
  ).run();

  console.log(`[Recipe Import] Created pending meal ${mealId} for ${url}`);

  // Capture browser binding reference before async context
  const browser = c.env.BROWSER;
  const env = c.env;

  // Process in background using waitUntil
  c.executionCtx.waitUntil((async () => {
    try {
      console.log(`[Recipe Import] Background: Starting import from: ${url}`);
      
      // Step 1: Use Browser Rendering to scrape recipe page
      const scrapedData = await scrapeRecipe(browser, url);
      console.log(`[Recipe Import] Background: Scraped: ${scrapedData.name}, ${scrapedData.ingredients.length} ingredients`);
      
      // Step 2: Use AI to estimate nutrition from ingredients
      let ingredients: Array<{
        name: string;
        portion_size?: string;
        calories: number;
        protein: number;
        carbs: number;
        fat: number;
      }> = [];
      let totalCalories = 0;
      let totalProtein = 0;
      let totalCarbs = 0;
      let totalFat = 0;
      
      if (scrapedData.ingredients.length > 0 && env.CF_API_TOKEN) {
        console.log(`[Recipe Import] Background: Analyzing nutrition with AI Gateway...`);
        
        try {
          const aiGateway = new AIGatewayService(env);
          const nutritionResult = await aiGateway.analyzeRecipeNutrition(
            scrapedData.name,
            scrapedData.ingredients,
            1 // Assume single serving
          );
          
          // Use ingredient breakdown if available
          if (nutritionResult.ingredient_breakdown) {
            ingredients = nutritionResult.ingredient_breakdown.map((ing, idx) => ({
              name: ing.name || scrapedData.ingredients[idx] || 'Unknown',
              portion_size: scrapedData.ingredients[idx]?.match(/^[\d\/\s]+\s*(cup|tbsp|tsp|oz|g|lb|piece|slice|medium|large|small)?s?\b/i)?.[0]?.trim(),
              calories: ing.calories || 0,
              protein: ing.protein || 0,
              carbs: ing.carbs || 0,
              fat: ing.fat || 0
            }));
          } else {
            ingredients = scrapedData.ingredients.map(ing => ({
              name: ing,
              calories: 0,
              protein: 0,
              carbs: 0,
              fat: 0
            }));
          }
          
          totalCalories = nutritionResult.calories_per_serving;
          totalProtein = nutritionResult.protein_per_serving;
          totalCarbs = nutritionResult.carbs_per_serving;
          totalFat = nutritionResult.fat_per_serving;
          
          console.log(`[Recipe Import] Background: AI nutrition: ${totalCalories} cal, ${totalProtein}g P`);
        } catch (aiError) {
          console.error('[Recipe Import] Background: AI nutrition analysis failed:', aiError);
          ingredients = scrapedData.ingredients.map(ing => ({
            name: ing,
            calories: 0,
            protein: 0,
            carbs: 0,
            fat: 0
          }));
        }
      } else {
        ingredients = scrapedData.ingredients.map(ing => ({
          name: ing,
          calories: 0,
          protein: 0,
          carbs: 0,
          fat: 0
        }));
      }

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
        scrapedData.name,
        scrapedData.description || null,
        totalCalories,
        totalProtein,
        totalCarbs,
        totalFat,
        JSON.stringify(ingredients),
        mealId
      ).run();

      // Update daily tracker
      const date = now.split('T')[0];
      const trackerId = env.DAILY_TRACKER_V2.idFromName(`${userId}:${date}`);
      const tracker = env.DAILY_TRACKER_V2.get(trackerId);

      const user = await env.DB.prepare('SELECT goals FROM users WHERE id = ?').bind(userId).first();
      const goals = user?.goals ? JSON.parse(user.goals as string) : { daily_calories: 2000, daily_protein: 150 };

      await tracker.fetch(new Request('http://internal/meal', {
        method: 'POST',
        body: JSON.stringify({
          id: mealId,
          name: scrapedData.name,
          meal_type: meal_type || 'lunch',
          calories: totalCalories,
          protein: totalProtein,
          carbs: totalCarbs,
          fat: totalFat,
          goals
        })
      }));

      // Optionally save to recipes table
      if (save_to_recipes) {
        const recipeId = crypto.randomUUID();
        
        await env.DB.prepare(`
          INSERT INTO recipes (id, user_id, name, description, source_url, servings,
            ingredients, instructions, nutrition_per_serving, times_logged, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
        `).bind(
          recipeId,
          userId,
          scrapedData.name,
          scrapedData.description || null,
          url,
          scrapedData.servings || 1,
          JSON.stringify(ingredients),
          JSON.stringify(scrapedData.instructions || []),
          JSON.stringify({
            calories: totalCalories,
            protein: totalProtein,
            carbs: totalCarbs,
            fat: totalFat
          })
        ).run();
        
        console.log(`[Recipe Import] Background: Saved recipe ${recipeId}`);
      }

      // Track analytics
      env.ANALYTICS.writeDataPoint({
        blobs: [userId, 'recipe_imported', hostname],
        doubles: [totalCalories],
        indexes: [userId]
      });

      console.log(`[Recipe Import] Background: Complete - ${scrapedData.name}`);
    } catch (error) {
      console.error('[Recipe Import] Background: Error:', error);
      
      // Update meal to show error state
      const errorMsg = error instanceof Error ? error.message : 'Import failed';
      await env.DB.prepare(`
        UPDATE meals SET
          name = 'Import Failed',
          description = ?,
          pending = 0
        WHERE id = ?
      `).bind(`Error: ${errorMsg}`, mealId).run();
    }
  })());

  // Return immediately with the pending meal info
  return c.json({
    meal_id: mealId,
    name: pendingName,
    pending: true,
    success: true
  });
});

// Log imported recipe as a meal (and optionally save to recipes)
recipesRoutes.post('/import/log', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { recipe, meal_type, save_to_recipes } = await c.req.json();
  
  if (!recipe || !recipe.name) {
    return c.json({ error: 'Recipe data required' }, 400);
  }

  try {
    const mealId = crypto.randomUUID();
    const now = new Date().toISOString();
    
    // Create meal entry
    await c.env.DB.prepare(`
      INSERT INTO meals (id, user_id, name, description, meal_type, calories, protein, carbs, fat,
        source, recipe_url, ingredients, logged_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'recipe_import', ?, ?, ?)
    `).bind(
      mealId,
      userId,
      recipe.name,
      recipe.description || null,
      meal_type || 'lunch',
      recipe.total_calories || 0,
      recipe.total_protein || 0,
      recipe.total_carbs || 0,
      recipe.total_fat || 0,
      recipe.source_url || null,
      JSON.stringify(recipe.ingredients || []),
      now
    ).run();

    // Update daily tracker
    const date = now.split('T')[0];
    const trackerId = c.env.DAILY_TRACKER_V2.idFromName(`${userId}:${date}`);
    const tracker = c.env.DAILY_TRACKER_V2.get(trackerId);

    const user = await c.env.DB.prepare('SELECT goals FROM users WHERE id = ?').bind(userId).first();
    const goals = user?.goals ? JSON.parse(user.goals as string) : { daily_calories: 2000, daily_protein: 150 };

    await tracker.fetch(new Request('http://internal/meal', {
      method: 'POST',
      body: JSON.stringify({
        id: mealId,
        name: recipe.name,
        meal_type: meal_type || 'lunch',
        calories: recipe.total_calories || 0,
        protein: recipe.total_protein || 0,
        carbs: recipe.total_carbs || 0,
        fat: recipe.total_fat || 0,
        goals
      })
    }));

    // Optionally save to recipes table
    let recipeId = null;
    if (save_to_recipes) {
      recipeId = crypto.randomUUID();
      
      await c.env.DB.prepare(`
        INSERT INTO recipes (id, user_id, name, description, source_url, servings,
          ingredients, instructions, nutrition_per_serving, times_logged, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
      `).bind(
        recipeId,
        userId,
        recipe.name,
        recipe.description || null,
        recipe.source_url || null,
        recipe.servings || 1,
        JSON.stringify(recipe.ingredients || []),
        JSON.stringify(recipe.instructions || []),
        JSON.stringify({
          calories: recipe.total_calories || 0,
          protein: recipe.total_protein || 0,
          carbs: recipe.total_carbs || 0,
          fat: recipe.total_fat || 0
        })
      ).run();
    }

    // Track analytics
    c.env.ANALYTICS.writeDataPoint({
      blobs: [userId, 'recipe_logged', meal_type || 'lunch'],
      doubles: [recipe.total_calories || 0],
      indexes: [userId]
    });

    return c.json({
      meal_id: mealId,
      recipe_id: recipeId,
      success: true
    });
  } catch (error) {
    console.error('[Recipe Log] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: 'Failed to log recipe', details: errorMessage }, 500);
  }
});

// Create manual recipe
recipesRoutes.post('/', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const data = await c.req.json();
  const recipeId = crypto.randomUUID();

  await c.env.DB.prepare(`
    INSERT INTO recipes (id, user_id, name, description, servings, prep_time_minutes, 
      cook_time_minutes, ingredients, instructions, nutrition_per_serving, tags, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    recipeId,
    userId,
    data.name,
    data.description || null,
    data.servings || 1,
    data.prep_time_minutes || null,
    data.cook_time_minutes || null,
    JSON.stringify(data.ingredients),
    data.instructions ? JSON.stringify(data.instructions) : null,
    JSON.stringify(data.nutrition_per_serving),
    data.tags ? JSON.stringify(data.tags) : null
  ).run();

  return c.json({ id: recipeId, success: true });
});

// Update recipe
recipesRoutes.put('/:id', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const recipeId = c.req.param('id');
  const data = await c.req.json();

  // Verify ownership
  const existing = await c.env.DB.prepare(
    'SELECT id FROM recipes WHERE id = ? AND user_id = ?'
  ).bind(recipeId, userId).first();

  if (!existing) {
    return c.json({ error: 'Recipe not found' }, 404);
  }

  await c.env.DB.prepare(`
    UPDATE recipes SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      servings = COALESCE(?, servings),
      prep_time_minutes = COALESCE(?, prep_time_minutes),
      cook_time_minutes = COALESCE(?, cook_time_minutes),
      ingredients = COALESCE(?, ingredients),
      instructions = COALESCE(?, instructions),
      nutrition_per_serving = COALESCE(?, nutrition_per_serving),
      tags = COALESCE(?, tags),
      updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    data.name || null,
    data.description || null,
    data.servings || null,
    data.prep_time_minutes || null,
    data.cook_time_minutes || null,
    data.ingredients ? JSON.stringify(data.ingredients) : null,
    data.instructions ? JSON.stringify(data.instructions) : null,
    data.nutrition_per_serving ? JSON.stringify(data.nutrition_per_serving) : null,
    data.tags ? JSON.stringify(data.tags) : null,
    recipeId
  ).run();

  return c.json({ success: true });
});

// Toggle favorite
recipesRoutes.post('/:id/favorite', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const recipeId = c.req.param('id');

  const recipe = await c.env.DB.prepare(
    'SELECT is_favorite FROM recipes WHERE id = ? AND user_id = ?'
  ).bind(recipeId, userId).first();

  if (!recipe) {
    return c.json({ error: 'Recipe not found' }, 404);
  }

  const newFavorite = recipe.is_favorite === 1 ? 0 : 1;

  await c.env.DB.prepare(
    'UPDATE recipes SET is_favorite = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).bind(newFavorite, recipeId).run();

  return c.json({ is_favorite: newFavorite === 1 });
});

// Log recipe as meal
recipesRoutes.post('/:id/log', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const recipeId = c.req.param('id');
  const { meal_type, servings_eaten } = await c.req.json();

  const recipe = await c.env.DB.prepare(
    'SELECT * FROM recipes WHERE id = ? AND user_id = ?'
  ).bind(recipeId, userId).first();

  if (!recipe) {
    return c.json({ error: 'Recipe not found' }, 404);
  }

  const nutrition = JSON.parse(recipe.nutrition_per_serving as string);
  const servingsMultiplier = servings_eaten || 1;

  const mealId = crypto.randomUUID();
  const now = new Date().toISOString();

  await c.env.DB.prepare(`
    INSERT INTO meals (id, user_id, name, meal_type, calories, protein, carbs, fat, 
      source, recipe_url, logged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'recipe_import', ?, ?)
  `).bind(
    mealId,
    userId,
    recipe.name,
    meal_type || 'dinner',
    Math.round(nutrition.calories * servingsMultiplier),
    Math.round(nutrition.protein * servingsMultiplier),
    Math.round(nutrition.carbs * servingsMultiplier),
    Math.round(nutrition.fat * servingsMultiplier),
    recipe.source_url || null,
    now
  ).run();

  // Increment times_logged
  await c.env.DB.prepare(
    'UPDATE recipes SET times_logged = times_logged + 1, updated_at = datetime(\'now\') WHERE id = ?'
  ).bind(recipeId).run();

  // Update daily tracker
  const date = now.split('T')[0];
  const trackerId = c.env.DAILY_TRACKER.idFromName(`${userId}:${date}`);
  const tracker = c.env.DAILY_TRACKER.get(trackerId);

  const user = await c.env.DB.prepare('SELECT goals FROM users WHERE id = ?').bind(userId).first();
  const goals = user?.goals ? JSON.parse(user.goals as string) : { daily_calories: 2000, daily_protein: 150 };

  await tracker.fetch(new Request('http://internal/meal', {
    method: 'POST',
    body: JSON.stringify({
      calories: Math.round(nutrition.calories * servingsMultiplier),
      protein: Math.round(nutrition.protein * servingsMultiplier),
      carbs: Math.round(nutrition.carbs * servingsMultiplier),
      fat: Math.round(nutrition.fat * servingsMultiplier),
      goals
    })
  }));

  return c.json({ 
    meal_id: mealId, 
    calories: Math.round(nutrition.calories * servingsMultiplier),
    success: true 
  });
});

// Delete recipe
recipesRoutes.delete('/:id', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const recipeId = c.req.param('id');

  const recipe = await c.env.DB.prepare(
    'SELECT photo_key FROM recipes WHERE id = ? AND user_id = ?'
  ).bind(recipeId, userId).first();

  if (!recipe) {
    return c.json({ error: 'Recipe not found' }, 404);
  }

  // Delete photo if exists
  if (recipe.photo_key) {
    await c.env.PHOTOS.delete(recipe.photo_key as string);
  }

  await c.env.DB.prepare('DELETE FROM recipes WHERE id = ?').bind(recipeId).run();

  return c.json({ success: true });
});
