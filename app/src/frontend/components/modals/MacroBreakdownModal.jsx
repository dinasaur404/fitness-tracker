import { useApp } from '../../context/AppContext'
import Modal from '../shared/Modal'
import ProgressBar from '../shared/ProgressBar'

const MACRO_COLORS = {
  calories: 'mint',
  protein: 'sky',
  carbs: 'peach',
  fat: 'lavender',
}

export default function MacroBreakdownModal() {
  const { 
    macroBreakdownType, 
    setMacroBreakdownType,
    todayMeals,
    dashboard,
  } = useApp()
  
  if (!macroBreakdownType) return null
  
  const macro = macroBreakdownType
  const goal = dashboard.nutrition[macro]?.goal || 100
  
  // Get total for this macro
  const getTotal = () => {
    return todayMeals.reduce((sum, meal) => {
      if (macro === 'calories') return sum + (meal.calories || 0)
      return sum + (meal[macro] || 0)
    }, 0)
  }
  
  // Get meals sorted by contribution to this macro
  const getSortedMeals = () => {
    return [...todayMeals]
      .map(meal => ({
        ...meal,
        value: macro === 'calories' ? meal.calories : meal[macro],
      }))
      .filter(meal => meal.value > 0)
      .sort((a, b) => b.value - a.value)
  }
  
  const total = getTotal()
  const sortedMeals = getSortedMeals()
  
  return (
    <Modal 
      isOpen={!!macroBreakdownType} 
      onClose={() => setMacroBreakdownType(null)} 
      title={`${macro.toUpperCase()} BREAKDOWN`}
    >
      {/* Total Progress */}
      <div className="mb-6">
        <div className="flex justify-between items-baseline mb-2">
          <span className="font-medium capitalize">{macro}</span>
          <span className="mono">
            {total}{macro !== 'calories' && 'g'} / {goal}{macro !== 'calories' && 'g'}
          </span>
        </div>
        <ProgressBar 
          value={total} 
          max={goal} 
          color={MACRO_COLORS[macro]}
        />
      </div>
      
      {/* Meal Contributions */}
      {sortedMeals.length === 0 ? (
        <div className="text-center py-6 text-gray-500">
          <p className="text-sm">No meals logged yet</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sortedMeals.map((meal, i) => {
            const percentage = Math.round((meal.value / total) * 100)
            
            return (
              <div key={meal.id || i} className="flex items-center justify-between">
                <div className="flex-1 mr-4">
                  <p className="text-sm font-medium truncate">{meal.name}</p>
                  <p className="text-xs text-gray-500 capitalize">{meal.meal_type}</p>
                </div>
                <div className="text-right">
                  <p className="font-bold">
                    {meal.value}{macro !== 'calories' && 'g'}
                  </p>
                  <p className="text-xs text-gray-500">{percentage}%</p>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Modal>
  )
}
