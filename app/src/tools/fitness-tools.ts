/// <reference types="@cloudflare/workers-types" />

import { Env } from '../types/env';

/**
 * Fitness Tools - Data access functions for AI chat agent
 * 
 * These tools are called by the ChatAgent to retrieve user data
 * and provide context for AI responses.
 */

// Tool result types
export interface TodaySummary {
  date: string;
  nutrition: {
    calories: { consumed: number; goal: number; remaining: number };
    protein: { consumed: number; goal: number; remaining: number };
    carbs: { consumed: number; goal: number };
    fat: { consumed: number; goal: number };
    mealsLogged: number;
  };
  workout: {
    completed: boolean;
    type?: string;
    caloriesBurned?: number;
  };
  recovery: {
    score: number | null;
    hrv: number | null;
    sleepHours: number | null;
  };
  habits: {
    waterBottles: number;
    waterGoal: number;
    tookElectrolytes: boolean;
    drinksCount: number;
  };
  streaks: Record<string, { current: number; best: number }>;
}

export interface MealData {
  id: string;
  name: string;
  mealType: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  date: string;
  time: string;
}

export interface WorkoutData {
  id: string;
  type: string;
  caloriesBurned: number;
  strain?: number;
  duration?: number;
  date: string;
  isBarrys: boolean;
}

export interface RecoveryData {
  date: string;
  recoveryScore: number | null;
  hrv: number | null;
  restingHr: number | null;
  sleepHours: number | null;
  sleepPerformance: number | null;
  strain: number | null;
}

export interface HabitsData {
  date: string;
  waterBottles: number;
  tookElectrolytes: boolean;
  drinksCount: number;
  drinkTypes?: { type: string; count: number }[];
}

export interface GoalsData {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  waterBottles: number;
  workoutsPerWeek: number;
}

export interface WeightData {
  date: string;
  weightKg: number;
  weightLbs: number;
  bodyFat?: number;
}

// Helper to get current date in a specific timezone
function getLocalDate(timezone: string = 'America/Los_Angeles'): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone }); // en-CA gives YYYY-MM-DD format
}

// Tool implementations
export class FitnessTools {
  private timezone: string;
  
  constructor(
    private env: Env,
    private userId: string,
    timezone: string = 'America/Los_Angeles' // Default to PT since that's where user is
  ) {
    this.timezone = timezone;
  }
  
  // Get today's date in the user's timezone - ALWAYS current
  private getToday(): string {
    return getLocalDate(this.timezone);
  }

  /**
   * Get comprehensive summary of today's data
   */
  async getTodaysSummary(): Promise<TodaySummary> {
    const today = this.getToday();
    
    // Parallel queries
    const [meals, workout, whoop, habits, streaks] = await Promise.all([
      this.env.DB.prepare(`
        SELECT SUM(calories) as calories, SUM(protein) as protein, 
               SUM(carbs) as carbs, SUM(fat) as fat, COUNT(*) as count
        FROM meals WHERE user_id = ? AND date(logged_at) = ?
      `).bind(this.userId, today).first(),
      
      this.env.DB.prepare(`
        SELECT class_type, calories_burned FROM barrys_workouts 
        WHERE user_id = ? AND workout_date = ?
      `).bind(this.userId, today).first(),
      
      this.env.DB.prepare(`
        SELECT recovery_score, hrv_rmssd as hrv, sleep_duration_minutes, day_strain
        FROM whoop_daily WHERE user_id = ? AND date = ?
      `).bind(this.userId, today).first(),
      
      this.env.DB.prepare(`
        SELECT water_bottles, took_electrolytes, drinks_count
        FROM daily_habits WHERE user_id = ? AND date = ?
      `).bind(this.userId, today).first(),
      
      this.env.DB.prepare(`
        SELECT streak_type, current_count, best_count
        FROM streaks WHERE user_id = ?
      `).bind(this.userId).all()
    ]);

    // Default goals
    const goals = { calories: 1800, protein: 135, carbs: 180, fat: 60 };
    
    const consumed = {
      calories: Math.round((meals?.calories as number) || 0),
      protein: Math.round((meals?.protein as number) || 0),
      carbs: Math.round((meals?.carbs as number) || 0),
      fat: Math.round((meals?.fat as number) || 0)
    };

    const streaksMap: Record<string, { current: number; best: number }> = {};
    for (const s of (streaks.results || [])) {
      streaksMap[s.streak_type as string] = {
        current: s.current_count as number,
        best: s.best_count as number
      };
    }

    return {
      date: today,
      nutrition: {
        calories: { consumed: consumed.calories, goal: goals.calories, remaining: goals.calories - consumed.calories },
        protein: { consumed: consumed.protein, goal: goals.protein, remaining: goals.protein - consumed.protein },
        carbs: { consumed: consumed.carbs, goal: goals.carbs },
        fat: { consumed: consumed.fat, goal: goals.fat },
        mealsLogged: (meals?.count as number) || 0
      },
      workout: {
        completed: !!workout,
        type: workout?.class_type as string | undefined,
        caloriesBurned: workout?.calories_burned as number | undefined
      },
      recovery: {
        score: whoop?.recovery_score ? Math.round((whoop.recovery_score as number) * 100) / 100 : null,
        hrv: whoop?.hrv ? Math.round((whoop.hrv as number) * 100) / 100 : null,
        sleepHours: whoop?.sleep_duration_minutes ? Math.round((whoop.sleep_duration_minutes as number) / 60 * 100) / 100 : null
      },
      habits: {
        waterBottles: (habits?.water_bottles as number) || 0,
        waterGoal: 3,
        tookElectrolytes: (habits?.took_electrolytes as number) === 1,
        drinksCount: (habits?.drinks_count as number) || 0
      },
      streaks: streaksMap
    };
  }

  /**
   * Get meals for a date range
   */
  async getMeals(startDate?: string, endDate?: string): Promise<MealData[]> {
    const start = startDate || this.getToday();
    const end = endDate || start;
    
    const result = await this.env.DB.prepare(`
      SELECT id, name, meal_type, calories, protein, carbs, fat, 
             date(logged_at) as date, time(logged_at) as time
      FROM meals 
      WHERE user_id = ? AND date(logged_at) >= ? AND date(logged_at) <= ?
      ORDER BY logged_at DESC
    `).bind(this.userId, start, end).all();

    return (result.results || []).map(m => ({
      id: m.id as string,
      name: m.name as string,
      mealType: m.meal_type as string,
      calories: m.calories as number,
      protein: m.protein as number,
      carbs: m.carbs as number,
      fat: m.fat as number,
      date: m.date as string,
      time: m.time as string
    }));
  }

  /**
   * Get workout history
   */
  async getWorkouts(startDate?: string, endDate?: string): Promise<WorkoutData[]> {
    // Default to last 7 days ending today
    const today = this.getToday();
    const todayDate = new Date(today + 'T00:00:00');
    const weekAgo = new Date(todayDate.getTime() - 7 * 24 * 60 * 60 * 1000);
    const start = startDate || weekAgo.toISOString().split('T')[0];
    const end = endDate || today;
    
    const result = await this.env.DB.prepare(`
      SELECT id, class_type, calories_burned, workout_date
      FROM barrys_workouts 
      WHERE user_id = ? AND workout_date >= ? AND workout_date <= ?
      ORDER BY workout_date DESC
    `).bind(this.userId, start, end).all();

    return (result.results || []).map(w => ({
      id: w.id as string,
      type: w.class_type as string,
      caloriesBurned: w.calories_burned as number,
      date: w.workout_date as string,
      isBarrys: true
    }));
  }

  /**
   * Get recovery/sleep/strain data from Whoop
   */
  async getRecoveryData(days: number = 7): Promise<RecoveryData[]> {
    const result = await this.env.DB.prepare(`
      SELECT date, recovery_score, hrv_rmssd as hrv, resting_heart_rate,
             sleep_duration_minutes, sleep_performance, day_strain
      FROM whoop_daily 
      WHERE user_id = ? AND date >= date('now', '-' || ? || ' days')
      ORDER BY date DESC
    `).bind(this.userId, days).all();

    return (result.results || []).map(r => ({
      date: r.date as string,
      recoveryScore: r.recovery_score !== null ? Math.round((r.recovery_score as number) * 100) / 100 : null,
      hrv: r.hrv !== null ? Math.round((r.hrv as number) * 100) / 100 : null,
      restingHr: r.resting_heart_rate !== null ? Math.round((r.resting_heart_rate as number) * 100) / 100 : null,
      sleepHours: r.sleep_duration_minutes ? Math.round((r.sleep_duration_minutes as number) / 60 * 100) / 100 : null,
      sleepPerformance: r.sleep_performance !== null ? Math.round((r.sleep_performance as number) * 100) / 100 : null,
      strain: r.day_strain !== null ? Math.round((r.day_strain as number) * 100) / 100 : null
    }));
  }

  /**
   * Get habits for a specific date
   */
  async getHabits(date?: string): Promise<HabitsData> {
    const targetDate = date || this.getToday();
    
    const result = await this.env.DB.prepare(`
      SELECT water_bottles, took_electrolytes, drinks_count, drink_types
      FROM daily_habits WHERE user_id = ? AND date = ?
    `).bind(this.userId, targetDate).first();

    return {
      date: targetDate,
      waterBottles: (result?.water_bottles as number) || 0,
      tookElectrolytes: (result?.took_electrolytes as number) === 1,
      drinksCount: (result?.drinks_count as number) || 0,
      drinkTypes: result?.drink_types ? JSON.parse(result.drink_types as string) : []
    };
  }

  /**
   * Get user's goals
   */
  async getGoals(): Promise<GoalsData> {
    const result = await this.env.DB.prepare(`
      SELECT goals FROM users WHERE id = ?
    `).bind(this.userId).first();

    const goals = result?.goals ? JSON.parse(result.goals as string) : {};
    
    return {
      calories: goals.daily_calories || 1800,
      protein: goals.daily_protein || 135,
      carbs: goals.daily_carbs || 180,
      fat: goals.daily_fat || 60,
      waterBottles: goals.water_bottles_per_day || 3,
      workoutsPerWeek: goals.workout_days_per_week || 5
    };
  }

  /**
   * Get weight trend over time
   */
  async getWeightTrend(days: number = 30): Promise<WeightData[]> {
    const result = await this.env.DB.prepare(`
      SELECT date, weight_kg
      FROM whoop_daily 
      WHERE user_id = ? AND weight_kg IS NOT NULL 
        AND date >= date('now', '-' || ? || ' days')
      ORDER BY date DESC
    `).bind(this.userId, days).all();

    return (result.results || []).map(w => ({
      date: w.date as string,
      weightKg: w.weight_kg as number,
      weightLbs: Math.round((w.weight_kg as number) * 2.205 * 10) / 10
    }));
  }

  /**
   * Get remaining macros for today
   */
  async getRemainingMacros(): Promise<{
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    percentComplete: { calories: number; protein: number };
  }> {
    const summary = await this.getTodaysSummary();
    const goals = await this.getGoals();
    
    return {
      calories: goals.calories - summary.nutrition.calories.consumed,
      protein: goals.protein - summary.nutrition.protein.consumed,
      carbs: goals.carbs - summary.nutrition.carbs.consumed,
      fat: goals.fat - summary.nutrition.fat.consumed,
      percentComplete: {
        calories: Math.round((summary.nutrition.calories.consumed / goals.calories) * 100),
        protein: Math.round((summary.nutrition.protein.consumed / goals.protein) * 100)
      }
    };
  }

  /**
   * Analyze correlation between drinking and recovery
   */
  async getDrinkingRecoveryCorrelation(): Promise<{
    avgRecoveryNoDrinks: number | null;
    avgRecoveryWithDrinks: number | null;
    daysAnalyzed: number;
    insight: string;
  }> {
    // Get last 30 days of habits and next-day recovery
    const result = await this.env.DB.prepare(`
      SELECT 
        h.date as habit_date,
        h.drinks_count,
        w.recovery_score as next_day_recovery
      FROM daily_habits h
      LEFT JOIN whoop_daily w ON w.date = date(h.date, '+1 day') AND w.user_id = h.user_id
      WHERE h.user_id = ? AND h.date >= date('now', '-30 days')
      ORDER BY h.date DESC
    `).bind(this.userId).all();

    const withDrinks: number[] = [];
    const noDrinks: number[] = [];

    for (const r of (result.results || [])) {
      if (r.next_day_recovery !== null) {
        if ((r.drinks_count as number) > 0) {
          withDrinks.push(r.next_day_recovery as number);
        } else {
          noDrinks.push(r.next_day_recovery as number);
        }
      }
    }

    const avgNoDrinks = noDrinks.length > 0 ? Math.round(noDrinks.reduce((a, b) => a + b, 0) / noDrinks.length) : null;
    const avgWithDrinks = withDrinks.length > 0 ? Math.round(withDrinks.reduce((a, b) => a + b, 0) / withDrinks.length) : null;

    let insight = '';
    if (avgNoDrinks !== null && avgWithDrinks !== null) {
      const diff = avgNoDrinks - avgWithDrinks;
      if (diff > 10) {
        insight = `Drinking significantly impacts your recovery - you average ${diff}% lower recovery the day after drinking.`;
      } else if (diff > 5) {
        insight = `Drinking has a moderate impact on your recovery (about ${diff}% lower the next day).`;
      } else {
        insight = `Your recovery doesn't seem heavily affected by drinking, but staying hydrated is still important.`;
      }
    } else {
      insight = 'Not enough data yet to analyze the correlation.';
    }

    return {
      avgRecoveryNoDrinks: avgNoDrinks,
      avgRecoveryWithDrinks: avgWithDrinks,
      daysAnalyzed: result.results?.length || 0,
      insight
    };
  }

  /**
   * Get weekly summary stats
   */
  async getWeeklySummary(): Promise<{
    totalCalories: number;
    totalProtein: number;
    avgCaloriesPerDay: number;
    avgProteinPerDay: number;
    workoutsCompleted: number;
    avgRecoveryPercent: number | null;
    daysTracked: number;
  }> {
    const [meals, workouts, recovery] = await Promise.all([
      this.env.DB.prepare(`
        SELECT SUM(calories) as cal, SUM(protein) as prot, COUNT(DISTINCT date(logged_at)) as days
        FROM meals 
        WHERE user_id = ? AND date(logged_at) >= date('now', '-7 days')
      `).bind(this.userId).first(),
      
      this.env.DB.prepare(`
        SELECT COUNT(*) as count
        FROM barrys_workouts 
        WHERE user_id = ? AND workout_date >= date('now', '-7 days')
      `).bind(this.userId).first(),
      
      this.env.DB.prepare(`
        SELECT AVG(recovery_score) as avg
        FROM whoop_daily 
        WHERE user_id = ? AND date >= date('now', '-7 days') AND recovery_score IS NOT NULL
      `).bind(this.userId).first()
    ]);

    const days = (meals?.days as number) || 1;
    
    return {
      totalCalories: Math.round((meals?.cal as number) || 0),
      totalProtein: Math.round((meals?.prot as number) || 0),
      avgCaloriesPerDay: Math.round(((meals?.cal as number) || 0) / days),
      avgProteinPerDay: Math.round(((meals?.prot as number) || 0) / days),
      workoutsCompleted: (workouts?.count as number) || 0,
      avgRecoveryPercent: recovery?.avg ? Math.round(recovery.avg as number) : null,
      daysTracked: days
    };
  }
}

// Tool definitions for AI function calling
export const toolDefinitions = [
  {
    type: 'function' as const,
    function: {
      name: 'getTodaysSummary',
      description: 'Get a comprehensive summary of today\'s nutrition, workout, recovery, and habits data',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'getMeals',
      description: 'Get meals logged for a specific date or date range',
      parameters: {
        type: 'object',
        properties: {
          startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format (defaults to today)' },
          endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (defaults to startDate)' }
        },
        required: []
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'getWorkouts',
      description: 'Get workout history for a date range',
      parameters: {
        type: 'object',
        properties: {
          startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
          endDate: { type: 'string', description: 'End date in YYYY-MM-DD format' }
        },
        required: []
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'getRecoveryData',
      description: 'Get Whoop recovery, sleep, and strain data for recent days',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Number of days to look back (default 7)' }
        },
        required: []
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'getHabits',
      description: 'Get habits (water, electrolytes, alcohol) for a specific date',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date in YYYY-MM-DD format (defaults to today)' }
        },
        required: []
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'getGoals',
      description: 'Get the user\'s calorie, protein, and other fitness goals',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'getWeightTrend',
      description: 'Get weight measurements over time',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Number of days to look back (default 30)' }
        },
        required: []
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'getRemainingMacros',
      description: 'Calculate remaining calories and macros needed for today to hit goals',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'getDrinkingRecoveryCorrelation',
      description: 'Analyze how drinking alcohol affects next-day recovery scores',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'getWeeklySummary',
      description: 'Get a summary of the past week\'s nutrition, workouts, and recovery. Returns avgRecoveryPercent as a percentage (0-100%) from Whoop recovery scores.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  }
];
