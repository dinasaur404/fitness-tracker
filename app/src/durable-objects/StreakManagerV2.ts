/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from 'cloudflare:workers';

/**
 * StreakManagerV2 Durable Object - SQLite-backed
 * 
 * Tracks and manages user streaks across different habits/goals.
 * Each user gets their own instance keyed by `userId`
 * 
 * Benefits of SQLite storage:
 * - Query streak history for trends
 * - Analyze patterns (which days do you usually break streaks?)
 * - Calculate statistics efficiently
 */

type StreakType = 'no_drinks' | 'no_weed' | 'workout' | 'calorie_goal' | 'protein_goal' | 'water_goal' | 'barrys';

interface Streak {
  type: StreakType;
  current_count: number;
  best_count: number;
  last_achieved_date: string;
}

const STREAK_TYPES: StreakType[] = ['no_drinks', 'no_weed', 'workout', 'calorie_goal', 'protein_goal', 'water_goal', 'barrys'];

export class StreakManagerV2 extends DurableObject<Record<string, unknown>> {
  private sql: SqlStorage;
  private userId: string | null = null;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    
    // Block requests until initialization completes
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      await this.loadUserId();
    });
  }

  /**
   * Run SQLite migrations
   */
  private migrate(): void {
    // Streaks table - current streak state
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS streaks (
        type TEXT PRIMARY KEY,
        current_count INTEGER NOT NULL DEFAULT 0,
        best_count INTEGER NOT NULL DEFAULT 0,
        last_achieved_date TEXT
      )
    `);
    
    // Initialize all streak types if not present
    for (const type of STREAK_TYPES) {
      this.sql.exec(
        `INSERT OR IGNORE INTO streaks (type, current_count, best_count) VALUES (?, 0, 0)`,
        type
      );
    }
    
    // Streak history table - for trends analysis
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS streak_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        streak_type TEXT NOT NULL,
        date TEXT NOT NULL,
        achieved INTEGER NOT NULL DEFAULT 0,
        count_at_date INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(streak_type, date)
      )
    `);
    
    // Daily checkins table - raw daily data
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS daily_checkins (
        date TEXT PRIMARY KEY,
        drank_alcohol INTEGER DEFAULT 0,
        smoked_weed INTEGER DEFAULT 0,
        worked_out INTEGER DEFAULT 0,
        did_barrys INTEGER DEFAULT 0,
        hit_calorie_goal INTEGER DEFAULT 0,
        hit_protein_goal INTEGER DEFAULT 0,
        hit_water_goal INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
    
    // Indexes
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_history_type_date ON streak_history(streak_type, date)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_history_date ON streak_history(date)`);
  }

  /**
   * Load user ID from KV
   */
  private async loadUserId(): Promise<void> {
    this.userId = await this.ctx.storage.get<string>('userId') || null;
  }

  /**
   * Get all current streaks from SQLite
   */
  private getAllStreaks(): Record<StreakType, Streak> {
    const rows = this.sql.exec(`SELECT * FROM streaks`).toArray();
    const streaks: Record<StreakType, Streak> = {} as Record<StreakType, Streak>;
    
    for (const row of rows) {
      streaks[row.type as StreakType] = {
        type: row.type as StreakType,
        current_count: row.current_count as number,
        best_count: row.best_count as number,
        last_achieved_date: (row.last_achieved_date as string) || ''
      };
    }
    
    return streaks;
  }

  /**
   * Check if two dates are consecutive
   */
  private isConsecutive(lastDate: string, currentDate: string): boolean {
    if (!lastDate) return true;
    
    const last = new Date(lastDate);
    const current = new Date(currentDate);
    const diffTime = current.getTime() - last.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    
    return diffDays === 1;
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
          if (path === '/streaks') return this.handleGetAllStreaks();
          if (path.startsWith('/streak/')) {
            const type = path.split('/')[2] as StreakType;
            return this.handleGetStreak(type);
          }
          if (path === '/history') return this.handleGetHistory(url.searchParams);
          if (path === '/checkins') return this.handleGetCheckins(url.searchParams);
          if (path === '/stats') return this.handleGetStats();
          break;
        
        case 'POST':
          if (path === '/init') return this.handleInit(await request.json());
          if (path === '/check-day') return this.handleCheckDay(await request.json());
          if (path === '/reset') return this.handleResetStreak(await request.json());
          if (path === '/increment') return this.handleIncrement(await request.json());
          break;
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('StreakManagerV2 error:', error);
      return Response.json({ error: 'Internal error', details: String(error) }, { status: 500 });
    }
  }

  /**
   * Initialize with user ID
   */
  private async handleInit(data: { userId: string }): Promise<Response> {
    this.userId = data.userId;
    await this.ctx.storage.put('userId', data.userId);
    
    return Response.json({ success: true, streaks: this.getAllStreaks() });
  }

  /**
   * Get all streaks
   */
  private handleGetAllStreaks(): Response {
    return Response.json(this.getAllStreaks());
  }

  /**
   * Get specific streak
   */
  private handleGetStreak(type: StreakType): Response {
    const row = this.sql.exec(`SELECT * FROM streaks WHERE type = ?`, type).toArray()[0];
    
    if (!row) {
      return Response.json({ error: 'Streak type not found' }, { status: 404 });
    }
    
    return Response.json({
      type: row.type,
      current_count: row.current_count,
      best_count: row.best_count,
      last_achieved_date: row.last_achieved_date || ''
    });
  }

  /**
   * Get streak history with optional filters
   */
  private handleGetHistory(params: URLSearchParams): Response {
    const type = params.get('type');
    const days = parseInt(params.get('days') || '90');
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = startDate.toISOString().split('T')[0];
    
    let query = `
      SELECT streak_type, date, achieved, count_at_date 
      FROM streak_history 
      WHERE date >= ?
    `;
    const bindings: (string | number)[] = [startDateStr];
    
    if (type) {
      query += ` AND streak_type = ?`;
      bindings.push(type);
    }
    
    query += ` ORDER BY date DESC`;
    
    const history = this.sql.exec(query, ...bindings).toArray();
    return Response.json(history);
  }

  /**
   * Get daily checkins
   */
  private handleGetCheckins(params: URLSearchParams): Response {
    const days = parseInt(params.get('days') || '30');
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = startDate.toISOString().split('T')[0];
    
    const checkins = this.sql.exec(`
      SELECT * FROM daily_checkins 
      WHERE date >= ? 
      ORDER BY date DESC
    `, startDateStr).toArray();
    
    return Response.json(checkins);
  }

  /**
   * Get streak statistics
   */
  private handleGetStats(): Response {
    // Best streaks ever
    const bestStreaks = this.sql.exec(`
      SELECT type, best_count FROM streaks ORDER BY best_count DESC
    `).toArray();
    
    // Days tracked
    const totalDays = this.sql.exec(`
      SELECT COUNT(DISTINCT date) as count FROM daily_checkins
    `).toArray()[0] as { count: number };
    
    // Success rates per streak type
    const successRates = this.sql.exec(`
      SELECT 
        streak_type,
        COUNT(*) as total_days,
        SUM(achieved) as achieved_days,
        ROUND(SUM(achieved) * 100.0 / COUNT(*), 1) as success_rate
      FROM streak_history
      GROUP BY streak_type
    `).toArray();
    
    // Longest streaks from history
    const longestStreaks: Record<string, number> = {};
    for (const type of STREAK_TYPES) {
      const maxCount = this.sql.exec(`
        SELECT MAX(count_at_date) as max_count 
        FROM streak_history 
        WHERE streak_type = ? AND achieved = 1
      `, type).toArray()[0] as { max_count: number };
      longestStreaks[type] = maxCount?.max_count || 0;
    }
    
    return Response.json({
      best_streaks: bestStreaks,
      total_days_tracked: totalDays.count,
      success_rates: successRates,
      longest_streaks: longestStreaks
    });
  }

  /**
   * Increment a specific streak
   */
  private async handleIncrement(data: { type?: StreakType; date: string }): Promise<Response> {
    const type = data.type || 'barrys';
    
    // Get current streak
    const current = this.sql.exec(`SELECT * FROM streaks WHERE type = ?`, type).toArray()[0];
    if (!current) {
      return Response.json({ error: 'Invalid streak type' }, { status: 400 });
    }
    
    const lastDate = current.last_achieved_date as string;
    const isConsecutive = this.isConsecutive(lastDate, data.date);
    
    const newCount = isConsecutive ? (current.current_count as number) + 1 : 1;
    const newBest = Math.max(newCount, current.best_count as number);
    
    // Update streak
    this.sql.exec(
      `UPDATE streaks SET current_count = ?, best_count = ?, last_achieved_date = ? WHERE type = ?`,
      newCount, newBest, data.date, type
    );
    
    // Record in history
    this.sql.exec(
      `INSERT OR REPLACE INTO streak_history (streak_type, date, achieved, count_at_date, created_at)
       VALUES (?, ?, 1, ?, ?)`,
      type, data.date, newCount, new Date().toISOString()
    );
    
    return Response.json({
      success: true,
      streak: { type, current_count: newCount, best_count: newBest, last_achieved_date: data.date }
    });
  }

  /**
   * Check day's achievements and update all streaks
   */
  private async handleCheckDay(data: {
    date: string;
    drank_alcohol: boolean;
    smoked_weed: boolean;
    worked_out: boolean;
    did_barrys: boolean;
    hit_calorie_goal: boolean;
    hit_protein_goal: boolean;
    hit_water_goal: boolean;
  }): Promise<Response> {
    const today = data.date;
    
    // Save daily checkin
    this.sql.exec(
      `INSERT OR REPLACE INTO daily_checkins 
       (date, drank_alcohol, smoked_weed, worked_out, did_barrys, 
        hit_calorie_goal, hit_protein_goal, hit_water_goal, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      today,
      data.drank_alcohol ? 1 : 0,
      data.smoked_weed ? 1 : 0,
      data.worked_out ? 1 : 0,
      data.did_barrys ? 1 : 0,
      data.hit_calorie_goal ? 1 : 0,
      data.hit_protein_goal ? 1 : 0,
      data.hit_water_goal ? 1 : 0,
      new Date().toISOString()
    );

    // Update each streak
    const updateStreak = (type: StreakType, achieved: boolean) => {
      const current = this.sql.exec(`SELECT * FROM streaks WHERE type = ?`, type).toArray()[0];
      const lastDate = current?.last_achieved_date as string;
      
      let newCount: number;
      if (achieved) {
        newCount = this.isConsecutive(lastDate, today) ? (current?.current_count as number || 0) + 1 : 1;
      } else {
        newCount = 0;
      }
      
      const newBest = Math.max(newCount, current?.best_count as number || 0);
      const newLastDate = achieved ? today : (current?.last_achieved_date as string || '');
      
      this.sql.exec(
        `UPDATE streaks SET current_count = ?, best_count = ?, last_achieved_date = ? WHERE type = ?`,
        newCount, newBest, newLastDate, type
      );
      
      // Record in history
      this.sql.exec(
        `INSERT OR REPLACE INTO streak_history (streak_type, date, achieved, count_at_date, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        type, today, achieved ? 1 : 0, newCount, new Date().toISOString()
      );
    };

    // Update streaks based on day's data
    updateStreak('no_drinks', !data.drank_alcohol);
    updateStreak('no_weed', !data.smoked_weed);
    updateStreak('workout', data.worked_out);
    updateStreak('barrys', data.did_barrys);
    updateStreak('calorie_goal', data.hit_calorie_goal);
    updateStreak('protein_goal', data.hit_protein_goal);
    updateStreak('water_goal', data.hit_water_goal);

    const streaks = this.getAllStreaks();
    const celebrations = this.getCelebrations(streaks);

    return Response.json({ streaks, celebrations });
  }

  /**
   * Reset a specific streak
   */
  private async handleResetStreak(data: { type: StreakType }): Promise<Response> {
    this.sql.exec(`UPDATE streaks SET current_count = 0 WHERE type = ?`, data.type);
    
    const updated = this.sql.exec(`SELECT * FROM streaks WHERE type = ?`, data.type).toArray()[0];
    
    return Response.json({
      success: true,
      streak: {
        type: data.type,
        current_count: 0,
        best_count: updated?.best_count || 0,
        last_achieved_date: updated?.last_achieved_date || ''
      }
    });
  }

  /**
   * Get celebration messages for milestone streaks
   */
  private getCelebrations(streaks: Record<StreakType, Streak>): string[] {
    const celebrations: string[] = [];
    const milestones = [7, 14, 21, 30, 60, 90, 100, 365];

    for (const [type, streak] of Object.entries(streaks)) {
      if (milestones.includes(streak.current_count)) {
        const name = this.getStreakName(type as StreakType);
        celebrations.push(`${streak.current_count} day ${name} streak! You're crushing it!`);
      }
    }

    // Special celebrations for New Year's resolution
    const weedStreak = streaks.no_weed;
    if (weedStreak && weedStreak.current_count > 0) {
      const days = weedStreak.current_count;
      if (days === 1) {
        celebrations.push("Day 1 of your 2026 resolution! You've got this!");
      } else if (days === 7) {
        celebrations.push("One week weed-free! Your resolution is going strong!");
      } else if (days === 30) {
        celebrations.push("30 DAYS! You've proven you can do this. Incredible willpower!");
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

  /**
   * Alarm handler
   */
  async alarm(): Promise<void> {
    console.log('StreakManagerV2 alarm fired');
  }
}
