/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from 'cloudflare:workers';

/**
 * DailyTracker Durable Object - KV-backed
 * 
 * Manages real-time daily statistics for a user.
 * Each user gets their own instance keyed by `userId:date`
 * 
 * This enables:
 * - Real-time macro tracking as meals are logged
 * - Instant goal progress without DB queries
 * - Per-entity scheduled tasks via alarms
 * 
 * Storage: KV-backed (not SQLite - existing DOs can't be migrated)
 */

interface DailyGoals {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  water_bottles: number;
}

interface MealEntry {
  id: string;
  name: string;
  meal_type: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  logged_at: string;
}

interface WorkoutEntry {
  id: string;
  type: string;
  calories_burned: number;
  strain: number;
  is_barrys: boolean;
  is_double_floor: boolean;
  logged_at: string;
}

interface DailySummary {
  date: string;
  user_id: string;
  // Nutrition totals
  total_calories: number;
  total_protein: number;
  total_carbs: number;
  total_fat: number;
  meals_logged: number;
  // Fitness
  workouts_completed: number;
  total_calories_burned: number;
  total_strain: number;
  day_strain?: number;
  barrys_completed: boolean;
  is_double_floor?: boolean;
  // Recovery (from Whoop)
  recovery_score?: number;
  sleep_score?: number;
  sleep_hours?: number;
  hrv?: number;
  resting_hr?: number;
  // Weight
  weight?: number;
  weight_kg?: number;
  // Habits
  drinks_count: number;
  smoked_weed: boolean;
  water_bottles: number;
  took_electrolytes: boolean;
  steps?: number;
  // Goals
  goals: DailyGoals;
  calorie_goal_hit: boolean;
  protein_goal_hit: boolean;
  water_goal_hit: boolean;
  // Meta
  updated_at: string;
}

interface DailyData {
  summary: DailySummary;
  meals: MealEntry[];
  workouts: WorkoutEntry[];
}

export class DailyTracker extends DurableObject<Record<string, unknown>> {
  private initialized: boolean = false;
  
  // In-memory cache for fast reads
  private cachedData: DailyData | null = null;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    
    // Block requests until initialization completes
    ctx.blockConcurrencyWhile(async () => {
      await this.loadFromStorage();
    });
  }

  /**
   * Load cached data from KV storage
   */
  private async loadFromStorage(): Promise<void> {
    const stored = await this.ctx.storage.get<DailyData>('data');
    if (stored) {
      this.cachedData = stored;
      this.initialized = true;
    }
  }

  /**
   * Get or create default data
   */
  private getDefaultData(): DailyData {
    return {
      summary: {
        date: new Date().toISOString().split('T')[0],
        user_id: '',
        total_calories: 0,
        total_protein: 0,
        total_carbs: 0,
        total_fat: 0,
        meals_logged: 0,
        workouts_completed: 0,
        total_calories_burned: 0,
        total_strain: 0,
        barrys_completed: false,
        drinks_count: 0,
        smoked_weed: false,
        water_bottles: 0,
        took_electrolytes: false,
        goals: { calories: 1800, protein: 135, carbs: 180, fat: 60, water_bottles: 3 },
        calorie_goal_hit: false,
        protein_goal_hit: false,
        water_goal_hit: false,
        updated_at: new Date().toISOString()
      },
      meals: [],
      workouts: []
    };
  }

  /**
   * Get data (from cache or create default)
   */
  private getData(): DailyData {
    if (this.cachedData) {
      return this.cachedData;
    }
    return this.getDefaultData();
  }

  /**
   * Recalculate totals from meals array
   */
  private recalculateTotals(data: DailyData): void {
    let totalCalories = 0;
    let totalProtein = 0;
    let totalCarbs = 0;
    let totalFat = 0;

    for (const meal of data.meals) {
      totalCalories += meal.calories;
      totalProtein += meal.protein;
      totalCarbs += meal.carbs;
      totalFat += meal.fat;
    }

    data.summary.total_calories = totalCalories;
    data.summary.total_protein = totalProtein;
    data.summary.total_carbs = totalCarbs;
    data.summary.total_fat = totalFat;
    data.summary.meals_logged = data.meals.length;
  }

  /**
   * Save data to KV storage
   */
  private async saveData(): Promise<void> {
    if (this.cachedData) {
      const summary = this.cachedData.summary;
      summary.updated_at = new Date().toISOString();
      
      // Check goal progress
      const goals = summary.goals;
      summary.calorie_goal_hit = 
        summary.total_calories >= goals.calories * 0.9 && 
        summary.total_calories <= goals.calories * 1.1;
      summary.protein_goal_hit = summary.total_protein >= goals.protein;
      summary.water_goal_hit = summary.water_bottles >= goals.water_bottles;
      
      await this.ctx.storage.put('data', this.cachedData);
    }
  }

  /**
   * Handle incoming requests
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (request.method) {
        case 'GET':
          if (path === '/summary') return this.handleGetSummary();
          if (path === '/meals') return this.handleGetMeals();
          break;
        
        case 'POST':
          if (path === '/init') return this.handleInit(await request.json());
          if (path === '/meal') return this.handleAddMeal(await request.json());
          if (path === '/workout') return this.handleAddWorkout(await request.json());
          if (path === '/habits') return this.handleUpdateHabits(await request.json());
          if (path === '/recovery') return this.handleUpdateRecovery(await request.json());
          if (path === '/weight') return this.handleUpdateWeight(await request.json());
          break;
        
        case 'DELETE':
          if (path === '/meal') return this.handleRemoveMeal(await request.json());
          break;
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('DailyTracker error:', error);
      return Response.json({ error: 'Internal error' }, { status: 500 });
    }
  }

  /**
   * Initialize the DO with user and date identity
   */
  private async handleInit(data: { 
    date: string; 
    user_id: string; 
    goals?: Partial<DailyGoals>;
    existingData?: Partial<DailySummary>;
  }): Promise<Response> {
    // Store identity
    await this.ctx.storage.put('userId', data.user_id);
    await this.ctx.storage.put('date', data.date);
    
    // Initialize or update data
    const currentData = this.getData();
    currentData.summary.date = data.date;
    currentData.summary.user_id = data.user_id;
    
    // Merge goals if provided
    if (data.goals) {
      currentData.summary.goals = { ...currentData.summary.goals, ...data.goals };
    }
    
    // Merge existing data (from D1 on startup)
    if (data.existingData) {
      Object.assign(currentData.summary, data.existingData);
    }
    
    this.cachedData = currentData;
    this.initialized = true;
    await this.saveData();
    
    // Schedule end-of-day alarm for streak calculation (11:59 PM)
    const endOfDay = new Date(data.date);
    endOfDay.setHours(23, 59, 0, 0);
    if (endOfDay.getTime() > Date.now()) {
      const existingAlarm = await this.ctx.storage.getAlarm();
      if (!existingAlarm) {
        await this.ctx.storage.setAlarm(endOfDay.getTime());
      }
    }
    
    return Response.json(currentData.summary);
  }

  /**
   * Alarm handler - runs at end of day for streak updates
   */
  async alarm(): Promise<void> {
    console.log('DailyTracker alarm fired for date:', this.cachedData?.summary.date);
    
    // The alarm can trigger streak calculations or daily summaries
    // For now, we just ensure the data is saved
    if (this.cachedData) {
      await this.saveData();
    }
  }

  /**
   * Get summary
   */
  private handleGetSummary(): Response {
    const data = this.getData();
    // Recalculate to ensure accuracy
    this.recalculateTotals(data);
    return Response.json(data.summary);
  }

  /**
   * Get all meals for today
   */
  private handleGetMeals(): Response {
    const data = this.getData();
    return Response.json(data.meals);
  }

  /**
   * Add a meal
   */
  private async handleAddMeal(meal: {
    id?: string;
    name: string;
    meal_type: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
  }): Promise<Response> {
    const mealId = meal.id || crypto.randomUUID();
    const now = new Date().toISOString();
    
    const data = this.getData();
    
    // Add meal to array
    const newMeal: MealEntry = {
      id: mealId,
      name: meal.name,
      meal_type: meal.meal_type,
      calories: meal.calories,
      protein: meal.protein,
      carbs: meal.carbs,
      fat: meal.fat,
      logged_at: now
    };
    
    data.meals.push(newMeal);
    
    // Update totals
    data.summary.total_calories += meal.calories;
    data.summary.total_protein += meal.protein;
    data.summary.total_carbs += meal.carbs;
    data.summary.total_fat += meal.fat;
    data.summary.meals_logged = data.meals.length;
    
    this.cachedData = data;
    await this.saveData();
    
    return Response.json({ id: mealId, summary: data.summary });
  }

  /**
   * Remove a meal
   */
  private async handleRemoveMeal(reqData: { mealId: string }): Promise<Response> {
    const data = this.getData();
    
    // Find meal
    const mealIndex = data.meals.findIndex(m => m.id === reqData.mealId);
    if (mealIndex === -1) {
      return Response.json({ error: 'Meal not found' }, { status: 404 });
    }
    
    const meal = data.meals[mealIndex];
    
    // Remove from array
    data.meals.splice(mealIndex, 1);
    
    // Update totals
    data.summary.total_calories = Math.max(0, data.summary.total_calories - meal.calories);
    data.summary.total_protein = Math.max(0, data.summary.total_protein - meal.protein);
    data.summary.total_carbs = Math.max(0, data.summary.total_carbs - meal.carbs);
    data.summary.total_fat = Math.max(0, data.summary.total_fat - meal.fat);
    data.summary.meals_logged = data.meals.length;
    
    this.cachedData = data;
    await this.saveData();
    
    return Response.json({ success: true, summary: data.summary });
  }

  /**
   * Add a workout
   */
  private async handleAddWorkout(workout: {
    id?: string;
    type?: string;
    calories_burned: number;
    strain: number;
    is_barrys?: boolean;
    is_double_floor?: boolean;
    day_strain?: number;
    workout_count?: number;
  }): Promise<Response> {
    const workoutId = workout.id || crypto.randomUUID();
    const now = new Date().toISOString();
    
    const data = this.getData();
    
    // Check if workout already exists (update if so)
    const existingIndex = data.workouts.findIndex(w => w.id === workoutId);
    
    const newWorkout: WorkoutEntry = {
      id: workoutId,
      type: workout.type || 'general',
      calories_burned: workout.calories_burned,
      strain: workout.strain,
      is_barrys: workout.is_barrys || false,
      is_double_floor: workout.is_double_floor || false,
      logged_at: now
    };
    
    if (existingIndex >= 0) {
      // Update existing
      data.workouts[existingIndex] = newWorkout;
    } else {
      // Add new
      data.workouts.push(newWorkout);
    }
    
    // Update summary
    if (workout.workout_count !== undefined) {
      data.summary.workouts_completed = workout.workout_count;
    } else if (existingIndex < 0) {
      data.summary.workouts_completed += 1;
    }
    
    // Recalculate workout totals
    let totalCaloriesBurned = 0;
    let totalStrain = 0;
    let hasBarrys = false;
    let isDoubleFloor = false;
    
    for (const w of data.workouts) {
      totalCaloriesBurned += w.calories_burned;
      totalStrain += w.strain;
      if (w.is_barrys) {
        hasBarrys = true;
        isDoubleFloor = w.is_double_floor;
      }
    }
    
    data.summary.total_calories_burned = totalCaloriesBurned;
    data.summary.total_strain = totalStrain;
    data.summary.barrys_completed = hasBarrys;
    data.summary.is_double_floor = isDoubleFloor;
    
    if (workout.day_strain !== undefined) {
      data.summary.day_strain = workout.day_strain;
    }
    
    this.cachedData = data;
    await this.saveData();
    
    return Response.json({ id: workoutId, summary: data.summary });
  }

  /**
   * Update habits
   */
  private async handleUpdateHabits(habits: {
    drinks_count?: number;
    smoked_weed?: boolean;
    water_bottles?: number;
    took_electrolytes?: boolean;
    steps?: number;
  }): Promise<Response> {
    const data = this.getData();
    
    if (habits.drinks_count !== undefined) data.summary.drinks_count = habits.drinks_count;
    if (habits.smoked_weed !== undefined) data.summary.smoked_weed = habits.smoked_weed;
    if (habits.water_bottles !== undefined) data.summary.water_bottles = habits.water_bottles;
    if (habits.took_electrolytes !== undefined) data.summary.took_electrolytes = habits.took_electrolytes;
    if (habits.steps !== undefined) data.summary.steps = habits.steps;
    
    this.cachedData = data;
    await this.saveData();
    
    return Response.json(data.summary);
  }

  /**
   * Update recovery data from Whoop
   */
  private async handleUpdateRecovery(recovery: {
    recovery_score: number;
    sleep_score?: number;
    hrv?: number;
    resting_hr?: number;
    sleep_hours?: number;
    weight_kg?: number;
  }): Promise<Response> {
    const data = this.getData();
    
    data.summary.recovery_score = recovery.recovery_score;
    if (recovery.sleep_score !== undefined) data.summary.sleep_score = recovery.sleep_score;
    if (recovery.hrv !== undefined) data.summary.hrv = recovery.hrv;
    if (recovery.resting_hr !== undefined) data.summary.resting_hr = recovery.resting_hr;
    if (recovery.sleep_hours !== undefined) data.summary.sleep_hours = recovery.sleep_hours;
    if (recovery.weight_kg !== undefined) {
      data.summary.weight_kg = recovery.weight_kg;
      data.summary.weight = Math.round(recovery.weight_kg * 2.205 * 10) / 10;
    }
    
    this.cachedData = data;
    await this.saveData();
    
    return Response.json(data.summary);
  }

  /**
   * Update weight
   */
  private async handleUpdateWeight(weight: {
    weight: number;
    weight_kg?: number;
  }): Promise<Response> {
    const data = this.getData();
    
    data.summary.weight = weight.weight;
    if (weight.weight_kg !== undefined) {
      data.summary.weight_kg = weight.weight_kg;
    }
    
    this.cachedData = data;
    await this.saveData();
    
    return Response.json(data.summary);
  }
}
