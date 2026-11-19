/// <reference types="@cloudflare/workers-types" />

import { Hono } from 'hono';
import { getAgentByName } from 'agents';
import { Env } from '../types/env';
import { safeJsonParse } from '../utils/error-handling';

export const habitsRoutes = new Hono<{ Bindings: Env }>();

// Get habits for a date
habitsRoutes.get('/:date', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const date = c.req.param('date');
  
  const habits = await c.env.DB.prepare(`
    SELECT * FROM daily_habits WHERE user_id = ? AND date = ?
  `).bind(userId, date).first();

  if (!habits) {
    return c.json({
      date,
      drinks_count: 0,
      smoked_weed: false,
      water_bottles: 0,
      took_electrolytes: false,
      steps: null,
      mood_rating: null,
      energy_rating: null,
      notes: null,
      tomorrow_workout: null,
      tomorrow_events: null
    });
  }

  return c.json({
    ...habits,
    smoked_weed: habits.smoked_weed === 1,
    took_electrolytes: habits.took_electrolytes === 1,
    drink_types: safeJsonParse(habits.drink_types, [])
  });
});

// Get habits for date range
habitsRoutes.get('/', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const startDate = c.req.query('start') || new Date().toISOString().split('T')[0];
  const endDate = c.req.query('end') || startDate;

  const habits = await c.env.DB.prepare(`
    SELECT * FROM daily_habits 
    WHERE user_id = ? AND date BETWEEN ? AND ?
    ORDER BY date DESC
  `).bind(userId, startDate, endDate).all();

  return c.json(habits.results?.map(h => ({
    ...h,
    smoked_weed: h.smoked_weed === 1,
    drink_types: safeJsonParse(h.drink_types, [])
  })));
});

// Update habits for a date
habitsRoutes.post('/:date', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const date = c.req.param('date');
  const data = await c.req.json();

  // Upsert habits (updated fields: water_bottles instead of water_glasses, added took_electrolytes, steps)
  await c.env.DB.prepare(`
    INSERT INTO daily_habits (id, user_id, date, drinks_count, drink_types, smoked_weed, 
      water_bottles, took_electrolytes, steps, mood_rating, energy_rating, stress_rating, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET
      drinks_count = excluded.drinks_count,
      drink_types = excluded.drink_types,
      smoked_weed = excluded.smoked_weed,
      water_bottles = excluded.water_bottles,
      took_electrolytes = excluded.took_electrolytes,
      steps = COALESCE(excluded.steps, daily_habits.steps),
      mood_rating = COALESCE(excluded.mood_rating, daily_habits.mood_rating),
      energy_rating = COALESCE(excluded.energy_rating, daily_habits.energy_rating),
      stress_rating = COALESCE(excluded.stress_rating, daily_habits.stress_rating),
      notes = COALESCE(excluded.notes, daily_habits.notes),
      updated_at = datetime('now')
  `).bind(
    crypto.randomUUID(),
    userId,
    date,
    data.drinks_count || 0,
    data.drink_types ? JSON.stringify(data.drink_types) : null,
    data.smoked_weed ? 1 : 0,
    data.water_bottles || 0,
    data.took_electrolytes ? 1 : 0,
    data.steps || null,
    data.mood_rating || null,
    data.energy_rating || null,
    data.stress_rating || null,
    data.notes || null
  ).run();

  // Update daily tracker V2 Durable Object
  const trackerId = c.env.DAILY_TRACKER_V2.idFromName(`${userId}:${date}`);
  const tracker = c.env.DAILY_TRACKER_V2.get(trackerId);
  
  await tracker.fetch(new Request('http://internal/habits', {
    method: 'POST',
    body: JSON.stringify({
      drinks_count: data.drinks_count || 0,
      smoked_weed: data.smoked_weed || false,
      water_bottles: data.water_bottles || 0,
      took_electrolytes: data.took_electrolytes || false
    })
  }));

  // Update streaks V2
  const streakId = c.env.STREAK_MANAGER_V2.idFromName(userId);
  const streakManager = c.env.STREAK_MANAGER_V2.get(streakId);
  
  // Get today's summary for streak calculation
  const summaryResponse = await tracker.fetch(new Request('http://internal/summary'));
  const summary = await summaryResponse.json() as { 
    calorie_goal_hit: boolean; 
    protein_goal_hit: boolean;
    water_glasses: number;
    workouts_completed: number;
    barrys_completed: boolean;
  };

  await streakManager.fetch(new Request('http://internal/check-day', {
    method: 'POST',
    body: JSON.stringify({
      date,
      drank_alcohol: (data.drinks_count || 0) > 0,
      smoked_weed: data.smoked_weed || false,
      worked_out: summary.workouts_completed > 0,
      did_barrys: summary.barrys_completed,
      hit_calorie_goal: summary.calorie_goal_hit,
      hit_protein_goal: summary.protein_goal_hit,
      hit_water_goal: summary.water_glasses >= 8
    })
  }));

  // Track analytics
  c.env.ANALYTICS.writeDataPoint({
    blobs: [userId, 'habits_logged', date],
    doubles: [data.drinks_count || 0, data.smoked_weed ? 1 : 0, data.water_glasses || 0],
    indexes: [userId]
  });

  return c.json({ success: true });
});

// Partial update habits (PUT) - only updates fields that are provided
habitsRoutes.put('/:date', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const date = c.req.param('date');
  const data = await c.req.json();

  // Build dynamic update query based on provided fields
  const updates: string[] = ['updated_at = datetime(\'now\')'];
  const values: (string | number | null)[] = [];

  if (data.water_bottles !== undefined) {
    updates.push('water_bottles = ?');
    values.push(data.water_bottles);
  }
  if (data.took_electrolytes !== undefined) {
    updates.push('took_electrolytes = ?');
    values.push(data.took_electrolytes ? 1 : 0);
  }
  if (data.drinks_count !== undefined) {
    updates.push('drinks_count = ?');
    values.push(data.drinks_count);
  }
  if (data.smoked_weed !== undefined) {
    updates.push('smoked_weed = ?');
    values.push(data.smoked_weed ? 1 : 0);
  }
  if (data.mood_rating !== undefined) {
    updates.push('mood_rating = ?');
    values.push(data.mood_rating);
  }
  if (data.energy_rating !== undefined) {
    updates.push('energy_rating = ?');
    values.push(data.energy_rating);
  }
  if (data.steps !== undefined) {
    updates.push('steps = ?');
    values.push(data.steps);
  }
  if (data.tomorrow_workout !== undefined) {
    updates.push('tomorrow_workout = ?');
    values.push(data.tomorrow_workout); // e.g., "barrys_double", "barrys_regular", "rest", "other"
  }
  if (data.tomorrow_events !== undefined) {
    updates.push('tomorrow_events = ?');
    values.push(data.tomorrow_events); // Free text: "dinner out at Nobu", "sister's birthday drinks", "WFO"
  }

  // First ensure record exists
  await c.env.DB.prepare(`
    INSERT OR IGNORE INTO daily_habits (id, user_id, date)
    VALUES (?, ?, ?)
  `).bind(crypto.randomUUID(), userId, date).run();

  // Then update only the provided fields
  if (updates.length > 1) {
    const sql = `UPDATE daily_habits SET ${updates.join(', ')} WHERE user_id = ? AND date = ?`;
    await c.env.DB.prepare(sql).bind(...values, userId, date).run();
  }

  // Update UserAgent with the changed fields
  try {
    const agent = await getAgentByName(c.env.USER_AGENT, userId);
    const agentUpdate: Record<string, unknown> = {};
    if (data.water_bottles !== undefined) agentUpdate.waterBottles = data.water_bottles;
    if (data.took_electrolytes !== undefined) agentUpdate.tookElectrolytes = data.took_electrolytes;
    if (data.drinks_count !== undefined) agentUpdate.drinksCount = data.drinks_count;
    if (data.smoked_weed !== undefined) agentUpdate.smokedWeed = data.smoked_weed;
    if (data.steps !== undefined) agentUpdate.steps = data.steps;
    
    if (Object.keys(agentUpdate).length > 0) {
      await agent.updateHabits(agentUpdate);
    }
  } catch (error) {
    console.error('Failed to update UserAgent:', error);
  }

  return c.json({ success: true, updated: data });
});

// Log a drink
habitsRoutes.post('/:date/drink', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const date = c.req.param('date');
  const { drink_type } = await c.req.json();

  // Get current habits
  const current = await c.env.DB.prepare(`
    SELECT drinks_count, drink_types FROM daily_habits WHERE user_id = ? AND date = ?
  `).bind(userId, date).first();

  let drinkTypes = safeJsonParse(current?.drink_types, []) as Array<{ type: string; count: number }>;
  const existingType = drinkTypes.find((d: { type: string }) => d.type === drink_type);
  
  if (existingType) {
    existingType.count += 1;
  } else {
    drinkTypes.push({ type: drink_type, count: 1 });
  }

  const newCount = (current?.drinks_count as number || 0) + 1;

  await c.env.DB.prepare(`
    INSERT INTO daily_habits (id, user_id, date, drinks_count, drink_types)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET
      drinks_count = ?,
      drink_types = ?,
      updated_at = datetime('now')
  `).bind(
    crypto.randomUUID(),
    userId,
    date,
    newCount,
    JSON.stringify(drinkTypes),
    newCount,
    JSON.stringify(drinkTypes)
  ).run();

  // Update UserAgent
  try {
    const agent = await getAgentByName(c.env.USER_AGENT, userId);
    await agent.updateHabits({ drinksCount: newCount });
  } catch (error) {
    console.error('Failed to update UserAgent habits:', error);
  }
  
  // Also update legacy daily tracker V2
  try {
    const trackerId = c.env.DAILY_TRACKER_V2.idFromName(`${userId}:${date}`);
    const tracker = c.env.DAILY_TRACKER_V2.get(trackerId);
    await tracker.fetch(new Request('http://internal/habits', {
      method: 'POST',
      body: JSON.stringify({ drinks_count: newCount })
    }));
  } catch (error) {
    console.error('Failed to update legacy tracker:', error);
  }

  return c.json({ drinks_count: newCount, drink_types: drinkTypes });
});

// Log water bottle refill (32oz bottles, goal: 3/day)
habitsRoutes.post('/:date/water', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const date = c.req.param('date');
  const { bottles } = await c.req.json();

  const current = await c.env.DB.prepare(`
    SELECT water_bottles FROM daily_habits WHERE user_id = ? AND date = ?
  `).bind(userId, date).first();

  const newCount = (current?.water_bottles as number || 0) + (bottles || 1);

  await c.env.DB.prepare(`
    INSERT INTO daily_habits (id, user_id, date, water_bottles)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET
      water_bottles = ?,
      updated_at = datetime('now')
  `).bind(
    crypto.randomUUID(),
    userId,
    date,
    newCount,
    newCount
  ).run();

  // Update UserAgent
  try {
    const agent = await getAgentByName(c.env.USER_AGENT, userId);
    await agent.updateHabits({ waterBottles: newCount });
  } catch (error) {
    console.error('Failed to update UserAgent habits:', error);
  }
  
  // Also update legacy daily tracker V2
  try {
    const trackerId = c.env.DAILY_TRACKER_V2.idFromName(`${userId}:${date}`);
    const tracker = c.env.DAILY_TRACKER_V2.get(trackerId);
    await tracker.fetch(new Request('http://internal/habits', {
      method: 'POST',
      body: JSON.stringify({ water_bottles: newCount })
    }));
  } catch (error) {
    console.error('Failed to update legacy tracker:', error);
  }

  return c.json({ water_bottles: newCount, goal: 3 });
});

// Toggle electrolytes (LMNT)
habitsRoutes.post('/:date/electrolytes', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const date = c.req.param('date');
  const { took } = await c.req.json();

  await c.env.DB.prepare(`
    INSERT INTO daily_habits (id, user_id, date, took_electrolytes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET
      took_electrolytes = ?,
      updated_at = datetime('now')
  `).bind(
    crypto.randomUUID(),
    userId,
    date,
    took ? 1 : 0,
    took ? 1 : 0
  ).run();

  // Update UserAgent
  try {
    const agent = await getAgentByName(c.env.USER_AGENT, userId);
    await agent.updateHabits({ tookElectrolytes: took });
  } catch (error) {
    console.error('Failed to update UserAgent habits:', error);
  }
  
  // Also update legacy daily tracker V2
  try {
    const trackerId = c.env.DAILY_TRACKER_V2.idFromName(`${userId}:${date}`);
    const tracker = c.env.DAILY_TRACKER_V2.get(trackerId);
    await tracker.fetch(new Request('http://internal/habits', {
      method: 'POST',
      body: JSON.stringify({ took_electrolytes: took })
    }));
  } catch (error) {
    console.error('Failed to update legacy tracker:', error);
  }

  return c.json({ took_electrolytes: took });
});

// Get weekly drinks summary
habitsRoutes.get('/summary/drinks-weekly', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Get start of current week (Sunday)
  const today = new Date();
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay());
  const weekStartStr = weekStart.toISOString().split('T')[0];
  
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);
  const weekEndStr = weekEnd.toISOString().split('T')[0];

  const result = await c.env.DB.prepare(`
    SELECT 
      SUM(drinks_count) as total_drinks,
      COUNT(CASE WHEN drinks_count > 0 THEN 1 END) as days_with_drinks
    FROM daily_habits 
    WHERE user_id = ? AND date >= ? AND date < ?
  `).bind(userId, weekStartStr, weekEndStr).first();

  return c.json({
    week_start: weekStartStr,
    total_drinks: result?.total_drinks || 0,
    days_with_drinks: result?.days_with_drinks || 0
  });
});

// Toggle weed for a day
habitsRoutes.post('/:date/weed', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const date = c.req.param('date');
  const { smoked, notes } = await c.req.json();

  await c.env.DB.prepare(`
    INSERT INTO daily_habits (id, user_id, date, smoked_weed, weed_notes)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET
      smoked_weed = ?,
      weed_notes = ?,
      updated_at = datetime('now')
  `).bind(
    crypto.randomUUID(),
    userId,
    date,
    smoked ? 1 : 0,
    notes || null,
    smoked ? 1 : 0,
    notes || null
  ).run();

  // Update UserAgent
  try {
    const agent = await getAgentByName(c.env.USER_AGENT, userId);
    await agent.updateHabits({ smokedWeed: smoked });
    
    // If they smoked, reset the streak in the agent
    if (smoked) {
      await agent.resetStreak('no_weed');
    }
  } catch (error) {
    console.error('Failed to update UserAgent habits:', error);
  }
  
  // Also update legacy daily tracker V2
  try {
    const trackerId = c.env.DAILY_TRACKER_V2.idFromName(`${userId}:${date}`);
    const tracker = c.env.DAILY_TRACKER_V2.get(trackerId);
    await tracker.fetch(new Request('http://internal/habits', {
      method: 'POST',
      body: JSON.stringify({ smoked_weed: smoked })
    }));
  } catch (error) {
    console.error('Failed to update legacy tracker:', error);
  }

  // If they smoked, reset the streak in legacy streak manager
  if (smoked) {
    try {
      const streakId = c.env.STREAK_MANAGER_V2.idFromName(userId);
      const streakManager = c.env.STREAK_MANAGER_V2.get(streakId);
      await streakManager.fetch(new Request('http://internal/reset', {
        method: 'POST',
        body: JSON.stringify({ type: 'no_weed' })
      }));
    } catch (error) {
      console.error('Failed to update legacy streak manager:', error);
    }
  }

  return c.json({ smoked_weed: smoked });
});
