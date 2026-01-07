/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from 'cloudflare:workers';

/**
 * DailyTrackerV2 Durable Object - SQLite-backed
 * 
 * Manages real-time daily statistics for a user with full SQL query capabilities.
 * Each user gets their own instance keyed by `userId:date`
 * 
 * Benefits of SQLite storage:
 * - Query meals by type, time, macros
 * - Aggregate calculations in SQL
 * - Persistent storage with ACID guarantees
 * - Can analyze patterns within a day
 */

interface DailyGoals {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  water_bottles: number;
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

interface DailyMeta {
  date: string;
  user_id: string;
  goals: DailyGoals;
  // Non-meal data stored in KV for simplicity
  workouts_completed: number;
  total_calories_burned: number;
  total_strain: number;
  day_strain?: number;
  barrys_completed: boolean;
  is_double_floor?: boolean;
  recovery_score?: number;
  sleep_score?: number;
  sleep_hours?: number;
  hrv?: number;
  resting_hr?: number;
  weight?: number;
  weight_kg?: number;
  drinks_count: number;
  smoked_weed: boolean;
  water_bottles: number;
  took_electrolytes: boolean;
  steps?: number;
}

export class DailyTrackerV2 extends DurableObject<Record<string, unknown>> {
  private sql: SqlStorage;
  private initialized: boolean = false;
  
  // In-memory cache for fast reads
  private cachedMeta: DailyMeta | null = null;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    
    // Block requests until initialization completes
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      await this.loadMeta();
    });
  }

  /**
   * Run SQLite migrations - creates tables for meals and workouts
   */
  private migrate(): void {
    // Meals table - stores individual meals for the day
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meals (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        meal_type TEXT NOT NULL CHECK(meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
        calories REAL NOT NULL DEFAULT 0,
        protein REAL NOT NULL DEFAULT 0,
        carbs REAL NOT NULL DEFAULT 0,
        fat REAL NOT NULL DEFAULT 0,
        logged_at TEXT NOT NULL
      )
    `);
    
    // Workouts table - stores workouts for the day
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS workouts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        calories_burned REAL DEFAULT 0,
        strain REAL DEFAULT 0,
        is_barrys INTEGER DEFAULT 0,
        is_double_floor INTEGER DEFAULT 0,
        logged_at TEXT NOT NULL
      )
    `);
    
    // Indexes for common queries
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_meals_type ON meals(meal_type)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_meals_logged ON meals(logged_at)`);
  }

  /**
   * Load metadata from KV (non-queryable stuff like goals, habits)
   */
  private async loadMeta(): Promise<void> {
    const stored = await this.ctx.storage.get<DailyMeta>('meta');
    if (stored) {
      this.cachedMeta = stored;
      this.initialized = true;
    }
  }

  /**
   * Save metadata to KV
   */
  private async saveMeta(): Promise<void> {
    if (this.cachedMeta) {
      await this.ctx.storage.put('meta', this.cachedMeta);
    }
  }

  /**
   * Get nutrition totals from SQLite
   */
  private getNutritionTotals(): { calories: number; protein: number; carbs: number; fat: number; count: number } {
    const result = this.sql.exec(`
      SELECT 
        COALESCE(SUM(calories), 0) as total_calories,
        COALESCE(SUM(protein), 0) as total_protein,
        COALESCE(SUM(carbs), 0) as total_carbs,
        COALESCE(SUM(fat), 0) as total_fat,
        COUNT(*) as count
      FROM meals
    `).toArray()[0] as { total_calories: number; total_protein: number; total_carbs: number; total_fat: number; count: number };
    
    return {
      calories: result.total_calories,
      protein: result.total_protein,
      carbs: result.total_carbs,
      fat: result.total_fat,
      count: result.count
    };
  }

  /**
   * Get workout totals from SQLite
   */
  private getWorkoutTotals(): { count: number; calories: number; strain: number; has_barrys: boolean; is_double_floor: boolean } {
    const result = this.sql.exec(`
      SELECT 
        COUNT(*) as count,
        COALESCE(SUM(calories_burned), 0) as total_calories,
        COALESCE(SUM(strain), 0) as total_strain,
        MAX(is_barrys) as has_barrys,
        MAX(CASE WHEN is_barrys = 1 THEN is_double_floor ELSE 0 END) as is_double_floor
      FROM workouts
    `).toArray()[0] as { count: number; total_calories: number; total_strain: number; has_barrys: number; is_double_floor: number };
    
    return {
      count: result.count,
      calories: result.total_calories,
      strain: result.total_strain,
      has_barrys: result.has_barrys === 1,
      is_double_floor: result.is_double_floor === 1
    };
  }

  /**
   * Default metadata
   */
  private getDefaultMeta(): DailyMeta {
    return {
      date: new Date().toISOString().split('T')[0],
      user_id: '',
      goals: { calories: 1800, protein: 135, carbs: 180, fat: 60, water_bottles: 3 },
      workouts_completed: 0,
      total_calories_burned: 0,
      total_strain: 0,
      day_strain: undefined,
      barrys_completed: false,
      is_double_floor: undefined,
      recovery_score: undefined,
      sleep_score: undefined,
      sleep_hours: undefined,
      hrv: undefined,
      resting_hr: undefined,
      weight: undefined,
      weight_kg: undefined,
      drinks_count: 0,
      smoked_weed: false,
      water_bottles: 0,
      took_electrolytes: false,
      steps: undefined
    };
  }

  /**
   * Build full summary from SQLite + KV
   */
  private buildSummary(): DailySummary {
    const nutrition = this.getNutritionTotals();
    const workouts = this.getWorkoutTotals();
    const meta = this.cachedMeta || this.getDefaultMeta();
    
    const goals = meta.goals;
    const calorie_goal_hit = nutrition.calories >= goals.calories * 0.9 && nutrition.calories <= goals.calories * 1.1;
    const protein_goal_hit = nutrition.protein >= goals.protein;
    const water_goal_hit = meta.water_bottles >= goals.water_bottles;
    
    return {
      date: meta.date,
      user_id: meta.user_id,
      total_calories: nutrition.calories,
      total_protein: nutrition.protein,
      total_carbs: nutrition.carbs,
      total_fat: nutrition.fat,
      meals_logged: nutrition.count,
      workouts_completed: workouts.count || meta.workouts_completed,
      total_calories_burned: workouts.calories || meta.total_calories_burned,
      total_strain: workouts.strain || meta.total_strain,
      day_strain: meta.day_strain,
      barrys_completed: workouts.has_barrys || meta.barrys_completed,
      is_double_floor: workouts.is_double_floor || meta.is_double_floor,
      recovery_score: meta.recovery_score,
      sleep_score: meta.sleep_score,
      sleep_hours: meta.sleep_hours,
      hrv: meta.hrv,
      resting_hr: meta.resting_hr,
      weight: meta.weight,
      weight_kg: meta.weight_kg,
      drinks_count: meta.drinks_count,
      smoked_weed: meta.smoked_weed,
      water_bottles: meta.water_bottles,
      took_electrolytes: meta.took_electrolytes,
      steps: meta.steps,
      goals,
      calorie_goal_hit,
      protein_goal_hit,
      water_goal_hit,
      updated_at: new Date().toISOString()
    };
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
          if (path === '/meals/by-type') return this.handleGetMealsByType();
          if (path === '/workouts') return this.handleGetWorkouts();
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
          if (path === '/workout') return this.handleRemoveWorkout(await request.json());
          break;
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('DailyTrackerV2 error:', error);
      return Response.json({ error: 'Internal error', details: String(error) }, { status: 500 });
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
    const meta = this.cachedMeta || this.getDefaultMeta();
    meta.date = data.date;
    meta.user_id = data.user_id;
    
    if (data.goals) {
      meta.goals = { ...meta.goals, ...data.goals };
    }
    
    // Merge existing data (from D1 on startup)
    if (data.existingData) {
      if (data.existingData.drinks_count !== undefined) meta.drinks_count = data.existingData.drinks_count;
      if (data.existingData.smoked_weed !== undefined) meta.smoked_weed = data.existingData.smoked_weed;
      if (data.existingData.water_bottles !== undefined) meta.water_bottles = data.existingData.water_bottles;
      if (data.existingData.took_electrolytes !== undefined) meta.took_electrolytes = data.existingData.took_electrolytes;
      if (data.existingData.recovery_score !== undefined) meta.recovery_score = data.existingData.recovery_score;
      if (data.existingData.sleep_score !== undefined) meta.sleep_score = data.existingData.sleep_score;
      if (data.existingData.sleep_hours !== undefined) meta.sleep_hours = data.existingData.sleep_hours;
      if (data.existingData.hrv !== undefined) meta.hrv = data.existingData.hrv;
      if (data.existingData.resting_hr !== undefined) meta.resting_hr = data.existingData.resting_hr;
      if (data.existingData.weight !== undefined) meta.weight = data.existingData.weight;
      if (data.existingData.weight_kg !== undefined) meta.weight_kg = data.existingData.weight_kg;
      if (data.existingData.day_strain !== undefined) meta.day_strain = data.existingData.day_strain;
      if (data.existingData.steps !== undefined) meta.steps = data.existingData.steps;
    }
    
    this.cachedMeta = meta;
    this.initialized = true;
    await this.saveMeta();
    
    // Schedule end-of-day alarm
    const endOfDay = new Date(data.date);
    endOfDay.setHours(23, 59, 0, 0);
    if (endOfDay.getTime() > Date.now()) {
      const existingAlarm = await this.ctx.storage.getAlarm();
      if (!existingAlarm) {
        await this.ctx.storage.setAlarm(endOfDay.getTime());
      }
    }
    
    return Response.json(this.buildSummary());
  }

  /**
   * Alarm handler
   */
  async alarm(): Promise<void> {
    console.log('DailyTrackerV2 alarm fired for date:', this.cachedMeta?.date);
    await this.saveMeta();
  }

  /**
   * Get summary
   */
  private handleGetSummary(): Response {
    return Response.json(this.buildSummary());
  }

  /**
   * Get all meals
   */
  private handleGetMeals(): Response {
    const meals = this.sql.exec(`SELECT * FROM meals ORDER BY logged_at ASC`).toArray();
    return Response.json(meals);
  }

  /**
   * Get meals grouped by type
   */
  private handleGetMealsByType(): Response {
    const meals = this.sql.exec(`SELECT * FROM meals ORDER BY logged_at ASC`).toArray();
    
    const grouped: Record<string, unknown[]> = {
      breakfast: [],
      lunch: [],
      dinner: [],
      snack: []
    };
    
    for (const meal of meals) {
      const type = meal.meal_type as string;
      if (grouped[type]) {
        grouped[type].push(meal);
      }
    }
    
    return Response.json(grouped);
  }

  /**
   * Get all workouts
   */
  private handleGetWorkouts(): Response {
    const workouts = this.sql.exec(`SELECT * FROM workouts ORDER BY logged_at ASC`).toArray();
    return Response.json(workouts);
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
    
    this.sql.exec(
      `INSERT OR REPLACE INTO meals (id, name, meal_type, calories, protein, carbs, fat, logged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      mealId, meal.name, meal.meal_type, meal.calories, meal.protein, meal.carbs, meal.fat, now
    );
    
    return Response.json({ id: mealId, summary: this.buildSummary() });
  }

  /**
   * Remove a meal
   */
  private async handleRemoveMeal(data: { mealId: string }): Promise<Response> {
    const existing = this.sql.exec('SELECT id FROM meals WHERE id = ?', data.mealId).toArray();
    if (existing.length === 0) {
      return Response.json({ error: 'Meal not found' }, { status: 404 });
    }
    
    this.sql.exec('DELETE FROM meals WHERE id = ?', data.mealId);
    return Response.json({ success: true, summary: this.buildSummary() });
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
    
    this.sql.exec(
      `INSERT OR REPLACE INTO workouts (id, type, calories_burned, strain, is_barrys, is_double_floor, logged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      workoutId,
      workout.type || 'general',
      workout.calories_burned,
      workout.strain,
      workout.is_barrys ? 1 : 0,
      workout.is_double_floor ? 1 : 0,
      now
    );
    
    // Update meta with day strain if provided
    if (workout.day_strain !== undefined && this.cachedMeta) {
      this.cachedMeta.day_strain = workout.day_strain;
      await this.saveMeta();
    }
    
    return Response.json({ id: workoutId, summary: this.buildSummary() });
  }

  /**
   * Remove a workout
   */
  private async handleRemoveWorkout(data: { workoutId: string }): Promise<Response> {
    this.sql.exec('DELETE FROM workouts WHERE id = ?', data.workoutId);
    return Response.json({ success: true, summary: this.buildSummary() });
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
    const meta = this.cachedMeta || this.getDefaultMeta();
    
    if (habits.drinks_count !== undefined) meta.drinks_count = habits.drinks_count;
    if (habits.smoked_weed !== undefined) meta.smoked_weed = habits.smoked_weed;
    if (habits.water_bottles !== undefined) meta.water_bottles = habits.water_bottles;
    if (habits.took_electrolytes !== undefined) meta.took_electrolytes = habits.took_electrolytes;
    if (habits.steps !== undefined) meta.steps = habits.steps;
    
    this.cachedMeta = meta;
    await this.saveMeta();
    
    return Response.json(this.buildSummary());
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
    const meta = this.cachedMeta || this.getDefaultMeta();
    
    meta.recovery_score = recovery.recovery_score;
    if (recovery.sleep_score !== undefined) meta.sleep_score = recovery.sleep_score;
    if (recovery.hrv !== undefined) meta.hrv = recovery.hrv;
    if (recovery.resting_hr !== undefined) meta.resting_hr = recovery.resting_hr;
    if (recovery.sleep_hours !== undefined) meta.sleep_hours = recovery.sleep_hours;
    if (recovery.weight_kg !== undefined) {
      meta.weight_kg = recovery.weight_kg;
      meta.weight = Math.round(recovery.weight_kg * 2.205 * 10) / 10;
    }
    
    this.cachedMeta = meta;
    await this.saveMeta();
    
    return Response.json(this.buildSummary());
  }

  /**
   * Update weight
   */
  private async handleUpdateWeight(weight: {
    weight: number;
    weight_kg?: number;
  }): Promise<Response> {
    const meta = this.cachedMeta || this.getDefaultMeta();
    
    meta.weight = weight.weight;
    if (weight.weight_kg !== undefined) {
      meta.weight_kg = weight.weight_kg;
    }
    
    this.cachedMeta = meta;
    await this.saveMeta();
    
    return Response.json(this.buildSummary());
  }
}
