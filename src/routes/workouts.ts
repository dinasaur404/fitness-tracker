/// <reference types="@cloudflare/workers-types" />

import { Hono } from 'hono';
import { Env } from '../types/env';
import { NutritionCalculator } from '../services/nutrition-calculator';

export const workoutsRoutes = new Hono<{ Bindings: Env }>();

// Barry's schedule
const BARRYS_SCHEDULE: Record<number, string> = {
  0: 'Total Body',      // Sunday
  1: 'Arms & Abs',      // Monday
  2: 'Lower Focus',     // Tuesday
  3: 'Chest/Back',      // Wednesday
  4: 'Abs & Ass',       // Thursday
  5: 'Total Body',      // Friday
  6: 'Upper Focus',     // Saturday
};

// Get today's Barry's class info
workoutsRoutes.get('/barrys/today', async (c) => {
  const today = new Date();
  const dayOfWeek = today.getDay();
  
  return c.json({
    date: today.toISOString().split('T')[0],
    day_name: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek],
    class_focus: BARRYS_SCHEDULE[dayOfWeek],
    schedule: BARRYS_SCHEDULE
  });
});

// Get Barry's workouts for a date range
workoutsRoutes.get('/barrys', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const startDate = c.req.query('start') || new Date().toISOString().split('T')[0];
  const endDate = c.req.query('end') || startDate;

  const workouts = await c.env.DB.prepare(`
    SELECT * FROM barrys_workouts 
    WHERE user_id = ? AND workout_date BETWEEN ? AND ?
    ORDER BY workout_date DESC
  `).bind(userId, startDate, endDate).all();

  return c.json(workouts.results);
});

// Get weekly Barry's summary
workoutsRoutes.get('/barrys/weekly', async (c) => {
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

  const workouts = await c.env.DB.prepare(`
    SELECT * FROM barrys_workouts 
    WHERE user_id = ? AND workout_date >= ? AND workout_date < ?
    ORDER BY workout_date ASC
  `).bind(userId, weekStartStr, weekEndStr).all();

  const completed = workouts.results?.length || 0;
  const goal = 5; // 5 per week target

  // Calculate totals
  const totals = workouts.results?.reduce((acc: { calories: number; strain: number; doubleFloors: number }, w: Record<string, unknown>) => ({
    calories: acc.calories + ((w.calories_burned as number) || 0),
    strain: acc.strain + ((w.strain as number) || 0),
    doubleFloors: acc.doubleFloors + ((w.is_double_floor as number) || 0)
  }), { calories: 0, strain: 0, doubleFloors: 0 });

  return c.json({
    week_start: weekStartStr,
    completed,
    goal,
    remaining: Math.max(0, goal - completed),
    on_track: completed >= Math.floor((today.getDay() / 7) * goal),
    workouts: workouts.results,
    totals: {
      calories_burned: totals?.calories || 0,
      total_strain: totals?.strain || 0,
      double_floor_count: totals?.doubleFloors || 0
    }
  });
});

// Log a Barry's workout
workoutsRoutes.post('/barrys', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const data = await c.req.json();
  const workoutId = crypto.randomUUID();
  
  const workoutDate = data.workout_date || new Date().toISOString().split('T')[0];
  const workoutDay = new Date(workoutDate + 'T12:00:00').getDay();
  const classType = data.class_type || BARRYS_SCHEDULE[workoutDay];
  const isDoubleFloor = !!data.is_double_floor;

  // Try to find matching Whoop workout
  let whoopWorkout = null;
  if (!data.whoop_workout_id) {
    // Look for a workout on this date that might be Barry's
    // Barry's is usually: high strain (8+), 40-60 min, in the morning/afternoon
    // Sport types that could be Barry's: Functional Fitness, HIIT, Bootcamp, Circuit Training
    // Use -8 hours offset for Pacific Time (UTC-8)
    const whoopResult = await c.env.DB.prepare(`
      SELECT * FROM whoop_workouts 
      WHERE user_id = ? 
        AND date(start_time, '-8 hours') = ?
        AND strain >= 8
        AND is_barrys = 1
      ORDER BY strain DESC
      LIMIT 1
    `).bind(userId, workoutDate).first();
    
    // If no explicit Barry's match, try to find any high-strain workout
    if (!whoopResult) {
      // Use -8 hours offset for Pacific Time (UTC-8)
      const anyHighStrain = await c.env.DB.prepare(`
        SELECT * FROM whoop_workouts 
        WHERE user_id = ? 
          AND date(start_time, '-8 hours') = ?
          AND strain >= 10
        ORDER BY strain DESC
        LIMIT 1
      `).bind(userId, workoutDate).first();
      whoopWorkout = anyHighStrain;
    } else {
      whoopWorkout = whoopResult;
    }
  } else {
    whoopWorkout = await c.env.DB.prepare(
      'SELECT * FROM whoop_workouts WHERE id = ?'
    ).bind(data.whoop_workout_id).first();
  }
  
  // If no Whoop data, estimate calories based on historical averages
  let estimatedCalories = null;
  let estimatedStrain = null;
  let isEstimated = false;
  
  if (!whoopWorkout) {
    isEstimated = true;
    
    // Get historical averages for this type of workout
    const historicalAvg = await c.env.DB.prepare(`
      SELECT 
        AVG(calories_burned) as avg_calories,
        AVG(strain) as avg_strain,
        COUNT(*) as workout_count
      FROM barrys_workouts 
      WHERE user_id = ? 
        AND is_double_floor = ?
        AND calories_burned IS NOT NULL
    `).bind(userId, isDoubleFloor ? 1 : 0).first();
    
    if (historicalAvg && (historicalAvg.workout_count as number) >= 3) {
      // Use historical average
      estimatedCalories = Math.round(historicalAvg.avg_calories as number);
      estimatedStrain = Math.round((historicalAvg.avg_strain as number) * 10) / 10;
    } else {
      // Use defaults based on workout type
      if (isDoubleFloor) {
        // Double floor = all strength, typically lower calories
        estimatedCalories = 450;
        estimatedStrain = 12;
      } else {
        // Regular Barry's = cardio + strength
        estimatedCalories = 550;
        estimatedStrain = 14;
      }
    }
  }

  // Determine final values (Whoop > manual input > estimate)
  const finalCalories = whoopWorkout?.calories_burned || data.calories_burned || estimatedCalories;
  const finalStrain = whoopWorkout?.strain || data.strain || estimatedStrain;
  const finalAvgHr = whoopWorkout?.average_heart_rate || data.avg_hr || null;
  const finalMaxHr = whoopWorkout?.max_heart_rate || data.max_hr || null;

  await c.env.DB.prepare(`
    INSERT INTO barrys_workouts (
      id, user_id, whoop_workout_id, studio_name, instructor, class_type,
      is_double_floor, treadmill_miles, floor_focus, personal_notes, rating,
      calories_burned, strain, avg_hr, max_hr, duration_minutes, workout_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    workoutId,
    userId,
    whoopWorkout?.id || data.whoop_workout_id || null,
    data.studio_name || null,
    data.instructor || null,
    classType,
    isDoubleFloor ? 1 : 0,
    data.treadmill_miles || null,
    data.floor_focus || null,
    data.personal_notes || null,
    data.rating || null,
    finalCalories,
    finalStrain,
    finalAvgHr,
    finalMaxHr,
    data.duration_minutes || 50,
    workoutDate
  ).run();

  // Update streak V2
  const streakId = c.env.STREAK_MANAGER_V2.idFromName(userId);
  const streakManager = c.env.STREAK_MANAGER_V2.get(streakId);
  await streakManager.fetch(new Request('http://internal/increment', {
    method: 'POST',
    body: JSON.stringify({ date: workoutDate })
  }));

  // Track analytics
  const analyticsCalories = typeof whoopWorkout?.calories_burned === 'number' 
    ? whoopWorkout.calories_burned 
    : 500;
  c.env.ANALYTICS.writeDataPoint({
    blobs: [userId, 'barrys_logged', classType],
    doubles: [analyticsCalories],
    indexes: [userId]
  });

  // Calculate macro adjustment
  const nutritionCalc = new NutritionCalculator(c.env);
  const defaultGoals = nutritionCalc.calculateDefaultGoals(
    61, // Will be replaced with actual weight from Whoop
    { hasBarrys: true, isDoubleFloor: !!data.is_double_floor }
  );
  const caloriesBurned = typeof whoopWorkout?.calories_burned === 'number' 
    ? whoopWorkout.calories_burned 
    : 500;
  const impact = nutritionCalc.calculatePostWorkoutAdjustment(
    defaultGoals,
    data.is_double_floor ? 'barrys_double_floor' : 'barrys_regular',
    caloriesBurned
  );

  return c.json({
    id: workoutId,
    class_type: classType,
    is_double_floor: isDoubleFloor,
    calories_burned: finalCalories,
    strain: finalStrain,
    is_estimated: isEstimated,
    whoop_matched: !!whoopWorkout,
    whoop_data: whoopWorkout ? {
      calories_burned: whoopWorkout.calories_burned,
      strain: whoopWorkout.strain,
      avg_hr: whoopWorkout.average_heart_rate,
      max_hr: whoopWorkout.max_heart_rate
    } : null,
    macro_adjustment: impact,
    success: true
  });
});

// Update a Barry's workout
workoutsRoutes.put('/barrys/:id', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const workoutId = c.req.param('id');
  const updates = await c.req.json();

  await c.env.DB.prepare(`
    UPDATE barrys_workouts SET
      studio_name = COALESCE(?, studio_name),
      instructor = COALESCE(?, instructor),
      class_type = COALESCE(?, class_type),
      is_double_floor = COALESCE(?, is_double_floor),
      treadmill_miles = COALESCE(?, treadmill_miles),
      personal_notes = COALESCE(?, personal_notes),
      rating = COALESCE(?, rating)
    WHERE id = ? AND user_id = ?
  `).bind(
    updates.studio_name || null,
    updates.instructor || null,
    updates.class_type || null,
    updates.is_double_floor !== undefined ? (updates.is_double_floor ? 1 : 0) : null,
    updates.treadmill_miles || null,
    updates.personal_notes || null,
    updates.rating || null,
    workoutId,
    userId
  ).run();

  return c.json({ success: true });
});

// Delete a Barry's workout
workoutsRoutes.delete('/barrys/:id', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const workoutId = c.req.param('id');
  
  await c.env.DB.prepare(
    'DELETE FROM barrys_workouts WHERE id = ? AND user_id = ?'
  ).bind(workoutId, userId).run();

  return c.json({ success: true });
});

// Delete all today's workouts
workoutsRoutes.delete('/today', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const today = new Date().toISOString().split('T')[0];
  
  // Delete all Barry's workouts for today
  const result = await c.env.DB.prepare(
    'DELETE FROM barrys_workouts WHERE user_id = ? AND workout_date = ?'
  ).bind(userId, today).run();

  return c.json({ success: true, deleted: result.meta.changes });
});

// Get all workouts from Whoop for linking
workoutsRoutes.get('/whoop', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const date = c.req.query('date') || new Date().toISOString().split('T')[0];

  // Use -8 hours offset for Pacific Time (UTC-8)
  const workouts = await c.env.DB.prepare(`
    SELECT * FROM whoop_workouts 
    WHERE user_id = ? AND date(start_time, '-8 hours') = ?
    ORDER BY start_time DESC
  `).bind(userId, date).all();

  return c.json(workouts.results);
});
