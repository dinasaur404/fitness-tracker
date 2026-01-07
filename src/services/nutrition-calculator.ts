/// <reference types="@cloudflare/workers-types" />

import { Env } from '../types/env';
import { AIGatewayService, MacroTargets, DailyMacroCalculation } from './ai-gateway';

/**
 * Nutrition Calculator Service
 * 
 * Handles dynamic macro calculations based on:
 * - User profile (weight, height, age, sex)
 * - Daily activity (Barry's, steps, Whoop data)
 * - Fitness goals (body recomposition)
 */

// User profile constants for Dina
const USER_PROFILE = {
  birthday: '1997-12-01',
  heightCm: 170.18, // 5'7" in cm
  isFemale: true,
  barrysGoalPerWeek: 5,
  waterBottleGoalPerDay: 3, // 32oz bottles
};

// Barry's schedule
const BARRYS_SCHEDULE: Record<number, { focus: string; muscleGroups: string[] }> = {
  0: { focus: 'Total Body', muscleGroups: ['full body', 'cardio'] },
  1: { focus: 'Arms & Abs', muscleGroups: ['biceps', 'triceps', 'shoulders', 'core'] },
  2: { focus: 'Lower Focus', muscleGroups: ['quads', 'hamstrings', 'glutes', 'calves'] },
  3: { focus: 'Chest/Back', muscleGroups: ['chest', 'back', 'shoulders'] },
  4: { focus: 'Abs & Ass', muscleGroups: ['core', 'glutes', 'hamstrings'] },
  5: { focus: 'Total Body', muscleGroups: ['full body', 'cardio'] },
  6: { focus: 'Upper Focus', muscleGroups: ['chest', 'back', 'shoulders', 'arms'] },
};

export interface UserActivity {
  hasBarrys: boolean;
  isDoubleFloor: boolean;
  whoopCaloriesBurned?: number;
  whoopStrain?: number;
  steps?: number;
  otherWorkouts?: number;
}

export interface DailyGoals {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  waterBottles: number;
  isWorkoutDay: boolean;
  barrysClassFocus?: string;
  reasoning: string;
}

export interface WeeklyProgress {
  barrysCompleted: number;
  barrysGoal: number;
  totalWorkouts: number;
  averageCalories: number;
  averageProtein: number;
  drinksTotal: number;
  weedFreeDays: number;
}

export class NutritionCalculator {
  private aiGateway: AIGatewayService;
  private db: D1Database;

  constructor(env: Env) {
    this.aiGateway = new AIGatewayService(env);
    this.db = env.DB;
  }

  /**
   * Calculate user's current age from birthday
   */
  private calculateAge(): number {
    const birthday = new Date(USER_PROFILE.birthday);
    const today = new Date();
    let age = today.getFullYear() - birthday.getFullYear();
    const monthDiff = today.getMonth() - birthday.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthday.getDate())) {
      age--;
    }
    return age;
  }

  /**
   * Get today's Barry's class info
   */
  getBarrysClassInfo(date: Date = new Date()): { focus: string; muscleGroups: string[] } {
    return BARRYS_SCHEDULE[date.getDay()];
  }

  /**
   * Get user's current weight from Whoop data
   */
  async getCurrentWeight(userId: string): Promise<number | null> {
    const result = await this.db.prepare(`
      SELECT weight_kg FROM whoop_daily 
      WHERE user_id = ? AND weight_kg IS NOT NULL 
      ORDER BY date DESC LIMIT 1
    `).bind(userId).first<{ weight_kg: number }>();

    return result?.weight_kg || null;
  }

  /**
   * Get user's steps for today from Whoop
   */
  async getTodaySteps(userId: string, date: string): Promise<number | null> {
    // Steps would come from Whoop daily data if available
    // For now, return null - can be enhanced later
    return null;
  }

  /**
   * Calculate dynamic daily goals based on activity
   */
  async calculateDailyGoals(
    userId: string,
    activity: UserActivity,
    date: Date = new Date()
  ): Promise<DailyGoals> {
    // Get current weight
    const weightKg = await this.getCurrentWeight(userId) || 61; // Default ~135lbs
    const age = this.calculateAge();
    const barrysInfo = this.getBarrysClassInfo(date);

    // Use AI for sophisticated calculation
    const macroCalc = await this.aiGateway.calculateDailyMacros(
      weightKg,
      USER_PROFILE.heightCm,
      age,
      USER_PROFILE.isFemale,
      activity,
      'recomp'
    );

    return {
      calories: macroCalc.final_calories,
      protein: macroCalc.macros.protein,
      carbs: macroCalc.macros.carbs,
      fat: macroCalc.macros.fat,
      fiber: macroCalc.macros.fiber || 28,
      waterBottles: USER_PROFILE.waterBottleGoalPerDay,
      isWorkoutDay: activity.hasBarrys || (activity.otherWorkouts || 0) > 0,
      barrysClassFocus: activity.hasBarrys ? barrysInfo.focus : undefined,
      reasoning: macroCalc.reasoning
    };
  }

  /**
   * Calculate default goals without AI (fallback)
   */
  calculateDefaultGoals(
    weightKg: number,
    activity: UserActivity,
    date: Date = new Date()
  ): DailyGoals {
    const age = this.calculateAge();
    const barrysInfo = this.getBarrysClassInfo(date);
    
    // Mifflin-St Jeor for BMR (female)
    const bmr = 10 * weightKg + 6.25 * USER_PROFILE.heightCm - 5 * age - 161;
    
    // Activity multiplier
    let activityMultiplier = 1.3; // Lightly active base
    if (activity.hasBarrys) {
      activityMultiplier = activity.isDoubleFloor ? 1.55 : 1.65;
    } else if (activity.steps && activity.steps > 10000) {
      activityMultiplier = 1.45;
    }

    // Base TDEE
    let tdee = Math.round(bmr * activityMultiplier);
    
    // Adjust for workout day
    if (activity.hasBarrys && activity.whoopCaloriesBurned) {
      // Add back some workout calories on heavy days
      tdee += Math.round(activity.whoopCaloriesBurned * 0.3);
    }

    // Slight deficit for recomp on rest days
    const goalCalories = activity.hasBarrys ? tdee : tdee - 200;

    // Macro split for body recomp
    const weightLbs = weightKg * 2.205;
    const protein = Math.round(weightLbs * 1); // 1g per lb
    const fat = Math.round(weightLbs * 0.35); // 0.35g per lb
    const proteinCals = protein * 4;
    const fatCals = fat * 9;
    const carbCals = Math.max(goalCalories - proteinCals - fatCals, 400);
    const carbs = Math.round(carbCals / 4);

    return {
      calories: goalCalories,
      protein,
      carbs,
      fat,
      fiber: 28,
      waterBottles: USER_PROFILE.waterBottleGoalPerDay,
      isWorkoutDay: activity.hasBarrys,
      barrysClassFocus: activity.hasBarrys ? barrysInfo.focus : undefined,
      reasoning: `${activity.hasBarrys ? `Barry's ${barrysInfo.focus} day` : 'Rest day'} - ${goalCalories} cal target for body recomposition`
    };
  }

  /**
   * Get weekly progress summary
   */
  async getWeeklyProgress(userId: string, weekStartDate: string): Promise<WeeklyProgress> {
    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setDate(weekEndDate.getDate() + 7);

    // Count Barry's workouts this week
    const barrysResult = await this.db.prepare(`
      SELECT COUNT(*) as count FROM barrys_workouts 
      WHERE user_id = ? AND workout_date >= ? AND workout_date < ?
    `).bind(userId, weekStartDate, weekEndDate.toISOString().split('T')[0])
      .first<{ count: number }>();

    // Get total workouts from Whoop
    const workoutsResult = await this.db.prepare(`
      SELECT COUNT(*) as count FROM whoop_workouts 
      WHERE user_id = ? AND start_time >= ? AND start_time < ?
    `).bind(userId, weekStartDate, weekEndDate.toISOString().split('T')[0])
      .first<{ count: number }>();

    // Get daily habits for the week
    const habitsResult = await this.db.prepare(`
      SELECT 
        SUM(drinks_count) as total_drinks,
        SUM(CASE WHEN smoked_weed = 0 THEN 1 ELSE 0 END) as weed_free_days
      FROM daily_habits 
      WHERE user_id = ? AND date >= ? AND date < ?
    `).bind(userId, weekStartDate, weekEndDate.toISOString().split('T')[0])
      .first<{ total_drinks: number; weed_free_days: number }>();

    // Get average nutrition
    const nutritionResult = await this.db.prepare(`
      SELECT 
        AVG(total_cals) as avg_calories,
        AVG(total_protein) as avg_protein
      FROM (
        SELECT 
          DATE(logged_at) as log_date,
          SUM(calories) as total_cals,
          SUM(protein) as total_protein
        FROM meals 
        WHERE user_id = ? AND logged_at >= ? AND logged_at < ?
        GROUP BY DATE(logged_at)
      )
    `).bind(userId, weekStartDate, weekEndDate.toISOString().split('T')[0])
      .first<{ avg_calories: number; avg_protein: number }>();

    return {
      barrysCompleted: barrysResult?.count || 0,
      barrysGoal: USER_PROFILE.barrysGoalPerWeek,
      totalWorkouts: workoutsResult?.count || 0,
      averageCalories: Math.round(nutritionResult?.avg_calories || 0),
      averageProtein: Math.round(nutritionResult?.avg_protein || 0),
      drinksTotal: habitsResult?.total_drinks || 0,
      weedFreeDays: habitsResult?.weed_free_days || 0
    };
  }

  /**
   * Adjust macros after logging a workout
   */
  calculatePostWorkoutAdjustment(
    currentGoals: DailyGoals,
    workoutType: 'barrys_regular' | 'barrys_double_floor' | 'other',
    caloriesBurned: number
  ): DailyGoals {
    const adjustment = this.aiGateway.calculateWorkoutImpact(
      workoutType,
      caloriesBurned
    );

    return {
      ...currentGoals,
      calories: currentGoals.calories + adjustment.macro_adjustment.calories,
      protein: currentGoals.protein + adjustment.macro_adjustment.protein,
      carbs: currentGoals.carbs + adjustment.macro_adjustment.carbs,
      reasoning: `${currentGoals.reasoning}. Post-workout: +${adjustment.macro_adjustment.calories} cal, +${adjustment.macro_adjustment.protein}g protein.`
    };
  }

  /**
   * Get user profile constants
   */
  getUserProfile() {
    return {
      ...USER_PROFILE,
      age: this.calculateAge()
    };
  }
}
