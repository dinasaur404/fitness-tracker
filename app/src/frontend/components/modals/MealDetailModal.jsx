import { useState } from 'react'
import { useApp } from '../../context/AppContext'
import Modal from '../shared/Modal'
import Button from '../shared/Button'
import { formatChatTime } from '../../utils/formatters'

export default function MealDetailModal() {
  const { 
    selectedMeal, 
    setSelectedMeal, 
    api, 
    fetchMeals,
    setErrorMessage,
    setSuccessMessage,
    setShowQuickAdd,
    setEditingMealId,
    setEditingOriginalMeal,
  } = useApp()
  
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [editingMacros, setEditingMacros] = useState(false)
  const [editedMacros, setEditedMacros] = useState({
    calories: 0,
    protein: 0,
    carbs: 0,
    fat: 0
  })
  const [savingMacros, setSavingMacros] = useState(false)
  
  if (!selectedMeal) return null
  
  // Close modal
  const closeModal = () => {
    setSelectedMeal(null)
    setConfirmingDelete(false)
    setEditingMacros(false)
  }
  
  // Start editing macros
  const startEditingMacros = () => {
    setEditedMacros({
      calories: selectedMeal.calories || 0,
      protein: selectedMeal.protein || 0,
      carbs: selectedMeal.carbs || 0,
      fat: selectedMeal.fat || 0
    })
    setEditingMacros(true)
  }
  
  // Save macro adjustments
  const saveMacroAdjustment = async () => {
    try {
      setSavingMacros(true)
      await api(`/api/meals/${selectedMeal.id}`, {
        method: 'PUT',
        body: JSON.stringify(editedMacros)
      })
      setSuccessMessage('Macros updated!')
      await fetchMeals()
      closeModal()
    } catch (error) {
      setErrorMessage('Failed to update macros')
    } finally {
      setSavingMacros(false)
    }
  }
  
  // Delete meal
  const deleteMeal = async () => {
    try {
      await api(`/api/meals/${selectedMeal.id}`, {
        method: 'DELETE'
      })
      setSuccessMessage('Meal deleted')
      await fetchMeals()
      closeModal()
    } catch (error) {
      setErrorMessage('Failed to delete meal')
    }
  }
  
  // Edit meal (re-describe)
  const editMeal = () => {
    setEditingMealId(selectedMeal.id)
    setEditingOriginalMeal(selectedMeal)
    setSelectedMeal(null)
    setShowQuickAdd(true)
  }
  
  return (
    <Modal isOpen={!!selectedMeal} onClose={closeModal} title={selectedMeal.name}>
      {/* Photo if available */}
      {selectedMeal.photo_key && (
        <div className="mb-4">
          <img
            src={`/api/meals/photos/${selectedMeal.photo_key}`}
            alt={selectedMeal.name}
            className="w-full h-48 object-cover border-2 border-[#2D2D2D]"
          />
        </div>
      )}
      
      {/* Description */}
      {selectedMeal.description && (
        <p className="text-sm text-gray-600 mb-4">{selectedMeal.description}</p>
      )}
      
      {/* Ingredients with Macro Breakdown */}
      {selectedMeal.ingredients && (() => {
        // Parse ingredients if it's a JSON string
        let ingredients = selectedMeal.ingredients
        if (typeof ingredients === 'string') {
          try {
            ingredients = JSON.parse(ingredients)
          } catch (e) {
            // If not valid JSON, treat as comma-separated or single item
            ingredients = ingredients.split(',').map(i => i.trim()).filter(Boolean)
          }
        }
        
        if (!Array.isArray(ingredients) || ingredients.length === 0) return null
        
        // Check if ingredients have macro data
        const hasNutritionData = ingredients.some(i => 
          typeof i === 'object' && (i.calories !== undefined || i.protein !== undefined)
        )
        
        return (
          <div className="mb-4">
            <h4 className="font-display text-sm mb-2">INGREDIENTS BREAKDOWN</h4>
            <div className="bg-gray-50 border-2 border-[#2D2D2D] overflow-hidden">
              {hasNutritionData ? (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-100 border-b border-gray-200">
                      <th className="text-left py-2 px-2 font-medium">Item</th>
                      <th className="text-right py-2 px-1 font-medium w-12">Cal</th>
                      <th className="text-right py-2 px-1 font-medium w-10">P</th>
                      <th className="text-right py-2 px-1 font-medium w-10">C</th>
                      <th className="text-right py-2 px-1 font-medium w-10">F</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ingredients.map((ingredient, idx) => {
                      if (typeof ingredient === 'object') {
                        const name = ingredient.name || ingredient.item || 'Unknown'
                        const portion = ingredient.portion_size || ingredient.portion || ''
                        return (
                          <tr key={idx} className="border-b border-gray-100 last:border-b-0">
                            <td className="py-2 px-2">
                              <div className="font-medium text-gray-800">{name}</div>
                              {portion && <div className="text-gray-500 text-[10px]">{portion}</div>}
                            </td>
                            <td className="text-right py-2 px-1 text-gray-700">{ingredient.calories || '-'}</td>
                            <td className="text-right py-2 px-1 text-blue-600">{ingredient.protein || '-'}</td>
                            <td className="text-right py-2 px-1 text-orange-600">{ingredient.carbs || '-'}</td>
                            <td className="text-right py-2 px-1 text-purple-600">{ingredient.fat || '-'}</td>
                          </tr>
                        )
                      }
                      return (
                        <tr key={idx} className="border-b border-gray-100 last:border-b-0">
                          <td className="py-2 px-2 text-gray-800" colSpan={5}>{ingredient}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-gray-100 font-medium">
                      <td className="py-2 px-2">Total</td>
                      <td className="text-right py-2 px-1">{selectedMeal.calories}</td>
                      <td className="text-right py-2 px-1 text-blue-600">{selectedMeal.protein}g</td>
                      <td className="text-right py-2 px-1 text-orange-600">{selectedMeal.carbs}g</td>
                      <td className="text-right py-2 px-1 text-purple-600">{selectedMeal.fat}g</td>
                    </tr>
                  </tfoot>
                </table>
              ) : (
                <ul className="text-sm text-gray-600 space-y-1 p-3">
                  {ingredients.map((ingredient, idx) => (
                    <li key={idx} className="flex items-start gap-2">
                      <span className="text-gray-400">-</span>
                      <span>{typeof ingredient === 'object' ? (ingredient.name || ingredient.item || JSON.stringify(ingredient)) : ingredient}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )
      })()}
      
      {/* Macros */}
      {editingMacros ? (
        <div className="space-y-3 mb-4">
          <h4 className="font-display text-sm">EDIT MACROS</h4>
          {['calories', 'protein', 'carbs', 'fat'].map(macro => (
            <div key={macro} className="flex items-center justify-between">
              <label className="text-sm capitalize">{macro}</label>
              <input
                type="number"
                value={editedMacros[macro]}
                onChange={(e) => setEditedMacros(prev => ({
                  ...prev,
                  [macro]: parseInt(e.target.value) || 0
                }))}
                className="w-24 px-2 py-1 border-2 border-[#2D2D2D] text-right"
              />
            </div>
          ))}
          <div className="flex gap-2 mt-4">
            <Button
              variant="default"
              onClick={() => setEditingMacros(false)}
              className="flex-1 py-2 text-sm"
            >
              Cancel
            </Button>
            <Button
              variant="dark"
              onClick={saveMacroAdjustment}
              disabled={savingMacros}
              className="flex-1 py-2 text-sm"
            >
              {savingMacros ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2 mb-4 text-center">
          <div className="p-2 bg-[#E8F5E9] border-2 border-[#2D2D2D]">
            <div className="font-bold">{selectedMeal.calories}</div>
            <div className="text-xs text-gray-500">cal</div>
          </div>
          <div className="p-2 bg-[#E3F2FD] border-2 border-[#2D2D2D]">
            <div className="font-bold">{selectedMeal.protein}g</div>
            <div className="text-xs text-gray-500">protein</div>
          </div>
          <div className="p-2 bg-[#FFF3E0] border-2 border-[#2D2D2D]">
            <div className="font-bold">{selectedMeal.carbs}g</div>
            <div className="text-xs text-gray-500">carbs</div>
          </div>
          <div className="p-2 bg-[#EDE7F6] border-2 border-[#2D2D2D]">
            <div className="font-bold">{selectedMeal.fat}g</div>
            <div className="text-xs text-gray-500">fat</div>
          </div>
        </div>
      )}
      
      {/* Metadata */}
      <div className="text-xs text-gray-500 mb-4 flex justify-between">
        <span className="capitalize">{selectedMeal.meal_type}</span>
        <span>{formatChatTime(selectedMeal.logged_at)}</span>
      </div>
      
      {/* Actions */}
      {!editingMacros && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Button
              variant="default"
              onClick={startEditingMacros}
              className="flex-1 py-2 text-sm"
            >
              Adjust Macros
            </Button>
            <Button
              variant="sky"
              onClick={editMeal}
              className="flex-1 py-2 text-sm"
            >
              Edit Description
            </Button>
          </div>
          
          {confirmingDelete ? (
            <div className="flex gap-2">
              <Button
                variant="default"
                onClick={() => setConfirmingDelete(false)}
                className="flex-1 py-2 text-sm"
              >
                Cancel
              </Button>
              <Button
                variant="blush"
                onClick={deleteMeal}
                className="flex-1 py-2 text-sm"
              >
                Confirm Delete
              </Button>
            </div>
          ) : (
            <Button
              variant="blush"
              onClick={() => setConfirmingDelete(true)}
              className="w-full py-2 text-sm"
            >
              Delete Meal
            </Button>
          )}
        </div>
      )}
    </Modal>
  )
}
