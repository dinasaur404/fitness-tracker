/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from 'cloudflare:workers';

/**
 * StreakManager Durable Object - KV-backed
 * 
 * Tracks and manages user streaks across different habits/goals.
 * Each user gets their own instance keyed by `userId`
 * 
 * Storage: KV-backed (not SQLite - existing DOs can't be migrated)
 */

type StreakType = 'no_drinks' | 'no_weed' | 'workout' | 'calorie_goal' | 'protein_goal' | 'water_goal' | 'barrys';

interface Streak {
  type: StreakType;
  current_count: number;
  best_count: number;
  last_achieved_date: string;
}

interface StreakHistoryEntry {
  streak_type: StreakType;
  date: string;
  achieved: boolean;
  count_at_date: number;
  created_at: string;
}

interface DailyCheckin {
  date: string;
  drank_alcohol: boolean;
  smoked_weed: boolean;
  worked_out: boolean;
  did_barrys: boolean;
  hit_calorie_goal: boolean;
  hit_protein_goal: boolean;
  hit_water_goal: boolean;
  created_at: string;
}

interface StreakData {
  streaks: Record<StreakType, Streak>;
  history: StreakHistoryEntry[];
  checkins: DailyCheckin[];
  userId?: string;
  lastUpdated: string;
}

const STREAK_TYPES: StreakType[] = ['no_drinks', 'no_weed', 'workout', 'calorie_goal', 'protein_goal', 'water_goal', 'barrys'];

export class StreakManager extends DurableObject<Record<string, unknown>> {
  private cachedData: StreakData | null = null;

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
    const stored = await this.ctx.storage.get<StreakData>('data');
    if (stored) {
      this.cachedData = stored;
    }
  }

  /**
   * Initialize empty streaks
   */
  private getDefaultData(): StreakData {
    const streaks: Record<StreakType, Streak> = {} as Record<StreakType, Streak>;
    
    for (const type of STREAK_TYPES) {
      streaks[type] = {
        type,
        current_count: 0,
        best_count: 0,
        last_achieved_date: ''
      };
    }
    
    return {
      streaks,
      history: [],
      checkins: [],
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Get or create streak data
   */
  private getData(): StreakData {
    if (this.cachedData) {
      return this.cachedData;
    }
    return this.getDefaultData();
  }

  /**
   * Save data to KV storage
   */
  private async saveData(): Promise<void> {
    if (this.cachedData) {
      this.cachedData.lastUpdated = new Date().toISOString();
      
      // Keep history limited to last 90 days
      if (this.cachedData.history.length > 630) { // 7 streak types * 90 days
        this.cachedData.history = this.cachedData.history.slice(-630);
      }
      
      // Keep checkins limited to last 90 days
      if (this.cachedData.checkins.length > 90) {
        this.cachedData.checkins = this.cachedData.checkins.slice(-90);
      }
      
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
          if (path === '/streaks') return this.handleGetAllStreaks();
          if (path.startsWith('/streak/')) {
            const type = path.split('/')[2] as StreakType;
            return this.handleGetStreak(type);
          }
          if (path === '/history') return this.handleGetHistory();
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
      console.error('StreakManager error:', error);
      return Response.json({ error: 'Internal error' }, { status: 500 });
    }
  }

  /**
   * Initialize with user ID
   */
  private async handleInit(reqData: { userId: string }): Promise<Response> {
    await this.ctx.storage.put('userId', reqData.userId);
    
    const data = this.getData();
    data.userId = reqData.userId;
    this.cachedData = data;
    await this.saveData();
    
    return Response.json({ success: true, streaks: data.streaks });
  }

  /**
   * Get all streaks
   */
  private handleGetAllStreaks(): Response {
    const data = this.getData();
    return Response.json(data.streaks);
  }

  /**
   * Get specific streak
   */
  private handleGetStreak(type: StreakType): Response {
    const data = this.getData();
    const streak = data.streaks[type];
    
    if (!streak) {
      return Response.json({ error: 'Streak type not found' }, { status: 404 });
    }
    
    return Response.json(streak);
  }

  /**
   * Get streak history (for trends)
   */
  private handleGetHistory(): Response {
    const data = this.getData();
    // Return last 90 entries sorted by date descending
    const history = [...data.history].sort((a, b) => 
      new Date(b.date).getTime() - new Date(a.date).getTime()
    ).slice(0, 90);
    
    return Response.json(history);
  }

  /**
   * Increment a specific streak (e.g., for Barry's)
   */
  private async handleIncrement(reqData: { type?: StreakType; date: string }): Promise<Response> {
    const data = this.getData();
    const type = reqData.type || 'barrys';
    const streak = data.streaks[type];
    
    if (!streak) {
      return Response.json({ error: 'Invalid streak type' }, { status: 400 });
    }
    
    // Check if consecutive
    const isConsecutive = this.isConsecutive(streak.last_achieved_date, reqData.date);
    
    if (isConsecutive) {
      streak.current_count += 1;
    } else {
      streak.current_count = 1;
    }
    
    streak.last_achieved_date = reqData.date;
    if (streak.current_count > streak.best_count) {
      streak.best_count = streak.current_count;
    }
    
    // Record in history
    data.history.push({
      streak_type: type,
      date: reqData.date,
      achieved: true,
      count_at_date: streak.current_count,
      created_at: new Date().toISOString()
    });
    
    this.cachedData = data;
    await this.saveData();
    
    return Response.json({ success: true, streak });
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
   * Check day's achievements and update all streaks
   */
  private async handleCheckDay(reqData: {
    date: string;
    drank_alcohol: boolean;
    smoked_weed: boolean;
    worked_out: boolean;
    did_barrys: boolean;
    hit_calorie_goal: boolean;
    hit_protein_goal: boolean;
    hit_water_goal: boolean;
  }): Promise<Response> {
    const data = this.getData();
    const today = reqData.date;
    
    // Save daily checkin
    const checkinIndex = data.checkins.findIndex(c => c.date === today);
    const checkin: DailyCheckin = {
      date: today,
      drank_alcohol: reqData.drank_alcohol,
      smoked_weed: reqData.smoked_weed,
      worked_out: reqData.worked_out,
      did_barrys: reqData.did_barrys,
      hit_calorie_goal: reqData.hit_calorie_goal,
      hit_protein_goal: reqData.hit_protein_goal,
      hit_water_goal: reqData.hit_water_goal,
      created_at: new Date().toISOString()
    };
    
    if (checkinIndex >= 0) {
      data.checkins[checkinIndex] = checkin;
    } else {
      data.checkins.push(checkin);
    }

    // Update each streak
    const updateStreak = (type: StreakType, achieved: boolean) => {
      const streak = data.streaks[type];
      
      if (achieved) {
        if (this.isConsecutive(streak.last_achieved_date, today)) {
          streak.current_count += 1;
        } else {
          streak.current_count = 1;
        }
        streak.last_achieved_date = today;
        if (streak.current_count > streak.best_count) {
          streak.best_count = streak.current_count;
        }
      } else {
        streak.current_count = 0;
      }
      
      // Record in history
      data.history.push({
        streak_type: type,
        date: today,
        achieved,
        count_at_date: streak.current_count,
        created_at: new Date().toISOString()
      });
    };

    // Update streaks based on day's data
    updateStreak('no_drinks', !reqData.drank_alcohol);
    updateStreak('no_weed', !reqData.smoked_weed);
    updateStreak('workout', reqData.worked_out);
    updateStreak('barrys', reqData.did_barrys);
    updateStreak('calorie_goal', reqData.hit_calorie_goal);
    updateStreak('protein_goal', reqData.hit_protein_goal);
    updateStreak('water_goal', reqData.hit_water_goal);

    this.cachedData = data;
    await this.saveData();

    // Get celebration messages
    const celebrations = this.getCelebrations(data.streaks);

    return Response.json({
      streaks: data.streaks,
      celebrations
    });
  }

  /**
   * Reset a specific streak
   */
  private async handleResetStreak(reqData: { type: StreakType }): Promise<Response> {
    const data = this.getData();
    
    if (data.streaks[reqData.type]) {
      data.streaks[reqData.type].current_count = 0;
      this.cachedData = data;
      await this.saveData();
    }
    
    return Response.json({ success: true, streak: data.streaks[reqData.type] });
  }

  /**
   * Get celebration messages for milestone streaks
   */
  private getCelebrations(streaks: Record<StreakType, Streak>): string[] {
    const celebrations: string[] = [];
    const milestones = [7, 14, 21, 30, 60, 90, 100, 365];

    for (const [type, streak] of Object.entries(streaks)) {
      if (milestones.includes(streak.current_count)) {
        const emoji = this.getStreakEmoji(type as StreakType);
        const name = this.getStreakName(type as StreakType);
        celebrations.push(`${emoji} ${streak.current_count} day ${name} streak! You're crushing it!`);
      }
    }

    // Special celebrations for New Year's resolution
    const weedStreak = streaks.no_weed;
    if (weedStreak.current_count > 0) {
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

  private getStreakEmoji(type: StreakType): string {
    const emojis: Record<StreakType, string> = {
      no_drinks: '',
      no_weed: '',
      workout: '',
      calorie_goal: '',
      protein_goal: '',
      water_goal: '',
      barrys: ''
    };
    return emojis[type] || '';
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
   * Alarm handler - for scheduled streak calculations
   */
  async alarm(): Promise<void> {
    console.log('StreakManager alarm fired');
    // Can be used for weekly summary emails, etc.
  }
}
