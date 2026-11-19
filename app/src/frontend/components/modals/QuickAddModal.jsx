import { useState, useRef, useEffect } from 'react'
import { useApp } from '../../context/AppContext'
import Modal from '../shared/Modal'
import Button from '../shared/Button'
import { MEAL_TYPES } from '../../utils/constants'

export default function QuickAddModal() {
  const { 
    showQuickAdd, 
    setShowQuickAdd, 
    api, 
    fetchMeals,
    setErrorMessage,
    setSuccessMessage,
    editingMealId,
    setEditingMealId,
    editingOriginalMeal,
    setEditingOriginalMeal,
  } = useApp()
  
  const [logMethod, setLogMethod] = useState('food') // 'food' (photo+text) or 'url'
  const [foodDescription, setFoodDescription] = useState('')
  const [mealType, setMealType] = useState('lunch')
  const [photoFile, setPhotoFile] = useState(null)
  const [photoPreview, setPhotoPreview] = useState(null)
  const [recipeUrl, setRecipeUrl] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitStatus, setSubmitStatus] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  
  // Recipe import state
  const [saveToRecipes, setSaveToRecipes] = useState(true) // Checkbox default checked
  
  const fileInputRef = useRef(null)
  
  // Pre-fill form when editing an existing meal
  useEffect(() => {
    if (showQuickAdd && editingOriginalMeal) {
      // Pre-fill with original description or name
      setFoodDescription(editingOriginalMeal.description || editingOriginalMeal.name || '')
      setMealType(editingOriginalMeal.meal_type || 'lunch')
      setLogMethod('food')
      
      // If the meal has a photo, load it as preview
      if (editingOriginalMeal.photo_key) {
        setPhotoPreview(`/api/meals/photos/${editingOriginalMeal.photo_key}`)
      }
    }
  }, [showQuickAdd, editingOriginalMeal])
  
  // Check if we're in edit mode
  const isEditing = !!editingMealId
  
  // Close modal and reset
  const closeModal = () => {
    setShowQuickAdd(false)
    setLogMethod('food')
    setFoodDescription('')
    setMealType('lunch')
    setPhotoFile(null)
    setPhotoPreview(null)
    setRecipeUrl('')
    setIsSubmitting(false)
    setSubmitStatus('')
    setEditingMealId(null)
    setEditingOriginalMeal(null)
    setSaveToRecipes(true)
  }
  
  // Handle photo selection
  const handlePhotoSelect = (e) => {
    const file = e.target.files?.[0]
    if (file) {
      setPhotoFile(file)
      const reader = new FileReader()
      reader.onload = (e) => setPhotoPreview(e.target.result)
      reader.readAsDataURL(file)
    }
  }
  
  // Handle drag and drop
  const handleDrop = (e) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file && file.type.startsWith('image/')) {
      setPhotoFile(file)
      const reader = new FileReader()
      reader.onload = (e) => setPhotoPreview(e.target.result)
      reader.readAsDataURL(file)
    }
  }
  
  // Clear photo
  const clearPhoto = () => {
    setPhotoFile(null)
    setPhotoPreview(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }
  
  // Submit food
  const submitFood = async () => {
    try {
      setIsSubmitting(true)
      
      if (logMethod === 'food') {
        // Validate: need at least description OR photo
        if (!foodDescription.trim() && !photoFile && !photoPreview) {
          setErrorMessage('Please describe your food or upload a photo')
          return
        }
        
        // If editing an existing meal, use PUT to update (this stays synchronous)
        if (isEditing) {
          setSubmitStatus('Updating meal...')
          
          // If there's a new photo, upload it first
          if (photoFile) {
            const formData = new FormData()
            formData.append('photo', photoFile)
            formData.append('meal_type', mealType)
            formData.append('description', foodDescription)
            
            const photoResponse = await fetch(`/api/meals/${editingMealId}/photo`, {
              method: 'PUT',
              headers: { 'X-User-Id': 'demo' },
              body: formData
            })
            
            if (!photoResponse.ok) {
              const errorData = await photoResponse.json().catch(() => ({ error: 'Failed to update photo' }))
              throw new Error(errorData.error || `Photo update failed (${photoResponse.status})`)
            }
          } else {
            // No new photo, just update description/meal_type
            await api(`/api/meals/${editingMealId}`, {
              method: 'PUT',
              body: JSON.stringify({
                description: foodDescription,
                meal_type: mealType
              })
            })
          }
          
          setSuccessMessage('Meal updated!')
        } else {
          // Creating new meal - ASYNC: creates pending meal and processes in background
          if (photoFile) {
            // Has photo - use photo endpoint (timezone sent via header)
            const formData = new FormData()
            formData.append('photo', photoFile)
            formData.append('meal_type', mealType)
            if (foodDescription.trim()) {
              formData.append('description', foodDescription)
            }
            
            const photoResponse = await fetch('/api/meals/photo', {
              method: 'POST',
              headers: { 
                'X-User-Id': 'demo',
                'X-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone
              },
              body: formData
            })
            
            if (!photoResponse.ok) {
              const errorData = await photoResponse.json().catch(() => ({ error: 'Failed to upload photo' }))
              throw new Error(errorData.error || `Photo upload failed (${photoResponse.status})`)
            }
          } else {
            // Text only - timezone sent via header
            await api('/api/meals/quick-add', {
              method: 'POST',
              body: JSON.stringify({
                description: foodDescription,
                meal_type: mealType
              })
            })
          }
          
          // Show success and close immediately - meal will appear as pending in list
          setSuccessMessage('Analyzing your meal...')
        }
      } else if (logMethod === 'url') {
        // Import recipe - this now creates a pending meal and processes in background
        if (!recipeUrl.trim()) {
          setErrorMessage('Please enter a recipe URL')
          return
        }
        
        setSubmitStatus('Starting import...')
        
        // Call the async import endpoint - it creates a pending meal and returns immediately
        // Timezone sent via header
        await api('/api/recipes/import', {
          method: 'POST',
          body: JSON.stringify({ 
            url: recipeUrl,
            meal_type: mealType,
            save_to_recipes: saveToRecipes
          })
        })
        
        setSuccessMessage('Recipe importing! Check your meals list.')
      }
      
      await fetchMeals()
      closeModal()
    } catch (error) {
      setErrorMessage(error.message || 'Failed to log food')
    } finally {
      setIsSubmitting(false)
      setSubmitStatus('')
    }
  }
  
  if (!showQuickAdd) return null
  
  return (
    <Modal isOpen={showQuickAdd} onClose={closeModal} title={isEditing ? "EDIT MEAL" : "LOG FOOD"}>
      {/* Method Tabs - simplified to Food vs URL */}
      <div className="flex border-2 border-[#2D2D2D] mb-4">
        {[
          { id: 'food', label: 'Food', icon: '🍽️' },
          { id: 'url', label: 'Recipe URL', icon: '🔗' },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setLogMethod(tab.id)}
            className={`flex-1 py-2 text-sm font-medium transition-all border-r border-[#2D2D2D] last:border-r-0
              ${logMethod === tab.id ? 'bg-[#A5D6A7]' : 'bg-white'}`}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>
      
      {/* Meal Type Selector */}
      <div className="mb-4">
        <label className="text-sm font-medium mb-2 block">Meal Type</label>
        <div className="flex gap-2">
          {MEAL_TYPES.map(type => (
            <button
              key={type}
              onClick={() => setMealType(type)}
              className={`flex-1 py-2 text-xs font-medium capitalize border-2 border-[#2D2D2D] transition-all
                ${mealType === type ? 'bg-[#A5D6A7]' : 'bg-white'}`}
            >
              {type}
            </button>
          ))}
        </div>
      </div>
      
      {/* Combined Food Input (Photo + Description) */}
      {logMethod === 'food' && (
        <>
          {/* Photo Upload - Optional */}
          <div className="mb-4">
            <label className="text-sm font-medium mb-2 block">Photo (optional)</label>
            
            {photoPreview ? (
              <div className="relative">
                <img 
                  src={photoPreview} 
                  alt="Preview" 
                  className="w-full h-40 object-cover border-2 border-[#2D2D2D]"
                />
                <button
                  onClick={clearPhoto}
                  className="absolute top-2 right-2 w-8 h-8 bg-red-500 text-white rounded-full flex items-center justify-center"
                >
                  x
                </button>
              </div>
            ) : (
              <div
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed border-[#2D2D2D] p-4 text-center cursor-pointer transition-all
                  ${isDragging ? 'drag-active' : 'hover:bg-gray-50'}`}
              >
                <div className="text-2xl mb-1">+</div>
                <p className="text-xs text-gray-600">Click or drag photo</p>
              </div>
            )}
            
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handlePhotoSelect}
              className="hidden"
            />
          </div>
          
          {/* Description Input */}
          <div className="mb-4">
            <label htmlFor="food-description" className="text-sm font-medium mb-2 block">
              Description {photoPreview ? '(helps AI identify ingredients)' : ''}
            </label>
            <textarea
              id="food-description"
              value={foodDescription}
              onChange={(e) => setFoodDescription(e.target.value)}
              placeholder={photoPreview 
                ? "e.g., this is my lunch - grilled chicken salad with ranch" 
                : "e.g., large iced latte with oat milk and a blueberry muffin"}
              className="input min-h-[80px] resize-none"
              aria-describedby="food-description-hint"
            />
            <p id="food-description-hint" className="sr-only">Describe your meal in natural language</p>
          </div>
        </>
      )}
      
      {/* URL Input */}
      {logMethod === 'url' && (
        <div className="mb-4">
          <label htmlFor="recipe-url" className="text-sm font-medium mb-2 block">Recipe URL</label>
          <input
            id="recipe-url"
            type="url"
            value={recipeUrl}
            onChange={(e) => setRecipeUrl(e.target.value)}
            placeholder="https://example.com/recipe"
            className="input"
          />
          <p className="text-xs text-gray-500 mt-1">Paste a recipe URL from any cooking site</p>
          
          {/* Save to Recipes Checkbox */}
          <label className="flex items-center gap-2 mt-3 cursor-pointer">
            <input
              type="checkbox"
              checked={saveToRecipes}
              onChange={(e) => setSaveToRecipes(e.target.checked)}
              className="w-5 h-5 border-2 border-[#2D2D2D] accent-[#A5D6A7]"
            />
            <span className="text-sm">Save to My Recipes</span>
          </label>
        </div>
      )}
      
      {/* Submit Status */}
      {submitStatus && (
        <div className="mb-4 p-3 bg-[#E8F5E9] border-2 border-[#2D2D2D] text-sm text-center">
          {submitStatus}
        </div>
      )}
      
      {/* Submit Button */}
      <Button
        variant="dark"
        onClick={submitFood}
        disabled={isSubmitting}
        className="w-full py-3 font-display"
      >
        {isSubmitting 
          ? 'ANALYZING...' 
          : isEditing 
            ? 'UPDATE MEAL' 
            : logMethod === 'url' 
              ? 'IMPORT RECIPE'
              : 'LOG FOOD'}
      </Button>
    </Modal>
  )
}
