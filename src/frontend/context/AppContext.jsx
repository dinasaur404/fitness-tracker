import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react'
import { formatLocalDate } from '../utils/formatters'

const AppContext = createContext(null)

export function AppProvider({ children }) {
  // Navigation & Loading
  const [currentView, setCurrentView] = useState('dashboard')
  const [loading, setLoading] = useState(true)
  
  // User & Integrations
  const [user, setUser] = useState(null)
  const [integrations, setIntegrations] = useState({ whoop: false })
  
  // Dashboard Data
  const [dashboard, setDashboard] = useState({
    nutrition: {
      calories: { consumed: 0, goal: 1800, remaining: 1800, percentage: 0 },
      protein: { consumed: 0, goal: 135, remaining: 135, percentage: 0 },
      carbs: { consumed: 0, goal: 180, percentage: 0 },
      fat: { consumed: 0, goal: 60, percentage: 0 },
      meals_logged: 0
    },
    habits: { drinks: 0, waterBottles: 0, tookElectrolytes: false },
    recovery: null,
    fitness: { workouts: 0, calories_burned: 0, day_strain: 0, day_calories: 0, day_avg_hr: 0 }
  })
  const [streaks, setStreaks] = useState({})
  const [todayMeals, setTodayMeals] = useState([])
  const [expandedMealTypes, setExpandedMealTypes] = useState({})
  const [habits, setHabits] = useState({})
  const [weight, setWeight] = useState({ current: null, change: null })
  
  // AI Summaries
  const [dailySummary, setDailySummary] = useState(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [aiInsights, setAiInsights] = useState(null)
  const [aiInsightsLoading, setAiInsightsLoading] = useState(false)
  
  // Quick Add Modal
  const [showQuickAdd, setShowQuickAdd] = useState(false)
  const [editingMealId, setEditingMealId] = useState(null)
  const [editingOriginalMeal, setEditingOriginalMeal] = useState(null)
  
  // Meal Detail Modal
  const [selectedMeal, setSelectedMeal] = useState(null)
  const [macroBreakdownType, setMacroBreakdownType] = useState(null)
  
  // Workout Log Modal
  const [showWorkoutLog, setShowWorkoutLog] = useState(false)
  const [barrysThisWeek, setBarrysThisWeek] = useState(0)
  
  // Habit loading states
  const [updatingWater, setUpdatingWater] = useState(false)
  const [updatingElectrolytes, setUpdatingElectrolytes] = useState(false)
  
  // Whoop Sync
  const [syncingWhoop, setSyncingWhoop] = useState(false)
  const [syncStatus, setSyncStatus] = useState(null)
  const [backfillStatus, setBackfillStatus] = useState(null)
  const [backfillLoading, setBackfillLoading] = useState(false)
  const [whoopSyncStatus, setWhoopSyncStatus] = useState(null)
  
  // Data View
  const [dataTab, setDataTab] = useState('daily')
  const [dataDate, setDataDate] = useState(new Date())
  const [dataLoading, setDataLoading] = useState(false)
  const [dailyData, setDailyData] = useState({})
  const [weeklyData, setWeeklyData] = useState({ daily_data: [] })
  const [monthlyData, setMonthlyData] = useState({ daily_data: [] })
  const [trendData, setTrendData] = useState([])
  const [trendStats, setTrendStats] = useState({})
  
  // Tomorrow Planning
  const [showTomorrowPlan, setShowTomorrowPlan] = useState(false)
  const [tomorrowEvents, setTomorrowEvents] = useState({ workout: '', notes: '' })
  const [tomorrowRecommendations, setTomorrowRecommendations] = useState(null)
  const [loadingRecommendations, setLoadingRecommendations] = useState(false)
  
  // Messages
  const [errorMessage, setErrorMessage] = useState(null)
  const [successMessage, setSuccessMessage] = useState(null)
  
  // Constants
  const userId = 'demo'
  
  // Get user's timezone
  const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  
  // API helper - includes timezone on all requests
  const api = useCallback(async (endpoint, options = {}) => {
    const response = await fetch(endpoint, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': userId,
        'X-Timezone': userTimezone,
        ...options.headers,
      },
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }))
      throw new Error(error.error || 'Request failed')
    }
    return response.json()
  }, [userId, userTimezone])
  
  // Fetch dashboard data
  const fetchDashboard = useCallback(async () => {
    try {
      const data = await api('/api/dashboard')
      if (data.streaks) setStreaks(data.streaks)
      if (data.whoop_connected !== undefined) {
        setIntegrations(prev => ({ ...prev, whoop: data.whoop_connected }))
      }
    } catch (error) {
      console.error('Failed to fetch dashboard:', error)
    }
  }, [api])
  
  // Fetch today's meals
  const fetchMeals = useCallback(async () => {
    try {
      const today = formatLocalDate(new Date())
      const meals = await api(`/api/meals?start=${today}&end=${today}`)
      setTodayMeals(meals || [])
      
      // Update nutrition totals (exclude pending meals from totals)
      const completedMeals = meals.filter(m => !m.pending)
      const totals = completedMeals.reduce((acc, meal) => ({
        calories: acc.calories + (meal.calories || 0),
        protein: acc.protein + (meal.protein || 0),
        carbs: acc.carbs + (meal.carbs || 0),
        fat: acc.fat + (meal.fat || 0),
      }), { calories: 0, protein: 0, carbs: 0, fat: 0 })
      
      setDashboard(prev => ({
        ...prev,
        nutrition: {
          ...prev.nutrition,
          calories: {
            ...prev.nutrition.calories,
            consumed: totals.calories,
            remaining: prev.nutrition.calories.goal - totals.calories,
            percentage: Math.round((totals.calories / prev.nutrition.calories.goal) * 100)
          },
          protein: {
            ...prev.nutrition.protein,
            consumed: totals.protein,
            remaining: prev.nutrition.protein.goal - totals.protein,
            percentage: Math.round((totals.protein / prev.nutrition.protein.goal) * 100)
          },
          carbs: {
            ...prev.nutrition.carbs,
            consumed: totals.carbs,
            percentage: Math.round((totals.carbs / prev.nutrition.carbs.goal) * 100)
          },
          fat: {
            ...prev.nutrition.fat,
            consumed: totals.fat,
            percentage: Math.round((totals.fat / prev.nutrition.fat.goal) * 100)
          },
          meals_logged: meals.length
        }
      }))
      
      // Return whether there are pending meals (for polling)
      return meals.some(m => m.pending)
    } catch (error) {
      console.error('Failed to fetch meals:', error)
      return false
    }
  }, [api])
  
  // Poll for pending meal updates
  useEffect(() => {
    const hasPending = todayMeals.some(m => m.pending)
    if (!hasPending) return
    
    // Poll every 3 seconds while there are pending meals
    const pollInterval = setInterval(async () => {
      const stillPending = await fetchMeals()
      if (!stillPending) {
        clearInterval(pollInterval)
      }
    }, 3000)
    
    return () => clearInterval(pollInterval)
  }, [todayMeals, fetchMeals])
  
  // Fetch today's habits
  const fetchHabits = useCallback(async () => {
    try {
      const today = formatLocalDate(new Date())
      const data = await api(`/api/habits/${today}`)
      setHabits(data || {})
      setDashboard(prev => ({
        ...prev,
        habits: {
          drinks: data.drinks_count || 0,
          waterBottles: data.water_bottles || 0,
          tookElectrolytes: data.took_electrolytes || false
        }
      }))
      // Store tomorrow planning data
      if (data.tomorrow_workout || data.tomorrow_events) {
        setTomorrowEvents({
          workout: data.tomorrow_workout || '',
          notes: data.tomorrow_events || ''
        })
      }
    } catch (error) {
      console.error('Failed to fetch habits:', error)
    }
  }, [api])
  
  // Fetch Barry's weekly count
  const fetchBarrysWeekly = useCallback(async () => {
    try {
      const data = await api('/api/workouts/barrys/weekly')
      setBarrysThisWeek(data.completed || 0)
    } catch (error) {
      console.error('Failed to fetch Barry\'s weekly:', error)
    }
  }, [api])
  
  // Fetch AI daily summary
  const fetchDailySummary = useCallback(async () => {
    try {
      setSummaryLoading(true)
      const today = formatLocalDate(new Date())
      const hour = new Date().getHours()
      const data = await api(`/api/dashboard/summary?date=${today}&hour=${hour}`)
      if (data.summary) {
        setDailySummary(data.summary)
      }
    } catch (error) {
      console.error('Failed to fetch daily summary:', error)
    } finally {
      setSummaryLoading(false)
    }
  }, [api])
  
  // Fetch AI insights
  const fetchAiInsights = useCallback(async () => {
    try {
      setAiInsightsLoading(true)
      const data = await api('/api/dashboard/insights')
      if (data.goals) {
        setAiInsights(data)
        // Update goals from AI insights
        setDashboard(prev => ({
          ...prev,
          nutrition: {
            ...prev.nutrition,
            calories: { ...prev.nutrition.calories, goal: data.goals.calories || prev.nutrition.calories.goal },
            protein: { ...prev.nutrition.protein, goal: data.goals.protein || prev.nutrition.protein.goal },
            carbs: { ...prev.nutrition.carbs, goal: data.goals.carbs || prev.nutrition.carbs.goal },
            fat: { ...prev.nutrition.fat, goal: data.goals.fat || prev.nutrition.fat.goal },
          }
        }))
      }
    } catch (error) {
      console.error('Failed to fetch AI insights:', error)
    } finally {
      setAiInsightsLoading(false)
    }
  }, [api])
  
  // Fetch Whoop data
  const fetchWhoopData = useCallback(async () => {
    if (!integrations.whoop) return
    
    try {
      const today = formatLocalDate(new Date())
      const [dailyResponse, trendResponse] = await Promise.all([
        api(`/api/whoop/daily/${today}`).catch(() => null),
        api(`/api/whoop/trend?today=${today}`).catch(() => null)
      ])
      
      if (dailyResponse) {
        setDashboard(prev => ({
          ...prev,
          recovery: dailyResponse.recovery_score,
          fitness: {
            ...prev.fitness,
            day_strain: dailyResponse.day_strain || 0,
            day_calories: dailyResponse.day_calories || 0,
            day_avg_hr: dailyResponse.day_avg_hr || 0
          }
        }))
        if (dailyResponse.weight_lbs) {
          setWeight({ current: dailyResponse.weight_lbs, change: null })
        }
      }
      
      if (trendResponse?.days) {
        setTrendData(trendResponse.days)
        setTrendStats(trendResponse.stats || {})
      }
    } catch (error) {
      console.error('Failed to fetch Whoop data:', error)
    }
  }, [api, integrations.whoop])
  
  // Quick sync Whoop with timeout
  const syncWhoopQuick = useCallback(async () => {
    if (!integrations.whoop || syncingWhoop) return
    
    try {
      setSyncingWhoop(true)
      setSyncStatus('Syncing 7 days...')
      
      // Add timeout to prevent hanging forever
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 60000) // 60 second timeout
      
      const response = await fetch('/api/whoop/sync/quick', { 
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': userId,
        },
        signal: controller.signal 
      })
      
      clearTimeout(timeoutId)
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        
        // Handle specific error cases
        if (errorData.needsReconnect) {
          // Whoop needs to be reconnected - update state
          setIntegrations(prev => ({ ...prev, whoop: false }))
          setSyncStatus('Please reconnect Whoop')
          return
        }
        
        if (errorData.rateLimited) {
          const retryAfter = errorData.retryAfter || 60
          // Format time nicely for user
          if (retryAfter > 3600) {
            const hours = Math.ceil(retryAfter / 3600)
            setSyncStatus(`Daily limit reached. Resets in ~${hours}h`)
          } else if (retryAfter > 60) {
            const mins = Math.ceil(retryAfter / 60)
            setSyncStatus(`Rate limited. Try in ~${mins}m`)
          } else {
            setSyncStatus(`Rate limited. Try in ${retryAfter}s`)
          }
          return
        }
        
        throw new Error(errorData.error || `Sync failed (${response.status})`)
      }
      
      setSyncStatus('Synced!')
      await fetchWhoopData()
    } catch (error) {
      console.error('Failed to sync Whoop:', error)
      if (error.name === 'AbortError') {
        setSyncStatus('Sync timed out')
      } else {
        setSyncStatus(error.message || 'Sync failed')
      }
    } finally {
      setSyncingWhoop(false)
      setTimeout(() => setSyncStatus(null), 5000)
    }
  }, [integrations.whoop, syncingWhoop, fetchWhoopData, userId])
  
  // Set water bottles with optimistic update
  const setWaterBottles = useCallback(async (count) => {
    const previousCount = dashboard.habits.waterBottles
    
    // Optimistic update
    setDashboard(prev => ({
      ...prev,
      habits: { ...prev.habits, waterBottles: count }
    }))
    setUpdatingWater(true)
    
    try {
      const today = formatLocalDate(new Date())
      await api(`/api/habits/${today}`, {
        method: 'PUT',
        body: JSON.stringify({ water_bottles: count })
      })
    } catch (error) {
      console.error('Failed to set water bottles:', error)
      // Revert on error
      setDashboard(prev => ({
        ...prev,
        habits: { ...prev.habits, waterBottles: previousCount }
      }))
      setErrorMessage('Failed to update water intake')
    } finally {
      setUpdatingWater(false)
    }
  }, [api, dashboard.habits.waterBottles])
  
  // Toggle electrolytes with optimistic update
  const toggleElectrolytes = useCallback(async () => {
    const previousValue = dashboard.habits.tookElectrolytes
    const newValue = !previousValue
    
    // Optimistic update
    setDashboard(prev => ({
      ...prev,
      habits: { ...prev.habits, tookElectrolytes: newValue }
    }))
    setUpdatingElectrolytes(true)
    
    try {
      const today = formatLocalDate(new Date())
      await api(`/api/habits/${today}`, {
        method: 'PUT',
        body: JSON.stringify({ took_electrolytes: newValue })
      })
    } catch (error) {
      console.error('Failed to toggle electrolytes:', error)
      // Revert on error
      setDashboard(prev => ({
        ...prev,
        habits: { ...prev.habits, tookElectrolytes: previousValue }
      }))
      setErrorMessage('Failed to update electrolytes')
    } finally {
      setUpdatingElectrolytes(false)
    }
  }, [api, dashboard.habits.tookElectrolytes])
  
  // Initialize app
  useEffect(() => {
    const initialize = async () => {
      setLoading(true)
      
      try {
        // Fetch initial data in parallel
        await Promise.all([
          fetchDashboard(),
          fetchMeals(),
          fetchHabits(),
          fetchBarrysWeekly(),
        ])
        
        // Fetch AI data (can happen after initial load)
        fetchDailySummary()
        fetchAiInsights()
      } catch (error) {
        console.error('Initialization failed:', error)
        setErrorMessage('Failed to load data')
      } finally {
        setLoading(false)
      }
    }
    
    initialize()
  }, [fetchDashboard, fetchMeals, fetchHabits, fetchBarrysWeekly, fetchDailySummary, fetchAiInsights])
  
  // Fetch Whoop data when integrations change (don't auto-sync, just fetch cached data)
  useEffect(() => {
    if (integrations.whoop) {
      fetchWhoopData()
      // Don't auto-sync on page load - let user trigger sync manually if needed
    }
  }, [integrations.whoop, fetchWhoopData])
  
  // Auto-refresh every 30 minutes (only when tab is visible)
  useEffect(() => {
    let interval = null
    
    const startRefresh = () => {
      if (interval) return
      interval = setInterval(() => {
        if (document.visibilityState === 'visible') {
          fetchMeals()
          fetchHabits()
          if (integrations.whoop) {
            fetchWhoopData()
          }
        }
      }, 30 * 60 * 1000)
    }
    
    const stopRefresh = () => {
      if (interval) {
        clearInterval(interval)
        interval = null
      }
    }
    
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Refresh immediately when tab becomes visible after being hidden
        fetchMeals()
        fetchHabits()
        if (integrations.whoop) {
          fetchWhoopData()
        }
        startRefresh()
      } else {
        stopRefresh()
      }
    }
    
    // Start interval if tab is visible
    if (document.visibilityState === 'visible') {
      startRefresh()
    }
    
    document.addEventListener('visibilitychange', handleVisibilityChange)
    
    return () => {
      stopRefresh()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [fetchMeals, fetchHabits, fetchWhoopData, integrations.whoop])
  
  // Memoize the context value to prevent unnecessary re-renders
  const value = useMemo(() => ({
    // Navigation
    currentView,
    setCurrentView,
    loading,
    setLoading,
    
    // User & Integrations
    user,
    setUser,
    userId,
    integrations,
    setIntegrations,
    
    // Dashboard
    dashboard,
    setDashboard,
    streaks,
    setStreaks,
    todayMeals,
    setTodayMeals,
    expandedMealTypes,
    setExpandedMealTypes,
    habits,
    setHabits,
    weight,
    setWeight,
    trendData,
    trendStats,
    setWaterBottles,
    toggleElectrolytes,
    updatingWater,
    updatingElectrolytes,
    
    // AI
    dailySummary,
    summaryLoading,
    fetchDailySummary,
    aiInsights,
    aiInsightsLoading,
    
    // Quick Add
    showQuickAdd,
    setShowQuickAdd,
    editingMealId,
    setEditingMealId,
    editingOriginalMeal,
    setEditingOriginalMeal,
    
    // Meal Detail
    selectedMeal,
    setSelectedMeal,
    macroBreakdownType,
    setMacroBreakdownType,
    
    // Workout
    showWorkoutLog,
    setShowWorkoutLog,
    barrysThisWeek,
    setBarrysThisWeek,
    
    // Whoop
    syncingWhoop,
    syncStatus,
    syncWhoopQuick,
    backfillStatus,
    setBackfillStatus,
    backfillLoading,
    setBackfillLoading,
    whoopSyncStatus,
    setWhoopSyncStatus,
    
    // Data View
    dataTab,
    setDataTab,
    dataDate,
    setDataDate,
    dataLoading,
    setDataLoading,
    dailyData,
    setDailyData,
    weeklyData,
    setWeeklyData,
    monthlyData,
    setMonthlyData,
    
    // Tomorrow Planning
    showTomorrowPlan,
    setShowTomorrowPlan,
    tomorrowEvents,
    setTomorrowEvents,
    tomorrowRecommendations,
    setTomorrowRecommendations,
    loadingRecommendations,
    setLoadingRecommendations,
    
    // Messages
    errorMessage,
    setErrorMessage,
    successMessage,
    setSuccessMessage,
    
    // API & Refresh
    api,
    fetchDashboard,
    fetchMeals,
    fetchHabits,
    fetchWhoopData,
    fetchBarrysWeekly,
  }), [
    currentView, loading, user, userId, integrations, dashboard, streaks,
    todayMeals, expandedMealTypes, habits, weight, trendData, trendStats,
    setWaterBottles, toggleElectrolytes, updatingWater, updatingElectrolytes,
    dailySummary, summaryLoading,
    fetchDailySummary, aiInsights, aiInsightsLoading, showQuickAdd,
    editingMealId, editingOriginalMeal, selectedMeal, macroBreakdownType,
    showWorkoutLog, barrysThisWeek, syncingWhoop, syncStatus, syncWhoopQuick,
    backfillStatus, backfillLoading, whoopSyncStatus, dataTab, dataDate,
    dataLoading, dailyData, weeklyData, monthlyData, showTomorrowPlan,
    tomorrowEvents, tomorrowRecommendations, loadingRecommendations,
    errorMessage, successMessage, api, fetchDashboard, fetchMeals,
    fetchHabits, fetchWhoopData, fetchBarrysWeekly
  ])

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  const context = useContext(AppContext)
  if (!context) {
    throw new Error('useApp must be used within an AppProvider')
  }
  return context
}
