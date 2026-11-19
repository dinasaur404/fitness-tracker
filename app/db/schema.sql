-- Gains Goblin Database Schema
-- Using Cloudflare D1 (SQLite)

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar_url TEXT,
  -- Profile info for macro calculations
  birthday TEXT, -- YYYY-MM-DD
  height_cm REAL, -- Height in cm
  sex TEXT CHECK(sex IN ('female', 'male')) DEFAULT 'female',
  fitness_goal TEXT CHECK(fitness_goal IN ('recomp', 'cut', 'bulk', 'maintain')) DEFAULT 'recomp',
  -- Integration tokens
  whoop_access_token TEXT,
  whoop_refresh_token TEXT,
  whoop_token_expires_at TEXT,
  whoop_connected INTEGER DEFAULT 0,
  wyze_access_token TEXT,
  wyze_refresh_token TEXT,
  wyze_connected INTEGER DEFAULT 0,
  -- Goals stored as JSON (can be dynamic based on activity)
  goals TEXT DEFAULT '{"daily_calories":1800,"daily_protein":135,"daily_carbs":180,"daily_fat":60,"workout_days_per_week":5,"water_bottles_per_day":3}',
  timezone TEXT DEFAULT 'America/New_York',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Meals table
CREATE TABLE IF NOT EXISTS meals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  meal_type TEXT CHECK(meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')) NOT NULL,
  calories REAL NOT NULL DEFAULT 0,
  protein REAL NOT NULL DEFAULT 0,
  carbs REAL NOT NULL DEFAULT 0,
  fat REAL NOT NULL DEFAULT 0,
  fiber REAL DEFAULT 0,
  sugar REAL DEFAULT 0,
  sodium REAL DEFAULT 0,
  photo_key TEXT,
  source TEXT CHECK(source IN ('manual', 'photo_ai', 'recipe_import', 'quick_add', 'barcode')) DEFAULT 'manual',
  recipe_url TEXT,
  ingredients TEXT, -- JSON array
  pending INTEGER DEFAULT 0, -- 1 if meal is still being analyzed
  logged_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Progress photos table
CREATE TABLE IF NOT EXISTS progress_photos (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  photo_key TEXT NOT NULL,
  thumbnail_key TEXT,
  ai_analysis TEXT, -- JSON object
  weight REAL,
  body_fat REAL,
  notes TEXT,
  tags TEXT, -- JSON array: ['front', 'side', 'back', 'flexing']
  taken_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Whoop workouts table
CREATE TABLE IF NOT EXISTS whoop_workouts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  whoop_id TEXT UNIQUE NOT NULL,
  sport_id INTEGER,
  sport_name TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  calories_burned REAL DEFAULT 0,
  average_heart_rate REAL,
  max_heart_rate REAL,
  strain REAL DEFAULT 0,
  distance_meters REAL,
  altitude_gain_meters REAL,
  altitude_change_meters REAL,
  is_barrys INTEGER DEFAULT 0,
  raw_data TEXT, -- Full JSON from Whoop API
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Whoop recovery/sleep data
CREATE TABLE IF NOT EXISTS whoop_recovery (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  whoop_cycle_id TEXT UNIQUE NOT NULL,
  recovery_score REAL,
  resting_heart_rate REAL,
  hrv REAL,
  spo2 REAL,
  skin_temp REAL,
  sleep_performance REAL,
  sleep_needed_ms INTEGER,
  sleep_debt_ms INTEGER,
  sleep_quality_duration_ms INTEGER,
  date TEXT NOT NULL,
  raw_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Wyze scale measurements
CREATE TABLE IF NOT EXISTS wyze_weights (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  weight REAL NOT NULL,
  body_fat REAL,
  muscle_mass REAL,
  bone_mass REAL,
  water_percentage REAL,
  protein_percentage REAL,
  bmi REAL,
  bmr REAL,
  visceral_fat REAL,
  metabolic_age INTEGER,
  measured_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Daily habits table
CREATE TABLE IF NOT EXISTS daily_habits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  -- Drinks tracking
  drinks_count INTEGER DEFAULT 0,
  drink_types TEXT, -- JSON: [{"type": "beer", "count": 2}, {"type": "wine", "count": 1}]
  -- Weed tracking (2026 resolution: stay weed-free!)
  smoked_weed INTEGER DEFAULT 0,
  weed_notes TEXT,
  -- Water tracking (32oz bottles, goal: 3/day)
  water_bottles INTEGER DEFAULT 0, -- Number of 32oz bottle refills
  -- Electrolytes (LMNT)
  took_electrolytes INTEGER DEFAULT 0,
  -- Activity
  steps INTEGER,
  -- Mood/Energy
  mood_rating INTEGER CHECK(mood_rating BETWEEN 1 AND 5),
  energy_rating INTEGER CHECK(energy_rating BETWEEN 1 AND 5),
  stress_rating INTEGER CHECK(stress_rating BETWEEN 1 AND 5),
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, date)
);

-- Streaks table
CREATE TABLE IF NOT EXISTS streaks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  streak_type TEXT NOT NULL CHECK(streak_type IN ('no_drinks', 'no_weed', 'workout', 'calorie_goal', 'protein_goal', 'water_goal', 'barrys')),
  current_count INTEGER DEFAULT 0,
  best_count INTEGER DEFAULT 0,
  last_achieved_date TEXT,
  started_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, streak_type)
);

-- Food database for quick lookup (seeded with common foods)
CREATE TABLE IF NOT EXISTS food_database (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT,
  serving_size TEXT NOT NULL,
  serving_unit TEXT NOT NULL,
  calories REAL NOT NULL,
  protein REAL NOT NULL,
  carbs REAL NOT NULL,
  fat REAL NOT NULL,
  fiber REAL,
  sugar REAL,
  sodium REAL,
  barcode TEXT,
  category TEXT,
  embedding_id TEXT, -- Reference to Vectorize
  popularity_score INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Saved recipes
CREATE TABLE IF NOT EXISTS recipes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  source_url TEXT,
  servings INTEGER DEFAULT 1,
  prep_time_minutes INTEGER,
  cook_time_minutes INTEGER,
  ingredients TEXT NOT NULL, -- JSON array
  instructions TEXT, -- JSON array
  nutrition_per_serving TEXT NOT NULL, -- JSON: {calories, protein, carbs, fat}
  photo_key TEXT,
  tags TEXT, -- JSON array
  is_favorite INTEGER DEFAULT 0,
  times_logged INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Barry's specific tracking
CREATE TABLE IF NOT EXISTS barrys_workouts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  whoop_workout_id TEXT,
  studio_name TEXT,
  instructor TEXT,
  -- Class type based on day: Arms & Abs, Lower Focus, Chest/Back, Abs & Ass, Total Body, Upper Focus
  class_type TEXT,
  -- Double floor = all weights, no treadmill
  is_double_floor INTEGER DEFAULT 0,
  treadmill_miles REAL,
  floor_focus TEXT,
  personal_notes TEXT,
  rating INTEGER CHECK(rating BETWEEN 1 AND 5),
  -- Whoop data for this workout
  calories_burned INTEGER,
  strain REAL,
  avg_hr INTEGER,
  max_hr INTEGER,
  duration_minutes INTEGER,
  workout_date TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (whoop_workout_id) REFERENCES whoop_workouts(id) ON DELETE SET NULL
);

-- Comprehensive daily Whoop data (aggregated from all Whoop endpoints)
CREATE TABLE IF NOT EXISTS whoop_daily (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL, -- YYYY-MM-DD
  
  -- Recovery
  recovery_score INTEGER,
  hrv_rmssd REAL,
  resting_heart_rate INTEGER,
  spo2_percentage REAL,
  skin_temp_celsius REAL,
  
  -- Sleep
  sleep_performance INTEGER,
  sleep_efficiency INTEGER,
  sleep_duration_minutes INTEGER,
  rem_duration_minutes INTEGER,
  deep_duration_minutes INTEGER,
  light_duration_minutes INTEGER,
  awake_duration_minutes INTEGER,
  respiratory_rate REAL,
  sleep_needed_minutes INTEGER,
  sleep_debt_minutes INTEGER,
  
  -- Strain/Cycle
  day_strain REAL,
  day_calories INTEGER,
  day_avg_hr INTEGER,
  day_max_hr INTEGER,
  
  -- Body
  weight_kg REAL,
  
  -- Workout summary for the day
  workout_count INTEGER DEFAULT 0,
  total_workout_strain REAL DEFAULT 0,
  total_workout_calories INTEGER DEFAULT 0,
  
  -- Meta
  cycle_id TEXT,
  sleep_id TEXT,
  recovery_id TEXT,
  synced_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_whoop_daily_user_date ON whoop_daily(user_id, date);

-- Indexes for performance
-- Core meal queries (dashboard, daily summaries)
CREATE INDEX IF NOT EXISTS idx_meals_user_date ON meals(user_id, logged_at);
CREATE INDEX IF NOT EXISTS idx_meals_type ON meals(meal_type);
CREATE INDEX IF NOT EXISTS idx_meals_user_date_only ON meals(user_id, date(logged_at));

-- Progress photos
CREATE INDEX IF NOT EXISTS idx_progress_photos_user ON progress_photos(user_id, taken_at);

-- Whoop workouts (frequently queried by date)
CREATE INDEX IF NOT EXISTS idx_whoop_workouts_user ON whoop_workouts(user_id, start_time);
CREATE INDEX IF NOT EXISTS idx_whoop_workouts_date ON whoop_workouts(user_id, date(start_time));
CREATE INDEX IF NOT EXISTS idx_whoop_workouts_whoop_id ON whoop_workouts(whoop_id);

-- Whoop recovery
CREATE INDEX IF NOT EXISTS idx_whoop_recovery_user ON whoop_recovery(user_id, date);
CREATE INDEX IF NOT EXISTS idx_whoop_recovery_cycle ON whoop_recovery(whoop_cycle_id);

-- Wyze weights
CREATE INDEX IF NOT EXISTS idx_wyze_weights_user ON wyze_weights(user_id, measured_at);

-- Daily habits (queried by user+date frequently)
CREATE INDEX IF NOT EXISTS idx_daily_habits_user ON daily_habits(user_id, date);

-- Food database
CREATE INDEX IF NOT EXISTS idx_food_database_name ON food_database(name);
CREATE INDEX IF NOT EXISTS idx_food_database_barcode ON food_database(barcode);

-- Recipes
CREATE INDEX IF NOT EXISTS idx_recipes_user ON recipes(user_id);
CREATE INDEX IF NOT EXISTS idx_recipes_favorite ON recipes(user_id, is_favorite);

-- Barry's workouts
CREATE INDEX IF NOT EXISTS idx_barrys_user ON barrys_workouts(user_id, workout_date);

-- Users - for Whoop token refresh queries
CREATE INDEX IF NOT EXISTS idx_users_whoop_connected ON users(whoop_connected);

-- Streaks
CREATE INDEX IF NOT EXISTS idx_streaks_user_type ON streaks(user_id, streak_type);

-- Goals table - for daily/weekly/monthly/yearly goals with todo-style tracking
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  -- Goal type: daily, weekly, monthly, yearly
  goal_type TEXT NOT NULL CHECK(goal_type IN ('daily', 'weekly', 'monthly', 'yearly')),
  -- Category for grouping: fitness, nutrition, habits, personal, work, other
  category TEXT DEFAULT 'personal',
  -- Target value (optional, for measurable goals like "run 20 miles")
  target_value REAL,
  target_unit TEXT, -- 'miles', 'kg', 'times', etc.
  current_value REAL DEFAULT 0,
  -- For daily goals: the specific date, for weekly: week start, for monthly: first of month, yearly: year
  target_date TEXT NOT NULL, -- YYYY-MM-DD
  -- Status: pending, completed, rolled_over, cancelled
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'rolled_over', 'cancelled')),
  -- Completion tracking
  completed_at TEXT,
  -- For rolled over goals, reference to original
  rolled_from_id TEXT,
  -- Priority: low, medium, high
  priority TEXT DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high')),
  -- For recurring goals
  is_recurring INTEGER DEFAULT 0,
  recurrence_pattern TEXT, -- JSON: {"frequency": "daily", "days": [1,2,3,4,5]} for weekdays
  -- AI-generated content
  ai_summary TEXT, -- AI-generated summary of what this goal helps achieve
  ai_tips TEXT, -- JSON array of tips to achieve the goal
  breakdown TEXT, -- JSON array of suggested sub-goals (for monthly/yearly)
  -- Timestamps
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (rolled_from_id) REFERENCES goals(id) ON DELETE SET NULL
);

-- Indexes for goals
CREATE INDEX IF NOT EXISTS idx_goals_user_date ON goals(user_id, target_date);
CREATE INDEX IF NOT EXISTS idx_goals_user_type ON goals(user_id, goal_type);
CREATE INDEX IF NOT EXISTS idx_goals_user_status ON goals(user_id, status);
CREATE INDEX IF NOT EXISTS idx_goals_user_type_date ON goals(user_id, goal_type, target_date);
