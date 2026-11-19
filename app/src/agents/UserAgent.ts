/// <reference types="@cloudflare/workers-types" />

import { Agent, type Connection, type ConnectionContext } from 'agents';
import { Env } from '../types/env';

/**
 * UserAgent - Cloudflare Agents SDK powered agent
 * 
 * One agent per user, handling:
 * - Daily meal tracking (SQLite - last 30 days)
 * - Workout logging
 * - Habit tracking (water, drinks, weed, electrolytes)
 * - Streak management
 * - Scheduled tasks (Whoop sync, end-of-day summaries, data cleanup)
 * 
 * Key features:
 * - Uses this.sql tagged template for SQLite queries
 * - Uses this.setState() for reactive state (WebSocket clients auto-update)
 * - Uses this.schedule() for recurring tasks
 * - RPC methods callable from routes
 */

// Agent state - synced to connected clients via WebSocket
export interface UserState {
  userId: string;
  today: string;
  // Today's totals
  totalCalories: number;
  totalProtein: number;
  totalCarbs: number;
  totalFat: number;
  mealsLogged: number;
  // Workout data
  workoutsCompleted: number;
  totalCaloriesBurned: number;
  totalStrain: number;
  dayStrain?: number;
  barrysCompleted: boolean;
  isDoubleFloor?: boolean;
  // Recovery (from Whoop)
  recoveryScore?: number;
  sleepScore?: number;
  sleepHours?: number;
  hrv?: number;
  restingHr?: number;
  // Weight
  weight?: number;
  weightKg?: number;
  // Habits
  drinksCount: number;
  smokedWeed: boolean;
  waterBottles: number;
  tookElectrolytes: boolean;
  steps?: number;
  // Goals
  goals: {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    waterBottles: number;
  };
  // Streaks
  streaks: Record<StreakType, Streak>;
  // Last updated
  lastUpdated: string;
}

export type StreakType = 'no_drinks' | 'no_weed' | 'workout' | 'calorie_goal' | 'protein_goal' | 'water_goal' | 'barrys';

export interface Streak {
  type: StreakType;
  currentCount: number;
  bestCount: number;
  lastAchievedDate: string;
}

export interface Meal {
  id: string;
  name: string;
  mealType: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  loggedAt: string;
  date: string;
}

export interface Workout {
  id: string;
  type: string;
  caloriesBurned: number;
  strain: number;
  isBarrys: boolean;
  isDoubleFloor: boolean;
  loggedAt: string;
  date: string;
}

const STREAK_TYPES: StreakType[] = ['no_drinks', 'no_weed', 'workout', 'calorie_goal', 'protein_goal', 'water_goal', 'barrys'];

const DEFAULT_GOALS = {
  calories: 1800,
  protein: 135,
  carbs: 180,
  fat: 60,
  waterBottles: 3
};

export class UserAgent extends Agent<Env, UserState> {
  
  /**
   * Called when agent is first created - set up SQLite schema
   */
  async onStart(): Promise<void> {
    console.log('UserAgent starting...');
    this.migrate();
    await this.initializeState();
    await this.setupSchedules();
  }

  /**
   * Run SQLite migrations - creates tables for meals, workouts, habits, streaks
   */
  private migrate(): void {
    // Meals table - stores meals for the last 30 days
    this.sql`
      CREATE TABLE IF NOT EXISTS meals (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        meal_type TEXT NOT NULL CHECK(meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
        calories REAL NOT NULL DEFAULT 0,
        protein REAL NOT NULL DEFAULT 0,
        carbs REAL NOT NULL DEFAULT 0,
        fat REAL NOT NULL DEFAULT 0,
        logged_at TEXT NOT NULL,
        date TEXT NOT NULL
      )
    `;
    
    // Workouts table
    this.sql`
      CREATE TABLE IF NOT EXISTS workouts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        calories_burned REAL DEFAULT 0,
        strain REAL DEFAULT 0,
        is_barrys INTEGER DEFAULT 0,
        is_double_floor INTEGER DEFAULT 0,
        logged_at TEXT NOT NULL,
        date TEXT NOT NULL
      )
    `;
    
    // Daily habits table - one row per day
    this.sql`
      CREATE TABLE IF NOT EXISTS daily_habits (
        date TEXT PRIMARY KEY,
        drinks_count INTEGER DEFAULT 0,
        smoked_weed INTEGER DEFAULT 0,
        water_bottles INTEGER DEFAULT 0,
        took_electrolytes INTEGER DEFAULT 0,
        steps INTEGER,
        recovery_score REAL,
        sleep_score REAL,
        sleep_hours REAL,
        hrv REAL,
        resting_hr REAL,
        weight REAL,
        weight_kg REAL,
        day_strain REAL,
        updated_at TEXT NOT NULL
      )
    `;
    
    // Streaks table
    this.sql`
      CREATE TABLE IF NOT EXISTS streaks (
        type TEXT PRIMARY KEY,
        current_count INTEGER NOT NULL DEFAULT 0,
        best_count INTEGER NOT NULL DEFAULT 0,
        last_achieved_date TEXT
      )
    `;
    
    // Streak history for analytics
    this.sql`
      CREATE TABLE IF NOT EXISTS streak_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        streak_type TEXT NOT NULL,
        date TEXT NOT NULL,
        achieved INTEGER NOT NULL DEFAULT 0,
        count_at_date INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(streak_type, date)
      )
    `;
    
    // Indexes
    this.sql`CREATE INDEX IF NOT EXISTS idx_meals_date ON meals(date)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_meals_type ON meals(meal_type)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_workouts_date ON workouts(date)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_streak_history_date ON streak_history(date)`;
    
    // Initialize streak types if not present
    for (const type of STREAK_TYPES) {
      this.sql`INSERT OR IGNORE INTO streaks (type, current_count, best_count) VALUES (${type}, 0, 0)`;
    }
  }

  /**
   * Initialize agent state from SQLite
   */
  private async initializeState(): Promise<void> {
    const today = this.getToday();
    const userId = this.name; // Agent name is the user ID
    
    // Get today's nutrition totals
    const nutritionRows = this.sql<{ total_calories: number; total_protein: number; total_carbs: number; total_fat: number; count: number }>`
      SELECT 
        COALESCE(SUM(calories), 0) as total_calories,
        COALESCE(SUM(protein), 0) as total_protein,
        COALESCE(SUM(carbs), 0) as total_carbs,
        COALESCE(SUM(fat), 0) as total_fat,
        COUNT(*) as count
      FROM meals WHERE date = ${today}
    `;
    const nutrition = nutritionRows[0] || { total_calories: 0, total_protein: 0, total_carbs: 0, total_fat: 0, count: 0 };
    
    // Get today's workout totals
    const workoutRows = this.sql<{ count: number; total_calories: number; total_strain: number; has_barrys: number; is_double_floor: number }>`
      SELECT 
        COUNT(*) as count,
        COALESCE(SUM(calories_burned), 0) as total_calories,
        COALESCE(SUM(strain), 0) as total_strain,
        MAX(is_barrys) as has_barrys,
        MAX(CASE WHEN is_barrys = 1 THEN is_double_floor ELSE 0 END) as is_double_floor
      FROM workouts WHERE date = ${today}
    `;
    const workouts = workoutRows[0] || { count: 0, total_calories: 0, total_strain: 0, has_barrys: 0, is_double_floor: 0 };
    
    // Get today's habits
    const habitsRows = this.sql<{
      drinks_count: number;
      smoked_weed: number;
      water_bottles: number;
      took_electrolytes: number;
      steps: number | null;
      recovery_score: number | null;
      sleep_score: number | null;
      sleep_hours: number | null;
      hrv: number | null;
      resting_hr: number | null;
      weight: number | null;
      weight_kg: number | null;
      day_strain: number | null;
    }>`SELECT * FROM daily_habits WHERE date = ${today}`;
    const habits = habitsRows[0];
    
    // Get all streaks
    const streakRows = this.sql<{ type: string; current_count: number; best_count: number; last_achieved_date: string | null }>`
      SELECT * FROM streaks
    `;
    const streaks: Record<StreakType, Streak> = {} as Record<StreakType, Streak>;
    for (const row of streakRows) {
      streaks[row.type as StreakType] = {
        type: row.type as StreakType,
        currentCount: row.current_count,
        bestCount: row.best_count,
        lastAchievedDate: row.last_achieved_date || ''
      };
    }
    
    // Set initial state
    this.setState({
      userId,
      today,
      totalCalories: nutrition.total_calories,
      totalProtein: nutrition.total_protein,
      totalCarbs: nutrition.total_carbs,
      totalFat: nutrition.total_fat,
      mealsLogged: nutrition.count,
      workoutsCompleted: workouts.count,
      totalCaloriesBurned: workouts.total_calories,
      totalStrain: workouts.total_strain,
      dayStrain: habits?.day_strain ?? undefined,
      barrysCompleted: workouts.has_barrys === 1,
      isDoubleFloor: workouts.is_double_floor === 1,
      recoveryScore: habits?.recovery_score ?? undefined,
      sleepScore: habits?.sleep_score ?? undefined,
      sleepHours: habits?.sleep_hours ?? undefined,
      hrv: habits?.hrv ?? undefined,
      restingHr: habits?.resting_hr ?? undefined,
      weight: habits?.weight ?? undefined,
      weightKg: habits?.weight_kg ?? undefined,
      drinksCount: habits?.drinks_count ?? 0,
      smokedWeed: (habits?.smoked_weed ?? 0) === 1,
      waterBottles: habits?.water_bottles ?? 0,
      tookElectrolytes: (habits?.took_electrolytes ?? 0) === 1,
      steps: habits?.steps ?? undefined,
      goals: DEFAULT_GOALS,
      streaks,
      lastUpdated: new Date().toISOString()
    });
  }

  /**
   * Set up scheduled tasks using agent scheduling
   */
  private async setupSchedules(): Promise<void> {
    // End-of-day summary at 11:59 PM (uses cron syntax)
    await this.schedule('59 23 * * *', 'scheduledEndOfDay', {});
    
    // Whoop token refresh & sync every hour (proactive refresh before 1hr expiration)
    await this.schedule('0 * * * *', 'scheduledWhoopSync', {});
    
    // Data cleanup - remove meals/workouts older than 30 days (runs at 3 AM)
    await this.schedule('0 3 * * *', 'scheduledDataCleanup', {});
  }

  /**
   * Scheduled task: End of day handler
   */
  async scheduledEndOfDay(): Promise<void> {
    console.log(`End of day sync for user: ${this.name}`);
    await this.checkDayStreaks();
    console.log('End of day sync completed');
  }

  /**
   * Scheduled task: Whoop sync handler
   * Proactively refreshes tokens before they expire (1 hour lifetime)
   * and syncs Whoop data
   */
  async scheduledWhoopSync(): Promise<void> {
    const userId = this.name;
    console.log(`Whoop sync scheduled for user: ${userId}`);
    
    try {
      // Get user's Whoop tokens from D1
      const user = await this.env.DB.prepare(`
        SELECT whoop_access_token, whoop_refresh_token, whoop_token_expires_at, whoop_connected
        FROM users WHERE id = ?
      `).bind(userId).first() as {
        whoop_access_token: string | null;
        whoop_refresh_token: string | null;
        whoop_token_expires_at: string | null;
        whoop_connected: number;
      } | null;
      
      if (!user || !user.whoop_connected || !user.whoop_access_token) {
        console.log(`User ${userId} has no Whoop connection, skipping sync`);
        return;
      }
      
      let accessToken = user.whoop_access_token;
      
      // Check if token needs refresh (expires in less than 15 minutes)
      const expiresAt = user.whoop_token_expires_at ? new Date(user.whoop_token_expires_at) : null;
      const fifteenMinutesFromNow = Date.now() + 15 * 60 * 1000;
      const needsRefresh = !expiresAt || expiresAt.getTime() < fifteenMinutesFromNow;
      
      if (needsRefresh && user.whoop_refresh_token) {
        console.log(`Token for ${userId} expires soon, refreshing proactively...`);
        
        try {
          // Refresh the token
          const response = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: user.whoop_refresh_token,
              client_id: this.env.WHOOP_CLIENT_ID,
              client_secret: this.env.WHOOP_CLIENT_SECRET
            })
          });
          
          if (!response.ok) {
            const errorText = await response.text();
            console.error(`Token refresh failed for ${userId}: ${response.status} - ${errorText}`);
            
            // Mark as disconnected if refresh fails
            await this.env.DB.prepare(`
              UPDATE users SET whoop_connected = 0, updated_at = datetime('now') WHERE id = ?
            `).bind(userId).run();
            return;
          }
          
          const tokens = await response.json() as { 
            access_token: string; 
            refresh_token: string; 
            expires_in: number 
          };
          
          accessToken = tokens.access_token;
          const newExpiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();
          
          // Update tokens in D1
          await this.env.DB.prepare(`
            UPDATE users SET 
              whoop_access_token = ?,
              whoop_refresh_token = ?,
              whoop_token_expires_at = ?,
              updated_at = datetime('now')
            WHERE id = ?
          `).bind(tokens.access_token, tokens.refresh_token, newExpiresAt, userId).run();
          
          console.log(`Token refreshed for ${userId}, new expiration: ${newExpiresAt}`);
        } catch (refreshError) {
          console.error(`Token refresh error for ${userId}:`, refreshError);
          return;
        }
      }
      
      // Now sync Whoop data (just today's recovery for the agent state)
      // Full historical sync is handled by the cron/queue
      try {
        const today = this.getToday();
        const dailyResponse = await fetch(`https://api.prod.whoop.com/developer/v2/recovery?start=${today}T00:00:00.000Z&end=${today}T23:59:59.999Z&limit=1`, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        
        if (dailyResponse.ok) {
          const data = await dailyResponse.json() as { 
            records: Array<{ 
              score: { 
                recovery_score: number; 
                hrv_rmssd_milli: number; 
                resting_heart_rate: number 
              } 
            }> 
          };
          
          if (data.records && data.records.length > 0) {
            const recovery = data.records[0].score;
            await this.updateRecovery({
              recoveryScore: recovery.recovery_score,
              hrv: recovery.hrv_rmssd_milli,
              restingHr: recovery.resting_heart_rate
            });
            console.log(`Updated recovery data for ${userId}: ${recovery.recovery_score}%`);
          }
        }
      } catch (syncError) {
        console.error(`Whoop data sync error for ${userId}:`, syncError);
      }
      
    } catch (error) {
      console.error(`Whoop sync failed for ${userId}:`, error);
    }
  }

  /**
   * Scheduled task: Cleanup old data (keep only 30 days in agent SQLite)
   */
  async scheduledDataCleanup(): Promise<void> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 30);
    const cutoff = cutoffDate.toISOString().split('T')[0];
    
    this.sql`DELETE FROM meals WHERE date < ${cutoff}`;
    this.sql`DELETE FROM workouts WHERE date < ${cutoff}`;
    this.sql`DELETE FROM daily_habits WHERE date < ${cutoff}`;
    this.sql`DELETE FROM streak_history WHERE date < ${cutoff}`;
    
    console.log(`Cleaned up data older than ${cutoff}`);
  }

  /**
   * Handle WebSocket connections for real-time updates
   */
  onConnect(connection: Connection, ctx: ConnectionContext): void {
    console.log(`Client connected to UserAgent: ${this.name}`);
    // State is automatically synced to connected clients
  }

  onDisconnect(connection: Connection): void {
    console.log(`Client disconnected from UserAgent: ${this.name}`);
  }

  // ============ RPC METHODS (callable from routes) ============

  /**
   * Add a meal
   */
  async addMeal(meal: {
    id?: string;
    name: string;
    mealType: 'breakfast' | 'lunch' | 'dinner' | 'snack';
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
  }): Promise<{ id: string; state: UserState }> {
    const mealId = meal.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const today = this.getToday();
    
    this.sql`
      INSERT OR REPLACE INTO meals (id, name, meal_type, calories, protein, carbs, fat, logged_at, date)
      VALUES (${mealId}, ${meal.name}, ${meal.mealType}, ${meal.calories}, ${meal.protein}, ${meal.carbs}, ${meal.fat}, ${now}, ${today})
    `;
    
    // Update state
    this.setState({
      ...this.state,
      totalCalories: this.state.totalCalories + meal.calories,
      totalProtein: this.state.totalProtein + meal.protein,
      totalCarbs: this.state.totalCarbs + meal.carbs,
      totalFat: this.state.totalFat + meal.fat,
      mealsLogged: this.state.mealsLogged + 1,
      lastUpdated: now
    });
    
    return { id: mealId, state: this.state };
  }

  /**
   * Remove a meal
   */
  async removeMeal(mealId: string): Promise<{ success: boolean; state: UserState }> {
    // Get meal data first
    const mealRows = this.sql<{ calories: number; protein: number; carbs: number; fat: number }>`
      SELECT calories, protein, carbs, fat FROM meals WHERE id = ${mealId}
    `;
    
    if (mealRows.length === 0) {
      return { success: false, state: this.state };
    }
    
    const meal = mealRows[0];
    
    // Delete meal
    this.sql`DELETE FROM meals WHERE id = ${mealId}`;
    
    // Update state
    this.setState({
      ...this.state,
      totalCalories: Math.max(0, this.state.totalCalories - meal.calories),
      totalProtein: Math.max(0, this.state.totalProtein - meal.protein),
      totalCarbs: Math.max(0, this.state.totalCarbs - meal.carbs),
      totalFat: Math.max(0, this.state.totalFat - meal.fat),
      mealsLogged: Math.max(0, this.state.mealsLogged - 1),
      lastUpdated: new Date().toISOString()
    });
    
    return { success: true, state: this.state };
  }

  /**
   * Get meals for a specific date
   */
  getMeals(date?: string): Meal[] {
    const targetDate = date || this.getToday();
    const rows = this.sql<{
      id: string;
      name: string;
      meal_type: string;
      calories: number;
      protein: number;
      carbs: number;
      fat: number;
      logged_at: string;
      date: string;
    }>`SELECT * FROM meals WHERE date = ${targetDate} ORDER BY logged_at ASC`;
    
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      mealType: row.meal_type as Meal['mealType'],
      calories: row.calories,
      protein: row.protein,
      carbs: row.carbs,
      fat: row.fat,
      loggedAt: row.logged_at,
      date: row.date
    }));
  }

  /**
   * Get meals grouped by type
   */
  getMealsByType(date?: string): Record<string, Meal[]> {
    const meals = this.getMeals(date);
    const grouped: Record<string, Meal[]> = {
      breakfast: [],
      lunch: [],
      dinner: [],
      snack: []
    };
    
    for (const meal of meals) {
      if (grouped[meal.mealType]) {
        grouped[meal.mealType].push(meal);
      }
    }
    
    return grouped;
  }

  /**
   * Log a workout
   */
  async logWorkout(workout: {
    id?: string;
    type?: string;
    caloriesBurned: number;
    strain: number;
    isBarrys?: boolean;
    isDoubleFloor?: boolean;
    dayStrain?: number;
  }): Promise<{ id: string; state: UserState }> {
    const workoutId = workout.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const today = this.getToday();
    
    this.sql`
      INSERT OR REPLACE INTO workouts (id, type, calories_burned, strain, is_barrys, is_double_floor, logged_at, date)
      VALUES (${workoutId}, ${workout.type || 'general'}, ${workout.caloriesBurned}, ${workout.strain}, 
              ${workout.isBarrys ? 1 : 0}, ${workout.isDoubleFloor ? 1 : 0}, ${now}, ${today})
    `;
    
    // Update day strain in habits if provided
    if (workout.dayStrain !== undefined) {
      this.sql`
        INSERT INTO daily_habits (date, day_strain, updated_at)
        VALUES (${today}, ${workout.dayStrain}, ${now})
        ON CONFLICT(date) DO UPDATE SET day_strain = ${workout.dayStrain}, updated_at = ${now}
      `;
    }
    
    // Update state
    this.setState({
      ...this.state,
      workoutsCompleted: this.state.workoutsCompleted + 1,
      totalCaloriesBurned: this.state.totalCaloriesBurned + workout.caloriesBurned,
      totalStrain: this.state.totalStrain + workout.strain,
      dayStrain: workout.dayStrain ?? this.state.dayStrain,
      barrysCompleted: this.state.barrysCompleted || (workout.isBarrys ?? false),
      isDoubleFloor: this.state.isDoubleFloor || (workout.isBarrys && workout.isDoubleFloor) || false,
      lastUpdated: now
    });
    
    // Update workout streak
    if (workout.isBarrys) {
      await this.incrementStreak('barrys', today);
    }
    await this.incrementStreak('workout', today);
    
    return { id: workoutId, state: this.state };
  }

  /**
   * Update habits for today
   */
  async updateHabits(habits: {
    drinksCount?: number;
    smokedWeed?: boolean;
    waterBottles?: number;
    tookElectrolytes?: boolean;
    steps?: number;
  }): Promise<UserState> {
    const now = new Date().toISOString();
    const today = this.getToday();
    
    // Use null for undefined values in SQL
    const drinksCount = habits.drinksCount ?? null;
    const smokedWeed = habits.smokedWeed !== undefined ? (habits.smokedWeed ? 1 : 0) : null;
    const waterBottles = habits.waterBottles ?? null;
    const tookElectrolytes = habits.tookElectrolytes !== undefined ? (habits.tookElectrolytes ? 1 : 0) : null;
    const steps = habits.steps ?? null;
    
    // Upsert habits
    this.sql`
      INSERT INTO daily_habits (date, drinks_count, smoked_weed, water_bottles, took_electrolytes, steps, updated_at)
      VALUES (${today}, ${drinksCount ?? 0}, ${smokedWeed ?? 0}, ${waterBottles ?? 0}, ${tookElectrolytes ?? 0}, ${steps}, ${now})
      ON CONFLICT(date) DO UPDATE SET
        drinks_count = COALESCE(${drinksCount}, drinks_count),
        smoked_weed = COALESCE(${smokedWeed}, smoked_weed),
        water_bottles = COALESCE(${waterBottles}, water_bottles),
        took_electrolytes = COALESCE(${tookElectrolytes}, took_electrolytes),
        steps = COALESCE(${steps}, steps),
        updated_at = ${now}
    `;
    
    // Update state
    this.setState({
      ...this.state,
      drinksCount: habits.drinksCount ?? this.state.drinksCount,
      smokedWeed: habits.smokedWeed ?? this.state.smokedWeed,
      waterBottles: habits.waterBottles ?? this.state.waterBottles,
      tookElectrolytes: habits.tookElectrolytes ?? this.state.tookElectrolytes,
      steps: habits.steps ?? this.state.steps,
      lastUpdated: now
    });
    
    return this.state;
  }

  /**
   * Update recovery data (from Whoop)
   */
  async updateRecovery(recovery: {
    recoveryScore: number;
    sleepScore?: number;
    hrv?: number;
    restingHr?: number;
    sleepHours?: number;
    weightKg?: number;
  }): Promise<UserState> {
    const now = new Date().toISOString();
    const today = this.getToday();
    const weight = recovery.weightKg ? Math.round(recovery.weightKg * 2.205 * 10) / 10 : null;
    
    // Use null for undefined values
    const sleepScore = recovery.sleepScore ?? null;
    const hrv = recovery.hrv ?? null;
    const restingHr = recovery.restingHr ?? null;
    const sleepHours = recovery.sleepHours ?? null;
    const weightKg = recovery.weightKg ?? null;
    
    this.sql`
      INSERT INTO daily_habits (date, recovery_score, sleep_score, hrv, resting_hr, sleep_hours, weight, weight_kg, updated_at)
      VALUES (${today}, ${recovery.recoveryScore}, ${sleepScore}, ${hrv}, ${restingHr}, ${sleepHours}, ${weight}, ${weightKg}, ${now})
      ON CONFLICT(date) DO UPDATE SET
        recovery_score = ${recovery.recoveryScore},
        sleep_score = COALESCE(${sleepScore}, sleep_score),
        hrv = COALESCE(${hrv}, hrv),
        resting_hr = COALESCE(${restingHr}, resting_hr),
        sleep_hours = COALESCE(${sleepHours}, sleep_hours),
        weight = COALESCE(${weight}, weight),
        weight_kg = COALESCE(${weightKg}, weight_kg),
        updated_at = ${now}
    `;
    
    // Update state
    this.setState({
      ...this.state,
      recoveryScore: recovery.recoveryScore,
      sleepScore: recovery.sleepScore ?? this.state.sleepScore,
      hrv: recovery.hrv ?? this.state.hrv,
      restingHr: recovery.restingHr ?? this.state.restingHr,
      sleepHours: recovery.sleepHours ?? this.state.sleepHours,
      weight: weight ?? this.state.weight,
      weightKg: recovery.weightKg ?? this.state.weightKg,
      lastUpdated: now
    });
    
    return this.state;
  }

  /**
   * Get all streaks
   */
  getStreaks(): Record<StreakType, Streak> {
    return this.state.streaks;
  }

  /**
   * Get streak statistics
   */
  getStreakStats(): {
    bestStreaks: Array<{ type: string; bestCount: number }>;
    totalDaysTracked: number;
    successRates: Array<{ streakType: string; totalDays: number; achievedDays: number; successRate: number }>;
  } {
    const bestStreaks = this.sql<{ type: string; best_count: number }>`
      SELECT type, best_count FROM streaks ORDER BY best_count DESC
    `.map(r => ({ type: r.type, bestCount: r.best_count }));
    
    const totalDaysResult = this.sql<{ count: number }>`
      SELECT COUNT(DISTINCT date) as count FROM daily_habits
    `;
    const totalDaysTracked = totalDaysResult[0]?.count || 0;
    
    const successRates = this.sql<{ streak_type: string; total_days: number; achieved_days: number; success_rate: number }>`
      SELECT 
        streak_type,
        COUNT(*) as total_days,
        SUM(achieved) as achieved_days,
        ROUND(SUM(achieved) * 100.0 / COUNT(*), 1) as success_rate
      FROM streak_history
      GROUP BY streak_type
    `.map(r => ({
      streakType: r.streak_type,
      totalDays: r.total_days,
      achievedDays: r.achieved_days,
      successRate: r.success_rate
    }));
    
    return { bestStreaks, totalDaysTracked, successRates };
  }

  /**
   * Increment a specific streak
   */
  private async incrementStreak(type: StreakType, date: string): Promise<Streak> {
    const rows = this.sql<{ current_count: number; best_count: number; last_achieved_date: string | null }>`
      SELECT * FROM streaks WHERE type = ${type}
    `;
    const current = rows[0];
    
    const lastDate = current?.last_achieved_date || '';
    const isConsecutive = this.isConsecutiveDay(lastDate, date);
    
    const newCount = isConsecutive ? (current?.current_count || 0) + 1 : 1;
    const newBest = Math.max(newCount, current?.best_count || 0);
    
    this.sql`
      UPDATE streaks SET current_count = ${newCount}, best_count = ${newBest}, last_achieved_date = ${date}
      WHERE type = ${type}
    `;
    
    // Record in history
    this.sql`
      INSERT OR REPLACE INTO streak_history (streak_type, date, achieved, count_at_date, created_at)
      VALUES (${type}, ${date}, 1, ${newCount}, ${new Date().toISOString()})
    `;
    
    const streak: Streak = { type, currentCount: newCount, bestCount: newBest, lastAchievedDate: date };
    
    // Update state
    this.setState({
      ...this.state,
      streaks: { ...this.state.streaks, [type]: streak },
      lastUpdated: new Date().toISOString()
    });
    
    return streak;
  }

  /**
   * Reset a streak (e.g., user drank alcohol)
   */
  async resetStreak(type: StreakType): Promise<Streak> {
    this.sql`UPDATE streaks SET current_count = 0 WHERE type = ${type}`;
    
    const rows = this.sql<{ best_count: number; last_achieved_date: string | null }>`
      SELECT best_count, last_achieved_date FROM streaks WHERE type = ${type}
    `;
    const current = rows[0];
    
    const streak: Streak = {
      type,
      currentCount: 0,
      bestCount: current?.best_count || 0,
      lastAchievedDate: current?.last_achieved_date || ''
    };
    
    // Update state
    this.setState({
      ...this.state,
      streaks: { ...this.state.streaks, [type]: streak },
      lastUpdated: new Date().toISOString()
    });
    
    return streak;
  }

  /**
   * Check and update all streaks based on today's data
   */
  async checkDayStreaks(): Promise<{ streaks: Record<StreakType, Streak>; celebrations: string[] }> {
    const today = this.getToday();
    const state = this.state;
    
    // Determine what was achieved today
    const achieved = {
      no_drinks: state.drinksCount === 0,
      no_weed: !state.smokedWeed,
      workout: state.workoutsCompleted > 0,
      barrys: state.barrysCompleted,
      calorie_goal: state.totalCalories >= state.goals.calories * 0.9 && state.totalCalories <= state.goals.calories * 1.1,
      protein_goal: state.totalProtein >= state.goals.protein,
      water_goal: state.waterBottles >= state.goals.waterBottles
    };
    
    // Update each streak
    for (const type of STREAK_TYPES) {
      if (achieved[type]) {
        await this.incrementStreak(type, today);
      } else {
        await this.resetStreak(type);
      }
    }
    
    // Get celebrations for milestones
    const celebrations = this.getCelebrations();
    
    return { streaks: this.state.streaks, celebrations };
  }

  /**
   * Get current state (for REST API)
   */
  getState(): UserState {
    return this.state;
  }

  /**
   * Get summary for a specific date (for historical view)
   */
  getDaySummary(date: string): {
    date: string;
    nutrition: { calories: number; protein: number; carbs: number; fat: number; mealsLogged: number };
    workouts: { count: number; caloriesBurned: number; strain: number; barrys: boolean };
    habits: { drinks: number; weed: boolean; water: number; electrolytes: boolean; steps?: number };
    recovery: { score?: number; sleep?: number; hrv?: number; restingHr?: number };
  } {
    // Nutrition
    const nutritionRows = this.sql<{ total_calories: number; total_protein: number; total_carbs: number; total_fat: number; count: number }>`
      SELECT 
        COALESCE(SUM(calories), 0) as total_calories,
        COALESCE(SUM(protein), 0) as total_protein,
        COALESCE(SUM(carbs), 0) as total_carbs,
        COALESCE(SUM(fat), 0) as total_fat,
        COUNT(*) as count
      FROM meals WHERE date = ${date}
    `;
    const nutrition = nutritionRows[0] || { total_calories: 0, total_protein: 0, total_carbs: 0, total_fat: 0, count: 0 };
    
    // Workouts
    const workoutRows = this.sql<{ count: number; total_calories: number; total_strain: number; has_barrys: number }>`
      SELECT 
        COUNT(*) as count,
        COALESCE(SUM(calories_burned), 0) as total_calories,
        COALESCE(SUM(strain), 0) as total_strain,
        MAX(is_barrys) as has_barrys
      FROM workouts WHERE date = ${date}
    `;
    const workouts = workoutRows[0] || { count: 0, total_calories: 0, total_strain: 0, has_barrys: 0 };
    
    // Habits & Recovery
    const habitsRows = this.sql<{
      drinks_count: number;
      smoked_weed: number;
      water_bottles: number;
      took_electrolytes: number;
      steps: number | null;
      recovery_score: number | null;
      sleep_hours: number | null;
      hrv: number | null;
      resting_hr: number | null;
    }>`SELECT * FROM daily_habits WHERE date = ${date}`;
    const habits = habitsRows[0];
    
    return {
      date,
      nutrition: {
        calories: nutrition.total_calories,
        protein: nutrition.total_protein,
        carbs: nutrition.total_carbs,
        fat: nutrition.total_fat,
        mealsLogged: nutrition.count
      },
      workouts: {
        count: workouts.count,
        caloriesBurned: workouts.total_calories,
        strain: workouts.total_strain,
        barrys: workouts.has_barrys === 1
      },
      habits: {
        drinks: habits?.drinks_count ?? 0,
        weed: (habits?.smoked_weed ?? 0) === 1,
        water: habits?.water_bottles ?? 0,
        electrolytes: (habits?.took_electrolytes ?? 0) === 1,
        steps: habits?.steps ?? undefined
      },
      recovery: {
        score: habits?.recovery_score ?? undefined,
        sleep: habits?.sleep_hours ?? undefined,
        hrv: habits?.hrv ?? undefined,
        restingHr: habits?.resting_hr ?? undefined
      }
    };
  }

  // ============ HELPER METHODS ============

  private getToday(): string {
    return new Date().toISOString().split('T')[0];
  }

  private isConsecutiveDay(lastDate: string, currentDate: string): boolean {
    if (!lastDate) return true;
    
    const last = new Date(lastDate);
    const current = new Date(currentDate);
    const diffTime = current.getTime() - last.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    
    return diffDays === 1;
  }

  private getCelebrations(): string[] {
    const celebrations: string[] = [];
    const milestones = [7, 14, 21, 30, 60, 90, 100, 365];
    
    for (const [type, streak] of Object.entries(this.state.streaks)) {
      if (milestones.includes(streak.currentCount)) {
        const name = this.getStreakName(type as StreakType);
        celebrations.push(`${streak.currentCount} day ${name} streak!`);
      }
    }
    
    // Special celebrations for New Year's resolution
    const weedStreak = this.state.streaks.no_weed;
    if (weedStreak && weedStreak.currentCount > 0) {
      const days = weedStreak.currentCount;
      if (days === 1) {
        celebrations.push("Day 1 of your 2026 resolution! You've got this!");
      } else if (days === 7) {
        celebrations.push("One week weed-free! Your resolution is going strong!");
      } else if (days === 30) {
        celebrations.push("30 DAYS! Incredible willpower!");
      }
    }
    
    return celebrations;
  }

  private getStreakName(type: StreakType): string {
    const names: Record<StreakType, string> = {
      no_drinks: 'alcohol-free',
      no_weed: 'weed-free',
      workout: 'workout',
      calorie_goal: 'calorie goal',
      protein_goal: 'protein goal',
      water_goal: 'hydration',
      barrys: "Barry's"
    };
    return names[type] || type;
  }
}
