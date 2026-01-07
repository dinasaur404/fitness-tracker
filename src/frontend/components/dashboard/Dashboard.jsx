import { useApp } from '../../context/AppContext'
import Card from '../shared/Card'
import ProgressBar from '../shared/ProgressBar'
import { getDayMessage, getDayOfWeek } from '../../utils/formatters'
import { getRecoveryColor } from '../../utils/recovery'
import { BARRYS_SCHEDULE } from '../../utils/constants'

export default function Dashboard() {
  const { 
    dashboard, 
    todayMeals, 
    dailySummary, 
    summaryLoading,
    fetchDailySummary,
    integrations,
    trendData,
    setShowQuickAdd,
    setShowWorkoutLog,
    setCurrentView,
    barrysThisWeek,
    setSelectedMeal,
    expandedMealTypes,
    setExpandedMealTypes,
    setMacroBreakdownType,
    setWaterBottles,
    toggleElectrolytes,
    updatingWater,
    updatingElectrolytes,
    setErrorMessage,
  } = useApp()
  
  const { nutrition, habits, recovery, fitness } = dashboard
  
  // Get today's Barry's class
  const getBarrysToday = () => {
    const day = new Date().getDay()
    return BARRYS_SCHEDULE[day] || 'Total Body'
  }
  
  // Get meals grouped by type
  const getMealsByType = (type) => {
    return todayMeals.filter(m => m.meal_type === type)
  }
  
  // Toggle meal type expansion
  const toggleMealType = (type) => {
    setExpandedMealTypes(prev => ({
      ...prev,
      [type]: !prev[type]
    }))
  }
  
  // Get summary for a meal type
  const getMealTypeSummary = (type) => {
    const meals = getMealsByType(type)
    return {
      count: meals.length,
      calories: meals.reduce((sum, m) => sum + (m.calories || 0), 0),
      protein: meals.reduce((sum, m) => sum + (m.protein || 0), 0),
      carbs: meals.reduce((sum, m) => sum + (m.carbs || 0), 0),
      fat: meals.reduce((sum, m) => sum + (m.fat || 0), 0),
      hasPending: meals.some(m => m.pending),
    }
  }

  return (
    <div className="space-y-5">
      {/* Greeting Card */}
      <Card className="p-5">
        <div>
          <p className="text-sm mono text-gray-500">{getDayOfWeek()}</p>
          <h2 className="font-display text-2xl mt-1">{getDayMessage()}</h2>
        </div>
      </Card>
      
      {/* AI Daily Summary */}
      {dailySummary && (
        <Card className="p-4 bg-gradient-to-r from-[#E8F5E9] to-[#E3F2FD]">
          <div className="flex items-start gap-3">
            <div className="text-2xl">✨</div>
            <div className="flex-1">
              <p className="text-sm leading-relaxed">{dailySummary.message}</p>
              {dailySummary.tip && (
                <div className="mt-2 text-xs text-gray-600 bg-white/50 p-2 rounded">
                  <span className="font-bold">Tip:</span> {dailySummary.tip}
                </div>
              )}
            </div>
            <button 
              onClick={fetchDailySummary} 
              className="text-gray-400 hover:text-gray-600 p-1"
              title="Refresh daily summary"
              aria-label="Refresh daily summary"
              disabled={summaryLoading}
            >
              <svg className={`w-4 h-4 ${summaryLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
        </Card>
      )}
      
      {/* Main Stats Grid - Calories & Protein */}
      <div className="grid grid-cols-2 gap-4">
        {/* Calories Card */}
        <Card 
          onClick={() => setMacroBreakdownType('calories')}
          className={`p-4 cursor-pointer hover:shadow-md transition-shadow ${
            nutrition.calories.percentage > 100 ? 'bg-red-50 border-red-300' : 'card-mint'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="font-bold text-sm">CALORIES</span>
            <span className={`badge text-xs ${
              nutrition.calories.percentage > 110 ? 'bg-red-200 text-red-800' : 
              nutrition.calories.percentage > 100 ? 'bg-yellow-200 text-yellow-800' : ''
            }`}>
              {nutrition.calories.percentage > 100 
                ? `+${nutrition.calories.percentage - 100}%` 
                : `${nutrition.calories.percentage}%`}
            </span>
          </div>
          <div className="font-display text-3xl">{nutrition.calories.consumed}</div>
          <div className="text-xs mono text-gray-600">/ {nutrition.calories.goal} cal</div>
          <div className="progress-bar mt-3 relative overflow-visible">
            <div 
              className={`progress-fill transition-all ${nutrition.calories.percentage > 100 ? 'bg-red-500' : 'bg-[#2D2D2D]'}`}
              style={{ width: `${Math.min(nutrition.calories.percentage, 100)}%` }}
            />
            {nutrition.calories.percentage > 100 && (
              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2 h-2 bg-red-500 rounded-full animate-pulse" />
            )}
          </div>
          {nutrition.calories.percentage > 100 && (
            <div className="text-xs text-red-600 mt-1">
              {nutrition.calories.consumed - nutrition.calories.goal} over
            </div>
          )}
        </Card>
        
        {/* Protein Card */}
        <Card 
          onClick={() => setMacroBreakdownType('protein')}
          className={`p-4 cursor-pointer hover:shadow-md transition-shadow ${
            nutrition.protein.percentage >= 100 ? 'bg-green-50 border-green-300' : 'card-sky'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="font-bold text-sm">PROTEIN</span>
            <span className={`badge text-xs ${
              nutrition.protein.percentage >= 100 ? 'bg-green-200 text-green-800' : ''
            }`}>
              {nutrition.protein.percentage}%
            </span>
          </div>
          <div className="font-display text-3xl">{nutrition.protein.consumed}g</div>
          <div className="text-xs mono text-gray-600">/ {nutrition.protein.goal}g goal</div>
          <div className="progress-bar mt-3">
            <div 
              className={`progress-fill transition-all ${
                nutrition.protein.percentage >= 100 ? 'bg-green-500' : 'bg-[#2D2D2D]'
              }`}
              style={{ width: `${Math.min(nutrition.protein.percentage, 100)}%` }}
            />
          </div>
          {nutrition.protein.percentage >= 100 && (
            <div className="text-xs text-green-600 mt-1">Goal hit!</div>
          )}
        </Card>
      </div>
      
      {/* Secondary Stats - Carbs & Fat */}
      <div className="grid grid-cols-2 gap-4">
        {/* Carbs Card */}
        <Card 
          onClick={() => setMacroBreakdownType('carbs')}
          className={`p-3 cursor-pointer hover:shadow-md transition-shadow ${
            nutrition.carbs.percentage > 100 ? 'bg-yellow-50 border-yellow-300' : 'card-peach'
          }`}
        >
          <div className="flex justify-between items-center">
            <span className="font-bold text-sm">CARBS</span>
            <div className="text-right">
              <span className="mono text-sm">{nutrition.carbs.consumed}g</span>
              <span className="text-xs text-gray-500"> / {nutrition.carbs.goal}g</span>
            </div>
          </div>
          <div className="progress-bar mt-2 h-3">
            <div 
              className={`progress-fill h-full transition-all ${
                nutrition.carbs.percentage > 100 ? 'bg-yellow-500' : 'bg-[#2D2D2D]'
              }`}
              style={{ width: `${Math.min(nutrition.carbs.percentage, 100)}%` }}
            />
          </div>
          {nutrition.carbs.percentage > 100 && (
            <div className="text-xs text-yellow-600 mt-1">
              +{nutrition.carbs.consumed - nutrition.carbs.goal}g over
            </div>
          )}
        </Card>
        
        {/* Fat Card */}
        <Card 
          onClick={() => setMacroBreakdownType('fat')}
          className={`p-3 cursor-pointer hover:shadow-md transition-shadow ${
            nutrition.fat.percentage > 100 ? 'bg-red-50 border-red-300' : 'card-lavender'
          }`}
        >
          <div className="flex justify-between items-center">
            <span className="font-bold text-sm">FAT</span>
            <div className="text-right">
              <span className="mono text-sm">{nutrition.fat.consumed}g</span>
              <span className="text-xs text-gray-500"> / {nutrition.fat.goal}g</span>
            </div>
          </div>
          <div className="progress-bar mt-2 h-3">
            <div 
              className={`progress-fill h-full transition-all ${
                nutrition.fat.percentage > 100 ? 'bg-red-400' : 'bg-[#2D2D2D]'
              }`}
              style={{ width: `${Math.min(nutrition.fat.percentage, 100)}%` }}
            />
          </div>
          {nutrition.fat.percentage > 100 && (
            <div className="text-xs text-red-500 mt-1">
              +{nutrition.fat.consumed - nutrition.fat.goal}g over
            </div>
          )}
        </Card>
      </div>
      
      {/* Today's Meals */}
      <Card className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-lg">TODAY'S MEALS</h3>
          <button 
            onClick={() => setShowQuickAdd(true)}
            className="btn px-3 py-1 text-xs"
          >
            + Add
          </button>
        </div>
        
        {todayMeals.length === 0 ? (
          <div className="text-center py-6 border-2 border-dashed border-gray-300">
            <p className="text-gray-500 mb-3">No meals logged yet</p>
            <button 
              onClick={() => setShowQuickAdd(true)}
              className="btn px-6 py-2 text-sm"
            >
              + Add first meal
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {['breakfast', 'lunch', 'dinner', 'snack'].map(type => {
              const summary = getMealTypeSummary(type)
              if (summary.count === 0) return null
              
              const isExpanded = expandedMealTypes[type]
              const meals = getMealsByType(type)
              
              // Color scheme per meal type
              const mealColors = {
                breakfast: { bg: 'bg-[#FFF3E0]', hover: 'hover:bg-[#FFE0B2]', expanded: 'bg-[#FFCC80]' },
                lunch: { bg: 'bg-[#E8F5E9]', hover: 'hover:bg-[#C8E6C9]', expanded: 'bg-[#A5D6A7]' },
                dinner: { bg: 'bg-[#E3F2FD]', hover: 'hover:bg-[#BBDEFB]', expanded: 'bg-[#90CAF9]' },
                snack: { bg: 'bg-[#EDE7F6]', hover: 'hover:bg-[#D1C4E9]', expanded: 'bg-[#B39DDB]' },
              }
              const colors = mealColors[type]
              
              return (
                <div key={type}>
                  {/* Meal Type Header */}
                  <button
                    onClick={() => toggleMealType(type)}
                    className={`w-full flex items-center justify-between p-3 border-2 border-[#2D2D2D] cursor-pointer transition-colors ${
                      isExpanded ? colors.expanded : `${colors.bg} ${colors.hover}`
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <svg 
                        className={`w-4 h-4 text-gray-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                        fill="none" 
                        stroke="currentColor" 
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                      </svg>
                      <div className="text-left">
                        <div className="font-bold text-sm uppercase flex items-center gap-2">
                          {type}
                          <span className="text-xs font-normal text-gray-500">
                            ({summary.count} item{summary.count > 1 ? 's' : ''})
                          </span>
                          {summary.hasPending && (
                            <span className="w-3 h-3 border-2 border-orange-400 border-t-transparent rounded-full animate-spin" />
                          )}
                        </div>
                        <div className="text-xs mono text-gray-500">
                          {summary.protein}g P / {summary.carbs}g C / {summary.fat}g F
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-display text-lg">{summary.calories}</div>
                      <div className="text-xs mono text-gray-500">cal</div>
                    </div>
                  </button>
                  
                  {/* Expanded meal items */}
                  {isExpanded && (
                    <div className="border-x-2 border-b-2 border-[#2D2D2D] bg-white">
                      {meals.map(meal => (
                        <button
                          key={meal.id}
                          onClick={() => !meal.pending && setSelectedMeal(meal)}
                          className={`w-full flex items-center justify-between p-3 border-b border-gray-200 last:border-b-0 transition-colors ${
                            meal.pending === 1 ? 'bg-[#FFF3E0] cursor-wait' : 'hover:bg-[#F5F5F5] cursor-pointer'
                          }`}
                        >
                          <div className="flex-1 pl-7 text-left">
                            <div className="font-medium text-sm flex items-center gap-2">
                              {meal.name}
                              {meal.pending === 1 && (
                                <span className="inline-flex items-center gap-1 text-xs font-normal text-orange-600">
                                  <span className="w-3 h-3 border-2 border-orange-400 border-t-transparent rounded-full animate-spin" />
                                  analyzing...
                                </span>
                              )}
                            </div>
                            {meal.pending === 1 ? (
                              <div className="text-xs text-orange-600">Calculating macros...</div>
                            ) : (
                              <div className="text-xs mono text-gray-400">
                                {meal.protein}g P / {meal.carbs}g C / {meal.fat}g F
                              </div>
                            )}
                          </div>
                          <div className="text-right flex items-center gap-2">
                            {meal.pending === 1 ? (
                              <div className="text-orange-400">
                                <div className="font-medium">--</div>
                                <div className="text-xs mono">cal</div>
                              </div>
                            ) : (
                              <div>
                                <div className="font-medium">{meal.calories}</div>
                                <div className="text-xs mono text-gray-400">cal</div>
                              </div>
                            )}
                            {meal.pending !== 1 && (
                              <svg className="w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                              </svg>
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Card>
      
      {/* Hydration Card */}
      <Card className="p-5">
        <h3 className="font-display text-lg mb-4">HYDRATION</h3>
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            {[1, 2, 3].map(i => (
              <button
                key={i}
                onClick={() => setWaterBottles(i === habits.waterBottles ? i - 1 : i)}
                disabled={updatingWater}
                aria-label={`${i} water bottle${i > 1 ? 's' : ''}`}
                aria-pressed={habits.waterBottles >= i}
                className={`w-12 h-12 rounded-full border-2 border-[#2D2D2D] flex items-center justify-center text-xl transition-all
                  ${habits.waterBottles >= i ? 'bg-[#90CAF9]' : 'bg-white hover:bg-blue-50'}
                  ${updatingWater ? 'opacity-50 cursor-wait' : ''}`}
              >
                💧
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">Electrolytes</span>
            <button
              onClick={toggleElectrolytes}
              disabled={updatingElectrolytes}
              aria-label="Toggle electrolytes taken"
              aria-pressed={habits.tookElectrolytes}
              className={`w-10 h-10 rounded-full border-2 border-[#2D2D2D] flex items-center justify-center transition-all
                ${habits.tookElectrolytes ? 'bg-[#A5D6A7]' : 'bg-white hover:bg-green-50'}
                ${updatingElectrolytes ? 'opacity-50 cursor-wait' : ''}`}
            >
              ⚡
            </button>
          </div>
        </div>
      </Card>
      
      {/* Recovery & Fitness Card (if Whoop connected) */}
      {integrations.whoop && recovery && (
        <Card className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-display text-lg">TODAY'S RECOVERY</h3>
            <span className={`text-xs px-2 py-1 rounded ${
              recovery >= 67 ? 'bg-green-100 text-green-700' :
              recovery >= 34 ? 'bg-yellow-100 text-yellow-700' :
              'bg-red-100 text-red-700'
            }`}>
              {recovery >= 67 ? 'Peak' : recovery >= 34 ? 'Moderate' : 'Rest'}
            </span>
          </div>
          
          {/* Main recovery display */}
          <div className="flex items-center gap-4 mb-4">
            <div className={`w-16 h-16 rounded-full border-4 flex items-center justify-center ${
              recovery >= 67 ? 'border-green-500 bg-green-50' :
              recovery >= 34 ? 'border-yellow-500 bg-yellow-50' :
              'border-red-500 bg-red-50'
            }`}>
              <span className={`font-display text-xl ${getRecoveryColor(recovery)}`}>{recovery}</span>
            </div>
            <div className="flex-1">
              <p className="text-sm text-gray-600">
                {recovery >= 67 
                  ? "Great day to push hard!" 
                  : recovery >= 34 
                  ? "Train smart today."
                  : "Focus on recovery."}
              </p>
              <div className="flex gap-4 mt-2 text-center">
                <div>
                  <div className="font-display text-lg">{fitness.day_strain?.toFixed(1) || 0}</div>
                  <div className="text-[10px] text-gray-500">Strain</div>
                </div>
                <div>
                  <div className="font-display text-lg">{fitness.day_calories || 0}</div>
                  <div className="text-[10px] text-gray-500">Calories</div>
                </div>
              </div>
            </div>
          </div>
          
          {/* 7-Day Trend with actual values - Neo-brutalist style */}
          {trendData.length > 0 && trendData.some(d => d.recovery_score) && (
            <div className="pt-4 border-t-2 border-[#2D2D2D] mt-4">
              <div className="flex items-center justify-between mb-3">
                <p className="font-display text-xs">7-DAY TREND</p>
              </div>
              <div className="flex items-end justify-between gap-1">
                {trendData.slice(-7).map((day, i) => {
                  const hasData = day.recovery_score != null
                  const score = day.recovery_score || 0
                  const dayLabel = new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' }).charAt(0)
                  
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center">
                      {/* Score label */}
                      <div className={`text-[10px] font-bold mb-1 ${hasData ? 'text-[#2D2D2D]' : 'text-gray-300'}`}>
                        {hasData ? score : '-'}
                      </div>
                      {/* Bar - Neo-brutalist with hard edges */}
                      <div className="w-full h-14 bg-[#F5F5F5] border-2 border-[#2D2D2D] relative">
                        {hasData ? (
                          <div 
                            className={`absolute bottom-0 left-0 right-0 transition-all ${
                              score >= 67 ? 'bg-[#A5D6A7]' :
                              score >= 34 ? 'bg-[#FFF59D]' :
                              'bg-[#EF9A9A]'
                            }`}
                            style={{ height: `${Math.max(score, 5)}%` }}
                          />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <div className="w-4 h-0.5 bg-gray-300" />
                          </div>
                        )}
                      </div>
                      {/* Day label */}
                      <div className="text-[10px] font-bold text-gray-500 mt-1">{dayLabel}</div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </Card>
      )}
      
      {/* Action Buttons */}
      <div className="grid grid-cols-2 gap-4">
        <button 
          onClick={() => setShowWorkoutLog(true)} 
          className="btn btn-lavender py-5 flex flex-col items-center gap-2"
        >
          <span className="font-display text-sm">LOG WORKOUT</span>
          <span className="text-xs mono text-gray-600">Barry's: {getBarrysToday()}</span>
        </button>
        <button 
          onClick={() => setCurrentView('data')} 
          className="btn btn-sky py-5 flex flex-col items-center gap-2"
        >
          <span className="font-display text-sm">VIEW DATA</span>
          <span className="text-xs mono text-gray-600">Whoop metrics</span>
        </button>
      </div>
    </div>
  )
}
