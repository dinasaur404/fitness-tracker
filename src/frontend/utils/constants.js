// Meal types
export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack']

// Drink types with emojis
export const DRINK_TYPES = [
  { type: 'beer', emoji: '🍺', label: 'Beer' },
  { type: 'wine', emoji: '🍷', label: 'Wine' },
  { type: 'cocktail', emoji: '🍸', label: 'Cocktail' },
  { type: 'shot', emoji: '🥃', label: 'Shot' },
]

// Mood emojis (1-5 scale)
export const MOOD_EMOJIS = ['😢', '😕', '😐', '🙂', '😄']

// Energy emojis (1-5 scale)
export const ENERGY_EMOJIS = ['😴', '🥱', '😌', '⚡', '🚀']

// Barry's schedule by day of week
export const BARRYS_SCHEDULE = {
  0: 'Total Body',
  1: 'Arms & Abs',
  2: 'Lower Focus',
  3: 'Chest/Back',
  4: 'Abs & Ass',
  5: 'Total Body',
  6: 'Upper Focus'
}

// Workout types
export const WORKOUT_TYPES = [
  { value: 'barrys', label: "Barry's Regular" },
  { value: 'barrys_double', label: "Barry's Double Floor" },
  { value: 'pilates', label: 'Pilates' },
  { value: 'other', label: 'Other Workout' },
  { value: 'rest', label: 'Rest Day' },
]

// Macro colors
export const MACRO_COLORS = {
  calories: '#A5D6A7',  // mint-bold
  protein: '#90CAF9',   // sky-bold
  carbs: '#FFAB91',     // peach-bold
  fat: '#B39DDB',       // lavender-bold
}

// Nav items
export const NAV_ITEMS = [
  { id: 'dashboard', label: 'Home', icon: 'home' },
  { id: 'data', label: 'Data', icon: 'chart' },
  { id: 'log', label: 'Log', icon: 'plus', isAction: true },
  { id: 'coach', label: 'Coach', icon: 'chat' },
  { id: 'settings', label: 'More', icon: 'settings' },
]

// Water goal (bottles)
export const WATER_GOAL = 3

// Default macro goals
export const DEFAULT_GOALS = {
  calories: 1800,
  protein: 135,
  carbs: 180,
  fat: 60,
}
