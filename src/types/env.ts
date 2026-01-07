/// <reference types="@cloudflare/workers-types" />

import type { AgentNamespace } from 'agents';
import type { UserAgent } from '../agents/UserAgent';
import type { ChatAgent } from '../agents/ChatAgent';

// Cloudflare bindings type definitions
export interface Env {
  // D1 Database - historical data storage
  DB: D1Database;
  
  // R2 Bucket for photos
  PHOTOS: R2Bucket;
  
  // KV Namespaces
  SESSIONS: KVNamespace;
  CACHE: KVNamespace;
  
  // Workers AI (for embeddings only, LLM via AI Gateway)
  AI: Ai;
  
  // Vectorize Index
  FOOD_INDEX: VectorizeIndex;
  
  // Analytics Engine
  ANALYTICS: AnalyticsEngineDataset;
  
  // Browser Rendering (for recipe scraping, optional)
  BROWSER?: Fetcher;
  
  // Queues (legacy, kept for backward compatibility - will remove in v4)
  WHOOP_QUEUE?: Queue;
  PHOTO_QUEUE?: Queue;
  
  // UserAgent - Cloudflare Agents SDK (one agent per user)
  // Handles: meals, workouts, habits, streaks, scheduling
  // Using AgentNamespace<UserAgent> for proper RPC typing
  USER_AGENT: AgentNamespace<UserAgent>;
  
  // ChatAgent - AI fitness coach with tool calls
  // Handles: chat history, AI responses with data lookups
  CHAT_AGENT: AgentNamespace<ChatAgent>;
  
  // Legacy Durable Objects (kept for migration, will be removed in v4)
  DAILY_TRACKER: DurableObjectNamespace;
  STREAK_MANAGER: DurableObjectNamespace;
  DAILY_TRACKER_V2: DurableObjectNamespace;
  STREAK_MANAGER_V2: DurableObjectNamespace;
  
  // Environment variables
  WHOOP_CLIENT_ID: string;
  WHOOP_CLIENT_SECRET: string;
  JWT_SECRET: string;
  
  // AI Gateway (Unified Billing)
  CF_API_TOKEN?: string;
  
  // Optional: Direct API Keys (if not using unified billing)
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  
  // Assets
  ASSETS: Fetcher;
  
  // TODO: Code Mode bindings (once DO support is ready)
  // LOADER: WorkerLoader;
  // SELF: Fetcher;
}

// User type
export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url?: string;
  whoop_connected: boolean;
  wyze_connected: boolean;
  created_at: string;
  updated_at: string;
  goals: UserGoals;
}

export interface UserGoals {
  daily_calories: number;
  daily_protein: number;
  daily_carbs: number;
  daily_fat: number;
  target_weight?: number;
  workout_days_per_week: number;
}

// Meal/Food tracking
export interface Meal {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  meal_type: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  photo_url?: string;
  source: 'manual' | 'photo_ai' | 'recipe_import' | 'quick_add';
  logged_at: string;
  created_at: string;
}

// Progress photos
export interface ProgressPhoto {
  id: string;
  user_id: string;
  photo_url: string;
  thumbnail_url?: string;
  ai_analysis?: ProgressAnalysis;
  weight?: number;
  body_fat?: number;
  notes?: string;
  taken_at: string;
  created_at: string;
}

export interface ProgressAnalysis {
  observations: string[];
  comparison_to_previous?: string;
  visible_changes?: string[];
  recommendations?: string[];
}

// Whoop data
export interface WhoopWorkout {
  id: string;
  user_id: string;
  whoop_id: string;
  sport_name: string;
  start_time: string;
  end_time: string;
  calories_burned: number;
  average_heart_rate: number;
  max_heart_rate: number;
  strain: number;
  is_barrys: boolean;
  created_at: string;
}

export interface WhoopRecovery {
  id: string;
  user_id: string;
  whoop_cycle_id: string;
  recovery_score: number;
  resting_heart_rate: number;
  hrv: number;
  sleep_performance: number;
  date: string;
  created_at: string;
}

// Wyze scale data
export interface WyzeWeight {
  id: string;
  user_id: string;
  weight: number;
  body_fat?: number;
  muscle_mass?: number;
  bone_mass?: number;
  water_percentage?: number;
  bmi?: number;
  measured_at: string;
  created_at: string;
}

// Daily habits
export interface DailyHabits {
  id: string;
  user_id: string;
  date: string;
  drinks_count: number;
  smoked_weed: boolean;
  water_glasses: number;
  sleep_hours?: number;
  mood_rating?: number; // 1-5
  energy_rating?: number; // 1-5
  notes?: string;
  created_at: string;
  updated_at: string;
}

// Streaks
export type StreakType = 'no_drinks' | 'no_weed' | 'workout' | 'calorie_goal' | 'protein_goal' | 'water_goal' | 'barrys';

export interface Streak {
  type: StreakType;
  current_count: number;
  best_count: number;
  last_achieved_date: string;
}

// Daily summary (stored in Durable Objects)
export interface DailySummary {
  date: string;
  user_id: string;
  
  // Nutrition
  total_calories: number;
  total_protein: number;
  total_carbs: number;
  total_fat: number;
  meals_logged: number;
  
  // Exercise
  workouts_completed: number;
  total_calories_burned: number;
  total_strain: number;
  day_strain?: number;
  barrys_completed: boolean;
  
  // Recovery (from Whoop)
  recovery_score?: number;
  sleep_score?: number;
  sleep_hours?: number;
  hrv?: number;
  resting_hr?: number;
  
  // Weight (from Whoop body measurement)
  weight?: number;
  weight_kg?: number;
  body_fat?: number;
  
  // Habits
  drinks_count: number;
  smoked_weed: boolean;
  water_glasses: number;
  water_bottles: number;
  took_electrolytes: boolean;
  steps?: number;
  
  // Streaks
  streaks: Streak[];
  
  // Goals hit
  calorie_goal_hit: boolean;
  protein_goal_hit: boolean;
  
  updated_at: string;
}

// Queue message types
export interface WhoopSyncMessage {
  user_id: string;
  whoop_access_token: string;
  sync_type: 'full' | 'incremental';
}

export interface PhotoAnalysisMessage {
  user_id: string;
  photo_key: string;
  analysis_type: 'food' | 'progress';
}

// Analytics events
export interface AnalyticsEvent {
  event: string;
  user_id: string;
  properties: Record<string, string | number>;
}
