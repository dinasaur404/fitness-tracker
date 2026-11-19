/// <reference types="@cloudflare/workers-types" />

import { Hono } from 'hono';
import { Env } from '../types/env';
import { WhoopService, WhoopRateLimitError, WhoopAuthError } from '../services/whoop';

export const whoopRoutes = new Hono<{ Bindings: Env }>();

// Get Whoop OAuth URL - redirects directly to Whoop
whoopRoutes.get('/auth', async (c) => {
  // For demo, we use a fixed user ID. In production, get from session/JWT
  const userId = c.req.query('user_id') || 'demo';

  // Redirect URI must match exactly what's registered in Whoop Developer Portal
  const redirectUri = `${new URL(c.req.url).origin}/callback`;
  const state = crypto.randomUUID();
  
  // Store state in KV for validation
  await c.env.CACHE.put(`whoop_state:${state}`, userId, { expirationTtl: 600 });

  const whoopService = new WhoopService(c.env);
  const authUrl = whoopService.getAuthUrl(redirectUri, state);

  // Redirect directly to Whoop OAuth
  return c.redirect(authUrl);
});

// NOTE: OAuth callback is handled at root level /callback in index.ts
// to match the redirect URI registered in Whoop Developer Portal

// Disconnect Whoop
whoopRoutes.delete('/disconnect', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await c.env.DB.prepare(`
    UPDATE users SET 
      whoop_access_token = NULL,
      whoop_refresh_token = NULL,
      whoop_connected = 0,
      updated_at = datetime('now')
    WHERE id = ?
  `).bind(userId).run();

  return c.json({ success: true });
});

// Get Whoop workouts
whoopRoutes.get('/workouts', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const startDate = c.req.query('start');
  const endDate = c.req.query('end');
  const limit = parseInt(c.req.query('limit') || '20');

  let query = 'SELECT * FROM whoop_workouts WHERE user_id = ?';
  const bindings: (string | number)[] = [userId];

  if (startDate) {
    query += ' AND start_time >= ?';
    bindings.push(startDate);
  }
  if (endDate) {
    query += ' AND start_time <= ?';
    bindings.push(endDate);
  }

  query += ' ORDER BY start_time DESC LIMIT ?';
  bindings.push(limit);

  const workouts = await c.env.DB.prepare(query).bind(...bindings).all();

  return c.json(workouts.results?.map(w => ({
    ...w,
    is_barrys: w.is_barrys === 1
  })));
});

// Get Barry's workouts specifically
whoopRoutes.get('/barrys', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const limit = parseInt(c.req.query('limit') || '20');

  const barrys = await c.env.DB.prepare(`
    SELECT w.*, b.studio_name, b.instructor, b.class_type, b.treadmill_miles, 
           b.floor_focus, b.personal_notes, b.rating
    FROM whoop_workouts w
    LEFT JOIN barrys_workouts b ON w.id = b.whoop_workout_id
    WHERE w.user_id = ? AND w.is_barrys = 1
    ORDER BY w.start_time DESC
    LIMIT ?
  `).bind(userId, limit).all();

  return c.json(barrys.results);
});

// Log Barry's workout details
whoopRoutes.post('/barrys/:workoutId', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const workoutId = c.req.param('workoutId');
  const details = await c.req.json();

  const workout = await c.env.DB.prepare(
    'SELECT id FROM whoop_workouts WHERE id = ? AND user_id = ?'
  ).bind(workoutId, userId).first();

  if (!workout) {
    return c.json({ error: 'Workout not found' }, 404);
  }

  await c.env.DB.prepare(`
    INSERT INTO barrys_workouts (id, user_id, whoop_workout_id, studio_name, instructor, 
      class_type, treadmill_miles, floor_focus, personal_notes, rating, workout_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(whoop_workout_id) DO UPDATE SET
      studio_name = excluded.studio_name,
      instructor = excluded.instructor,
      class_type = excluded.class_type,
      treadmill_miles = excluded.treadmill_miles,
      floor_focus = excluded.floor_focus,
      personal_notes = excluded.personal_notes,
      rating = excluded.rating
  `).bind(
    crypto.randomUUID(),
    userId,
    workoutId,
    details.studio_name || null,
    details.instructor || null,
    details.class_type || null,
    details.treadmill_miles || null,
    details.floor_focus || null,
    details.personal_notes || null,
    details.rating || null,
    details.workout_date || new Date().toISOString().split('T')[0]
  ).run();

  return c.json({ success: true });
});

// Get recovery data
whoopRoutes.get('/recovery', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const startDate = c.req.query('start');
  const endDate = c.req.query('end');
  const limit = parseInt(c.req.query('limit') || '14');

  let query = 'SELECT * FROM whoop_recovery WHERE user_id = ?';
  const bindings: (string | number)[] = [userId];

  if (startDate) {
    query += ' AND date >= ?';
    bindings.push(startDate);
  }
  if (endDate) {
    query += ' AND date <= ?';
    bindings.push(endDate);
  }

  query += ' ORDER BY date DESC LIMIT ?';
  bindings.push(limit);

  const recovery = await c.env.DB.prepare(query).bind(...bindings).all();

  return c.json(recovery.results);
});

// Trigger manual sync
whoopRoutes.post('/sync', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Use the token refresh helper to ensure we have a valid token
  const accessToken = await getValidAccessToken(c, userId);
  
  if (!accessToken) {
    return c.json({ error: 'Whoop not connected or token expired. Please reconnect.' }, 400);
  }

  const whoopService = new WhoopService(c.env);
  await whoopService.queueSync(userId, accessToken, 'incremental');

  return c.json({ success: true, message: 'Sync queued' });
});

// Get today's Whoop summary
whoopRoutes.get('/today', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const today = new Date().toISOString().split('T')[0];

  const [workouts, recovery] = await Promise.all([
    c.env.DB.prepare(`
      SELECT COUNT(*) as count, SUM(calories_burned) as calories, 
             SUM(strain) as strain, MAX(is_barrys) as did_barrys
      FROM whoop_workouts 
      WHERE user_id = ? AND date(start_time, '-8 hours') = ?
    `).bind(userId, today).first(),
    c.env.DB.prepare(`
      SELECT recovery_score, hrv, resting_heart_rate, sleep_performance
      FROM whoop_recovery
      WHERE user_id = ? AND date = ?
    `).bind(userId, today).first()
  ]);

  return c.json({
    workouts: {
      count: workouts?.count || 0,
      calories_burned: workouts?.calories || 0,
      total_strain: workouts?.strain || 0,
      did_barrys: workouts?.did_barrys === 1
    },
    recovery: recovery || null
  });
});

// Whoop Webhook handler - receives real-time updates from Whoop
whoopRoutes.post('/webhook', async (c) => {
  // Whoop sends webhook events for workout, recovery, sleep updates
  try {
    const payload = await c.req.json();
    
    console.log('Whoop webhook received:', JSON.stringify(payload));
    
    // Webhook payload structure:
    // { type: "workout.updated", user_id: 12345, id: 67890, ... }
    const { type, user_id: whoopUserId } = payload;
    
    // Find our user by their Whoop user ID (would need to store this during OAuth)
    // For now, log and acknowledge
    
    // Track webhook event
    c.env.ANALYTICS.writeDataPoint({
      blobs: ['webhook', type, String(whoopUserId)],
      doubles: [1],
      indexes: ['whoop_webhook']
    });

    return c.json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return c.json({ error: 'Webhook processing failed' }, 500);
  }
});

// Get body measurement (weight)
whoopRoutes.get('/weight', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const user = await c.env.DB.prepare(
    'SELECT whoop_access_token FROM users WHERE id = ?'
  ).bind(userId).first();

  if (!user?.whoop_access_token) {
    return c.json({ error: 'Whoop not connected' }, 400);
  }

  const whoopService = new WhoopService(c.env);
  
  try {
    const measurement = await whoopService.getBodyMeasurement(user.whoop_access_token as string);
    
    if (!measurement) {
      return c.json({ weight: null, message: 'No body measurement data' });
    }

    // Convert kg to lbs
    const weightLbs = Math.round(measurement.weight_kilogram * 2.20462 * 10) / 10;
    
    return c.json({
      weight_kg: measurement.weight_kilogram,
      weight_lbs: weightLbs,
      height_m: measurement.height_meter,
      max_heart_rate: measurement.max_heart_rate
    });
  } catch (error) {
    console.error('Failed to get body measurement:', error);
    return c.json({ error: 'Failed to fetch weight data' }, 500);
  }
});

// Get daily data for a specific date
whoopRoutes.get('/daily/:date', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const date = c.req.param('date');
  const whoopService = new WhoopService(c.env);
  
  try {
    const data = await whoopService.getDailyData(userId, date);
    
    if (!data) {
      return c.json({ data: null, message: 'No data for this date' });
    }

    // Get workouts for this day from whoop_workouts table
    // Use -8 hours offset for Pacific Time (UTC-8, or UTC-7 during DST)
    const workouts = await c.env.DB.prepare(`
      SELECT * FROM whoop_workouts 
      WHERE user_id = ? AND date(start_time, '-8 hours') = ?
      ORDER BY start_time ASC
    `).bind(userId, date).all();

    // Get habits from the daily_habits table (this is the source of truth for user-entered habits)
    const habits = await c.env.DB.prepare(`
      SELECT water_bottles, took_electrolytes, drinks_count
      FROM daily_habits 
      WHERE user_id = ? AND date = ?
    `).bind(userId, date).first();

    // Merge habits data - habits table is source of truth for user-entered habits
    const mergedData = {
      ...data,
      weight_lbs: data.weight_kg ? Math.round(data.weight_kg * 2.20462 * 10) / 10 : null,
      sleep_hours: data.sleep_duration_minutes ? Math.round(data.sleep_duration_minutes / 60 * 10) / 10 : null,
      workouts: workouts.results || [],
      // Habits from the habits table (source of truth for user input)
      water_bottles: habits?.water_bottles ?? 0,
      took_electrolytes: habits?.took_electrolytes ?? false,
      drinks_count: habits?.drinks_count ?? 0,
    };

    return c.json(mergedData);
  } catch (error) {
    console.error('Failed to get daily data:', error);
    return c.json({ error: 'Failed to fetch daily data' }, 500);
  }
});

// Get data for a date range
whoopRoutes.get('/range', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const startDate = c.req.query('start');
  const endDate = c.req.query('end');

  if (!startDate || !endDate) {
    return c.json({ error: 'start and end dates are required' }, 400);
  }

  const whoopService = new WhoopService(c.env);
  
  try {
    const data = await whoopService.getDateRange(userId, startDate, endDate);
    
    // Add weight_lbs conversion to each day
    const dataWithLbs = data.map(d => ({
      ...d,
      weight_lbs: d.weight_kg ? Math.round(d.weight_kg * 2.20462 * 10) / 10 : null,
      sleep_hours: d.sleep_duration_minutes ? Math.round(d.sleep_duration_minutes / 60 * 10) / 10 : null
    }));

    return c.json({ data: dataWithLbs });
  } catch (error) {
    console.error('Failed to get date range:', error);
    return c.json({ error: 'Failed to fetch data range' }, 500);
  }
});

// Get weekly summary
whoopRoutes.get('/summary/week', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Allow client to specify start date (for timezone correctness)
  const startParam = c.req.query('start');
  let weekStartStr: string;
  
  if (startParam) {
    weekStartStr = startParam;
  } else {
    // Fallback to server time calculation (Monday start)
    const today = new Date();
    const dayOfWeek = today.getDay();
    const diff = today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
    const weekStart = new Date(today.setDate(diff));
    weekStartStr = weekStart.toISOString().split('T')[0];
  }

  const whoopService = new WhoopService(c.env);
  
  try {
    const summary = await whoopService.getWeeklySummary(userId, weekStartStr);
    return c.json(summary);
  } catch (error) {
    console.error('Failed to get weekly summary:', error);
    return c.json({ error: 'Failed to fetch weekly summary' }, 500);
  }
});

// Get monthly summary
whoopRoutes.get('/summary/month', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const yearParam = c.req.query('year');
  const monthParam = c.req.query('month');
  
  const now = new Date();
  const year = yearParam ? parseInt(yearParam) : now.getFullYear();
  const month = monthParam ? parseInt(monthParam) : now.getMonth() + 1;

  const whoopService = new WhoopService(c.env);
  
  try {
    const summary = await whoopService.getMonthlySummary(userId, year, month);
    return c.json(summary);
  } catch (error) {
    console.error('Failed to get monthly summary:', error);
    return c.json({ error: 'Failed to fetch monthly summary' }, 500);
  }
});

// Helper to get valid access token (refresh if needed)
// Uses proactive refresh based on stored expiration time to avoid unnecessary API calls
async function getValidAccessToken(c: any, userId: string): Promise<string | null> {
  const user = await c.env.DB.prepare(
    'SELECT whoop_access_token, whoop_refresh_token, whoop_token_expires_at FROM users WHERE id = ?'
  ).bind(userId).first();

  if (!user?.whoop_access_token) {
    console.log('No access token found for user', userId);
    return null;
  }

  // Check if token is expired or expiring soon (5 minute buffer)
  const expiresAt = user.whoop_token_expires_at ? new Date(user.whoop_token_expires_at as string) : null;
  const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;
  const needsRefresh = !expiresAt || expiresAt.getTime() < fiveMinutesFromNow;

  console.log('Token check:', { 
    expiresAt: expiresAt?.toISOString(), 
    needsRefresh, 
    hasRefreshToken: !!user.whoop_refresh_token 
  });

  if (!needsRefresh) {
    // Token is still valid, use it
    return user.whoop_access_token as string;
  }

  // Token expired or expiring soon - try to refresh
  if (user.whoop_refresh_token) {
    console.log('Access token expired or expiring soon, attempting refresh...');
    const whoopService = new WhoopService(c.env);
    
    try {
      const newTokens = await whoopService.refreshToken(user.whoop_refresh_token as string);
      
      // Calculate new expiration time
      const newExpiresAt = new Date(Date.now() + (newTokens.expires_in || 3600) * 1000).toISOString();
      
      // Update tokens in database
      await c.env.DB.prepare(`
        UPDATE users SET 
          whoop_access_token = ?,
          whoop_refresh_token = ?,
          whoop_token_expires_at = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).bind(newTokens.access_token, newTokens.refresh_token, newExpiresAt, userId).run();
      
      console.log('Token refreshed successfully, new expiration:', newExpiresAt);
      return newTokens.access_token;
    } catch (refreshError) {
      console.error('Token refresh failed:', refreshError);
      
      // Mark Whoop as disconnected so UI can show reconnect banner
      await c.env.DB.prepare(`
        UPDATE users SET whoop_connected = 0, updated_at = datetime('now') WHERE id = ?
      `).bind(userId).run();
      
      // Propagate specific error types for better frontend handling
      if (refreshError instanceof WhoopAuthError || refreshError instanceof WhoopRateLimitError) {
        throw refreshError;
      }
      
      return null;
    }
  }

  console.log('No refresh token available for user', userId);
  return null;
}

// Full sync - triggers comprehensive 90-day sync
whoopRoutes.post('/sync/full', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let accessToken: string | null;
  try {
    accessToken = await getValidAccessToken(c, userId);
  } catch (error) {
    if (error instanceof WhoopAuthError) {
      return c.json({ 
        error: 'Whoop authentication expired. Please reconnect your account.',
        needsReconnect: true
      }, 401);
    }
    if (error instanceof WhoopRateLimitError) {
      return c.json({ 
        error: 'Whoop API rate limited. Please try again later.',
        retryAfter: error.retryAfter,
        rateLimited: true
      }, 429);
    }
    throw error;
  }
  
  if (!accessToken) {
    return c.json({ error: 'Whoop not connected or token expired. Please reconnect.', needsReconnect: true }, 400);
  }

  const whoopService = new WhoopService(c.env);
  
  try {
    // Do full 30-day sync
    const result = await whoopService.syncComprehensive(
      userId, 
      accessToken, 
      30
    );
    
    return c.json({ 
      success: true, 
      synced: result.synced,
      message: `Synced ${result.synced} days of data`
    });
  } catch (error) {
    console.error('Full sync failed:', error);
    if (error instanceof WhoopRateLimitError) {
      return c.json({ 
        error: 'Whoop API rate limited. Please try again later.',
        retryAfter: error.retryAfter,
        rateLimited: true
      }, 429);
    }
    if (error instanceof WhoopAuthError) {
      // Mark as disconnected so UI shows reconnect banner
      await c.env.DB.prepare(`
        UPDATE users SET whoop_connected = 0, updated_at = datetime('now') WHERE id = ?
      `).bind(userId).run();
      return c.json({ 
        error: 'Whoop authentication expired. Please reconnect your account.',
        needsReconnect: true
      }, 401);
    }
    return c.json({ error: 'Sync failed: ' + (error instanceof Error ? error.message : 'Unknown error') }, 500);
  }
});

// Quick sync - just recent data (incremental)
whoopRoutes.post('/sync/quick', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let accessToken: string | null;
  try {
    accessToken = await getValidAccessToken(c, userId);
  } catch (error) {
    if (error instanceof WhoopAuthError) {
      return c.json({ 
        error: 'Whoop authentication expired. Please reconnect your account.',
        needsReconnect: true
      }, 401);
    }
    if (error instanceof WhoopRateLimitError) {
      return c.json({ 
        error: 'Whoop API rate limited. Please try again later.',
        retryAfter: error.retryAfter,
        rateLimited: true
      }, 429);
    }
    throw error;
  }
  
  if (!accessToken) {
    return c.json({ error: 'Whoop not connected or token expired. Please reconnect.', needsReconnect: true }, 400);
  }

  const whoopService = new WhoopService(c.env);
  
  try {
    // Quick 7-day sync
    const result = await whoopService.syncComprehensive(
      userId, 
      accessToken, 
      7
    );
    
    return c.json({ 
      success: true, 
      synced: result.synced,
      message: `Synced ${result.synced} days of data`
    });
  } catch (error) {
    console.error('Quick sync failed:', error);
    if (error instanceof WhoopRateLimitError) {
      return c.json({ 
        error: 'Whoop API rate limited. Please try again later.',
        retryAfter: error.retryAfter,
        rateLimited: true
      }, 429);
    }
    if (error instanceof WhoopAuthError) {
      // Mark as disconnected so UI shows reconnect banner
      await c.env.DB.prepare(`
        UPDATE users SET whoop_connected = 0, updated_at = datetime('now') WHERE id = ?
      `).bind(userId).run();
      return c.json({ 
        error: 'Whoop authentication expired. Please reconnect your account.',
        needsReconnect: true
      }, 401);
    }
    return c.json({ error: 'Sync failed: ' + (error instanceof Error ? error.message : 'Unknown error') }, 500);
  }
});

// Start backfill - initiates 6-month historical data backfill
// This runs gradually over time to avoid rate limits
whoopRoutes.post('/backfill/start', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { days = 180 } = await c.req.json().catch(() => ({}));
  const targetDays = Math.min(Math.max(days, 7), 365); // Between 7 and 365 days

  const accessToken = await getValidAccessToken(c, userId);
  if (!accessToken) {
    return c.json({ error: 'Whoop not connected or token expired. Please reconnect.' }, 400);
  }

  // Find earliest date we already have
  const earliestResult = await c.env.DB.prepare(
    'SELECT MIN(date) as earliest FROM whoop_daily WHERE user_id = ?'
  ).bind(userId).first();
  const earliestDate = earliestResult?.earliest as string | null;

  // Store backfill progress in KV
  const backfillKey = `whoop_backfill:${userId}`;
  const existingProgress = await c.env.CACHE.get(backfillKey);
  
  if (existingProgress) {
    const progress = JSON.parse(existingProgress);
    if (!progress.complete) {
      return c.json({ 
        error: 'Backfill already in progress', 
        progress 
      }, 400);
    }
  }

  // Initialize backfill progress
  const progress: {
    userId: string;
    targetDays: number;
    currentProgress: number;
    startedAt: string;
    lastChunkAt: string | null;
    complete: boolean;
    error: string | null;
    earliestDate: string | null;
  } = {
    userId,
    targetDays,
    currentProgress: 0,
    startedAt: new Date().toISOString(),
    lastChunkAt: null,
    complete: false,
    error: null,
    earliestDate
  };
  
  await c.env.CACHE.put(backfillKey, JSON.stringify(progress), { expirationTtl: 86400 * 30 }); // 30 day TTL

  // Run first chunk immediately
  const whoopService = new WhoopService(c.env);
  const result = await whoopService.backfillChunk(userId, accessToken, targetDays, 0, earliestDate || undefined);
  
  // Update progress
  progress.currentProgress = result.nextProgress;
  progress.lastChunkAt = new Date().toISOString();
  progress.complete = result.complete;
  if (result.error) progress.error = result.error;
  
  await c.env.CACHE.put(backfillKey, JSON.stringify(progress), { expirationTtl: 86400 * 30 });

  return c.json({
    success: true,
    message: result.message,
    progress: {
      daysProcessed: result.daysProcessed,
      targetDays: result.targetDays,
      complete: result.complete,
      estimatedHoursRemaining: result.complete ? 0 : Math.ceil((targetDays - result.daysProcessed) / 7)
    }
  });
});

// Get backfill status
whoopRoutes.get('/backfill/status', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const backfillKey = `whoop_backfill:${userId}`;
  const progressStr = await c.env.CACHE.get(backfillKey);
  
  if (!progressStr) {
    return c.json({ 
      active: false, 
      message: 'No backfill in progress. Use POST /api/whoop/backfill/start to begin.' 
    });
  }

  const progress = JSON.parse(progressStr);
  const estimatedHoursRemaining = progress.complete ? 0 : Math.ceil((progress.targetDays - progress.currentProgress) / 7);

  return c.json({
    active: !progress.complete,
    complete: progress.complete,
    daysProcessed: progress.currentProgress,
    targetDays: progress.targetDays,
    percentComplete: Math.round((progress.currentProgress / progress.targetDays) * 100),
    startedAt: progress.startedAt,
    lastChunkAt: progress.lastChunkAt,
    estimatedHoursRemaining,
    error: progress.error
  });
});

// Cancel backfill
whoopRoutes.delete('/backfill', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const backfillKey = `whoop_backfill:${userId}`;
  await c.env.CACHE.delete(backfillKey);

  return c.json({ success: true, message: 'Backfill cancelled' });
});

// Re-sync recovery/sleep data for dates missing it
// This fills in gaps where we have cycle data but no recovery/sleep
whoopRoutes.post('/resync-recovery', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const accessToken = await getValidAccessToken(c, userId);
  if (!accessToken) {
    return c.json({ error: 'Whoop not connected or token expired', needsReconnect: true }, 401);
  }

  const whoopService = new WhoopService(c.env);

  try {
    // Find dates with cycle data but missing recovery
    const missingRecovery = await c.env.DB.prepare(`
      SELECT date FROM whoop_daily 
      WHERE user_id = ? AND day_strain IS NOT NULL AND recovery_score IS NULL
      ORDER BY date DESC
      LIMIT 90
    `).bind(userId).all();

    const dates = (missingRecovery.results || []).map(r => r.date as string);
    
    if (dates.length === 0) {
      return c.json({ success: true, message: 'No missing recovery data to sync', synced: 0 });
    }

    console.log(`Re-syncing recovery for ${dates.length} dates`);

    // Group dates into ranges to minimize API calls
    const minDate = dates[dates.length - 1];
    const maxDate = dates[0];

    // Fetch recovery and sleep for the entire range
    const [recoveries, sleeps] = await Promise.all([
      whoopService.getRecovery(accessToken, minDate, maxDate),
      whoopService.getSleep(accessToken, minDate, maxDate)
    ]);

    console.log(`Fetched ${recoveries.length} recoveries, ${sleeps.length} sleeps for ${minDate} to ${maxDate}`);

    let updatedCount = 0;

    // Update recovery data
    for (const recovery of recoveries) {
      const date = recovery.created_at.split('T')[0];
      const score = recovery.score;
      if (score) {
        await c.env.DB.prepare(`
          UPDATE whoop_daily SET
            recovery_score = ?,
            hrv_rmssd = ?,
            resting_heart_rate = ?,
            spo2_percentage = ?,
            skin_temp_celsius = ?,
            recovery_id = ?,
            synced_at = datetime('now')
          WHERE user_id = ? AND date = ?
        `).bind(
          score.recovery_score || 0,
          score.hrv_rmssd_milli || 0,
          score.resting_heart_rate || 0,
          score.spo2_percentage || null,
          score.skin_temp_celsius || null,
          recovery.cycle_id.toString(),
          userId,
          date
        ).run();
        updatedCount++;
      }
    }

    // Update sleep data
    for (const sleep of sleeps) {
      if (sleep.nap) continue;
      const date = sleep.end.split('T')[0];
      const score = sleep.score;
      if (score) {
        const stages = score.stage_summary;
        const sleepDuration = stages 
          ? Math.round((stages.total_in_bed_time_milli - stages.total_awake_time_milli) / 60000)
          : null;
        
        await c.env.DB.prepare(`
          UPDATE whoop_daily SET
            sleep_performance = ?,
            sleep_efficiency = ?,
            sleep_duration_minutes = ?,
            rem_duration_minutes = ?,
            deep_duration_minutes = ?,
            light_duration_minutes = ?,
            awake_duration_minutes = ?,
            respiratory_rate = ?,
            sleep_id = ?,
            synced_at = datetime('now')
          WHERE user_id = ? AND date = ?
        `).bind(
          score.sleep_performance_percentage || 0,
          score.sleep_efficiency_percentage || 0,
          sleepDuration,
          stages ? Math.round(stages.total_rem_sleep_time_milli / 60000) : null,
          stages ? Math.round(stages.total_slow_wave_sleep_time_milli / 60000) : null,
          stages ? Math.round(stages.total_light_sleep_time_milli / 60000) : null,
          stages ? Math.round(stages.total_awake_time_milli / 60000) : null,
          score.respiratory_rate || null,
          sleep.id.toString(),
          userId,
          date
        ).run();
      }
    }

    return c.json({
      success: true,
      message: `Re-synced recovery/sleep data`,
      dates_checked: dates.length,
      recoveries_found: recoveries.length,
      sleeps_found: sleeps.length,
      updated: updatedCount
    });

  } catch (error) {
    console.error('Re-sync failed:', error);
    return c.json({ error: 'Failed to re-sync recovery data' }, 500);
  }
});

// Re-sync workout data for all dates
whoopRoutes.post('/resync-workouts', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const accessToken = await getValidAccessToken(c, userId);
  if (!accessToken) {
    return c.json({ error: 'Whoop not connected or token expired', needsReconnect: true }, 401);
  }

  const whoopService = new WhoopService(c.env);

  try {
    // Get date range we have daily data for
    const dateRange = await c.env.DB.prepare(`
      SELECT MIN(date) as min_date, MAX(date) as max_date
      FROM whoop_daily WHERE user_id = ?
    `).bind(userId).first();

    if (!dateRange?.min_date) {
      return c.json({ success: true, message: 'No daily data to sync workouts for', synced: 0 });
    }

    const minDate = dateRange.min_date as string;
    const maxDate = dateRange.max_date as string;

    console.log(`Re-syncing workouts for ${minDate} to ${maxDate}`);

    // Fetch all workouts for the date range
    const workouts = await whoopService.getWorkouts(accessToken, minDate, maxDate);
    
    console.log(`Fetched ${workouts.length} workouts from Whoop API`);

    let savedCount = 0;
    let barrysCount = 0;

    // Sport name mapping
    const SPORT_NAMES: Record<number, string> = {
      0: 'Activity', 1: 'Running', 44: 'Cycling', 71: 'Functional Fitness',
      52: 'HIIT', 63: 'Bootcamp', 48: 'Rowing', 43: 'Swimming',
      16: 'Yoga', 42: 'Weight Training', 73: 'CrossFit'
    };

    for (const workout of workouts) {
      // Determine if this is a Barry's workout
      const sportName = SPORT_NAMES[workout.sport_id] || 'Activity';
      const isBarrys = sportName === 'Functional Fitness' || 
                       sportName === 'HIIT' || 
                       sportName === 'Bootcamp' ||
                       (workout.score?.strain >= 10 && sportName === 'Activity');

      const caloriesBurned = workout.score?.kilojoule ? Math.round(workout.score.kilojoule / 4.184) : 0;
      const workoutDate = workout.start.split('T')[0];

      await c.env.DB.prepare(`
        INSERT INTO whoop_workouts (id, user_id, whoop_id, sport_name, start_time, end_time, 
          calories_burned, average_heart_rate, max_heart_rate, strain, is_barrys, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(whoop_id) DO UPDATE SET
          sport_name = excluded.sport_name,
          calories_burned = excluded.calories_burned,
          average_heart_rate = excluded.average_heart_rate,
          max_heart_rate = excluded.max_heart_rate,
          strain = excluded.strain,
          is_barrys = excluded.is_barrys
      `).bind(
        crypto.randomUUID(),
        userId,
        workout.id.toString(),
        sportName,
        workout.start,
        workout.end,
        caloriesBurned,
        workout.score?.average_heart_rate || 0,
        workout.score?.max_heart_rate || 0,
        workout.score?.strain || 0,
        isBarrys ? 1 : 0,
        new Date().toISOString()
      ).run();
      
      savedCount++;
      if (isBarrys) barrysCount++;

      // Also update the daily summary
      // Use -8 hours offset for Pacific Time
      await c.env.DB.prepare(`
        UPDATE whoop_daily SET
          workout_count = (
            SELECT COUNT(*) FROM whoop_workouts 
            WHERE user_id = ? AND date(start_time, '-8 hours') = ?
          ),
          total_workout_strain = (
            SELECT COALESCE(SUM(strain), 0) FROM whoop_workouts 
            WHERE user_id = ? AND date(start_time, '-8 hours') = ?
          ),
          total_workout_calories = (
            SELECT COALESCE(SUM(calories_burned), 0) FROM whoop_workouts 
            WHERE user_id = ? AND date(start_time, '-8 hours') = ?
          )
        WHERE user_id = ? AND date = ?
      `).bind(
        userId, workoutDate,
        userId, workoutDate,
        userId, workoutDate,
        userId, workoutDate
      ).run();
    }

    return c.json({
      success: true,
      message: `Re-synced workout data`,
      date_range: { from: minDate, to: maxDate },
      workouts_found: workouts.length,
      saved: savedCount,
      barrys_detected: barrysCount
    });

  } catch (error) {
    console.error('Workout re-sync failed:', error);
    return c.json({ error: 'Failed to re-sync workout data' }, 500);
  }
});

// Get sync status - how much data we have
whoopRoutes.get('/sync-status', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    // Get count and date range of Whoop data we have
    const stats = await c.env.DB.prepare(`
      SELECT 
        COUNT(*) as total_days,
        MIN(date) as earliest_date,
        MAX(date) as latest_date
      FROM whoop_daily
      WHERE user_id = ?
    `).bind(userId).first();

    const totalDays = (stats?.total_days as number) || 0;
    const earliestDate = stats?.earliest_date as string || null;
    const latestDate = stats?.latest_date as string || null;

    // Calculate potential days (from earliest Whoop supports to today)
    const today = new Date();
    let daysSinceEarliest = 0;
    if (earliestDate) {
      const earliest = new Date(earliestDate);
      daysSinceEarliest = Math.ceil((today.getTime() - earliest.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    }

    // Check if backfill is in progress
    const backfillKey = `whoop_backfill:${userId}`;
    const backfillStr = await c.env.CACHE.get(backfillKey);
    let backfillActive = false;
    let backfillProgress = null;
    
    if (backfillStr) {
      const backfill = JSON.parse(backfillStr);
      backfillActive = !backfill.complete;
      backfillProgress = {
        complete: backfill.complete,
        daysProcessed: backfill.currentProgress,
        targetDays: backfill.targetDays,
        percentComplete: Math.round((backfill.currentProgress / backfill.targetDays) * 100)
      };
    }

    return c.json({
      totalDays,
      earliestDate,
      latestDate,
      daysCovered: daysSinceEarliest,
      backfillActive,
      backfillProgress
    });
  } catch (error) {
    console.error('Failed to get sync status:', error);
    return c.json({ error: 'Failed to get sync status' }, 500);
  }
});

// Detect gaps in historical data
whoopRoutes.get('/gaps', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const daysBack = parseInt(c.req.query('days') || '180');
  const whoopService = new WhoopService(c.env);

  try {
    const result = await whoopService.detectGaps(userId, daysBack);
    
    // Group missing dates by month for easier display
    const gapsByMonth: Record<string, string[]> = {};
    for (const date of result.missingDates) {
      const month = date.substring(0, 7); // YYYY-MM
      if (!gapsByMonth[month]) {
        gapsByMonth[month] = [];
      }
      gapsByMonth[month].push(date);
    }

    return c.json({
      ...result,
      gapsByMonth,
      summary: {
        totalMissing: result.missingDates.length,
        coveragePercent: result.totalDays > 0 
          ? Math.round((result.existingDays / result.totalDays) * 100) 
          : 0
      }
    });
  } catch (error) {
    console.error('Gap detection failed:', error);
    return c.json({ error: 'Failed to detect gaps' }, 500);
  }
});

// Fill gaps by fetching missing dates from Whoop API
whoopRoutes.post('/fill-gaps', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let accessToken: string | null;
  try {
    accessToken = await getValidAccessToken(c, userId);
  } catch (error) {
    if (error instanceof WhoopAuthError) {
      return c.json({ 
        error: 'Whoop authentication expired. Please reconnect your account.',
        needsReconnect: true
      }, 401);
    }
    if (error instanceof WhoopRateLimitError) {
      return c.json({ 
        error: 'Whoop API rate limited. Please try again later.',
        retryAfter: error.retryAfter,
        rateLimited: true
      }, 429);
    }
    throw error;
  }

  if (!accessToken) {
    return c.json({ error: 'Whoop not connected or token expired. Please reconnect.', needsReconnect: true }, 400);
  }

  const whoopService = new WhoopService(c.env);

  try {
    // First detect gaps
    const body = await c.req.json().catch(() => ({}));
    const daysBack = body.daysBack || 180;
    const maxDatesToFill = body.maxDates || 60; // Limit how many dates to fill at once

    const gaps = await whoopService.detectGaps(userId, daysBack);

    if (!gaps.hasGaps) {
      return c.json({ 
        success: true, 
        message: 'No gaps to fill - data is complete!',
        filledDates: [],
        failedDates: []
      });
    }

    // Limit dates to fill to avoid rate limits
    const datesToFill = gaps.missingDates.slice(0, maxDatesToFill);

    console.log(`Filling ${datesToFill.length} gap dates out of ${gaps.missingDates.length} total`);

    // Fill the gaps
    const result = await whoopService.fillGaps(userId, accessToken, datesToFill);

    return c.json({
      ...result,
      totalGaps: gaps.missingDates.length,
      remainingGaps: gaps.missingDates.length - result.filledDates.length
    });

  } catch (error) {
    console.error('Gap fill failed:', error);
    if (error instanceof WhoopRateLimitError) {
      return c.json({ 
        error: 'Whoop API rate limited. Please try again later.',
        retryAfter: error.retryAfter,
        rateLimited: true
      }, 429);
    }
    if (error instanceof WhoopAuthError) {
      await c.env.DB.prepare(`
        UPDATE users SET whoop_connected = 0, updated_at = datetime('now') WHERE id = ?
      `).bind(userId).run();
      return c.json({ 
        error: 'Whoop authentication expired. Please reconnect your account.',
        needsReconnect: true
      }, 401);
    }
    return c.json({ error: 'Gap fill failed: ' + (error instanceof Error ? error.message : 'Unknown error') }, 500);
  }
});

// Get trend data for dashboard - returns the ACTUAL last N calendar days
// Shows data if available, null if not (for honest representation)
whoopRoutes.get('/trend', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const days = parseInt(c.req.query('days') || '7');
  // Allow client to pass their local date so we calculate from their perspective
  const clientDate = c.req.query('today'); // Format: YYYY-MM-DD
  
  try {
    // Build list of the actual last N calendar days
    const today = clientDate ? new Date(clientDate + 'T12:00:00Z') : new Date();
    const dateList: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dateList.push(d.toISOString().split('T')[0]);
    }
    
    // Get data for these specific dates
    const placeholders = dateList.map(() => '?').join(',');
    const result = await c.env.DB.prepare(`
      SELECT * FROM whoop_daily 
      WHERE user_id = ? 
        AND date IN (${placeholders})
      ORDER BY date ASC
    `).bind(userId, ...dateList).all();
    
    // Create a map for quick lookup
    const dataMap = new Map<string, Record<string, unknown>>();
    for (const row of (result.results || [])) {
      dataMap.set(row.date as string, row);
    }
    
    // Build response with all dates, showing null for missing data
    const trendDays = dateList.map(date => {
      const data = dataMap.get(date);
      return {
        date,
        recovery_score: data?.recovery_score ?? null,
        day_strain: data?.day_strain ?? null,
        sleep_duration_minutes: data?.sleep_duration_minutes ?? null,
        has_data: !!data && (data.recovery_score !== null || (data.day_strain as number) > 0)
      };
    });
    
    // Count how many days actually have recovery data
    const daysWithRecovery = trendDays.filter(d => d.recovery_score !== null).length;
    
    // Get summary stats from last 30 days (for context/comparison)
    const endDate = dateList[dateList.length - 1];
    const stats = await c.env.DB.prepare(`
      SELECT 
        AVG(recovery_score) as avg_recovery,
        AVG(day_strain) as avg_strain,
        AVG(sleep_duration_minutes) as avg_sleep_minutes,
        MIN(recovery_score) as min_recovery,
        MAX(recovery_score) as max_recovery
      FROM whoop_daily 
      WHERE user_id = ? 
        AND date >= date(?, '-30 days')
        AND date <= ?
        AND recovery_score IS NOT NULL
    `).bind(userId, endDate, endDate).first();
    
    // Get previous 30-day period for trend comparison (30-60 days ago)
    const prevStats = await c.env.DB.prepare(`
      SELECT 
        AVG(recovery_score) as avg_recovery,
        AVG(day_strain) as avg_strain,
        AVG(sleep_duration_minutes) as avg_sleep_minutes
      FROM whoop_daily 
      WHERE user_id = ? 
        AND date >= date(?, '-60 days')
        AND date < date(?, '-30 days')
        AND recovery_score IS NOT NULL
    `).bind(userId, endDate, endDate).first();
    
    return c.json({
      days: trendDays,
      days_with_data: daysWithRecovery,
      stats: {
        avg_recovery: stats?.avg_recovery ? Math.round(stats.avg_recovery as number) : null,
        avg_strain: stats?.avg_strain ? Math.round((stats.avg_strain as number) * 10) / 10 : null,
        avg_sleep_hours: stats?.avg_sleep_minutes ? Math.round((stats.avg_sleep_minutes as number) / 60 * 10) / 10 : null,
        min_recovery: stats?.min_recovery,
        max_recovery: stats?.max_recovery,
        // Previous period for trend comparison
        prev_recovery: prevStats?.avg_recovery ? Math.round(prevStats.avg_recovery as number) : null,
        prev_strain: prevStats?.avg_strain ? Math.round((prevStats.avg_strain as number) * 10) / 10 : null,
        prev_sleep_hours: prevStats?.avg_sleep_minutes ? Math.round((prevStats.avg_sleep_minutes as number) / 60 * 10) / 10 : null,
      }
    });
  } catch (error) {
    console.error('Failed to get trend:', error);
    return c.json({ error: 'Failed to fetch trend data' }, 500);
  }
});
