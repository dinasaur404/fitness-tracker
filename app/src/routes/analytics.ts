/// <reference types="@cloudflare/workers-types" />

import { Hono } from 'hono';
import { Env } from '../types/env';

export const analyticsRoutes = new Hono<{ Bindings: Env }>();

/**
 * Combined historical analytics endpoint
 * Returns all tracked data for a date range: meals, habits, Whoop data, weight
 */
analyticsRoutes.get('/daily', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const days = parseInt(c.req.query('days') || '30');
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startDateStr = startDate.toISOString().split('T')[0];
  const endDateStr = new Date().toISOString().split('T')[0];

  // Batch all 4 queries into single round trip (saves ~150-300ms)
  const batchResults = await c.env.DB.batch([
    // 0: Meals aggregated by day
    c.env.DB.prepare(`
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
    `).bind(userId, startDateStr),

    // 1: Daily habits
    c.env.DB.prepare(`
      SELECT 
        date,
        drinks_count,
        smoked_weed,
        water_bottles,
        took_electrolytes,
        steps,
        mood_rating,
        energy_rating
      FROM daily_habits 
      WHERE user_id = ? AND date >= ?
      ORDER BY date ASC
    `).bind(userId, startDateStr),

    // 2: Whoop daily data
    c.env.DB.prepare(`
      SELECT 
        date,
        recovery_score,
        hrv_rmssd as hrv,
        resting_heart_rate,
        sleep_performance,
        sleep_duration_minutes,
        day_strain,
        day_calories as calories_burned,
        workout_count,
        weight_kg
      FROM whoop_daily 
      WHERE user_id = ? AND date >= ?
      ORDER BY date ASC
    `).bind(userId, startDateStr),

    // 3: Barry's workouts
    c.env.DB.prepare(`
      SELECT 
        workout_date as date,
        class_type,
        is_double_floor,
        calories_burned,
        strain,
        duration_minutes
      FROM barrys_workouts 
      WHERE user_id = ? AND workout_date >= ?
      ORDER BY workout_date ASC
    `).bind(userId, startDateStr)
  ]);

  type DbRecord = Record<string, unknown>;
  const mealsData = { results: batchResults[0].results as DbRecord[] };
  const habitsData = { results: batchResults[1].results as DbRecord[] };
  const whoopData = { results: batchResults[2].results as DbRecord[] };
  const barrysData = { results: batchResults[3].results as DbRecord[] };

  // Merge all data by date
  const dateMap = new Map<string, {
    date: string;
    // Nutrition
    meal_count?: number;
    total_calories?: number;
    total_protein?: number;
    total_carbs?: number;
    total_fat?: number;
    // Habits
    drinks_count?: number;
    smoked_weed?: boolean;
    water_bottles?: number;
    took_electrolytes?: boolean;
    steps?: number;
    mood_rating?: number;
    energy_rating?: number;
    // Whoop
    recovery_score?: number;
    hrv?: number;
    resting_heart_rate?: number;
    sleep_performance?: number;
    sleep_hours?: number;
    day_strain?: number;
    calories_burned?: number;
    workout_count?: number;
    weight_kg?: number;
    weight_lbs?: number;
    // Barry's
    did_barrys?: boolean;
    barrys_class?: string;
    barrys_double_floor?: boolean;
  }>();

  // Initialize all dates in range
  const current = new Date(startDateStr);
  const end = new Date(endDateStr);
  while (current <= end) {
    dateMap.set(current.toISOString().split('T')[0], { date: current.toISOString().split('T')[0] });
    current.setDate(current.getDate() + 1);
  }

  // Merge meals data
  for (const row of mealsData.results || []) {
    const dateKey = row.date as string;
    const existing = dateMap.get(dateKey) || { date: dateKey };
    dateMap.set(dateKey, {
      ...existing,
      meal_count: row.meal_count as number,
      total_calories: row.total_calories as number,
      total_protein: row.total_protein as number,
      total_carbs: row.total_carbs as number,
      total_fat: row.total_fat as number
    });
  }

  // Merge habits data
  for (const row of habitsData.results || []) {
    const dateKey = row.date as string;
    const existing = dateMap.get(dateKey) || { date: dateKey };
    dateMap.set(dateKey, {
      ...existing,
      drinks_count: row.drinks_count as number,
      smoked_weed: Boolean(row.smoked_weed),
      water_bottles: row.water_bottles as number,
      took_electrolytes: Boolean(row.took_electrolytes),
      steps: row.steps as number,
      mood_rating: row.mood_rating as number,
      energy_rating: row.energy_rating as number
    });
  }

  // Merge Whoop data
  for (const row of whoopData.results || []) {
    const dateKey = row.date as string;
    const existing = dateMap.get(dateKey) || { date: dateKey };
    const weightKg = row.weight_kg as number;
    dateMap.set(dateKey, {
      ...existing,
      recovery_score: row.recovery_score as number,
      hrv: row.hrv as number,
      resting_heart_rate: row.resting_heart_rate as number,
      sleep_performance: row.sleep_performance as number,
      sleep_hours: row.sleep_duration_minutes ? (row.sleep_duration_minutes as number) / 60 : undefined,
      day_strain: row.day_strain as number,
      calories_burned: row.calories_burned as number,
      workout_count: row.workout_count as number,
      weight_kg: weightKg,
      weight_lbs: weightKg ? Math.round(weightKg * 2.205 * 10) / 10 : undefined
    });
  }

  // Merge Barry's data
  for (const row of barrysData.results || []) {
    const dateKey = row.date as string;
    const existing = dateMap.get(dateKey) || { date: dateKey };
    dateMap.set(dateKey, {
      ...existing,
      did_barrys: true,
      barrys_class: row.class_type as string,
      barrys_double_floor: Boolean(row.is_double_floor)
    });
  }

  // Convert to array sorted by date
  const dailyData = Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  return c.json({
    period: { days, start_date: startDateStr, end_date: endDateStr },
    daily_data: dailyData
  });
});

/**
 * Get summary statistics for a period
 */
analyticsRoutes.get('/summary', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const days = parseInt(c.req.query('days') || '30');
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startDateStr = startDate.toISOString().split('T')[0];

  const [nutritionStats, habitStats, whoopStats, barrysStats] = await Promise.all([
    // Nutrition averages
    c.env.DB.prepare(`
      SELECT 
        COUNT(*) as days_logged,
        ROUND(AVG(daily_cal), 0) as avg_calories,
        ROUND(AVG(daily_pro), 1) as avg_protein,
        ROUND(AVG(daily_carb), 1) as avg_carbs,
        ROUND(AVG(daily_fat), 1) as avg_fat
      FROM (
        SELECT 
          date(logged_at) as meal_date,
          SUM(calories) as daily_cal,
          SUM(protein) as daily_pro,
          SUM(carbs) as daily_carb,
          SUM(fat) as daily_fat
        FROM meals 
        WHERE user_id = ? AND date(logged_at) >= ?
        GROUP BY date(logged_at)
      )
    `).bind(userId, startDateStr).first(),

    // Habit statistics
    c.env.DB.prepare(`
      SELECT 
        COUNT(*) as days_tracked,
        SUM(CASE WHEN drinks_count = 0 THEN 1 ELSE 0 END) as alcohol_free_days,
        SUM(CASE WHEN smoked_weed = 0 THEN 1 ELSE 0 END) as weed_free_days,
        ROUND(AVG(water_bottles), 1) as avg_water_bottles,
        SUM(CASE WHEN took_electrolytes = 1 THEN 1 ELSE 0 END) as electrolyte_days,
        ROUND(AVG(steps), 0) as avg_steps
      FROM daily_habits 
      WHERE user_id = ? AND date >= ?
    `).bind(userId, startDateStr).first(),

    // Whoop statistics
    c.env.DB.prepare(`
      SELECT 
        COUNT(*) as days_with_data,
        ROUND(AVG(recovery_score), 0) as avg_recovery,
        ROUND(AVG(hrv_rmssd), 1) as avg_hrv,
        ROUND(AVG(resting_heart_rate), 0) as avg_resting_hr,
        ROUND(AVG(sleep_performance), 0) as avg_sleep_performance,
        ROUND(AVG(sleep_duration_minutes) / 60.0, 1) as avg_sleep_hours,
        ROUND(AVG(day_strain), 1) as avg_strain,
        SUM(workout_count) as total_workouts,
        ROUND(AVG(weight_kg), 1) as avg_weight_kg,
        MIN(weight_kg) as min_weight_kg,
        MAX(weight_kg) as max_weight_kg
      FROM whoop_daily 
      WHERE user_id = ? AND date >= ?
    `).bind(userId, startDateStr).first(),

    // Barry's statistics
    c.env.DB.prepare(`
      SELECT 
        COUNT(*) as total_classes,
        SUM(CASE WHEN is_double_floor = 1 THEN 1 ELSE 0 END) as double_floor_classes,
        ROUND(AVG(calories_burned), 0) as avg_calories_burned,
        ROUND(AVG(strain), 1) as avg_strain,
        ROUND(AVG(duration_minutes), 0) as avg_duration
      FROM barrys_workouts 
      WHERE user_id = ? AND workout_date >= ?
    `).bind(userId, startDateStr).first()
  ]);

  // Calculate weight change
  const weightStats = whoopStats as { avg_weight_kg?: number; min_weight_kg?: number; max_weight_kg?: number } | null;
  let weightChange = null;
  if (weightStats?.min_weight_kg && weightStats?.max_weight_kg) {
    // Get first and last weight in period
    const firstWeight = await c.env.DB.prepare(`
      SELECT weight_kg FROM whoop_daily 
      WHERE user_id = ? AND date >= ? AND weight_kg IS NOT NULL
      ORDER BY date ASC LIMIT 1
    `).bind(userId, startDateStr).first() as { weight_kg: number } | null;
    
    const lastWeight = await c.env.DB.prepare(`
      SELECT weight_kg FROM whoop_daily 
      WHERE user_id = ? AND date >= ? AND weight_kg IS NOT NULL
      ORDER BY date DESC LIMIT 1
    `).bind(userId, startDateStr).first() as { weight_kg: number } | null;

    if (firstWeight && lastWeight) {
      weightChange = {
        start_kg: firstWeight.weight_kg,
        end_kg: lastWeight.weight_kg,
        change_kg: Math.round((lastWeight.weight_kg - firstWeight.weight_kg) * 10) / 10,
        start_lbs: Math.round(firstWeight.weight_kg * 2.205 * 10) / 10,
        end_lbs: Math.round(lastWeight.weight_kg * 2.205 * 10) / 10,
        change_lbs: Math.round((lastWeight.weight_kg - firstWeight.weight_kg) * 2.205 * 10) / 10
      };
    }
  }

  return c.json({
    period: { days, start_date: startDateStr },
    nutrition: nutritionStats,
    habits: habitStats,
    whoop: whoopStats,
    barrys: barrysStats,
    weight_change: weightChange
  });
});

/**
 * Get weight history
 */
analyticsRoutes.get('/weight', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const days = parseInt(c.req.query('days') || '90');
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startDateStr = startDate.toISOString().split('T')[0];

  const weights = await c.env.DB.prepare(`
    SELECT 
      date,
      weight_kg,
      ROUND(weight_kg * 2.205, 1) as weight_lbs
    FROM whoop_daily 
    WHERE user_id = ? AND date >= ? AND weight_kg IS NOT NULL
    ORDER BY date ASC
  `).bind(userId, startDateStr).all();

  return c.json({
    period: { days, start_date: startDateStr },
    weights: weights.results
  });
});

/**
 * Get correlations between habits and outcomes
 * e.g., Does drinking affect recovery score?
 */
analyticsRoutes.get('/correlations', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const days = parseInt(c.req.query('days') || '90');
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startDateStr = startDate.toISOString().split('T')[0];

  // Recovery when drinking vs not drinking
  const drinkingVsRecovery = await c.env.DB.prepare(`
    SELECT 
      CASE WHEN h.drinks_count > 0 THEN 'drank' ELSE 'sober' END as status,
      ROUND(AVG(w.recovery_score), 1) as avg_recovery,
      ROUND(AVG(w.hrv_rmssd), 1) as avg_hrv,
      ROUND(AVG(w.sleep_performance), 1) as avg_sleep,
      COUNT(*) as days
    FROM daily_habits h
    JOIN whoop_daily w ON h.date = w.date AND h.user_id = w.user_id
    WHERE h.user_id = ? AND h.date >= ?
    GROUP BY CASE WHEN h.drinks_count > 0 THEN 'drank' ELSE 'sober' END
  `).bind(userId, startDateStr).all();

  // Recovery when smoking vs not smoking
  const weedVsRecovery = await c.env.DB.prepare(`
    SELECT 
      CASE WHEN h.smoked_weed = 1 THEN 'smoked' ELSE 'clean' END as status,
      ROUND(AVG(w.recovery_score), 1) as avg_recovery,
      ROUND(AVG(w.hrv_rmssd), 1) as avg_hrv,
      ROUND(AVG(w.sleep_performance), 1) as avg_sleep,
      COUNT(*) as days
    FROM daily_habits h
    JOIN whoop_daily w ON h.date = w.date AND h.user_id = w.user_id
    WHERE h.user_id = ? AND h.date >= ?
    GROUP BY CASE WHEN h.smoked_weed = 1 THEN 'smoked' ELSE 'clean' END
  `).bind(userId, startDateStr).all();

  // Barry's day vs non-Barry's day strain/recovery
  const barrysEffect = await c.env.DB.prepare(`
    SELECT 
      CASE WHEN b.id IS NOT NULL THEN 'barrys_day' ELSE 'rest_day' END as day_type,
      ROUND(AVG(w.day_strain), 1) as avg_strain,
      ROUND(AVG(w.day_calories), 0) as avg_calories_burned,
      COUNT(*) as days
    FROM whoop_daily w
    LEFT JOIN barrys_workouts b ON w.date = b.workout_date AND w.user_id = b.user_id
    WHERE w.user_id = ? AND w.date >= ?
    GROUP BY CASE WHEN b.id IS NOT NULL THEN 'barrys_day' ELSE 'rest_day' END
  `).bind(userId, startDateStr).all();

  return c.json({
    period: { days, start_date: startDateStr },
    correlations: {
      alcohol_vs_recovery: drinkingVsRecovery.results,
      weed_vs_recovery: weedVsRecovery.results,
      barrys_effect: barrysEffect.results
    }
  });
});

/**
 * Weekly summary - great for seeing patterns
 */
analyticsRoutes.get('/weekly', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const weeks = parseInt(c.req.query('weeks') || '12');
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - (weeks * 7));
  const startDateStr = startDate.toISOString().split('T')[0];

  // Weekly nutrition
  const weeklyNutrition = await c.env.DB.prepare(`
    SELECT 
      strftime('%Y-W%W', meal_date) as week,
      MIN(meal_date) as week_start,
      COUNT(*) as days_logged,
      ROUND(AVG(daily_cal), 0) as avg_daily_calories,
      ROUND(AVG(daily_pro), 1) as avg_daily_protein
    FROM (
      SELECT 
        date(logged_at) as meal_date,
        SUM(calories) as daily_cal,
        SUM(protein) as daily_pro
      FROM meals 
      WHERE user_id = ? AND date(logged_at) >= ?
      GROUP BY date(logged_at)
    )
    GROUP BY strftime('%Y-W%W', meal_date)
    ORDER BY week ASC
  `).bind(userId, startDateStr).all();

  // Weekly habits
  const weeklyHabits = await c.env.DB.prepare(`
    SELECT 
      strftime('%Y-W%W', date) as week,
      MIN(date) as week_start,
      SUM(CASE WHEN drinks_count = 0 THEN 1 ELSE 0 END) as alcohol_free_days,
      SUM(CASE WHEN smoked_weed = 0 THEN 1 ELSE 0 END) as weed_free_days,
      ROUND(AVG(water_bottles), 1) as avg_water_bottles
    FROM daily_habits 
    WHERE user_id = ? AND date >= ?
    GROUP BY strftime('%Y-W%W', date)
    ORDER BY week ASC
  `).bind(userId, startDateStr).all();

  // Weekly Barry's
  const weeklyBarrys = await c.env.DB.prepare(`
    SELECT 
      strftime('%Y-W%W', workout_date) as week,
      MIN(workout_date) as week_start,
      COUNT(*) as classes_completed
    FROM barrys_workouts 
    WHERE user_id = ? AND workout_date >= ?
    GROUP BY strftime('%Y-W%W', workout_date)
    ORDER BY week ASC
  `).bind(userId, startDateStr).all();

  // Weekly Whoop averages
  const weeklyWhoop = await c.env.DB.prepare(`
    SELECT 
      strftime('%Y-W%W', date) as week,
      MIN(date) as week_start,
      ROUND(AVG(recovery_score), 0) as avg_recovery,
      ROUND(AVG(day_strain), 1) as avg_strain,
      ROUND(AVG(sleep_duration_minutes) / 60.0, 1) as avg_sleep_hours
    FROM whoop_daily 
    WHERE user_id = ? AND date >= ?
    GROUP BY strftime('%Y-W%W', date)
    ORDER BY week ASC
  `).bind(userId, startDateStr).all();

  return c.json({
    period: { weeks, start_date: startDateStr },
    weekly_nutrition: weeklyNutrition.results,
    weekly_habits: weeklyHabits.results,
    weekly_barrys: weeklyBarrys.results,
    weekly_whoop: weeklyWhoop.results
  });
});
