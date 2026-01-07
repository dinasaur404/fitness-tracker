/// <reference types="@cloudflare/workers-types" />

import { Env, WhoopWorkout, WhoopRecovery } from '../types/env';
import { fetchWithTimeout } from '../utils/error-handling';

const WHOOP_API_BASE = 'https://api.prod.whoop.com/developer/v2';
const WHOOP_API_TIMEOUT = 30000; // 30 second timeout for Whoop API calls

interface WhoopTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

interface WhoopWorkoutResponse {
  id: number;
  user_id: number;
  sport_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  timezone_offset: string;
  score_state: string;
  score: {
    strain: number;
    average_heart_rate: number;
    max_heart_rate: number;
    kilojoule: number;
    percent_recorded: number;
    distance_meter?: number;
    altitude_gain_meter?: number;
    altitude_change_meter?: number;
    zone_duration: {
      zone_zero_milli: number;
      zone_one_milli: number;
      zone_two_milli: number;
      zone_three_milli: number;
      zone_four_milli: number;
      zone_five_milli: number;
    };
  };
}

interface WhoopRecoveryResponse {
  cycle_id: number;
  sleep_id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  score_state: string;
  score: {
    user_calibrating: boolean;
    recovery_score: number;
    resting_heart_rate: number;
    hrv_rmssd_milli: number;
    spo2_percentage?: number;
    skin_temp_celsius?: number;
  };
}

interface WhoopSleepResponse {
  id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  timezone_offset: string;
  nap: boolean;
  score_state: string;
  score: {
    stage_summary: {
      total_in_bed_time_milli: number;
      total_awake_time_milli: number;
      total_no_data_time_milli: number;
      total_light_sleep_time_milli: number;
      total_slow_wave_sleep_time_milli: number;
      total_rem_sleep_time_milli: number;
      sleep_cycle_count: number;
      disturbance_count: number;
    };
    sleep_needed: {
      baseline_milli: number;
      need_from_sleep_debt_milli: number;
      need_from_recent_strain_milli: number;
      need_from_recent_nap_milli: number;
    };
    respiratory_rate: number;
    sleep_performance_percentage: number;
    sleep_consistency_percentage: number;
    sleep_efficiency_percentage: number;
  };
}

// Whoop Sport IDs for Barry's identification
const BARRYS_SPORT_IDS = [
  1, // Running (treadmill)
  63, // HIIT
  82, // Bootcamp
  96, // Barry's Bootcamp (if they have specific)
];

const SPORT_NAMES: Record<number, string> = {
  0: 'Activity',
  1: 'Running',
  16: 'Baseball',
  17: 'Basketball',
  18: 'Rowing',
  19: 'Fencing',
  20: 'Field Hockey',
  21: 'Football',
  22: 'Golf',
  24: 'Ice Hockey',
  25: 'Lacrosse',
  27: 'Rugby',
  28: 'Sailing',
  29: 'Skiing',
  30: 'Soccer',
  31: 'Softball',
  32: 'Squash',
  33: 'Swimming',
  34: 'Tennis',
  35: 'Track & Field',
  36: 'Volleyball',
  37: 'Water Polo',
  38: 'Wrestling',
  39: 'Boxing',
  42: 'Dance',
  43: 'Pilates',
  44: 'Yoga',
  45: 'Weightlifting',
  47: 'Cross Country Skiing',
  48: 'Functional Fitness',
  49: 'Duathlon',
  51: 'Gymnastics',
  52: 'Hiking/Rucking',
  53: 'Horseback Riding',
  55: 'Kayaking',
  56: 'Martial Arts',
  57: 'Mountain Biking',
  59: 'Powerlifting',
  60: 'Rock Climbing',
  61: 'Paddleboarding',
  62: 'Triathlon',
  63: 'Walking',
  64: 'Surfing',
  65: 'Elliptical',
  66: 'Stairmaster',
  70: 'Meditation',
  71: 'Other',
  73: 'Diving',
  74: 'Operations - Loss of Life',
  75: 'Climber',
  76: 'Spinning',
  82: 'HIIT',
  83: 'Cycling',
  84: 'Ice Bath',
  87: 'Commuting',
  88: 'Gaming',
  89: 'Snowboarding',
  90: 'Motocross',
  91: 'Caddying',
  92: 'Obstacle Course',
  93: 'Motor Racing',
  95: 'Assault Bike',
  96: "Barry's Bootcamp"
};

// Custom error for rate limiting
export class WhoopRateLimitError extends Error {
  retryAfter: number;
  constructor(retryAfter: number = 60) {
    super(`Whoop API rate limited. Retry after ${retryAfter} seconds.`);
    this.name = 'WhoopRateLimitError';
    this.retryAfter = retryAfter;
  }
}

// Custom error for authentication issues (expired token, revoked access)
export class WhoopAuthError extends Error {
  constructor(message: string = 'Whoop authentication failed. Please reconnect your account.') {
    super(message);
    this.name = 'WhoopAuthError';
  }
}

/**
 * Whoop Service - Integration with Whoop API
 * 
 * Handles:
 * - OAuth authentication
 * - Workout data sync
 * - Recovery & sleep data
 * - Barry's workout detection
 * - Rate limit handling
 */
export class WhoopService {
  private clientId: string;
  private clientSecret: string;
  private db: D1Database;
  private queue?: Queue;
  private cache?: KVNamespace;

  constructor(env: Env) {
    this.clientId = env.WHOOP_CLIENT_ID;
    this.clientSecret = env.WHOOP_CLIENT_SECRET;
    this.db = env.DB;
    this.queue = env.WHOOP_QUEUE;
    this.cache = env.CACHE;
  }

  /**
   * Check if we're currently rate limited (cached from previous 429)
   */
  async isRateLimited(): Promise<{ limited: boolean; retryAfter: number }> {
    if (!this.cache) return { limited: false, retryAfter: 0 };
    
    const rateLimitKey = 'whoop_rate_limit';
    const cached = await this.cache.get(rateLimitKey);
    
    if (cached) {
      const { until, retryAfter } = JSON.parse(cached);
      const untilTime = new Date(until).getTime();
      const now = Date.now();
      
      if (untilTime > now) {
        const remaining = Math.ceil((untilTime - now) / 1000);
        return { limited: true, retryAfter: remaining };
      }
    }
    
    return { limited: false, retryAfter: 0 };
  }

  /**
   * Cache that we hit a rate limit
   */
  private async cacheRateLimit(retryAfter: number): Promise<void> {
    if (!this.cache) return;
    
    const until = new Date(Date.now() + retryAfter * 1000).toISOString();
    await this.cache.put('whoop_rate_limit', JSON.stringify({ until, retryAfter }), {
      expirationTtl: retryAfter
    });
  }

  /**
   * Make a rate-limit-aware and auth-aware API call to Whoop
   * Throws WhoopRateLimitError on 429
   * Throws WhoopAuthError on 401
   */
  private async whoopFetch(url: string, options: RequestInit): Promise<Response> {
    // Check cached rate limit first to avoid unnecessary API calls
    const { limited, retryAfter: cachedRetry } = await this.isRateLimited();
    if (limited) {
      console.warn(`Whoop API call blocked - currently rate limited. Retry in ${cachedRetry}s`);
      throw new WhoopRateLimitError(cachedRetry);
    }

    const response = await fetchWithTimeout(url, {
      ...options,
      timeout: WHOOP_API_TIMEOUT
    });

    if (response.status === 429) {
      // Parse rate limit headers for more accurate retry time
      // Whoop returns: x-ratelimit-reset: <seconds until reset>
      const resetSeconds = parseInt(response.headers.get('x-ratelimit-reset') || '0');
      const retryAfter = resetSeconds > 0 ? resetSeconds : parseInt(response.headers.get('Retry-After') || '60');
      const remaining = response.headers.get('x-ratelimit-remaining') || 'unknown';
      const limit = response.headers.get('x-ratelimit-limit') || 'unknown';
      
      // Convert to hours for user-friendly display if > 1 hour
      const retryHours = Math.ceil(retryAfter / 3600);
      console.warn(`Whoop API rate limited. Remaining: ${remaining}/${limit}. Reset in ${retryAfter}s (~${retryHours} hours)`);
      
      // Cache the rate limit to prevent future calls
      await this.cacheRateLimit(retryAfter);
      
      throw new WhoopRateLimitError(retryAfter);
    }

    if (response.status === 401) {
      console.warn(`Whoop API authentication failed (401) - token may be expired or revoked`);
      throw new WhoopAuthError('Access token expired or invalid. Please reconnect your Whoop account.');
    }

    return response;
  }

  /**
   * Generate OAuth authorization URL
   */
  getAuthUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      // Include offline_access scope to get refresh tokens
      scope: 'offline read:profile read:workout read:sleep read:recovery read:cycles read:body_measurement',
      state
    });

    return `https://api.prod.whoop.com/oauth/oauth2/auth?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCode(code: string, redirectUri: string): Promise<WhoopTokenResponse> {
    console.log('Exchanging code for tokens...', { redirectUri, clientId: this.clientId });
    
    // Whoop requires client_secret_post method (credentials in body, not header)
    const response = await fetchWithTimeout('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: this.clientId,
        client_secret: this.clientSecret
      }).toString(),
      timeout: WHOOP_API_TIMEOUT
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Token exchange failed:', response.status, errorText);
      throw new Error(`Token exchange failed: ${response.status} - ${errorText}`);
    }

    const tokens = await response.json() as WhoopTokenResponse;
    console.log('Token exchange successful');
    return tokens;
  }

  /**
   * Refresh access token
   * Per Whoop docs: must include scope: "offline" in refresh request
   */
  async refreshToken(refreshToken: string): Promise<WhoopTokenResponse> {
    console.log('Attempting token refresh...');
    
    if (!refreshToken) {
      console.error('No refresh token provided');
      throw new WhoopAuthError('No refresh token available. Please reconnect your Whoop account.');
    }
    
    // Whoop requires client_secret_post method (credentials in body, not header)
    const response = await fetchWithTimeout('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: 'offline'  // Required per Whoop docs to get new refresh token
      }).toString(),
      timeout: WHOOP_API_TIMEOUT
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Token refresh failed:', response.status, errorText);
      
      // 400/401 errors typically mean the refresh token is invalid/expired
      if (response.status === 400 || response.status === 401) {
        throw new WhoopAuthError('Refresh token expired or invalid. Please reconnect your Whoop account.');
      }
      
      // 429 is rate limiting
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '60');
        throw new WhoopRateLimitError(retryAfter);
      }
      
      throw new Error(`Token refresh failed: ${response.status} - ${errorText}`);
    }

    const tokens = await response.json() as WhoopTokenResponse;
    console.log('Token refresh successful');
    return tokens;
  }

  /**
   * Fetch workouts from Whoop API with pagination
   */
  async getWorkouts(accessToken: string, startDate?: string, endDate?: string): Promise<WhoopWorkoutResponse[]> {
    const allRecords: WhoopWorkoutResponse[] = [];
    let nextToken: string | null = null;
    
    do {
      const params = new URLSearchParams();
      if (startDate) {
        const start = startDate.includes('T') ? startDate : `${startDate}T00:00:00.000Z`;
        params.set('start', start);
      }
      if (endDate) {
        const end = endDate.includes('T') ? endDate : `${endDate}T23:59:59.999Z`;
        params.set('end', end);
      }
      params.set('limit', '25');
      if (nextToken) {
        params.set('nextToken', nextToken);
      }

      const response = await this.whoopFetch(`${WHOOP_API_BASE}/activity/workout?${params.toString()}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Workouts API error:', response.status, errorText);
        throw new Error(`Failed to fetch workouts: ${response.status}`);
      }

      const data = await response.json() as { records: WhoopWorkoutResponse[]; next_token?: string };
      allRecords.push(...(data.records || []));
      nextToken = data.next_token || null;
    } while (nextToken);

    return allRecords;
  }

  /**
   * Fetch recovery data with pagination
   */
  async getRecovery(accessToken: string, startDate?: string, endDate?: string): Promise<WhoopRecoveryResponse[]> {
    const allRecords: WhoopRecoveryResponse[] = [];
    let nextToken: string | null = null;
    
    do {
      const params = new URLSearchParams();
      if (startDate) {
        const start = startDate.includes('T') ? startDate : `${startDate}T00:00:00.000Z`;
        params.set('start', start);
      }
      if (endDate) {
        const end = endDate.includes('T') ? endDate : `${endDate}T23:59:59.999Z`;
        params.set('end', end);
      }
      params.set('limit', '25');
      if (nextToken) {
        params.set('nextToken', nextToken);
      }

      const response = await this.whoopFetch(`${WHOOP_API_BASE}/recovery?${params.toString()}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Recovery API error:', response.status, errorText);
        throw new Error(`Failed to fetch recovery: ${response.status}`);
      }

      const data = await response.json() as { records: WhoopRecoveryResponse[]; next_token?: string };
      allRecords.push(...(data.records || []));
      nextToken = data.next_token || null;
    } while (nextToken);

    return allRecords;
  }

  /**
   * Fetch sleep data with pagination
   */
  async getSleep(accessToken: string, startDate?: string, endDate?: string): Promise<WhoopSleepResponse[]> {
    const allRecords: WhoopSleepResponse[] = [];
    let nextToken: string | null = null;
    
    do {
      const params = new URLSearchParams();
      if (startDate) {
        const start = startDate.includes('T') ? startDate : `${startDate}T00:00:00.000Z`;
        params.set('start', start);
      }
      if (endDate) {
        const end = endDate.includes('T') ? endDate : `${endDate}T23:59:59.999Z`;
        params.set('end', end);
      }
      params.set('limit', '25');
      if (nextToken) {
        params.set('nextToken', nextToken);
      }

      const response = await this.whoopFetch(`${WHOOP_API_BASE}/activity/sleep?${params.toString()}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Sleep API error:', response.status, errorText);
        throw new Error(`Failed to fetch sleep: ${response.status}`);
      }

      const data = await response.json() as { records: WhoopSleepResponse[]; next_token?: string };
      allRecords.push(...(data.records || []));
      nextToken = data.next_token || null;
    } while (nextToken);

    return allRecords;
  }

  /**
   * Fetch body measurements (weight, height, max HR)
   */
  async getBodyMeasurement(accessToken: string): Promise<{ height_meter: number; weight_kilogram: number; max_heart_rate: number } | null> {
    const response = await this.whoopFetch(`${WHOOP_API_BASE}/user/measurement/body`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`Failed to fetch body measurement: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Detect if a workout is a Barry's class
   */
  isBarrysWorkout(workout: WhoopWorkoutResponse): boolean {
    // Check by sport ID
    if (BARRYS_SPORT_IDS.includes(workout.sport_id)) {
      // Barry's workouts are typically 50-60 minutes with high strain
      const durationMs = new Date(workout.end).getTime() - new Date(workout.start).getTime();
      const durationMins = durationMs / 1000 / 60;
      
      // Barry's is usually 45-60 min with strain > 10
      if (durationMins >= 40 && durationMins <= 70 && workout.score.strain >= 10) {
        return true;
      }
    }
    return false;
  }

  /**
   * Sync workouts for a user
   */
  async syncWorkouts(userId: string, accessToken: string, daysBack: number = 7): Promise<WhoopWorkout[]> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);
    
    const workouts = await this.getWorkouts(accessToken, startDate.toISOString());
    const savedWorkouts: WhoopWorkout[] = [];

    for (const workout of workouts) {
      const isBarrys = this.isBarrysWorkout(workout);
      const caloriesBurned = workout.score.kilojoule / 4.184; // Convert kJ to kcal
      
      const whoopWorkout: WhoopWorkout = {
        id: crypto.randomUUID(),
        user_id: userId,
        whoop_id: workout.id.toString(),
        sport_name: SPORT_NAMES[workout.sport_id] || 'Activity',
        start_time: workout.start,
        end_time: workout.end,
        calories_burned: Math.round(caloriesBurned),
        average_heart_rate: workout.score.average_heart_rate,
        max_heart_rate: workout.score.max_heart_rate,
        strain: workout.score.strain,
        is_barrys: isBarrys,
        created_at: new Date().toISOString()
      };

      // Upsert into D1
      await this.db.prepare(`
        INSERT INTO whoop_workouts (id, user_id, whoop_id, sport_name, start_time, end_time, 
          calories_burned, average_heart_rate, max_heart_rate, strain, is_barrys, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(whoop_id) DO UPDATE SET
          sport_name = excluded.sport_name,
          calories_burned = excluded.calories_burned,
          average_heart_rate = excluded.average_heart_rate,
          max_heart_rate = excluded.max_heart_rate,
          strain = excluded.strain
      `).bind(
        whoopWorkout.id,
        whoopWorkout.user_id,
        whoopWorkout.whoop_id,
        whoopWorkout.sport_name,
        whoopWorkout.start_time,
        whoopWorkout.end_time,
        whoopWorkout.calories_burned,
        whoopWorkout.average_heart_rate,
        whoopWorkout.max_heart_rate,
        whoopWorkout.strain,
        isBarrys ? 1 : 0,
        whoopWorkout.created_at
      ).run();

      savedWorkouts.push(whoopWorkout);
    }

    return savedWorkouts;
  }

  /**
   * Sync recovery data for a user
   */
  async syncRecovery(userId: string, accessToken: string, daysBack: number = 7): Promise<WhoopRecovery[]> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);
    
    const recoveries = await this.getRecovery(accessToken, startDate.toISOString());
    const savedRecoveries: WhoopRecovery[] = [];

    for (const recovery of recoveries) {
      const whoopRecovery: WhoopRecovery = {
        id: crypto.randomUUID(),
        user_id: userId,
        whoop_cycle_id: recovery.cycle_id.toString(),
        recovery_score: recovery.score.recovery_score,
        resting_heart_rate: recovery.score.resting_heart_rate,
        hrv: recovery.score.hrv_rmssd_milli,
        sleep_performance: 0, // Will be filled from sleep data
        date: recovery.created_at.split('T')[0],
        created_at: new Date().toISOString()
      };

      await this.db.prepare(`
        INSERT INTO whoop_recovery (id, user_id, whoop_cycle_id, recovery_score, 
          resting_heart_rate, hrv, sleep_performance, date, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(whoop_cycle_id) DO UPDATE SET
          recovery_score = excluded.recovery_score,
          resting_heart_rate = excluded.resting_heart_rate,
          hrv = excluded.hrv
      `).bind(
        whoopRecovery.id,
        whoopRecovery.user_id,
        whoopRecovery.whoop_cycle_id,
        whoopRecovery.recovery_score,
        whoopRecovery.resting_heart_rate,
        whoopRecovery.hrv,
        whoopRecovery.sleep_performance,
        whoopRecovery.date,
        whoopRecovery.created_at
      ).run();

      savedRecoveries.push(whoopRecovery);
    }

    return savedRecoveries;
  }

  /**
   * Queue a background sync for a user (if queue is configured)
   */
  async queueSync(userId: string, accessToken: string, syncType: 'full' | 'incremental' = 'incremental'): Promise<void> {
    if (this.queue) {
      await this.queue.send({
        user_id: userId,
        whoop_access_token: accessToken,
        sync_type: syncType
      });
    } else {
      console.log('Queue not configured, skipping queueSync');
    }
  }

  /**
   * Fetch cycles (day strain) from Whoop API with pagination
   * Note: Whoop API requires ISO 8601 dates with timezone, max 25 per request
   */
  async getCycles(accessToken: string, startDate?: string, endDate?: string): Promise<WhoopCycleResponse[]> {
    const allRecords: WhoopCycleResponse[] = [];
    let nextToken: string | null = null;
    
    do {
      const params = new URLSearchParams();
      if (startDate) {
        const start = startDate.includes('T') ? startDate : `${startDate}T00:00:00.000Z`;
        params.set('start', start);
      }
      if (endDate) {
        const end = endDate.includes('T') ? endDate : `${endDate}T23:59:59.999Z`;
        params.set('end', end);
      }
      params.set('limit', '25');
      if (nextToken) {
        params.set('nextToken', nextToken);
      }

      const response = await this.whoopFetch(`${WHOOP_API_BASE}/cycle?${params.toString()}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Cycles API error:', response.status, errorText);
        throw new Error(`Failed to fetch cycles: ${response.status}`);
      }

      const data = await response.json() as { records: WhoopCycleResponse[]; next_token?: string };
      allRecords.push(...(data.records || []));
      nextToken = data.next_token || null;
    } while (nextToken);

    return allRecords;
  }

  /**
   * Get the last synced date for a user
   */
  async getLastSyncedDate(userId: string): Promise<string | null> {
    const result = await this.db.prepare(
      'SELECT MAX(date) as last_date FROM whoop_daily WHERE user_id = ?'
    ).bind(userId).first();
    
    return result?.last_date as string | null;
  }

  /**
   * Comprehensive sync - fetches all Whoop data and stores in whoop_daily
   */
  async syncComprehensive(userId: string, accessToken: string, daysBack: number = 90): Promise<{ synced: number; dates: string[] }> {
    // Check if we're rate limited before starting
    const { limited, retryAfter } = await this.isRateLimited();
    if (limited) {
      console.warn(`Skipping sync - rate limited for ${retryAfter}s more`);
      throw new WhoopRateLimitError(retryAfter);
    }
    
    console.log(`Starting comprehensive sync for ${userId}, ${daysBack} days back`);
    
    // Calculate date range - use simple YYYY-MM-DD format, let the API methods handle formatting
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);
    
    // Check what we already have
    const lastSynced = await this.getLastSyncedDate(userId);
    let effectiveStartDate = startDate;
    
    if (lastSynced && daysBack <= 7) {
      // For incremental syncs, only get data after last sync
      const lastDate = new Date(lastSynced);
      lastDate.setDate(lastDate.getDate() - 1); // Overlap by 1 day to catch updates
      if (lastDate > startDate) {
        effectiveStartDate = lastDate;
      }
    }
    
    const startStr = effectiveStartDate.toISOString();
    const endStr = endDate.toISOString();
    console.log(`Fetching from ${startStr} to ${endStr}`);

    // Fetch all data types - handle errors gracefully
    let cycles: WhoopCycleResponse[] = [];
    let recoveries: WhoopRecoveryResponse[] = [];
    let sleeps: WhoopSleepResponse[] = [];
    let workouts: WhoopWorkoutResponse[] = [];
    let bodyMeasurement: { height_meter: number; weight_kilogram: number; max_heart_rate: number } | null = null;

    // Try to fetch each data type, continue even if one fails
    try {
      cycles = await this.getCycles(accessToken, startStr, endStr);
      console.log(`Fetched ${cycles.length} cycles`);
    } catch (e) {
      console.error('Failed to fetch cycles:', e);
    }

    try {
      recoveries = await this.getRecovery(accessToken, startStr, endStr);
      console.log(`Fetched ${recoveries.length} recoveries`);
    } catch (e) {
      console.error('Failed to fetch recoveries:', e);
    }

    try {
      sleeps = await this.getSleep(accessToken, startStr, endStr);
      console.log(`Fetched ${sleeps.length} sleeps`);
    } catch (e) {
      console.error('Failed to fetch sleeps:', e);
    }

    try {
      workouts = await this.getWorkouts(accessToken, startStr, endStr);
      console.log(`Fetched ${workouts.length} workouts`);
    } catch (e) {
      console.error('Failed to fetch workouts:', e);
    }

    try {
      bodyMeasurement = await this.getBodyMeasurement(accessToken);
      console.log(`Fetched body measurement:`, bodyMeasurement);
    } catch (e) {
      console.error('Failed to fetch body measurement:', e);
    }

    console.log(`Fetched: ${cycles.length} cycles, ${recoveries.length} recoveries, ${sleeps.length} sleeps, ${workouts.length} workouts`);

    // Group data by date
    const dailyDataMap = new Map<string, WhoopDailyData>();

    // Process cycles (day strain)
    for (const cycle of cycles) {
      const date = cycle.start.split('T')[0];
      const data = dailyDataMap.get(date) || this.createEmptyDailyData(userId, date);
      
      data.day_strain = cycle.score?.strain || 0;
      data.day_calories = cycle.score?.kilojoule ? Math.round(cycle.score.kilojoule / 4.184) : 0;
      data.day_avg_hr = cycle.score?.average_heart_rate || 0;
      data.day_max_hr = cycle.score?.max_heart_rate || 0;
      data.cycle_id = cycle.id.toString();
      
      dailyDataMap.set(date, data);
    }

    // Process recovery
    for (const recovery of recoveries) {
      const date = recovery.created_at.split('T')[0];
      const data = dailyDataMap.get(date) || this.createEmptyDailyData(userId, date);
      
      data.recovery_score = recovery.score?.recovery_score || 0;
      data.hrv_rmssd = recovery.score?.hrv_rmssd_milli || 0;
      data.resting_heart_rate = recovery.score?.resting_heart_rate || 0;
      data.spo2_percentage = recovery.score?.spo2_percentage || null;
      data.skin_temp_celsius = recovery.score?.skin_temp_celsius || null;
      data.recovery_id = recovery.cycle_id.toString();
      
      dailyDataMap.set(date, data);
    }

    // Process sleep
    for (const sleep of sleeps) {
      if (sleep.nap) continue; // Skip naps, only count main sleep
      
      const date = sleep.end.split('T')[0]; // Use end date as the day it counts for
      const data = dailyDataMap.get(date) || this.createEmptyDailyData(userId, date);
      
      const score = sleep.score;
      if (score) {
        data.sleep_performance = score.sleep_performance_percentage || 0;
        data.sleep_efficiency = score.sleep_efficiency_percentage || 0;
        data.respiratory_rate = score.respiratory_rate || 0;
        
        const stages = score.stage_summary;
        if (stages) {
          data.sleep_duration_minutes = Math.round((stages.total_in_bed_time_milli - stages.total_awake_time_milli) / 60000);
          data.rem_duration_minutes = Math.round(stages.total_rem_sleep_time_milli / 60000);
          data.deep_duration_minutes = Math.round(stages.total_slow_wave_sleep_time_milli / 60000);
          data.light_duration_minutes = Math.round(stages.total_light_sleep_time_milli / 60000);
          data.awake_duration_minutes = Math.round(stages.total_awake_time_milli / 60000);
        }
        
        const needed = score.sleep_needed;
        if (needed) {
          data.sleep_needed_minutes = Math.round(needed.baseline_milli / 60000);
          data.sleep_debt_minutes = Math.round(needed.need_from_sleep_debt_milli / 60000);
        }
      }
      
      data.sleep_id = sleep.id.toString();
      dailyDataMap.set(date, data);
    }

    // Process workouts - aggregate by day
    const workoutsByDate = new Map<string, { count: number; strain: number; calories: number }>();
    for (const workout of workouts) {
      const date = workout.start.split('T')[0];
      const existing = workoutsByDate.get(date) || { count: 0, strain: 0, calories: 0 };
      existing.count++;
      existing.strain += workout.score?.strain || 0;
      existing.calories += workout.score?.kilojoule ? Math.round(workout.score.kilojoule / 4.184) : 0;
      workoutsByDate.set(date, existing);
    }

    for (const [date, workoutData] of workoutsByDate) {
      const data = dailyDataMap.get(date) || this.createEmptyDailyData(userId, date);
      data.workout_count = workoutData.count;
      data.total_workout_strain = workoutData.strain;
      data.total_workout_calories = workoutData.calories;
      dailyDataMap.set(date, data);
    }

    // Add body measurement to all days (it's current weight, applies to recent data)
    if (bodyMeasurement) {
      for (const data of dailyDataMap.values()) {
        data.weight_kg = bodyMeasurement.weight_kilogram;
      }
    }

    // Save all daily data to D1
    const syncedDates: string[] = [];
    for (const [date, data] of dailyDataMap) {
      await this.saveDailyData(data);
      syncedDates.push(date);
    }

    // Also sync workouts to the workouts table for detailed view
    // IMPORTANT: Reuse the workouts we already fetched above instead of making another API call
    await this.saveWorkoutsToTable(userId, workouts);

    console.log(`Synced ${syncedDates.length} days of data`);
    return { synced: syncedDates.length, dates: syncedDates };
  }

  /**
   * Save workouts to the whoop_workouts table (no API call, just DB save)
   */
  private async saveWorkoutsToTable(userId: string, workouts: WhoopWorkoutResponse[]): Promise<void> {
    for (const workout of workouts) {
      const isBarrys = this.isBarrysWorkout(workout);
      const caloriesBurned = workout.score.kilojoule / 4.184;
      
      await this.db.prepare(`
        INSERT INTO whoop_workouts (id, user_id, whoop_id, sport_name, start_time, end_time, 
          calories_burned, average_heart_rate, max_heart_rate, strain, is_barrys, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(whoop_id) DO UPDATE SET
          sport_name = excluded.sport_name,
          calories_burned = excluded.calories_burned,
          average_heart_rate = excluded.average_heart_rate,
          max_heart_rate = excluded.max_heart_rate,
          strain = excluded.strain
      `).bind(
        crypto.randomUUID(),
        userId,
        workout.id.toString(),
        SPORT_NAMES[workout.sport_id] || 'Activity',
        workout.start,
        workout.end,
        Math.round(caloriesBurned),
        workout.score.average_heart_rate,
        workout.score.max_heart_rate,
        workout.score.strain,
        isBarrys ? 1 : 0,
        new Date().toISOString()
      ).run();
    }
  }

  /**
   * Create empty daily data object
   */
  private createEmptyDailyData(userId: string, date: string): WhoopDailyData {
    return {
      id: crypto.randomUUID(),
      user_id: userId,
      date,
      recovery_score: null,
      hrv_rmssd: null,
      resting_heart_rate: null,
      spo2_percentage: null,
      skin_temp_celsius: null,
      sleep_performance: null,
      sleep_efficiency: null,
      sleep_duration_minutes: null,
      rem_duration_minutes: null,
      deep_duration_minutes: null,
      light_duration_minutes: null,
      awake_duration_minutes: null,
      respiratory_rate: null,
      sleep_needed_minutes: null,
      sleep_debt_minutes: null,
      day_strain: null,
      day_calories: null,
      day_avg_hr: null,
      day_max_hr: null,
      weight_kg: null,
      workout_count: 0,
      total_workout_strain: 0,
      total_workout_calories: 0,
      cycle_id: null,
      sleep_id: null,
      recovery_id: null,
      synced_at: new Date().toISOString()
    };
  }

  /**
   * Save daily data to D1
   */
  private async saveDailyData(data: WhoopDailyData): Promise<void> {
    // Use COALESCE to avoid overwriting good data with nulls
    await this.db.prepare(`
      INSERT INTO whoop_daily (
        id, user_id, date, recovery_score, hrv_rmssd, resting_heart_rate,
        spo2_percentage, skin_temp_celsius, sleep_performance, sleep_efficiency,
        sleep_duration_minutes, rem_duration_minutes, deep_duration_minutes,
        light_duration_minutes, awake_duration_minutes, respiratory_rate,
        sleep_needed_minutes, sleep_debt_minutes, day_strain, day_calories,
        day_avg_hr, day_max_hr, weight_kg, workout_count, total_workout_strain,
        total_workout_calories, cycle_id, sleep_id, recovery_id, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET
        recovery_score = COALESCE(excluded.recovery_score, whoop_daily.recovery_score),
        hrv_rmssd = COALESCE(excluded.hrv_rmssd, whoop_daily.hrv_rmssd),
        resting_heart_rate = COALESCE(excluded.resting_heart_rate, whoop_daily.resting_heart_rate),
        spo2_percentage = COALESCE(excluded.spo2_percentage, whoop_daily.spo2_percentage),
        skin_temp_celsius = COALESCE(excluded.skin_temp_celsius, whoop_daily.skin_temp_celsius),
        sleep_performance = COALESCE(excluded.sleep_performance, whoop_daily.sleep_performance),
        sleep_efficiency = COALESCE(excluded.sleep_efficiency, whoop_daily.sleep_efficiency),
        sleep_duration_minutes = COALESCE(excluded.sleep_duration_minutes, whoop_daily.sleep_duration_minutes),
        rem_duration_minutes = COALESCE(excluded.rem_duration_minutes, whoop_daily.rem_duration_minutes),
        deep_duration_minutes = COALESCE(excluded.deep_duration_minutes, whoop_daily.deep_duration_minutes),
        light_duration_minutes = COALESCE(excluded.light_duration_minutes, whoop_daily.light_duration_minutes),
        awake_duration_minutes = COALESCE(excluded.awake_duration_minutes, whoop_daily.awake_duration_minutes),
        respiratory_rate = COALESCE(excluded.respiratory_rate, whoop_daily.respiratory_rate),
        sleep_needed_minutes = COALESCE(excluded.sleep_needed_minutes, whoop_daily.sleep_needed_minutes),
        sleep_debt_minutes = COALESCE(excluded.sleep_debt_minutes, whoop_daily.sleep_debt_minutes),
        day_strain = COALESCE(excluded.day_strain, whoop_daily.day_strain),
        day_calories = COALESCE(excluded.day_calories, whoop_daily.day_calories),
        day_avg_hr = COALESCE(excluded.day_avg_hr, whoop_daily.day_avg_hr),
        day_max_hr = COALESCE(excluded.day_max_hr, whoop_daily.day_max_hr),
        weight_kg = COALESCE(excluded.weight_kg, whoop_daily.weight_kg),
        workout_count = COALESCE(excluded.workout_count, whoop_daily.workout_count),
        total_workout_strain = COALESCE(excluded.total_workout_strain, whoop_daily.total_workout_strain),
        total_workout_calories = COALESCE(excluded.total_workout_calories, whoop_daily.total_workout_calories),
        cycle_id = COALESCE(excluded.cycle_id, whoop_daily.cycle_id),
        sleep_id = COALESCE(excluded.sleep_id, whoop_daily.sleep_id),
        recovery_id = COALESCE(excluded.recovery_id, whoop_daily.recovery_id),
        synced_at = excluded.synced_at
    `).bind(
      data.id, data.user_id, data.date, data.recovery_score, data.hrv_rmssd,
      data.resting_heart_rate, data.spo2_percentage, data.skin_temp_celsius,
      data.sleep_performance, data.sleep_efficiency, data.sleep_duration_minutes,
      data.rem_duration_minutes, data.deep_duration_minutes, data.light_duration_minutes,
      data.awake_duration_minutes, data.respiratory_rate, data.sleep_needed_minutes,
      data.sleep_debt_minutes, data.day_strain, data.day_calories, data.day_avg_hr,
      data.day_max_hr, data.weight_kg, data.workout_count, data.total_workout_strain,
      data.total_workout_calories, data.cycle_id, data.sleep_id, data.recovery_id,
      data.synced_at
    ).run();
  }

  /**
   * Get daily data for a specific date
   */
  async getDailyData(userId: string, date: string): Promise<WhoopDailyData | null> {
    const result = await this.db.prepare(
      'SELECT * FROM whoop_daily WHERE user_id = ? AND date = ?'
    ).bind(userId, date).first();
    
    return result as WhoopDailyData | null;
  }

  /**
   * Get daily data for a date range
   */
  async getDateRange(userId: string, startDate: string, endDate: string): Promise<WhoopDailyData[]> {
    console.log(`[WhoopService] getDateRange: userId=${userId}, start=${startDate}, end=${endDate}`);
    const result = await this.db.prepare(
      'SELECT * FROM whoop_daily WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date DESC'
    ).bind(userId, startDate, endDate).all();
    
    console.log(`[WhoopService] getDateRange: found ${result.results?.length || 0} records`);
    return (result.results || []) as unknown as WhoopDailyData[];
  }

  /**
   * Get weekly summary
   */
  async getWeeklySummary(userId: string, weekStartDate: string): Promise<WeeklySummary> {
    // Parse the date string directly to avoid timezone issues
    const [year, month, day] = weekStartDate.split('-').map(Number);
    const endDay = day + 6;
    
    // Calculate end date (handling month overflow)
    const endDateObj = new Date(Date.UTC(year, month - 1, endDay));
    const endDateStr = endDateObj.toISOString().split('T')[0];
    
    console.log(`[WhoopService] getWeeklySummary: start=${weekStartDate}, end=${endDateStr}`);
    const data = await this.getDateRange(userId, weekStartDate, endDateStr);
    
    const daysWithData = data.filter(d => d.recovery_score !== null);
    
    return {
      start_date: weekStartDate,
      end_date: endDateStr,
      days: data.length,
      avg_recovery: daysWithData.length > 0 
        ? Math.round(daysWithData.reduce((sum, d) => sum + (d.recovery_score || 0), 0) / daysWithData.length)
        : null,
      avg_strain: daysWithData.length > 0
        ? Math.round(daysWithData.reduce((sum, d) => sum + (d.day_strain || 0), 0) / daysWithData.length * 10) / 10
        : null,
      avg_sleep_hours: daysWithData.length > 0
        ? Math.round(daysWithData.reduce((sum, d) => sum + (d.sleep_duration_minutes || 0), 0) / daysWithData.length / 60 * 10) / 10
        : null,
      total_workouts: data.reduce((sum, d) => sum + (d.workout_count || 0), 0),
      total_calories: data.reduce((sum, d) => sum + (d.day_calories || 0), 0),
      daily_data: data
    };
  }

  /**
   * Get monthly summary
   */
  async getMonthlySummary(userId: string, year: number, month: number): Promise<MonthlySummary> {
    // Use UTC dates to avoid timezone issues
    const startDateStr = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const endDateStr = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    
    console.log(`[WhoopService] getMonthlySummary: year=${year}, month=${month}, startDate=${startDateStr}, endDate=${endDateStr}`);
    
    const data = await this.getDateRange(userId, startDateStr, endDateStr);
    
    // Get Barry's workouts for this month
    const barrysResult = await this.db.prepare(
      `SELECT DATE(workout_date) as date FROM barrys_workouts 
       WHERE user_id = ? AND workout_date >= ? AND workout_date <= ?`
    ).bind(userId, startDateStr, endDateStr).all();
    
    const barrysDates = new Set((barrysResult.results || []).map((r: any) => r.date));
    
    const daysWithRecovery = data.filter(d => d.recovery_score !== null);
    const firstWeight = data.find(d => d.weight_kg)?.weight_kg;
    const lastWeight = [...data].reverse().find(d => d.weight_kg)?.weight_kg;
    
    return {
      year,
      month,
      days: data.length,
      avg_recovery: daysWithRecovery.length > 0
        ? Math.round(daysWithRecovery.reduce((sum, d) => sum + (d.recovery_score || 0), 0) / daysWithRecovery.length)
        : null,
      avg_strain: daysWithRecovery.length > 0
        ? Math.round(daysWithRecovery.reduce((sum, d) => sum + (d.day_strain || 0), 0) / daysWithRecovery.length * 10) / 10
        : null,
      avg_sleep_hours: daysWithRecovery.length > 0
        ? Math.round(daysWithRecovery.reduce((sum, d) => sum + (d.sleep_duration_minutes || 0), 0) / daysWithRecovery.length / 60 * 10) / 10
        : null,
      total_workouts: data.reduce((sum, d) => sum + (d.workout_count || 0), 0),
      total_barrys: barrysDates.size,
      barrys_dates: Array.from(barrysDates),
      weight_change_kg: firstWeight && lastWeight ? Math.round((lastWeight - firstWeight) * 10) / 10 : null,
      best_recovery_day: daysWithRecovery.length > 0 
        ? daysWithRecovery.reduce((best, d) => (d.recovery_score || 0) > (best.recovery_score || 0) ? d : best).date
        : null,
      daily_data: data
    };
  }

  /**
   * Backfill historical data in chunks to avoid rate limits
   * Fetches 14 days of data per call, working backwards from earliest existing data
   * 
   * @param userId - User ID
   * @param accessToken - Valid Whoop access token
   * @param targetDaysBack - Total days to backfill (e.g., 180 for 6 months from today)
   * @param currentProgress - How many days back we've already synced beyond earliest
   * @param earliestDate - Optional: earliest date we already have (to start backfill from there)
   * @returns Progress info including whether backfill is complete
   */
  async backfillChunk(
    userId: string, 
    accessToken: string, 
    targetDaysBack: number = 180,
    currentProgress: number = 0,
    earliestDate?: string
  ): Promise<BackfillProgress> {
    const CHUNK_SIZE = 14; // Days per chunk - 2 weeks at a time
    
    // If we've already backfilled everything, we're done
    if (currentProgress >= targetDaysBack) {
      return {
        complete: true,
        daysProcessed: currentProgress,
        targetDays: targetDaysBack,
        chunkSynced: 0,
        nextProgress: currentProgress,
        message: 'Backfill complete!'
      };
    }

    // Calculate the date range for this chunk
    // Start from earliest existing date (or today if none) and work backwards
    const baseDate = earliestDate ? new Date(earliestDate) : new Date();
    
    const chunkEnd = new Date(baseDate);
    chunkEnd.setDate(baseDate.getDate() - currentProgress - 1); // -1 to not overlap with existing
    
    const chunkStart = new Date(chunkEnd);
    chunkStart.setDate(chunkEnd.getDate() - CHUNK_SIZE);
    
    // Don't go further back than 6 months from today
    const today = new Date();
    const absoluteLimit = new Date(today);
    absoluteLimit.setDate(today.getDate() - targetDaysBack);
    if (chunkStart < absoluteLimit) {
      chunkStart.setTime(absoluteLimit.getTime());
    }

    const startStr = chunkStart.toISOString().split('T')[0];
    const endStr = chunkEnd.toISOString().split('T')[0];
    
    console.log(`Backfill chunk: ${startStr} to ${endStr} (progress: ${currentProgress}/${targetDaysBack}, earliest: ${earliestDate || 'today'})`);

    try {
      // Fetch data for this chunk
      const cycles = await this.getCycles(accessToken, startStr, endStr);
      const recoveries = await this.getRecovery(accessToken, startStr, endStr);
      const sleeps = await this.getSleep(accessToken, startStr, endStr);
      const workouts = await this.getWorkouts(accessToken, startStr, endStr);

      console.log(`Backfill chunk ${startStr} to ${endStr}: ${cycles.length} cycles, ${recoveries.length} recoveries, ${sleeps.length} sleeps, ${workouts.length} workouts`);
      
      // Log if recovery/sleep is missing (helps debug)
      if (cycles.length > 0 && recoveries.length === 0) {
        console.warn(`WARNING: Got ${cycles.length} cycles but 0 recoveries for ${startStr} to ${endStr}`);
      }
      if (cycles.length > 0 && sleeps.length === 0) {
        console.warn(`WARNING: Got ${cycles.length} cycles but 0 sleeps for ${startStr} to ${endStr}`);
      }

      // Process and save data (reuse existing logic)
      const dailyDataMap = new Map<string, WhoopDailyData>();

      // Process cycles
      for (const cycle of cycles) {
        const date = cycle.start.split('T')[0];
        const data = dailyDataMap.get(date) || this.createEmptyDailyData(userId, date);
        data.day_strain = cycle.score?.strain || 0;
        data.day_calories = cycle.score?.kilojoule ? Math.round(cycle.score.kilojoule / 4.184) : 0;
        data.day_avg_hr = cycle.score?.average_heart_rate || 0;
        data.day_max_hr = cycle.score?.max_heart_rate || 0;
        data.cycle_id = cycle.id.toString();
        dailyDataMap.set(date, data);
      }

      // Process recovery
      for (const recovery of recoveries) {
        const date = recovery.created_at.split('T')[0];
        const data = dailyDataMap.get(date) || this.createEmptyDailyData(userId, date);
        const score = recovery.score;
        if (score) {
          // Only set values if they actually exist (don't overwrite with 0)
          if (score.recovery_score !== undefined && score.recovery_score !== null) {
            data.recovery_score = score.recovery_score;
          }
          if (score.hrv_rmssd_milli) data.hrv_rmssd = score.hrv_rmssd_milli;
          if (score.resting_heart_rate) data.resting_heart_rate = score.resting_heart_rate;
          if (score.spo2_percentage) data.spo2_percentage = score.spo2_percentage;
          if (score.skin_temp_celsius) data.skin_temp_celsius = score.skin_temp_celsius;
        }
        data.recovery_id = recovery.cycle_id.toString();
        dailyDataMap.set(date, data);
      }

      // Process sleep
      for (const sleep of sleeps) {
        if (sleep.nap) continue;
        const date = sleep.end.split('T')[0];
        const data = dailyDataMap.get(date) || this.createEmptyDailyData(userId, date);
        const score = sleep.score;
        if (score) {
          data.sleep_performance = score.sleep_performance_percentage || 0;
          data.sleep_efficiency = score.sleep_efficiency_percentage || 0;
          data.respiratory_rate = score.respiratory_rate || 0;
          const stages = score.stage_summary;
          if (stages) {
            data.sleep_duration_minutes = Math.round((stages.total_in_bed_time_milli - stages.total_awake_time_milli) / 60000);
            data.rem_duration_minutes = Math.round(stages.total_rem_sleep_time_milli / 60000);
            data.deep_duration_minutes = Math.round(stages.total_slow_wave_sleep_time_milli / 60000);
            data.light_duration_minutes = Math.round(stages.total_light_sleep_time_milli / 60000);
            data.awake_duration_minutes = Math.round(stages.total_awake_time_milli / 60000);
          }
          const needed = score.sleep_needed;
          if (needed) {
            data.sleep_needed_minutes = Math.round(needed.baseline_milli / 60000);
            data.sleep_debt_minutes = Math.round(needed.need_from_sleep_debt_milli / 60000);
          }
        }
        data.sleep_id = sleep.id.toString();
        dailyDataMap.set(date, data);
      }

      // Process workouts
      const workoutsByDate = new Map<string, { count: number; strain: number; calories: number }>();
      for (const workout of workouts) {
        const date = workout.start.split('T')[0];
        const existing = workoutsByDate.get(date) || { count: 0, strain: 0, calories: 0 };
        existing.count++;
        existing.strain += workout.score?.strain || 0;
        existing.calories += workout.score?.kilojoule ? Math.round(workout.score.kilojoule / 4.184) : 0;
        workoutsByDate.set(date, existing);
      }
      for (const [date, workoutData] of workoutsByDate) {
        const data = dailyDataMap.get(date) || this.createEmptyDailyData(userId, date);
        data.workout_count = workoutData.count;
        data.total_workout_strain = workoutData.strain;
        data.total_workout_calories = workoutData.calories;
        dailyDataMap.set(date, data);
      }

      // Save to database
      for (const data of dailyDataMap.values()) {
        await this.saveDailyData(data);
      }

      // Also sync workouts to detailed table
      for (const workout of workouts) {
        const isBarrys = this.isBarrysWorkout(workout);
        const caloriesBurned = workout.score.kilojoule / 4.184;
        await this.db.prepare(`
          INSERT INTO whoop_workouts (id, user_id, whoop_id, sport_name, start_time, end_time, 
            calories_burned, average_heart_rate, max_heart_rate, strain, is_barrys, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(whoop_id) DO UPDATE SET
            sport_name = excluded.sport_name,
            calories_burned = excluded.calories_burned,
            average_heart_rate = excluded.average_heart_rate,
            max_heart_rate = excluded.max_heart_rate,
            strain = excluded.strain
        `).bind(
          crypto.randomUUID(),
          userId,
          workout.id.toString(),
          SPORT_NAMES[workout.sport_id] || 'Activity',
          workout.start,
          workout.end,
          Math.round(caloriesBurned),
          workout.score.average_heart_rate,
          workout.score.max_heart_rate,
          workout.score.strain,
          isBarrys ? 1 : 0,
          new Date().toISOString()
        ).run();
      }

      const newProgress = Math.min(currentProgress + CHUNK_SIZE, targetDaysBack);
      const isComplete = newProgress >= targetDaysBack;

      return {
        complete: isComplete,
        daysProcessed: newProgress,
        targetDays: targetDaysBack,
        chunkSynced: dailyDataMap.size,
        nextProgress: newProgress,
        message: isComplete 
          ? `Backfill complete! Synced ${targetDaysBack} days of data.`
          : `Synced ${startStr} to ${endStr} (${dailyDataMap.size} days). ${targetDaysBack - newProgress} days remaining.`
      };
    } catch (error) {
      console.error('Backfill chunk failed:', error);
      return {
        complete: false,
        daysProcessed: currentProgress,
        targetDays: targetDaysBack,
        chunkSynced: 0,
        nextProgress: currentProgress,
        error: error instanceof Error ? error.message : 'Unknown error',
        message: `Backfill failed at ${startStr}. Will retry next hour.`
      };
    }
  }

  /**
   * Detect gaps in historical data
   * Finds all missing dates between the earliest and latest data points
   */
  async detectGaps(userId: string, daysBack: number = 180): Promise<GapDetectionResult> {
    // Get date range
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - daysBack);
    
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = today.toISOString().split('T')[0];
    
    // Get all existing dates
    const result = await this.db.prepare(
      'SELECT date FROM whoop_daily WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date'
    ).bind(userId, startStr, endStr).all();
    
    const existingDates = new Set((result.results || []).map((r: any) => r.date));
    
    if (existingDates.size === 0) {
      return {
        hasGaps: false,
        missingDates: [],
        totalDays: daysBack,
        existingDays: 0,
        earliestDate: null,
        latestDate: null
      };
    }
    
    // Find earliest and latest dates we have
    const sortedDates = Array.from(existingDates).sort();
    const earliestDate = sortedDates[0];
    const latestDate = sortedDates[sortedDates.length - 1];
    
    // Generate all expected dates between earliest and today
    const missingDates: string[] = [];
    const current = new Date(earliestDate);
    const end = new Date(endStr);
    
    while (current <= end) {
      const dateStr = current.toISOString().split('T')[0];
      if (!existingDates.has(dateStr)) {
        missingDates.push(dateStr);
      }
      current.setDate(current.getDate() + 1);
    }
    
    console.log(`[WhoopService] Gap detection for ${userId}: ${existingDates.size} existing days, ${missingDates.length} gaps found`);
    
    return {
      hasGaps: missingDates.length > 0,
      missingDates,
      totalDays: Math.ceil((end.getTime() - new Date(earliestDate).getTime()) / (1000 * 60 * 60 * 24)) + 1,
      existingDays: existingDates.size,
      earliestDate,
      latestDate
    };
  }

  /**
   * Fill gaps by fetching missing dates from Whoop API
   * Processes in batches to avoid rate limits
   */
  async fillGaps(
    userId: string, 
    accessToken: string, 
    missingDates: string[],
    maxBatchSize: number = 30
  ): Promise<GapFillResult> {
    if (missingDates.length === 0) {
      return {
        success: true,
        filledDates: [],
        failedDates: [],
        message: 'No gaps to fill'
      };
    }

    console.log(`[WhoopService] Filling ${missingDates.length} gap dates for ${userId}`);
    
    const filledDates: string[] = [];
    const failedDates: string[] = [];
    
    // Sort dates and process in batches (by date range for efficiency)
    const sortedDates = [...missingDates].sort();
    
    // Group consecutive dates into ranges
    const ranges: { start: string; end: string }[] = [];
    let rangeStart = sortedDates[0];
    let rangeEnd = sortedDates[0];
    
    for (let i = 1; i < sortedDates.length; i++) {
      const currentDate = new Date(sortedDates[i]);
      const prevDate = new Date(sortedDates[i - 1]);
      const diffDays = (currentDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24);
      
      if (diffDays === 1) {
        // Consecutive date, extend range
        rangeEnd = sortedDates[i];
      } else {
        // Gap in dates, save current range and start new one
        ranges.push({ start: rangeStart, end: rangeEnd });
        rangeStart = sortedDates[i];
        rangeEnd = sortedDates[i];
      }
    }
    // Don't forget the last range
    ranges.push({ start: rangeStart, end: rangeEnd });
    
    console.log(`[WhoopService] Processing ${ranges.length} date ranges`);
    
    // Process each range
    for (const range of ranges) {
      try {
        console.log(`[WhoopService] Fetching data for range: ${range.start} to ${range.end}`);
        
        // Fetch data from Whoop API
        const cycles = await this.getCycles(accessToken, range.start, range.end);
        const recoveries = await this.getRecovery(accessToken, range.start, range.end);
        const sleeps = await this.getSleep(accessToken, range.start, range.end);
        const workouts = await this.getWorkouts(accessToken, range.start, range.end);
        
        console.log(`[WhoopService] Got: ${cycles.length} cycles, ${recoveries.length} recoveries, ${sleeps.length} sleeps, ${workouts.length} workouts`);
        
        // Process and save data
        const dailyDataMap = new Map<string, WhoopDailyData>();
        
        // Process cycles
        for (const cycle of cycles) {
          const date = cycle.start.split('T')[0];
          const data = dailyDataMap.get(date) || this.createEmptyDailyData(userId, date);
          data.day_strain = cycle.score?.strain || 0;
          data.day_calories = cycle.score?.kilojoule ? Math.round(cycle.score.kilojoule / 4.184) : 0;
          data.day_avg_hr = cycle.score?.average_heart_rate || 0;
          data.day_max_hr = cycle.score?.max_heart_rate || 0;
          data.cycle_id = cycle.id.toString();
          dailyDataMap.set(date, data);
        }
        
        // Process recovery
        for (const recovery of recoveries) {
          const date = recovery.created_at.split('T')[0];
          const data = dailyDataMap.get(date) || this.createEmptyDailyData(userId, date);
          const score = recovery.score;
          if (score) {
            if (score.recovery_score !== undefined && score.recovery_score !== null) {
              data.recovery_score = score.recovery_score;
            }
            if (score.hrv_rmssd_milli) data.hrv_rmssd = score.hrv_rmssd_milli;
            if (score.resting_heart_rate) data.resting_heart_rate = score.resting_heart_rate;
            if (score.spo2_percentage) data.spo2_percentage = score.spo2_percentage;
            if (score.skin_temp_celsius) data.skin_temp_celsius = score.skin_temp_celsius;
          }
          data.recovery_id = recovery.cycle_id?.toString();
          dailyDataMap.set(date, data);
        }
        
        // Process sleep (skip naps, use end date as the day it counts for)
        for (const sleep of sleeps) {
          if (sleep.nap) continue;
          
          const date = sleep.end.split('T')[0]; // Use end date as the day it counts for
          const data = dailyDataMap.get(date) || this.createEmptyDailyData(userId, date);
          const score = sleep.score;
          if (score) {
            data.sleep_performance = score.sleep_performance_percentage || 0;
            data.sleep_efficiency = score.sleep_efficiency_percentage || 0;
            data.respiratory_rate = score.respiratory_rate || 0;
            
            const stages = score.stage_summary;
            if (stages) {
              data.sleep_duration_minutes = Math.round((stages.total_in_bed_time_milli - stages.total_awake_time_milli) / 60000);
              data.rem_duration_minutes = Math.round(stages.total_rem_sleep_time_milli / 60000);
              data.deep_duration_minutes = Math.round(stages.total_slow_wave_sleep_time_milli / 60000);
              data.light_duration_minutes = Math.round(stages.total_light_sleep_time_milli / 60000);
              data.awake_duration_minutes = Math.round(stages.total_awake_time_milli / 60000);
            }
            
            const needed = score.sleep_needed;
            if (needed) {
              data.sleep_needed_minutes = Math.round(needed.baseline_milli / 60000);
              data.sleep_debt_minutes = Math.round(needed.need_from_sleep_debt_milli / 60000);
            }
          }
          data.sleep_id = sleep.id.toString();
          dailyDataMap.set(date, data);
        }
        
        // Process workouts
        const workoutsByDate = new Map<string, { count: number; strain: number; calories: number }>();
        for (const workout of workouts) {
          const date = workout.start.split('T')[0];
          const existing = workoutsByDate.get(date) || { count: 0, strain: 0, calories: 0 };
          existing.count++;
          existing.strain += workout.score?.strain || 0;
          existing.calories += workout.score?.kilojoule ? Math.round(workout.score.kilojoule / 4.184) : 0;
          workoutsByDate.set(date, existing);
        }
        
        for (const [date, workoutData] of workoutsByDate) {
          const data = dailyDataMap.get(date) || this.createEmptyDailyData(userId, date);
          data.workout_count = workoutData.count;
          data.total_workout_strain = workoutData.strain;
          data.total_workout_calories = workoutData.calories;
          dailyDataMap.set(date, data);
        }
        
        // Save all data
        for (const data of dailyDataMap.values()) {
          data.synced_at = new Date().toISOString();
          await this.saveDailyData(data);
          filledDates.push(data.date);
        }
        
        console.log(`[WhoopService] Saved ${dailyDataMap.size} days for range ${range.start} to ${range.end}`);
        
      } catch (error) {
        console.error(`[WhoopService] Failed to fill range ${range.start} to ${range.end}:`, error);
        
        // Mark all dates in this range as failed
        const current = new Date(range.start);
        const end = new Date(range.end);
        while (current <= end) {
          const dateStr = current.toISOString().split('T')[0];
          if (missingDates.includes(dateStr)) {
            failedDates.push(dateStr);
          }
          current.setDate(current.getDate() + 1);
        }
      }
    }
    
    const success = failedDates.length === 0;
    const message = success
      ? `Successfully filled ${filledDates.length} missing dates`
      : `Filled ${filledDates.length} dates, ${failedDates.length} failed`;
    
    console.log(`[WhoopService] Gap fill complete: ${message}`);
    
    return {
      success,
      filledDates,
      failedDates,
      message
    };
  }
}

// Backfill progress type
interface BackfillProgress {
  complete: boolean;
  daysProcessed: number;
  targetDays: number;
  chunkSynced: number;
  nextProgress: number;
  error?: string;
  message: string;
}

// Gap detection result
interface GapDetectionResult {
  hasGaps: boolean;
  missingDates: string[];
  totalDays: number;
  existingDays: number;
  earliestDate: string | null;
  latestDate: string | null;
}

// Gap fill result
interface GapFillResult {
  success: boolean;
  filledDates: string[];
  failedDates: string[];
  message: string;
}

// Additional types
interface WhoopCycleResponse {
  id: number;
  user_id: number;
  start: string;
  end: string;
  timezone_offset: string;
  score_state: string;
  score: {
    strain: number;
    kilojoule: number;
    average_heart_rate: number;
    max_heart_rate: number;
  } | null;
}

interface WhoopDailyData {
  id: string;
  user_id: string;
  date: string;
  recovery_score: number | null;
  hrv_rmssd: number | null;
  resting_heart_rate: number | null;
  spo2_percentage: number | null;
  skin_temp_celsius: number | null;
  sleep_performance: number | null;
  sleep_efficiency: number | null;
  sleep_duration_minutes: number | null;
  rem_duration_minutes: number | null;
  deep_duration_minutes: number | null;
  light_duration_minutes: number | null;
  awake_duration_minutes: number | null;
  respiratory_rate: number | null;
  sleep_needed_minutes: number | null;
  sleep_debt_minutes: number | null;
  day_strain: number | null;
  day_calories: number | null;
  day_avg_hr: number | null;
  day_max_hr: number | null;
  weight_kg: number | null;
  workout_count: number;
  total_workout_strain: number;
  total_workout_calories: number;
  cycle_id: string | null;
  sleep_id: string | null;
  recovery_id: string | null;
  synced_at: string;
}

interface WeeklySummary {
  start_date: string;
  end_date: string;
  days: number;
  avg_recovery: number | null;
  avg_strain: number | null;
  avg_sleep_hours: number | null;
  total_workouts: number;
  total_calories: number;
  daily_data: WhoopDailyData[];
}

interface MonthlySummary {
  year: number;
  month: number;
  days: number;
  avg_recovery: number | null;
  avg_strain: number | null;
  avg_sleep_hours: number | null;
  total_workouts: number;
  total_barrys: number;
  barrys_dates: string[];
  weight_change_kg: number | null;
  best_recovery_day: string | null;
  daily_data: WhoopDailyData[];
}
