/// <reference types="@cloudflare/workers-types" />

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { routeAgentRequest, getAgentByName } from 'agents';
import { Env, WhoopSyncMessage, PhotoAnalysisMessage } from './types/env';
import { DailyTracker } from './durable-objects/DailyTracker';
import { StreakManager } from './durable-objects/StreakManager';
import { DailyTrackerV2 } from './durable-objects/DailyTrackerV2';
import { StreakManagerV2 } from './durable-objects/StreakManagerV2';
import { UserAgent } from './agents/UserAgent';
import { ChatAgent } from './agents/ChatAgent';
import { AIService } from './services/ai';
import { WhoopService } from './services/whoop';
import { newWorkersRpcResponse } from 'capnweb';
import { ChatRpcServer } from './rpc/ChatRpc';
import { authRoutes } from './routes/auth';
import { mealsRoutes } from './routes/meals';
import { habitsRoutes } from './routes/habits';
import { whoopRoutes } from './routes/whoop';
import { progressRoutes } from './routes/progress';
import { dashboardRoutes } from './routes/dashboard';
import { recipesRoutes } from './routes/recipes';
import { workoutsRoutes } from './routes/workouts';
import { analyticsRoutes } from './routes/analytics';
import { goalsRoutes } from './routes/goals';

// Export Durable Objects (legacy V1/V2 + new UserAgent + ChatAgent)
export { DailyTracker, StreakManager, DailyTrackerV2, StreakManagerV2, UserAgent, ChatAgent };

// Create Hono app with env type
const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', logger());
app.use('/api/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Health check
app.get('/api/health', (c) => {
  return c.json({ 
    status: 'ok', 
    app: 'Dina Fitness',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Debug endpoint to test AI Gateway directly
app.get('/api/debug/ai-gateway', async (c) => {
  const ACCOUNT_ID = 'ede31cad5fa379850e090febbeaba602';
  const GATEWAY_ID = 'ai-playground';
  const url = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/${GATEWAY_ID}/compat/chat/completions`;
  const cfToken = c.env.CF_API_TOKEN;
  
  const debugInfo: Record<string, unknown> = {
    url,
    hasCfToken: !!cfToken,
    cfTokenPrefix: cfToken ? cfToken.substring(0, 10) + '...' : 'MISSING',
  };
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'cf-aig-authorization': `Bearer ${cfToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/gpt-5-mini',
        messages: [{ role: 'user', content: 'What is 2+2? Reply with just the number.' }],
        max_completion_tokens: 100,
      }),
    });
    
    debugInfo.status = response.status;
    debugInfo.statusText = response.statusText;
    
    const text = await response.text();
    debugInfo.responseLength = text.length;
    
    try {
      debugInfo.response = JSON.parse(text);
    } catch {
      debugInfo.responseText = text.substring(0, 500);
    }
  } catch (err) {
    debugInfo.error = err instanceof Error ? err.message : String(err);
  }
  
  return c.json(debugInfo);
});

// Whoop OAuth callback at root level (simpler URL for OAuth)
app.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');
  
  console.log('OAuth callback received', { code: code?.substring(0, 10) + '...', state, error });

  if (error) {
    console.error('OAuth error from Whoop:', error);
    return c.redirect('/?whoop_error=' + encodeURIComponent(error));
  }

  if (!code || !state) {
    console.error('Missing code or state');
    return c.redirect('/?whoop_error=missing_params');
  }

  // Validate state
  const userId = await c.env.CACHE.get(`whoop_state:${state}`);
  if (!userId) {
    console.error('Invalid state - not found in cache');
    return c.redirect('/?whoop_error=invalid_state');
  }

  // Delete used state
  await c.env.CACHE.delete(`whoop_state:${state}`);

  const redirectUri = `${new URL(c.req.url).origin}/callback`;
  console.log('Using redirect URI:', redirectUri);
  
  const whoopService = new WhoopService(c.env);

  try {
    const tokens = await whoopService.exchangeCode(code, redirectUri);
    console.log('Got tokens - keys:', Object.keys(tokens));
    console.log('Got tokens - has refresh_token:', !!tokens.refresh_token, 'length:', tokens.refresh_token?.length || 0);
    
    // Extract tokens - handle possible field name variations
    const accessToken = tokens.access_token;
    const refreshToken = tokens.refresh_token || '';
    
    console.log('Extracted refreshToken length:', refreshToken.length);
    
    if (!accessToken) {
      console.error('No access token in response:', tokens);
      throw new Error('No access token received');
    }
    
    console.log('Storing tokens in DB for user:', userId);

    // Calculate token expiration time (expires_in is in seconds, typically 3600 = 1 hour)
    const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();
    console.log('Token expires at:', expiresAt);

    // Store tokens in database - use INSERT OR REPLACE to handle new users
    const result = await c.env.DB.prepare(`
      INSERT INTO users (id, email, password_hash, name, whoop_access_token, whoop_refresh_token, whoop_token_expires_at, whoop_connected, created_at, updated_at)
      VALUES (?, ?, '', 'Dina', ?, ?, ?, 1, datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        whoop_access_token = excluded.whoop_access_token,
        whoop_refresh_token = excluded.whoop_refresh_token,
        whoop_token_expires_at = excluded.whoop_token_expires_at,
        whoop_connected = 1,
        updated_at = datetime('now')
    `).bind(userId, userId + '@demo.com', accessToken, refreshToken, expiresAt).run();
    
    console.log('DB update result:', result);

    // Queue initial sync
    await whoopService.queueSync(userId, accessToken, 'full');

    // Track analytics
    c.env.ANALYTICS.writeDataPoint({
      blobs: [userId, 'whoop_connected', 'oauth'],
      doubles: [1],
      indexes: [userId]
    });

    console.log('OAuth flow completed successfully');
    return c.redirect('/?whoop_connected=true');
  } catch (err) {
    console.error('Whoop OAuth error:', err);
    const errorMessage = err instanceof Error ? err.message : 'unknown_error';
    return c.redirect('/?whoop_error=' + encodeURIComponent(errorMessage));
  }
});

// Mount route modules
app.route('/api/auth', authRoutes);
app.route('/api/meals', mealsRoutes);
app.route('/api/habits', habitsRoutes);
app.route('/api/whoop', whoopRoutes);
app.route('/api/progress', progressRoutes);
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/recipes', recipesRoutes);
app.route('/api/workouts', workoutsRoutes);
app.route('/api/analytics', analyticsRoutes);
app.route('/api/goals', goalsRoutes);

// ============ UserAgent API Endpoints ============
// These endpoints use the new Cloudflare Agents SDK
// getAgentByName returns a stub that you can call RPC methods on

// Get current state (today's summary)
app.get('/api/agent/state', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const agent = await getAgentByName(c.env.USER_AGENT, userId);
  const state = await agent.getState();
  return c.json(state);
});

// Get day summary for a specific date
app.get('/api/agent/day/:date', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const date = c.req.param('date');
  const agent = await getAgentByName(c.env.USER_AGENT, userId);
  const summary = await agent.getDaySummary(date);
  return c.json(summary);
});

// Get meals for a date (defaults to today)
app.get('/api/agent/meals', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const date = c.req.query('date');
  const agent = await getAgentByName(c.env.USER_AGENT, userId);
  const meals = await agent.getMeals(date);
  return c.json(meals);
});

// Get meals grouped by type
app.get('/api/agent/meals/by-type', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const date = c.req.query('date');
  const agent = await getAgentByName(c.env.USER_AGENT, userId);
  const meals = await agent.getMealsByType(date);
  return c.json(meals);
});

// Add a meal
app.post('/api/agent/meals', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const meal = await c.req.json();
  const agent = await getAgentByName(c.env.USER_AGENT, userId);
  const result = await agent.addMeal(meal);
  return c.json(result);
});

// Remove a meal
app.delete('/api/agent/meals/:id', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const mealId = c.req.param('id');
  const agent = await getAgentByName(c.env.USER_AGENT, userId);
  const result = await agent.removeMeal(mealId);
  return c.json(result);
});

// Log a workout
app.post('/api/agent/workouts', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const workout = await c.req.json();
  const agent = await getAgentByName(c.env.USER_AGENT, userId);
  const result = await agent.logWorkout(workout);
  return c.json(result);
});

// Update habits
app.post('/api/agent/habits', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const habits = await c.req.json();
  const agent = await getAgentByName(c.env.USER_AGENT, userId);
  const state = await agent.updateHabits(habits);
  return c.json(state);
});

// Update recovery (from Whoop)
app.post('/api/agent/recovery', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const recovery = await c.req.json();
  const agent = await getAgentByName(c.env.USER_AGENT, userId);
  const state = await agent.updateRecovery(recovery);
  return c.json(state);
});

// Get streaks
app.get('/api/agent/streaks', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const agent = await getAgentByName(c.env.USER_AGENT, userId);
  const streaks = await agent.getStreaks();
  return c.json(streaks);
});

// Get streak stats
app.get('/api/agent/streaks/stats', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const agent = await getAgentByName(c.env.USER_AGENT, userId);
  const stats = await agent.getStreakStats();
  return c.json(stats);
});

// Check day streaks (end of day)
app.post('/api/agent/streaks/check', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const agent = await getAgentByName(c.env.USER_AGENT, userId);
  const result = await agent.checkDayStreaks();
  return c.json(result);
});

// WebSocket agent route (for real-time state sync)
// Routes to /agents/user-agent/:userId and /agents/chat-agent/:name
app.all('/agents/*', async (c) => {
  // Enable CORS for WebSocket upgrade requests
  const response = await routeAgentRequest(c.req.raw, c.env, { cors: true });
  return response || c.json({ error: 'No agent found' }, 404);
});

// ============ Legacy Endpoints (for backwards compatibility) ============
// These use the old DailyTrackerV2/StreakManagerV2 DOs
// TODO: Remove after migration to UserAgent is complete

// Daily summary endpoint using Durable Object V2 (SQLite-backed)
app.get('/api/daily/:date', async (c) => {
  const userId = c.req.header('X-User-Id'); // In real app, get from JWT
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const date = c.req.param('date');
  const id = c.env.DAILY_TRACKER_V2.idFromName(`${userId}:${date}`);
  const stub = c.env.DAILY_TRACKER_V2.get(id);
  
  const response = await stub.fetch(new Request('http://internal/summary'));
  const summary = await response.json();
  
  return c.json(summary);
});

// Streaks endpoint using Durable Object V2 (SQLite-backed)
app.get('/api/streaks', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const id = c.env.STREAK_MANAGER_V2.idFromName(userId);
  const stub = c.env.STREAK_MANAGER_V2.get(id);
  
  const response = await stub.fetch(new Request('http://internal/streaks'));
  const streaks = await response.json();
  
  return c.json(streaks);
});

// Streak stats endpoint (historical analysis)
app.get('/api/streaks/stats', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const id = c.env.STREAK_MANAGER_V2.idFromName(userId);
  const stub = c.env.STREAK_MANAGER_V2.get(id);
  
  const response = await stub.fetch(new Request('http://internal/stats'));
  const stats = await response.json();
  
  return c.json(stats);
});

// Streak history endpoint
app.get('/api/streaks/history', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const id = c.env.STREAK_MANAGER_V2.idFromName(userId);
  const stub = c.env.STREAK_MANAGER_V2.get(id);
  
  const type = c.req.query('type');
  const days = c.req.query('days') || '90';
  const url = new URL('http://internal/history');
  if (type) url.searchParams.set('type', type);
  url.searchParams.set('days', days);
  
  const response = await stub.fetch(new Request(url.toString()));
  const history = await response.json();
  
  return c.json(history);
});

// Quick food analysis endpoint
app.post('/api/analyze/food-text', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { description } = await c.req.json();
  const aiService = new AIService(c.env);
  
  try {
    const analysis = await aiService.analyzeTextFood(description);
    
    // Track analytics
    c.env.ANALYTICS.writeDataPoint({
      blobs: [userId, 'food_analysis', 'text'],
      doubles: [analysis.total_calories],
      indexes: [userId]
    });
    
    return c.json(analysis);
  } catch (error) {
    return c.json({ error: 'Failed to analyze food' }, 500);
  }
});

// Food photo analysis endpoint
app.post('/api/analyze/food-photo', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const formData = await c.req.formData();
  const photo = formData.get('photo');
  
  if (!photo || typeof photo === 'string') {
    return c.json({ error: 'No photo provided' }, 400);
  }

  const photoFile = photo as unknown as File;
  const aiService = new AIService(c.env);
  const imageData = await photoFile.arrayBuffer();
  
  try {
    const analysis = await aiService.analyzeFoodPhoto(imageData);
    
    // Track analytics
    c.env.ANALYTICS.writeDataPoint({
      blobs: [userId, 'food_analysis', 'photo'],
      doubles: [analysis.total_calories],
      indexes: [userId]
    });
    
    return c.json(analysis);
  } catch (error) {
    return c.json({ error: 'Failed to analyze photo' }, 500);
  }
});

// Meal suggestions endpoint
app.get('/api/suggestions/meals', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const mealType = c.req.query('type') as 'breakfast' | 'lunch' | 'dinner' | 'snack' || 'dinner';
  const remainingCalories = parseInt(c.req.query('calories') || '500');
  const remainingProtein = parseInt(c.req.query('protein') || '30');
  const remainingCarbs = parseInt(c.req.query('carbs') || '50');
  const remainingFat = parseInt(c.req.query('fat') || '20');

  const aiService = new AIService(c.env);
  
  try {
    const suggestions = await aiService.getMealSuggestions(
      remainingCalories,
      remainingProtein,
      remainingCarbs,
      remainingFat,
      mealType
    );
    
    return c.json(suggestions);
  } catch (error) {
    return c.json({ error: 'Failed to get suggestions' }, 500);
  }
});

// Semantic food search
app.get('/api/foods/search', async (c) => {
  const query = c.req.query('q');
  if (!query) {
    return c.json({ error: 'Query required' }, 400);
  }

  const aiService = new AIService(c.env);
  
  try {
    const results = await aiService.searchSimilarFoods(query, 10);
    
    // Fetch food details from D1 using parameterized query to prevent SQL injection
    if (results.length > 0) {
      const ids = results.map(r => r.id);
      // Create parameterized placeholders for each ID
      const placeholders = ids.map(() => '?').join(',');
      const foods = await c.env.DB.prepare(`
        SELECT * FROM food_database WHERE id IN (${placeholders})
      `).bind(...ids).all();
      
      return c.json(foods.results);
    }
    
    return c.json([]);
  } catch (error) {
    return c.json({ error: 'Search failed' }, 500);
  }
});

// ============ Cap'n Web RPC Endpoint ============
// This demonstrates the dramatic code reduction vs manual WebSocket handling
// Supports both HTTP batch and WebSocket modes
app.all('/api/chat/rpc', async (c) => {
  const url = new URL(c.req.url);
  const userId = url.searchParams.get('userId') || c.req.header('X-User-Id') || 'demo';
  const timezone = url.searchParams.get('tz') || 'America/Los_Angeles';
  
  // Create the RPC server
  const chatServer = new ChatRpcServer(c.env, userId, timezone);
  
  // Cap'n Web handles both HTTP batch and WebSocket automatically!
  return newWorkersRpcResponse(c.req.raw, chatServer);
});

// Serve static assets for the SPA
app.get('*', async (c) => {
  // Try to serve from assets
  try {
    return await c.env.ASSETS.fetch(c.req.raw);
  } catch {
    // Fall back to index.html for SPA routing
    return c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url)));
  }
});

// Export the Hono app
export default {
  fetch: app.fetch,
  
  // Queue consumer handler
  async queue(batch: MessageBatch<WhoopSyncMessage | PhotoAnalysisMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const body = message.body;
        
        if ('whoop_access_token' in body) {
          // Whoop sync message - use comprehensive sync
          const whoopService = new WhoopService(env);
          const daysBack = body.sync_type === 'full' ? 90 : 7;
          
          // Use comprehensive sync to get all data into whoop_daily
          const syncResult = await whoopService.syncComprehensive(
            body.user_id, 
            body.whoop_access_token, 
            daysBack
          );
          
          console.log(`Comprehensive sync completed: ${syncResult.synced} days synced`);
          
          // Update daily tracker V2 with today's data from whoop_daily
          const today = new Date().toISOString().split('T')[0];
          const trackerId = env.DAILY_TRACKER_V2.idFromName(`${body.user_id}:${today}`);
          const tracker = env.DAILY_TRACKER_V2.get(trackerId);
          
          // Get today's comprehensive data from whoop_daily
          const dailyData = await env.DB.prepare(`
            SELECT * FROM whoop_daily WHERE user_id = ? AND date = ?
          `).bind(body.user_id, today).first() as {
            workout_count?: number;
            total_workout_calories?: number;
            total_workout_strain?: number;
            day_strain?: number;
            recovery_score?: number | null;
            hrv_rmssd?: number;
            resting_heart_rate?: number;
            sleep_performance?: number;
            sleep_duration_minutes?: number;
            weight_kg?: number;
          } | null;
          
          if (dailyData) {
            // Update tracker with workout data
            if (dailyData.workout_count && dailyData.workout_count > 0) {
              await tracker.fetch(new Request('http://internal/workout', {
                method: 'POST',
                body: JSON.stringify({
                  calories_burned: dailyData.total_workout_calories || 0,
                  strain: dailyData.total_workout_strain || 0,
                  day_strain: dailyData.day_strain || 0,
                  workout_count: dailyData.workout_count
                })
              }));
            }
            
            // Update tracker with recovery and sleep data
            if (dailyData.recovery_score !== null && dailyData.recovery_score !== undefined) {
              await tracker.fetch(new Request('http://internal/recovery', {
                method: 'POST',
                body: JSON.stringify({
                  recovery_score: dailyData.recovery_score,
                  hrv: dailyData.hrv_rmssd,
                  resting_hr: dailyData.resting_heart_rate,
                  sleep_score: dailyData.sleep_performance,
                  sleep_hours: dailyData.sleep_duration_minutes ? dailyData.sleep_duration_minutes / 60 : null,
                  weight_kg: dailyData.weight_kg
                })
              }));
            }
          }
          
          // Track analytics
          env.ANALYTICS.writeDataPoint({
            blobs: [body.user_id, 'whoop_sync', body.sync_type],
            doubles: [syncResult.synced],
            indexes: [body.user_id]
          });
        } else if ('photo_key' in body) {
          // Photo analysis message
          const aiService = new AIService(env);
          
          // Get photo from R2
          const photoObj = await env.PHOTOS.get(body.photo_key);
          if (!photoObj) {
            throw new Error('Photo not found');
          }
          
          const imageData = await photoObj.arrayBuffer();
          
          if (body.analysis_type === 'food') {
            const analysis = await aiService.analyzeFoodPhoto(imageData);
            
            // Store analysis results (would update the meal record)
            await env.CACHE.put(
              `food_analysis:${body.photo_key}`,
              JSON.stringify(analysis),
              { expirationTtl: 86400 }
            );
          } else if (body.analysis_type === 'progress') {
            // Get previous photos for comparison
            const previousPhotos = await env.DB.prepare(`
              SELECT taken_at as date, ai_analysis 
              FROM progress_photos 
              WHERE user_id = ? AND ai_analysis IS NOT NULL
              ORDER BY taken_at DESC LIMIT 5
            `).bind(body.user_id).all();
            
            const prevAnalyses = previousPhotos.results?.map(p => ({
              date: p.date as string,
              analysis: JSON.parse(p.ai_analysis as string)
            }));
            
            const analysis = await aiService.analyzeProgressPhoto(imageData, prevAnalyses);
            
            // Update the progress photo record with analysis
            await env.DB.prepare(`
              UPDATE progress_photos SET ai_analysis = ? WHERE photo_key = ?
            `).bind(JSON.stringify(analysis), body.photo_key).run();
          }
          
          // Track analytics
          env.ANALYTICS.writeDataPoint({
            blobs: [body.user_id, 'photo_analysis', body.analysis_type],
            doubles: [1],
            indexes: [body.user_id]
          });
        }
        
        message.ack();
      } catch (error) {
        console.error('Queue processing error:', error);
        message.retry();
      }
    }
  },

  // Scheduled cron handler - automatic Whoop sync with proactive token refresh
  // Runs hourly to refresh tokens before they expire (1 hour lifetime)
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Cron triggered:', controller.cron);
    
    // Get all users with Whoop connected
    const users = await env.DB.prepare(`
      SELECT id, whoop_access_token, whoop_refresh_token, whoop_token_expires_at 
      FROM users 
      WHERE whoop_connected = 1 AND whoop_access_token IS NOT NULL
    `).all();
    
    if (!users.results || users.results.length === 0) {
      console.log('No users with Whoop connected');
      return;
    }
    
    const whoopService = new WhoopService(env);
    
    // Sync 7 days for hourly sync (full 30-day sync is less frequent)
    const daysBack = 7;
    
    console.log(`Running cron sync for ${users.results.length} users, ${daysBack} days back`);
    
    for (const user of users.results) {
      const userId = user.id as string;
      let accessToken = user.whoop_access_token as string;
      
      try {
        // Check if token needs proactive refresh (expires in < 15 minutes)
        const expiresAt = user.whoop_token_expires_at ? new Date(user.whoop_token_expires_at as string) : null;
        const fifteenMinutesFromNow = Date.now() + 15 * 60 * 1000;
        const needsRefresh = !expiresAt || expiresAt.getTime() < fifteenMinutesFromNow;
        
        if (needsRefresh && user.whoop_refresh_token) {
          console.log(`Proactively refreshing token for user ${userId} (expires: ${expiresAt?.toISOString() || 'unknown'})`);
          try {
            const newTokens = await whoopService.refreshToken(user.whoop_refresh_token as string);
            accessToken = newTokens.access_token;
            
            // Calculate new expiration
            const newExpiresAt = new Date(Date.now() + (newTokens.expires_in || 3600) * 1000).toISOString();
            
            // Update tokens in database with expiration
            await env.DB.prepare(`
              UPDATE users SET 
                whoop_access_token = ?,
                whoop_refresh_token = ?,
                whoop_token_expires_at = ?,
                updated_at = datetime('now')
              WHERE id = ?
            `).bind(newTokens.access_token, newTokens.refresh_token, newExpiresAt, userId).run();
            
            console.log(`Token refreshed for ${userId}, new expiration: ${newExpiresAt}`);
          } catch (refreshError) {
            console.error(`Token refresh failed for user ${userId}:`, refreshError);
            
            // Mark as disconnected so UI shows reconnect banner
            await env.DB.prepare(`
              UPDATE users SET whoop_connected = 0, updated_at = datetime('now') WHERE id = ?
            `).bind(userId).run();
            continue;
          }
        }
        
        // Check if there's an active backfill for this user
        const backfillKey = `whoop_backfill:${userId}`;
        const backfillProgressStr = await env.CACHE.get(backfillKey);
        
        if (backfillProgressStr) {
          const backfillProgress = JSON.parse(backfillProgressStr);
          
          if (!backfillProgress.complete) {
            // Continue backfill
            console.log(`Continuing backfill for ${userId}: ${backfillProgress.currentProgress}/${backfillProgress.targetDays} days`);
            
            const backfillResult = await whoopService.backfillChunk(
              userId, 
              accessToken, 
              backfillProgress.targetDays, 
              backfillProgress.currentProgress
            );
            
            // Update progress
            backfillProgress.currentProgress = backfillResult.nextProgress;
            backfillProgress.lastChunkAt = new Date().toISOString();
            backfillProgress.complete = backfillResult.complete;
            if (backfillResult.error) backfillProgress.error = backfillResult.error;
            
            await env.CACHE.put(backfillKey, JSON.stringify(backfillProgress), { expirationTtl: 86400 * 30 });
            
            console.log(`Backfill chunk completed for ${userId}: ${backfillResult.message}`);
            
            // Track analytics
            env.ANALYTICS.writeDataPoint({
              blobs: [userId, 'backfill_chunk', backfillResult.complete ? 'complete' : 'in_progress'],
              doubles: [backfillResult.chunkSynced],
              indexes: [userId]
            });
            
            // Skip regular sync if we did backfill
            continue;
          }
        }
        
        // Run regular incremental sync (extended to 14 days for more overlap)
        const result = await whoopService.syncComprehensive(userId, accessToken, 14);
        console.log(`Synced ${result.synced} days for user ${userId}`);
        
        // Track analytics
        env.ANALYTICS.writeDataPoint({
          blobs: [userId, 'cron_sync', 'scheduled'],
          doubles: [result.synced],
          indexes: [userId]
        });
        
        // Auto-detect and fill gaps (limited batch to avoid rate limits)
        // Only run gap detection/fill twice per day (at midnight and 8am UTC)
        const hour = new Date().getUTCHours();
        if (hour === 0 || hour === 8) { // Run at midnight and 8am UTC
          try {
            const gaps = await whoopService.detectGaps(userId, 180);
            
            if (gaps.hasGaps && gaps.missingDates.length > 0) {
              console.log(`Found ${gaps.missingDates.length} gap dates for user ${userId}`);
              
              // Fill up to 14 days of gaps per run to stay within rate limits
              const datesToFill = gaps.missingDates.slice(0, 14);
              const fillResult = await whoopService.fillGaps(userId, accessToken, datesToFill);
              
              console.log(`Gap fill for ${userId}: ${fillResult.message}`);
              
              // Track analytics
              env.ANALYTICS.writeDataPoint({
                blobs: [userId, 'gap_fill', 'auto'],
                doubles: [fillResult.filledDates.length],
                indexes: [userId]
              });
            }
          } catch (gapError) {
            console.error(`Gap detection/fill failed for user ${userId}:`, gapError);
            // Don't fail the whole cron if gap fill fails
          }
        }
        
      } catch (error) {
        console.error(`Cron sync failed for user ${userId}:`, error);
      }
    }
    
    console.log('Cron sync completed');
  }
};
