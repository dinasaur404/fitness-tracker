/// <reference types="@cloudflare/workers-types" />

import { Hono } from 'hono';
import { Env } from '../types/env';
import { fetchDOWithRetry } from '../utils/retry';
import { safeJsonParse, simpleHash } from '../utils/error-handling';

export const dashboardRoutes = new Hono<{ Bindings: Env }>();

// User profile constants
const USER_PROFILE = {
  birthday: '1997-12-01',
  heightCm: 170.18, // 5'7"
  isFemale: true,
  goal: 'recomp' as const, // body recomposition - lose fat, gain muscle
};

// Get comprehensive dashboard data
dashboardRoutes.get('/', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const today = new Date().toISOString().split('T')[0];

  try {
    // Batch all D1 queries into a single round trip (saves ~300-600ms)
    const batchResults = await c.env.DB.batch([
      // 0: User with goals and whoop status
      c.env.DB.prepare('SELECT goals, whoop_connected FROM users WHERE id = ?').bind(userId),
      
      // 1: Today's meals summary
      c.env.DB.prepare(`
        SELECT 
          SUM(calories) as total_calories,
          SUM(protein) as total_protein,
          SUM(carbs) as total_carbs,
          SUM(fat) as total_fat,
          COUNT(*) as meal_count
        FROM meals 
        WHERE user_id = ? AND date(logged_at) = ?
      `).bind(userId, today),
      
      // 2: Today's habits
      c.env.DB.prepare(`
        SELECT drinks_count, smoked_weed, water_bottles, mood_rating, energy_rating
        FROM daily_habits WHERE user_id = ? AND date = ?
      `).bind(userId, today),
      
      // 3: Today's workouts from Whoop
      // Use -8 hours offset for Pacific Time (UTC-8)
      c.env.DB.prepare(`
        SELECT 
          COUNT(*) as count,
          SUM(calories_burned) as calories_burned,
          SUM(strain) as total_strain,
          MAX(is_barrys) as did_barrys
        FROM whoop_workouts 
        WHERE user_id = ? AND date(start_time, '-8 hours') = ?
      `).bind(userId, today),
      
      // 4: Latest recovery
      c.env.DB.prepare(`
        SELECT recovery_score, hrv, resting_heart_rate, sleep_performance
        FROM whoop_recovery 
        WHERE user_id = ? 
        ORDER BY date DESC LIMIT 1
      `).bind(userId),
      
      // 5: Recent weight from Whoop
      c.env.DB.prepare(`
        SELECT weight_kg as weight, NULL as body_fat, date as measured_at
        FROM whoop_daily 
        WHERE user_id = ? AND weight_kg IS NOT NULL
        ORDER BY date DESC LIMIT 1
      `).bind(userId),
      
      // 6: Today's Whoop day data (strain, active calories)
      c.env.DB.prepare(`
        SELECT day_strain, day_calories, day_avg_hr
        FROM whoop_daily 
        WHERE user_id = ? AND date = ?
      `).bind(userId, today)
    ]);

    // Extract results (batch returns D1Result[], first() equivalent is results[0])
    // Use Record<string, unknown> for type safety with dynamic DB results
    type DbRecord = Record<string, unknown>;
    const user = (batchResults[0].results[0] as DbRecord) || null;
    const todayMeals = (batchResults[1].results[0] as DbRecord) || null;
    const todayHabits = (batchResults[2].results[0] as DbRecord) || null;
    const todayWorkouts = (batchResults[3].results[0] as DbRecord) || null;
    const recovery = (batchResults[4].results[0] as DbRecord) || null;
    const recentWeight = (batchResults[5].results[0] as DbRecord) || null;
    const todayWhoop = (batchResults[6].results[0] as DbRecord) || null;

    // Fetch streaks from Durable Object (separate, with retry for resilience)
    const streaks = await (async () => {
      try {
        const response = await fetchDOWithRetry(
          c.env.STREAK_MANAGER,
          userId,
          'http://internal/streaks'
        );
        return response.json();
      } catch (error) {
        console.error('Failed to fetch streaks:', error);
        return {}; // Return empty on failure to not break dashboard
      }
    })();

  // Base goals - for body recomp (~135lb, 5'7", age 28)
  // Slight deficit on rest days, maintenance on workout days
  const baseGoals = user?.goals ? JSON.parse(user.goals as string) : {
    daily_calories: 1800,
    daily_protein: 135,
    daily_carbs: 180,
    daily_fat: 60
  };
  
  // Override with hardcoded values for now (until user preferences page)
  const userBaseGoals = {
    daily_calories: 1800,
    daily_protein: 135,
    daily_carbs: 180,
    daily_fat: 60
  };
  
  // Calculate adjusted goals based on workout activity
  // Whoop kilojoules is total daily burn, strain indicates activity level
  const dayStrain = (todayWhoop?.day_strain as number) || 0;
  const didWorkout = (todayWorkouts?.did_barrys === 1) || dayStrain >= 10;
  
  // On workout days: add ~300-400 calories, 20-30g protein
  // Based on strain: light (<8) = +200cal/+15g protein, moderate (8-14) = +300/+25g, high (>14) = +400/+35g
  let calorieBonus = 0;
  let proteinBonus = 0;
  
  if (dayStrain >= 14) {
    calorieBonus = 400;
    proteinBonus = 35;
  } else if (dayStrain >= 10) {
    calorieBonus = 300;
    proteinBonus = 25;
  } else if (dayStrain >= 8 || didWorkout) {
    calorieBonus = 200;
    proteinBonus = 15;
  }
  
  const goals = {
    ...userBaseGoals,
    daily_calories: userBaseGoals.daily_calories + calorieBonus,
    daily_protein: userBaseGoals.daily_protein + proteinBonus,
    // Store adjustment info for frontend
    calorie_bonus: calorieBonus,
    protein_bonus: proteinBonus,
    is_workout_day: didWorkout || dayStrain >= 8
  };

  return c.json({
    date: today,
    
    nutrition: {
      calories: {
        consumed: todayMeals?.total_calories || 0,
        goal: goals.daily_calories,
        remaining: goals.daily_calories - (todayMeals?.total_calories as number || 0),
        percentage: Math.round(((todayMeals?.total_calories as number || 0) / goals.daily_calories) * 100)
      },
      protein: {
        consumed: todayMeals?.total_protein || 0,
        goal: goals.daily_protein,
        remaining: goals.daily_protein - (todayMeals?.total_protein as number || 0),
        percentage: Math.round(((todayMeals?.total_protein as number || 0) / goals.daily_protein) * 100)
      },
      carbs: {
        consumed: todayMeals?.total_carbs || 0,
        goal: goals.daily_carbs,
        percentage: Math.round(((todayMeals?.total_carbs as number || 0) / goals.daily_carbs) * 100)
      },
      fat: {
        consumed: todayMeals?.total_fat || 0,
        goal: goals.daily_fat,
        percentage: Math.round(((todayMeals?.total_fat as number || 0) / goals.daily_fat) * 100)
      },
      meals_logged: todayMeals?.meal_count || 0
    },
    
    fitness: {
      workouts: todayWorkouts?.count || 0,
      calories_burned: todayWorkouts?.calories_burned || 0,
      strain: todayWorkouts?.total_strain || 0,
      day_strain: dayStrain,
      day_calories: (todayWhoop?.day_calories as number) || 0, // Active calories from Whoop
      day_avg_hr: (todayWhoop?.day_avg_hr as number) || 0,
      did_barrys: todayWorkouts?.did_barrys === 1,
      net_calories: (todayMeals?.total_calories as number || 0) - (todayWorkouts?.calories_burned as number || 0)
    },
    
    // Goal adjustment info for frontend
    goal_adjustments: {
      is_workout_day: goals.is_workout_day,
      calorie_bonus: goals.calorie_bonus,
      protein_bonus: goals.protein_bonus,
      base_calories: userBaseGoals.daily_calories,
      base_protein: userBaseGoals.daily_protein
    },
    
    recovery: recovery ? {
      score: recovery.recovery_score,
      hrv: recovery.hrv,
      resting_hr: recovery.resting_heart_rate,
      sleep_performance: recovery.sleep_performance
    } : null,
    
    habits: {
      drinks: todayHabits?.drinks_count || 0,
      smoked: todayHabits?.smoked_weed === 1,
      water: todayHabits?.water_bottles || 0,
      water_goal: 3, // 3 x 32oz bottles = 96oz goal
      mood: todayHabits?.mood_rating,
      energy: todayHabits?.energy_rating
    },
    
    body: recentWeight ? {
      weight: recentWeight.weight,
      body_fat: recentWeight.body_fat,
      measured_at: recentWeight.measured_at
    } : null,
    
    streaks,
    
    // Whoop connection status (for reconnect banner)
    whoop_connected: user?.whoop_connected === 1
  });
  } catch (error) {
    console.error('Dashboard fetch error:', error);
    // Return minimal fallback data on error
    return c.json({
      error: 'Failed to load dashboard',
      date: today,
      nutrition: {
        calories: { consumed: 0, goal: 1800, remaining: 1800, percentage: 0 },
        protein: { consumed: 0, goal: 135, remaining: 135, percentage: 0 },
        carbs: { consumed: 0, goal: 180, percentage: 0 },
        fat: { consumed: 0, goal: 60, percentage: 0 },
        meals_logged: 0
      },
      fitness: { workouts: 0, calories_burned: 0, strain: 0, day_strain: 0, day_calories: 0, day_avg_hr: 0, did_barrys: false, net_calories: 0 },
      goal_adjustments: { is_workout_day: false, calorie_bonus: 0, protein_bonus: 0, base_calories: 1800, base_protein: 135 },
      recovery: null,
      habits: { drinks: 0, smoked: false, water: 0, water_goal: 3, mood: null, energy: null },
      body: null,
      streaks: {},
      whoop_connected: false
    }, 500);
  }
});

// Get weekly summary
dashboardRoutes.get('/weekly', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 7);

  try {
    // Batch all 4 queries into single round trip (saves ~150-300ms)
    const batchResults = await c.env.DB.batch([
      // 0: Daily calorie averages
      c.env.DB.prepare(`
        SELECT 
          date(logged_at) as date,
          SUM(calories) as calories,
          SUM(protein) as protein
        FROM meals 
        WHERE user_id = ? AND logged_at >= ? AND logged_at <= ?
        GROUP BY date(logged_at)
        ORDER BY date
      `).bind(userId, startDate.toISOString(), endDate.toISOString()),
      
      // 1: Workout stats
      // Use -8 hours offset for Pacific Time (UTC-8)
      c.env.DB.prepare(`
        SELECT 
          date(start_time, '-8 hours') as date,
          COUNT(*) as count,
          SUM(calories_burned) as calories,
          SUM(strain) as strain,
          SUM(is_barrys) as barrys_count
        FROM whoop_workouts 
        WHERE user_id = ? AND start_time >= ? AND start_time <= ?
        GROUP BY date(start_time, '-8 hours')
        ORDER BY date
      `).bind(userId, startDate.toISOString(), endDate.toISOString()),
      
      // 2: Habit tracking
      c.env.DB.prepare(`
        SELECT date, drinks_count, smoked_weed, water_bottles
        FROM daily_habits 
        WHERE user_id = ? AND date >= ? AND date <= ?
        ORDER BY date
      `).bind(userId, startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0]),
      
      // 3: Weight trend from Whoop
      c.env.DB.prepare(`
        SELECT weight_kg as weight, NULL as body_fat, date
        FROM whoop_daily 
        WHERE user_id = ? AND date >= ? AND date <= ? AND weight_kg IS NOT NULL
        ORDER BY date
      `).bind(userId, startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0])
    ]);

    type DbRecord = Record<string, unknown>;
    const meals = { results: batchResults[0].results as DbRecord[] };
    const workouts = { results: batchResults[1].results as DbRecord[] };
    const habits = { results: batchResults[2].results as DbRecord[] };
    const weights = { results: batchResults[3].results as DbRecord[] };

    // Calculate averages and totals
    const avgCalories = meals.results?.length 
      ? Math.round(meals.results.reduce((sum: number, m) => sum + (m.calories as number || 0), 0) / meals.results.length)
      : 0;
    
    const avgProtein = meals.results?.length
      ? Math.round(meals.results.reduce((sum: number, m) => sum + (m.protein as number || 0), 0) / meals.results.length)
      : 0;

    const totalWorkouts = workouts.results?.reduce((sum: number, w) => sum + (w.count as number || 0), 0) || 0;
    const totalCaloriesBurned = workouts.results?.reduce((sum: number, w) => sum + (w.calories as number || 0), 0) || 0;
    const barrysCount = workouts.results?.reduce((sum: number, w) => sum + (w.barrys_count as number || 0), 0) || 0;

    const daysWithDrinks = habits.results?.filter(h => (h.drinks_count as number) > 0).length || 0;
    const daysSmoked = habits.results?.filter(h => h.smoked_weed === 1).length || 0;

  return c.json({
    period: {
      start: startDate.toISOString().split('T')[0],
      end: endDate.toISOString().split('T')[0]
    },
    
    nutrition: {
      avg_daily_calories: avgCalories,
      avg_daily_protein: avgProtein,
      daily_data: meals.results
    },
    
    fitness: {
      total_workouts: totalWorkouts,
      total_calories_burned: totalCaloriesBurned,
      barrys_classes: barrysCount,
      daily_data: workouts.results
    },
    
    habits: {
      days_with_drinks: daysWithDrinks,
      days_smoked: daysSmoked,
      sober_days: 7 - daysWithDrinks,
      weed_free_days: 7 - daysSmoked,
      daily_data: habits.results
    },
    
    weight: {
      data_points: weights.results,
      trend: weights.results?.length >= 2
        ? ((weights.results[weights.results.length - 1] as Record<string, unknown>).weight as number) - ((weights.results[0] as Record<string, unknown>).weight as number)
        : null
    }
  });
  } catch (error) {
    console.error('Weekly summary error:', error);
    return c.json({ error: 'Failed to load weekly summary' }, 500);
  }
});

// Get monthly trends
dashboardRoutes.get('/monthly', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 30);

  try {
    // Batch D1 queries into single round trip
    const batchResults = await c.env.DB.batch([
      // 0: Weekly nutrition averages
      c.env.DB.prepare(`
        SELECT 
          strftime('%W', logged_at) as week,
          AVG(calories) as avg_calories,
          AVG(protein) as avg_protein
        FROM (
          SELECT date(logged_at) as day, SUM(calories) as calories, SUM(protein) as protein
          FROM meals 
          WHERE user_id = ? AND logged_at >= ?
          GROUP BY date(logged_at)
        )
        GROUP BY week
        ORDER BY week
      `).bind(userId, startDate.toISOString()),
      
      // 1: Weekly workout counts
      c.env.DB.prepare(`
        SELECT 
          strftime('%W', start_time) as week,
          COUNT(*) as workouts,
          SUM(is_barrys) as barrys
        FROM whoop_workouts 
        WHERE user_id = ? AND start_time >= ?
        GROUP BY week
        ORDER BY week
      `).bind(userId, startDate.toISOString())
    ]);

    const weeklyNutrition = { results: batchResults[0].results };
    const weeklyWorkouts = { results: batchResults[1].results };
    
    // Streak data (from Durable Object with retry) - separate call
    const streakHistory = await (async () => {
      try {
        const response = await fetchDOWithRetry(
          c.env.STREAK_MANAGER,
          userId,
          'http://internal/streaks'
        );
        return response.json();
      } catch (error) {
        console.error('Failed to fetch streaks for monthly:', error);
        return {};
      }
    })();

    return c.json({
      period: '30 days',
      nutrition_trends: weeklyNutrition.results,
      workout_trends: weeklyWorkouts.results,
      streaks: streakHistory
    });
  } catch (error) {
    console.error('Monthly trends error:', error);
    return c.json({ error: 'Failed to load monthly trends' }, 500);
  }
});

// Get achievements
dashboardRoutes.get('/achievements', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Calculate various achievements
  const [stats, streaks] = await Promise.all([
    c.env.DB.prepare(`
      SELECT 
        (SELECT COUNT(*) FROM meals WHERE user_id = ?) as total_meals,
        (SELECT COUNT(*) FROM whoop_workouts WHERE user_id = ?) as total_workouts,
        (SELECT COUNT(*) FROM whoop_workouts WHERE user_id = ? AND is_barrys = 1) as barrys_count,
        (SELECT COUNT(*) FROM progress_photos WHERE user_id = ?) as progress_photos,
        (SELECT COUNT(DISTINCT date) FROM daily_habits WHERE user_id = ? AND smoked_weed = 0) as weed_free_days,
        (SELECT COUNT(DISTINCT date) FROM daily_habits WHERE user_id = ? AND drinks_count = 0) as sober_days
    `).bind(userId, userId, userId, userId, userId, userId).first(),
    
    (async () => {
      try {
        const response = await fetchDOWithRetry(
          c.env.STREAK_MANAGER,
          userId,
          'http://internal/streaks'
        );
        return response.json();
      } catch (error) {
        console.error('Failed to fetch streaks for achievements:', error);
        return {};
      }
    })()
  ]);

  const achievements = [];
  
  // Meal logging achievements
  if ((stats?.total_meals as number) >= 10) achievements.push({ id: 'meals_10', name: 'Getting Started', description: 'Logged 10 meals', icon: '🍽️' });
  if ((stats?.total_meals as number) >= 50) achievements.push({ id: 'meals_50', name: 'Consistent Logger', description: 'Logged 50 meals', icon: '📝' });
  if ((stats?.total_meals as number) >= 100) achievements.push({ id: 'meals_100', name: 'Tracking Pro', description: 'Logged 100 meals', icon: '🏆' });
  
  // Workout achievements
  if ((stats?.total_workouts as number) >= 5) achievements.push({ id: 'workouts_5', name: 'Getting Active', description: 'Completed 5 workouts', icon: '💪' });
  if ((stats?.total_workouts as number) >= 20) achievements.push({ id: 'workouts_20', name: 'Fitness Fanatic', description: 'Completed 20 workouts', icon: '🔥' });
  if ((stats?.barrys_count as number) >= 10) achievements.push({ id: 'barrys_10', name: "Barry's Regular", description: "Completed 10 Barry's classes", icon: '🏃‍♂️' });
  
  // Sobriety achievements (for New Year's resolution!)
  const streakData = streaks as Record<string, { current_count: number; best_count: number }>;
  if (streakData?.no_weed?.current_count >= 7) achievements.push({ id: 'weed_free_week', name: 'One Week Strong', description: '7 days without cannabis', icon: '🌟' });
  if (streakData?.no_weed?.current_count >= 30) achievements.push({ id: 'weed_free_month', name: 'Month of Clarity', description: '30 days without cannabis', icon: '🎯' });
  if (streakData?.no_weed?.best_count >= 30) achievements.push({ id: 'weed_free_best_month', name: 'Personal Best', description: 'Best streak: 30+ days weed-free', icon: '🏅' });

  return c.json({
    achievements,
    stats: {
      total_meals: stats?.total_meals,
      total_workouts: stats?.total_workouts,
      barrys_classes: stats?.barrys_count,
      progress_photos: stats?.progress_photos,
      weed_free_days: stats?.weed_free_days,
      sober_days: stats?.sober_days
    },
    streaks
  });
});

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

// Get AI-powered daily insights with dynamic macro goals and personalized advice
// Cached for 5 minutes to reduce AI calls
dashboardRoutes.get('/insights', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const hour = today.getHours();
  const dayOfWeek = today.getDay();
  
  // Check cache first (cache key includes hour to refresh periodically)
  const cacheKey = `insights:${userId}:${todayStr}:${hour}`;
  const cached = await c.env.CACHE.get(cacheKey);
  if (cached) {
    return c.json(JSON.parse(cached));
  }
  const barrysClassToday = BARRYS_SCHEDULE[dayOfWeek];

  // Calculate age
  const birthday = new Date(USER_PROFILE.birthday);
  const age = today.getFullYear() - birthday.getFullYear() - 
    (today.getMonth() < birthday.getMonth() || 
    (today.getMonth() === birthday.getMonth() && today.getDate() < birthday.getDate()) ? 1 : 0);

  // Batch all 8 D1 queries into single round trip (saves ~350-700ms)
  type DbRecord = Record<string, unknown>;
  const batchResults = await c.env.DB.batch([
    // 0: Today's Whoop data (strain, calories, etc)
    c.env.DB.prepare(`
      SELECT * FROM whoop_daily WHERE user_id = ? AND date = ?
    `).bind(userId, todayStr),
    
    // 1: Recent recovery scores (last 7 days)
    c.env.DB.prepare(`
      SELECT date, recovery_score, hrv_rmssd, resting_heart_rate, sleep_duration_minutes
      FROM whoop_daily 
      WHERE user_id = ? AND recovery_score IS NOT NULL
      ORDER BY date DESC LIMIT 7
    `).bind(userId),
    
    // 2: Recent workouts (last 7 days)
    // Use -8 hours offset for Pacific Time (UTC-8)
    c.env.DB.prepare(`
      SELECT date(start_time, '-8 hours') as date, sport_name, strain, calories_burned, is_barrys
      FROM whoop_workouts 
      WHERE user_id = ? AND start_time >= date('now', '-7 days')
      ORDER BY start_time DESC
    `).bind(userId),
    
    // 3: Today's habits
    c.env.DB.prepare(`
      SELECT drinks_count, water_bottles, took_electrolytes
      FROM daily_habits WHERE user_id = ? AND date = ?
    `).bind(userId, todayStr),
    
    // 4: Yesterday's habits (for "drank last night" detection)
    c.env.DB.prepare(`
      SELECT drinks_count FROM daily_habits 
      WHERE user_id = ? AND date = date('now', '-1 day')
    `).bind(userId),
    
    // 5: This week's workout count
    // Use -8 hours offset for Pacific Time (UTC-8)
    c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM whoop_workouts 
      WHERE user_id = ? AND date(start_time, '-8 hours') >= date('now', 'weekday 0', '-7 days')
    `).bind(userId),
    
    // 6: Average sleep last 7 days
    c.env.DB.prepare(`
      SELECT AVG(sleep_duration_minutes) as avg_sleep
      FROM whoop_daily 
      WHERE user_id = ? AND sleep_duration_minutes IS NOT NULL
      ORDER BY date DESC LIMIT 7
    `).bind(userId),
    
    // 7: Current weight
    c.env.DB.prepare(`
      SELECT weight_kg FROM whoop_daily 
      WHERE user_id = ? AND weight_kg IS NOT NULL 
      ORDER BY date DESC LIMIT 1
    `).bind(userId)
  ]);

  // Extract results from batch
  const todayWhoop = (batchResults[0].results[0] as DbRecord) || null;
  const recentRecovery = { results: batchResults[1].results as DbRecord[] };
  const recentWorkouts = { results: batchResults[2].results as DbRecord[] };
  const todayHabits = (batchResults[3].results[0] as DbRecord) || null;
  const yesterdayHabits = (batchResults[4].results[0] as DbRecord) || null;
  const weekWorkoutCount = (batchResults[5].results[0] as DbRecord) || null;
  const recentSleepAvg = (batchResults[6].results[0] as DbRecord) || null;
  const weightData = (batchResults[7].results[0] as DbRecord) || null;

  // Process the data
  const weightKg = (weightData?.weight_kg as number) || 61.2; // ~135 lbs default
  const weightLbs = Math.round(weightKg * 2.205);
  
  const todayRecovery = (todayWhoop?.recovery_score as number) || null;
  const todayStrain = (todayWhoop?.day_strain as number) || 0;
  const todayCaloriesBurned = (todayWhoop?.day_calories as number) || 0;
  
  const recentRecoveryScores = (recentRecovery.results || []).map(r => r.recovery_score as number);
  const avgRecovery = recentRecoveryScores.length > 0 
    ? Math.round(recentRecoveryScores.reduce((a, b) => a + b, 0) / recentRecoveryScores.length)
    : null;
  
  const consecutiveWorkoutDays = countConsecutiveWorkoutDays(recentWorkouts.results || []);
  const drankLastNight = ((yesterdayHabits?.drinks_count as number) || 0) > 0;
  const drinksLastNight = (yesterdayHabits?.drinks_count as number) || 0;
  const avgSleepHours = recentSleepAvg?.avg_sleep ? Math.round((recentSleepAvg.avg_sleep as number) / 60 * 10) / 10 : null;
  const weekWorkouts = (weekWorkoutCount?.count as number) || 0;
  
  // Check if there's a Barry's workout logged today
  const didBarrysToday = (recentWorkouts.results || []).some(
    w => w.is_barrys === 1 && w.date === todayStr
  );

  // Build context for AI
  const contextData = {
    user: {
      age,
      weightKg,
      weightLbs,
      heightCm: USER_PROFILE.heightCm,
      isFemale: USER_PROFILE.isFemale,
      goal: USER_PROFILE.goal
    },
    today: {
      dayOfWeek: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek],
      barrysClass: barrysClassToday,
      recovery: todayRecovery,
      strain: todayStrain,
      caloriesBurned: todayCaloriesBurned,
      didBarrys: didBarrysToday,
      drankLastNight,
      drinksLastNight
    },
    recent: {
      avgRecovery,
      consecutiveWorkoutDays,
      weekWorkouts,
      avgSleepHours,
      recentRecoveryTrend: recentRecoveryScores.slice(0, 3) // last 3 days
    }
  };

  // Call AI for dynamic calculations and advice
  const cfToken = c.env.CF_API_TOKEN;
  if (!cfToken) {
    console.warn('CF_API_TOKEN not set, using fallback');
  }
  
  try {
    if (!cfToken) throw new Error('No API token');
    const aiResponse = await callAIForInsights(cfToken, contextData);
    
    const result = {
      success: true,
      date: todayStr,
      
      // Dynamic macro goals from AI
      goals: aiResponse.goals,
      
      // Personalized advice
      advice: aiResponse.advice,
      
      // Context data (for transparency)
      context: {
        weight_lbs: weightLbs,
        recovery: todayRecovery,
        avg_recovery_7d: avgRecovery,
        consecutive_workout_days: consecutiveWorkoutDays,
        week_workouts: weekWorkouts,
        barrys_today: barrysClassToday,
        did_barrys: didBarrysToday,
        drank_last_night: drankLastNight,
        avg_sleep_hours: avgSleepHours
      }
    };
    
    // Cache the result for 5 minutes
    await c.env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 300 });
    
    return c.json(result);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('AI insights failed:', errMsg);
    
    // Fallback to calculated defaults
    const fallbackGoals = calculateFallbackGoals(weightKg, didBarrysToday, todayCaloriesBurned);
    
    // Smarter workout recommendation based on recovery
    let workoutAdvice: string;
    let workoutRec: string;
    if (didBarrysToday) {
      workoutAdvice = `Great job on Barry's ${barrysClassToday}! Focus on protein to maximize recovery.`;
      workoutRec = 'done';
    } else if (todayRecovery && todayRecovery < 34) {
      workoutAdvice = `Recovery is only ${todayRecovery}% - consider pilates or a rest day instead of Barry's.`;
      workoutRec = 'pilates_or_rest';
    } else if (todayRecovery && todayRecovery < 67) {
      workoutAdvice = `${todayRecovery}% recovery - Barry's ${barrysClassToday} is fine, but listen to your body.`;
      workoutRec = 'moderate';
    } else {
      workoutAdvice = `Today is ${barrysClassToday} at Barry's. You got this!`;
      workoutRec = 'go';
    }
    
    const fallbackResult = {
      success: true,
      date: todayStr,
      goals: fallbackGoals,
      advice: {
        primary: workoutAdvice,
        tips: [
          'Aim for 1g protein per pound of bodyweight',
          'Stay hydrated - 3 water bottles minimum',
          todayRecovery && todayRecovery < 34 ? 'Low recovery = prioritize rest and nutrition' : 'Protein within 30 min of workout'
        ],
        workout_recommendation: workoutRec
      },
      context: {
        weight_lbs: weightLbs,
        recovery: todayRecovery,
        barrys_today: barrysClassToday,
        did_barrys: didBarrysToday
      },
      ai_fallback: true,
      ai_error: errMsg
    };
    
    // Cache fallback result too (shorter TTL since it's not AI-generated)
    await c.env.CACHE.put(cacheKey, JSON.stringify(fallbackResult), { expirationTtl: 120 });
    
    return c.json(fallbackResult);
  }
});

// Helper: Count consecutive workout days
function countConsecutiveWorkoutDays(workouts: Record<string, unknown>[]): number {
  if (!workouts.length) return 0;
  
  const workoutDates = new Set(workouts.map(w => w.date as string));
  let count = 0;
  const today = new Date();
  
  for (let i = 0; i < 14; i++) {
    const checkDate = new Date(today);
    checkDate.setDate(today.getDate() - i);
    const dateStr = checkDate.toISOString().split('T')[0];
    
    if (workoutDates.has(dateStr)) {
      count++;
    } else if (i > 0) {
      // Break if we find a gap (but don't count today as a gap)
      break;
    }
  }
  
  return count;
}

// Helper: Calculate fallback goals without AI
function calculateFallbackGoals(weightKg: number, didBarrys: boolean, caloriesBurned: number) {
  const weightLbs = weightKg * 2.205;
  
  // Base TDEE using Mifflin-St Jeor
  const bmr = 10 * weightKg + 6.25 * 170.18 - 5 * 27 - 161; // Female formula
  const activityMultiplier = didBarrys ? 1.6 : 1.3;
  let tdee = Math.round(bmr * activityMultiplier);
  
  // Add back workout calories on training days
  if (didBarrys && caloriesBurned > 0) {
    tdee += Math.round(caloriesBurned * 0.25);
  }
  
  // Slight deficit on rest days for recomp
  const calories = didBarrys ? tdee : tdee - 150;
  
  // Macros for body recomp
  const protein = Math.round(weightLbs * 1); // 1g per lb
  const fat = Math.round(weightLbs * 0.35);
  const proteinCals = protein * 4;
  const fatCals = fat * 9;
  const carbs = Math.round(Math.max((calories - proteinCals - fatCals) / 4, 100));
  
  return {
    calories,
    protein,
    carbs,
    fat,
    fiber: 28,
    water_bottles: 3,
    reasoning: didBarrys 
      ? `Barry's day: Higher calories to fuel performance and recovery`
      : `Rest day: Slight deficit for body recomposition`
  };
}

// Context type for AI insights
interface InsightsContext {
  user: {
    age: number;
    weightKg: number;
    weightLbs: number;
    heightCm: number;
    isFemale: boolean;
    goal: string;
  };
  today: {
    dayOfWeek: string;
    barrysClass: string;
    recovery: number | null;
    strain: number;
    caloriesBurned: number;
    didBarrys: boolean;
    drankLastNight: boolean;
    drinksLastNight: number;
  };
  recent: {
    avgRecovery: number | null;
    consecutiveWorkoutDays: number;
    weekWorkouts: number;
    avgSleepHours: number | null;
    recentRecoveryTrend: number[];
  };
}

// Get conversational daily summary
dashboardRoutes.get('/summary', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Get user's local date and time from query params (frontend sends these)
  const clientDate = c.req.query('date'); // YYYY-MM-DD
  const clientHour = c.req.query('hour'); // 0-23
  
  const todayStr = clientDate || new Date().toISOString().split('T')[0];
  const hour = clientHour ? parseInt(clientHour) : new Date().getHours();
  
  // Parse the date to get day of week
  const todayDate = new Date(todayStr + 'T12:00:00Z');
  const dayOfWeek = todayDate.getDay();
  const barrysClassToday = BARRYS_SCHEDULE[dayOfWeek];

  // Batch all 8 D1 queries into single round trip (saves ~300-600ms)
  type DbRecord = Record<string, unknown>;
  const batchResults = await c.env.DB.batch([
    // 0: Today's Whoop data
    c.env.DB.prepare(`
      SELECT recovery_score, day_strain, sleep_duration_minutes, sleep_performance
      FROM whoop_daily WHERE user_id = ? AND date = ?
    `).bind(userId, todayStr),
    
    // 1: Today's meals summary
    c.env.DB.prepare(`
      SELECT SUM(calories) as calories, SUM(protein) as protein, SUM(carbs) as carbs, SUM(fat) as fat, COUNT(*) as count
      FROM meals WHERE user_id = ? AND date(logged_at) = ?
    `).bind(userId, todayStr),
    
    // 2: Individual meals for AI analysis
    c.env.DB.prepare(`
      SELECT name, meal_type, calories, protein, carbs, fat, description
      FROM meals WHERE user_id = ? AND date(logged_at) = ?
      ORDER BY logged_at
    `).bind(userId, todayStr),
    
    // 3: Today's habits
    c.env.DB.prepare(`
      SELECT drinks_count, water_bottles FROM daily_habits
      WHERE user_id = ? AND date = ?
    `).bind(userId, todayStr),
    
    // 4: Today's Barry's workouts
    c.env.DB.prepare(`
      SELECT COUNT(*) as count, SUM(calories_burned) as calories
      FROM barrys_workouts WHERE user_id = ? AND workout_date = ?
    `).bind(userId, todayStr),
    
    // 5: Yesterday's habits (including tomorrow_workout which is today's planned workout)
    c.env.DB.prepare(`
      SELECT drinks_count, tomorrow_workout FROM daily_habits
      WHERE user_id = ? AND date = date(?, '-1 day')
    `).bind(userId, todayStr),
    
    // 6: User goals
    c.env.DB.prepare('SELECT goals FROM users WHERE id = ?').bind(userId),
    
    // 7: Today's actual workouts from Whoop (not just Barry's)
    c.env.DB.prepare(`
      SELECT sport_name, calories_burned, strain, is_barrys
      FROM whoop_workouts 
      WHERE user_id = ? AND date(start_time) = ?
      ORDER BY start_time DESC
      LIMIT 5
    `).bind(userId, todayStr)
  ]);

  // Extract results from batch
  const todayWhoop = (batchResults[0].results[0] as DbRecord) || null;
  const todayMeals = (batchResults[1].results[0] as DbRecord) || null;
  const todayMealsList = { results: batchResults[2].results as DbRecord[] };
  const todayHabits = (batchResults[3].results[0] as DbRecord) || null;
  const todayBarrys = (batchResults[4].results[0] as DbRecord) || null;
  const yesterdayHabits = (batchResults[5].results[0] as DbRecord) || null;
  const user = (batchResults[6].results[0] as DbRecord) || null;
  const todayWhoopWorkouts = batchResults[7].results as DbRecord[] || [];

  // Parse data
  const recovery = todayWhoop?.recovery_score as number | null;
  const sleepMins = todayWhoop?.sleep_duration_minutes as number | null;
  const sleepHours = sleepMins ? Math.round(sleepMins / 60 * 10) / 10 : null;
  const sleepPerf = todayWhoop?.sleep_performance as number | null;
  const strain = todayWhoop?.day_strain as number || 0;
  
  const caloriesConsumed = Math.round((todayMeals?.calories as number) || 0);
  const proteinConsumed = Math.round((todayMeals?.protein as number) || 0);
  const mealsLogged = (todayMeals?.count as number) || 0;
  
  const didBarrys = ((todayBarrys?.count as number) || 0) > 0;
  const barrysCals = (todayBarrys?.calories as number) || 0;
  
  // Get actual workout(s) done today from Whoop data
  const actualWorkouts = todayWhoopWorkouts.map(w => ({
    name: w.sport_name as string,
    calories: w.calories_burned as number,
    strain: w.strain as number,
    isBarrys: w.is_barrys === 1
  }));
  const didWorkout = actualWorkouts.length > 0;
  const mainWorkout = actualWorkouts[0]; // Most recent workout
  const actualWorkoutName = mainWorkout?.name || null;
  const actualWorkoutCals = mainWorkout?.calories || 0;
  
  const drankLastNight = ((yesterdayHabits?.drinks_count as number) || 0) > 0;
  const drinksLastNight = (yesterdayHabits?.drinks_count as number) || 0;
  const waterToday = (todayHabits?.water_bottles as number) || 0;
  const plannedWorkout = (yesterdayHabits?.tomorrow_workout as string) || null; // e.g. 'barrys_regular', 'pilates', 'rest'
  
  // Use hardcoded goals for now (same as main dashboard)
  const goals = {
    daily_calories: 1800,
    daily_protein: 135
  };

  // Build a time-appropriate summary
  let message = '';
  let tip = '';
  
  const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  
  // Morning summary (before noon)
  if (hour < 12) {
    // Determine today's workout context
    const workoutLabels: Record<string, string> = {
      'barrys_regular': `Barry's ${barrysClassToday}`,
      'barrys_double': `Barry's ${barrysClassToday} (double floor)`,
      'pilates': 'Pilates',
      'other': 'your workout',
      'rest': 'rest day'
    };
    const plannedLabel = plannedWorkout ? workoutLabels[plannedWorkout] || plannedWorkout : null;
    const isHighIntensityPlanned = plannedWorkout?.includes('barrys');
    const isRestOrLowIntensity = plannedWorkout === 'rest' || plannedWorkout === 'pilates';
    
    if (drankLastNight) {
      message = `Morning! You had ${drinksLastNight} drink${drinksLastNight > 1 ? 's' : ''} last night. `;
      if (recovery && recovery < 50) {
        message += `Recovery is ${recovery}% - take it easy today. `;
      }
      message += `Hydrate extra and eat clean today.`;
      tip = 'Start with a big glass of water and electrolytes before coffee.';
    } else if (recovery && recovery > 0) {
      if (recovery >= 67) {
        // High recovery - encourage the planned workout or suggest Barry's
        if (plannedLabel) {
          message = `Good morning! You're at ${recovery}% recovery - perfect for ${plannedLabel}!`;
        } else {
          message = `Good morning! You're at ${recovery}% recovery - great day to crush Barry's ${barrysClassToday}!`;
        }
        tip = 'High recovery = push harder today. Aim for that green strain zone.';
      } else if (recovery >= 34) {
        // Moderate recovery - support their plan or suggest moderate effort
        if (plannedLabel) {
          message = `Morning! ${recovery}% recovery today. ${isRestOrLowIntensity ? `Good call on ${plannedLabel}!` : `Moderate effort at ${plannedLabel} would be ideal.`}`;
        } else {
          message = `Morning! ${recovery}% recovery today. Moderate effort at Barry's ${barrysClassToday} would be ideal.`;
        }
        tip = isRestOrLowIntensity 
          ? 'Smart choice matching your workout to your recovery.'
          : 'Yellow recovery means listen to your body - don\'t skip but don\'t overdo it.';
      } else {
        // Low recovery - suggest rest or low intensity
        if (isRestOrLowIntensity) {
          message = `Morning. Recovery is ${recovery}% - smart choice planning ${plannedLabel} today!`;
          tip = plannedWorkout === 'pilates' 
            ? 'Pilates is perfect for low recovery days - builds strength without overtaxing your body.'
            : 'Rest days are when you actually get stronger. Embrace it!';
        } else if (isHighIntensityPlanned) {
          message = `Morning. Recovery is only ${recovery}% - you planned Barry's but consider pilates or rest instead.`;
          tip = 'Low recovery + high intensity = injury risk. Swap to pilates or rest today.';
        } else {
          message = `Morning. Recovery is only ${recovery}% - consider a rest day or pilates.`;
          tip = 'Red recovery = prioritize sleep and nutrition. Light movement like pilates is okay.';
        }
      }
    } else if (sleepHours) {
      message = `Good morning! You got ${sleepHours} hours of sleep${sleepPerf ? ` (${sleepPerf}% performance)` : ''}. `;
      if (plannedLabel) {
        message += `${plannedLabel} on the schedule today.`;
      } else {
        message += `Today's Barry's class is ${barrysClassToday}.`;
      }
      tip = sleepHours >= 7 ? 'Solid sleep - you\'re ready to perform!' : 'Sleep was a bit short - consider lighter workout.';
    } else {
      // No recovery or sleep data
      if (plannedLabel) {
        message = `Good morning! ${plannedLabel} on the schedule. Let's make it a great day!`;
      } else {
        message = `Good morning! Today's Barry's class is ${barrysClassToday}. Let's make it a great day!`;
      }
      tip = 'Start your day with protein to set up your nutrition.';
    }
  }
  // Afternoon summary
  else if (hour < 17) {
    // Check planned workout context for afternoon
    const workoutLabels: Record<string, string> = {
      'barrys_regular': `Barry's ${barrysClassToday}`,
      'barrys_double': `Barry's ${barrysClassToday} (double floor)`,
      'pilates': 'Pilates',
      'other': 'your workout',
      'rest': 'rest day'
    };
    const plannedLabel = plannedWorkout ? workoutLabels[plannedWorkout] || plannedWorkout : null;
    const isRestDay = plannedWorkout === 'rest';
    const isPilatesDay = plannedWorkout === 'pilates';
    
    if (didWorkout) {
      // Priority: 1) Planned workout from app, 2) Whoop workout name (if not generic "Activity"), 3) Barry's schedule if is_barrys
      const workoutDisplay = plannedLabel || 
        (actualWorkoutName && actualWorkoutName !== 'Activity' ? actualWorkoutName : null) || 
        (didBarrys ? `Barry's ${barrysClassToday}` : 'your workout');
      const calsDisplay = actualWorkoutCals || barrysCals;
      
      message = `Good job starting the day with ${workoutDisplay}${calsDisplay ? ` (~${calsDisplay} cal burned)` : ''}. `;
      const proteinRemaining = goals.daily_protein - proteinConsumed;
      if (proteinRemaining > 40) {
        message += `Still ${proteinRemaining}g protein short.`;
        tip = 'Post-workout is prime time for protein. Have a shake or protein-rich meal soon.';
      } else if (proteinRemaining > 0) {
        message += `Almost hit your protein goal - just ${proteinRemaining}g to go!`;
        tip = 'You\'re doing great on protein - keep it up with dinner.';
      } else {
        message += `You've hit your protein goal! Focus on recovery now.`;
        tip = 'Protein goal crushed! Make sure you\'re hydrating and resting.';
      }
    } else {
      message = mealsLogged > 0 
        ? `${mealsLogged} meal${mealsLogged > 1 ? 's' : ''} logged so far (${caloriesConsumed} cal, ${proteinConsumed}g protein). `
        : `No meals logged yet today. `;
      
      if (isRestDay) {
        message += 'Rest day - focus on nutrition and recovery.';
        tip = 'Rest days are when you actually get stronger. Embrace it!';
      } else if (isPilatesDay) {
        message += 'Pilates day - great for active recovery!';
        tip = 'Low-impact movement helps with recovery while building core strength.';
      } else if (!recovery || recovery >= 34) {
        if (plannedLabel) {
          message += `Still time for ${plannedLabel}!`;
        } else {
          message += 'Still time for a workout!';
        }
        tip = 'Afternoon workouts can be less crowded. Get that movement in!';
      } else {
        // Low recovery and no workout done
        message += 'Low recovery day - rest or light pilates would be smart.';
        tip = 'Listen to your body. Light movement or rest is okay.';
      }
    }
  }
  // Evening summary - AI-powered analysis of actual meals (cached 15min)
  else {
    const carbsConsumed = Math.round((todayMeals?.carbs as number) || 0);
    const fatConsumed = Math.round((todayMeals?.fat as number) || 0);
    const calOver = caloriesConsumed - goals.daily_calories;
    const protRemaining = goals.daily_protein - proteinConsumed;
    const meals = todayMealsList?.results || [];
    
    // Planned workout labels (for evening we need these too)
    const workoutLabels: Record<string, string> = {
      'barrys_regular': `Barry's ${barrysClassToday}`,
      'barrys_double': `Barry's ${barrysClassToday} (double floor)`,
      'pilates': 'Pilates',
      'other': 'your workout',
      'rest': 'rest day'
    };
    const plannedLabel = plannedWorkout ? workoutLabels[plannedWorkout] || plannedWorkout : null;
    
    // Tomorrow's info
    const tomorrowDayOfWeek = (dayOfWeek + 1) % 7;
    const tomorrowClass = BARRYS_SCHEDULE[tomorrowDayOfWeek];
    
    // If we have meals and are over calories, use AI for specific feedback
    if (meals.length > 0 && calOver > 100) {
      console.log(`Evening summary: ${meals.length} meals, ${calOver} cal over - triggering AI analysis`);
      
      // Check cache first (includes meal count to invalidate when meals change)
      const eveningCacheKey = `summary:evening:${userId}:${todayStr}:${mealsLogged}:${caloriesConsumed}`;
      const cachedEvening = await c.env.CACHE.get(eveningCacheKey);
      if (cachedEvening) {
        console.log('Evening summary CACHE HIT');
        const cached = JSON.parse(cachedEvening);
        message = cached.message;
        tip = cached.tip;
      } else {
        try {
          const cfToken = c.env.CF_API_TOKEN;
          if (cfToken) {
            console.log('CF_API_TOKEN found, calling AI...');
            const aiSummary = await generateAIEveningSummary(cfToken, {
            // Workout data
            didBarrys,
            barrysClass: barrysClassToday,
            caloriesBurned: barrysCals,
            strain,
            
            // Recovery & Sleep
            recovery,
            sleepHours,
            sleepPerformance: sleepPerf,
            
            // Meals
            meals: meals.map(m => ({
              name: m.name as string,
              meal_type: m.meal_type as string,
              calories: m.calories as number,
              protein: m.protein as number,
              carbs: m.carbs as number,
              fat: m.fat as number
            })),
            
            // Goals & Totals
            goals: { calories: goals.daily_calories, protein: goals.daily_protein, carbs: 180, fat: 60 },
            totals: { calories: caloriesConsumed, protein: proteinConsumed, carbs: carbsConsumed, fat: fatConsumed },
            
            // Habits
            waterBottles: waterToday,
            drankLastNight,
            drinksLastNight,
            
            // Tomorrow
            tomorrowClass
          });
          
            if (aiSummary) {
              message = aiSummary.message;
              tip = aiSummary.tip;
              // Cache the AI result for 15 minutes
              await c.env.CACHE.put(eveningCacheKey, JSON.stringify(aiSummary), { expirationTtl: 900 });
              console.log('Evening summary cached for 15min');
            }
          }
        } catch (error) {
          console.error('AI evening summary failed:', error);
        }
      } // end cache miss block
    }
    
    // Fallback if AI didn't run or failed
    if (!message) {
      const hitProtein = protRemaining <= 0;
      const isOverCalories = calOver > goals.daily_calories * 0.1;
      
      // Workout status - prioritize planned workout, then Whoop (if not generic), then Barry's
      if (didWorkout) {
        const workoutDisplay = plannedLabel || 
          (actualWorkoutName && actualWorkoutName !== 'Activity' ? actualWorkoutName : null) || 
          (didBarrys ? `Barry's ${barrysClassToday}` : 'your workout');
        message = `Good job starting the day with ${workoutDisplay}. `;
      } else {
        message = 'Rest day. ';
      }
      
      // Nutrition status
      if (hitProtein && !isOverCalories) {
        message += 'Hit your protein goal and stayed within calories - great day!';
      } else if (hitProtein && isOverCalories) {
        message += `Hit protein (${proteinConsumed}g) but went ${Math.round(calOver)} cal over goal.`;
      } else if (!hitProtein) {
        message += `Still ${protRemaining}g protein short.`;
      }
      
      // Default tip
      if (tomorrowClass) {
        tip = `Tomorrow is Barry's ${tomorrowClass}. ${isOverCalories ? 'Eat lighter to balance today.' : 'Get good rest!'}`;
      } else {
        tip = 'Rest day tomorrow. Focus on recovery and meal prep.';
      }
    }
  }

  return c.json({
    success: true,
    summary: {
      message,
      tip,
      time_of_day: timeOfDay
    },
    data: {
      recovery,
      strain,
      sleep_hours: sleepHours,
      did_barrys: didBarrys,
      calories_consumed: caloriesConsumed,
      protein_consumed: proteinConsumed,
      meals_logged: mealsLogged,
      water_bottles: waterToday,
      drank_last_night: drankLastNight
    }
  });
});

// Helper: Call AI for comprehensive insights
async function callAIForInsights(cfApiToken: string, context: InsightsContext) {
  const AI_GATEWAY_URL = 'https://gateway.ai.cloudflare.com/v1/ede31cad5fa379850e090febbeaba602/ai-playground/compat/chat/completions';
  
  const prompt = `You are a sports nutritionist. Calculate daily macros for this user:

USER: ${context.user.age}yo female, ${context.user.weightLbs}lbs, goal: body recomposition (lose fat, gain muscle)

TODAY (${context.today.dayOfWeek}):
- Barry's Bootcamp class: ${context.today.barrysClass}
- Already worked out: ${context.today.didBarrys ? 'yes' : 'no'}
- Recovery score: ${context.today.recovery || 'unknown'}
- Drank alcohol last night: ${context.today.drankLastNight ? 'yes, ' + context.today.drinksLastNight + ' drinks' : 'no'}

RECENT STATS:
- Average recovery: ${context.recent.avgRecovery || 'unknown'}%
- Consecutive workout days: ${context.recent.consecutiveWorkoutDays}
- Workouts this week: ${context.recent.weekWorkouts}

Calculate optimal daily macros and give advice. Consider:
- Protein: ~1g per lb bodyweight (${context.user.weightLbs}g)
- More calories on workout days, slight deficit on rest days
- If recovery <34 or 4+ consecutive workout days, recommend rest
- If hungover, recommend extra hydration

Return ONLY this JSON (no other text):
{"goals":{"calories":1800,"protein":135,"carbs":180,"fat":55,"fiber":28,"water_bottles":3,"reasoning":"explanation"},"advice":{"primary":"main tip","tips":["tip1","tip2"],"workout_recommendation":"go","nutrition_focus":"what to eat"}}`;

  const response = await fetch(AI_GATEWAY_URL, {
    method: 'POST',
    headers: {
      'cf-aig-authorization': `Bearer ${cfApiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      messages: [
        { role: 'user', content: prompt }
      ],
      max_tokens: 800,
      temperature: 0.7
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('AI Gateway error:', error);
    throw new Error('AI request failed');
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message: string } };
  
  console.log('AI response structure:', JSON.stringify(data).substring(0, 500));
  
  if (data.error) {
    throw new Error(`AI error: ${data.error.message}`);
  }
  
  const content = data.choices?.[0]?.message?.content;
  
  if (!content) {
    throw new Error(`Empty AI response: ${JSON.stringify(data).substring(0, 200)}`);
  }

  // Parse JSON from response
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON in response');
  }
  
  return JSON.parse(jsonMatch[0]);
}

// Evening summary with AI analysis of actual meals
interface EveningSummaryContext {
  // Workout
  didBarrys: boolean;
  barrysClass: string;
  caloriesBurned: number;
  strain: number;
  
  // Recovery & Sleep
  recovery: number | null;
  sleepHours: number | null;
  sleepPerformance: number | null;
  
  // Meals
  meals: Array<{
    name: string;
    meal_type: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
  }>;
  
  // Goals & Totals
  goals: { calories: number; protein: number; carbs: number; fat: number };
  totals: { calories: number; protein: number; carbs: number; fat: number };
  
  // Habits
  waterBottles: number;
  drankLastNight: boolean;
  drinksLastNight: number;
  
  // Tomorrow
  tomorrowClass: string | undefined;
}

async function generateAIEveningSummary(cfApiToken: string, context: EveningSummaryContext): Promise<{ message: string; tip: string } | null> {
  const AI_GATEWAY_URL = 'https://gateway.ai.cloudflare.com/v1/ede31cad5fa379850e090febbeaba602/ai-playground/compat/chat/completions';
  
  // Include meal names + macros so AI knows exact portions
  const mealsList = context.meals.map(m => 
    `- ${m.meal_type}: ${m.name} (${m.calories} cal, ${m.protein}g P, ${m.carbs}g C, ${m.fat}g F)`
  ).join('\n');
  
  const calOver = context.totals.calories - context.goals.calories;
  const protOver = context.totals.protein - context.goals.protein;
  const carbsOver = context.totals.carbs - context.goals.carbs;
  const fatOver = context.totals.fat - context.goals.fat;
  
  // Calculate net calories (consumed - burned)
  const netCalories = context.totals.calories - context.caloriesBurned;
  
  const prompt = `You are a supportive fitness coach giving an evening summary. Be concise, specific, and actionable.

USER'S DAY:

WORKOUT & ACTIVITY:
- Workout: ${context.didBarrys ? `Barry's ${context.barrysClass}` : 'Rest day (no workout)'}
- Calories burned: ${context.caloriesBurned || 0} cal
- Day strain: ${context.strain ? context.strain.toFixed(1) + '/21' : 'N/A'}

RECOVERY & SLEEP (from Whoop):
- Recovery score: ${context.recovery ? context.recovery + '%' : 'N/A'}${context.recovery ? (context.recovery >= 67 ? ' (green - great!)' : context.recovery >= 34 ? ' (yellow - moderate)' : ' (red - need rest)') : ''}
- Sleep: ${context.sleepHours ? context.sleepHours + ' hours' : 'N/A'}${context.sleepPerformance ? ` (${context.sleepPerformance}% performance)` : ''}
${context.drankLastNight ? `- Drank ${context.drinksLastNight} drink(s) last night (may affect recovery)` : ''}

HYDRATION:
- Water: ${context.waterBottles}/3 bottles (32oz each)

MEALS TODAY:
${mealsList}

NUTRITION TOTALS vs GOALS:
- Calories: ${context.totals.calories} consumed / ${context.goals.calories} goal (${calOver > 0 ? '+' + calOver + ' over' : Math.abs(calOver) + ' under'})
- Net calories (after workout burn): ${netCalories} cal
- Protein: ${context.totals.protein}g / ${context.goals.protein}g (${protOver >= 0 ? 'HIT!' : protOver + 'g short'})
- Carbs: ${context.totals.carbs}g / ${context.goals.carbs}g (${carbsOver > 0 ? '+' + carbsOver + 'g over' : 'on track'})
- Fat: ${context.totals.fat}g / ${context.goals.fat}g (${fatOver > 0 ? '+' + fatOver + 'g over' : 'on track'})

TOMORROW:
- ${context.tomorrowClass ? `Barry's ${context.tomorrowClass}` : 'Rest day'}

Analyze this day and respond like a supportive coach texting their client. Be honest but not preachy.

MESSAGE (2-3 sentences): Acknowledge workout if done. Honestly assess nutrition - what went well, what didn't. Be specific about which meals/foods caused issues.

TIP (1 sentence): One actionable recommendation for tomorrow based on patterns you notice.

Return ONLY this JSON:
{"message":"your message here","tip":"your specific tip here"}`;

  try {
    const response = await fetch(AI_GATEWAY_URL, {
      method: 'POST',
      headers: {
        'cf-aig-authorization': `Bearer ${cfApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 400,
        temperature: 0.7
      }),
    });

    if (!response.ok) {
      console.error('AI Gateway error:', await response.text());
      return null;
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    
    if (!content) return null;
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    
    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error('AI evening summary error:', error);
    return null;
  }
}

// Tomorrow recommendations endpoint (cached 30min)
dashboardRoutes.post('/tomorrow-recommendations', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { workout_plan, events, today_calories, today_protein, did_workout_today } = await c.req.json();
  
  // Check cache first (key based on inputs - same plan = same recommendations)
  const todayStr = new Date().toISOString().split('T')[0];
  const cacheKey = `tomorrow:${userId}:${todayStr}:${workout_plan}:${simpleHash(events || '')}`;
  const cached = await c.env.CACHE.get(cacheKey);
  if (cached) {
    console.log('Tomorrow recommendations CACHE HIT');
    return c.json(JSON.parse(cached));
  }
  
  const cfToken = c.env.CF_API_TOKEN;
  if (!cfToken) {
    return c.json({ error: 'AI not configured' }, 500);
  }

  const AI_GATEWAY_URL = 'https://gateway.ai.cloudflare.com/v1/ede31cad5fa379850e090febbeaba602/ai-playground/compat/chat/completions';
  
  // Build context about tomorrow
  const workoutOptions: Record<string, string> = {
    'barrys_regular': "Barry's Bootcamp (regular class - ~500 cal burn)",
    'barrys_double': "Barry's Bootcamp Double Floor (extra strength - ~400 cal burn, less cardio)", 
    'pilates': "Pilates (low-impact strength & flexibility - ~200-300 cal burn)",
    'other': "Other workout",
    'rest': "Rest day (no workout)"
  };
  const workoutText = workoutOptions[workout_plan as string] || "Unknown";

  const prompt = `You are a fitness coach helping plan tomorrow. Be specific and actionable.

TODAY:
- Calories: ${today_calories || 'unknown'} consumed
- Protein: ${today_protein || 'unknown'}g
- Worked out: ${did_workout_today ? 'yes' : 'no'}

TOMORROW'S PLAN:
- Workout: ${workoutText}
- Events: ${events || 'None specified'}

Give practical recommendations based on their specific plan. If they mention drinking, eating out, traveling, etc - tailor advice to that.

Return ONLY this JSON:
{"summary":"2-3 sentence game plan for tomorrow","tips":["specific tip 1","specific tip 2","specific tip 3"],"adjusted_goals":{"calories":number,"protein":number}}`;

  try {
    const response = await fetch(AI_GATEWAY_URL, {
      method: 'POST',
      headers: {
        'cf-aig-authorization': `Bearer ${cfToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
        temperature: 0.7
      }),
    });

    if (!response.ok) {
      console.error('AI Gateway error:', await response.text());
      return c.json({ error: 'AI request failed' }, 500);
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    
    if (!content) {
      return c.json({ error: 'Empty AI response' }, 500);
    }
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return c.json({ error: 'Invalid AI response format' }, 500);
    }
    
    const recommendations = JSON.parse(jsonMatch[0]);
    
    const result = {
      success: true,
      recommendations
    };
    
    // Cache for 30 minutes
    await c.env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 1800 });
    console.log('Tomorrow recommendations cached for 30min');
    
    return c.json(result);
  } catch (error) {
    console.error('Tomorrow recommendations error:', error);
    return c.json({ error: 'Failed to get recommendations' }, 500);
  }
});
