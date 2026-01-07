import { useState } from 'react'
import { useApp } from '../../context/AppContext'
import Modal from '../shared/Modal'
import Button from '../shared/Button'
import { BARRYS_SCHEDULE } from '../../utils/constants'
import { formatLocalDate } from '../../utils/formatters'

export default function WorkoutLogModal() {
  const { 
    showWorkoutLog, 
    setShowWorkoutLog,
    barrysThisWeek,
    api,
    fetchBarrysWeekly,
    fetchWhoopData,
    setSuccessMessage,
    setErrorMessage,
  } = useApp()
  
  const [workoutType, setWorkoutType] = useState('barrys')
  const [isDoubleFloor, setIsDoubleFloor] = useState(false)
  const [isLogging, setIsLogging] = useState(false)
  
  // Get today's Barry's class
  const getBarrysToday = () => {
    const day = new Date().getDay()
    return BARRYS_SCHEDULE[day] || 'Total Body'
  }
  
  // Close modal
  const closeModal = () => {
    setShowWorkoutLog(false)
    setWorkoutType('barrys')
    setIsDoubleFloor(false)
  }
  
  // Log workout
  const logWorkout = async () => {
    try {
      setIsLogging(true)
      
      const today = formatLocalDate(new Date())
      
      await api('/api/workouts/barrys', {
        method: 'POST',
        body: JSON.stringify({
          workout_date: today,
          class_type: getBarrysToday(),
          is_double_floor: isDoubleFloor,
        })
      })
      
      setSuccessMessage(`Logged Barry's ${getBarrysToday()}!`)
      await fetchBarrysWeekly()
      await fetchWhoopData()
      closeModal()
    } catch (error) {
      setErrorMessage('Failed to log workout')
    } finally {
      setIsLogging(false)
    }
  }
  
  if (!showWorkoutLog) return null
  
  return (
    <Modal isOpen={showWorkoutLog} onClose={closeModal} title="LOG WORKOUT">
      {/* Weekly Progress */}
      <div className="mb-6 p-4 bg-[#EDE7F6] border-2 border-[#2D2D2D]">
        <div className="flex justify-between items-center">
          <span className="font-medium">This Week</span>
          <span className="font-display text-lg">{barrysThisWeek} / 5</span>
        </div>
        <div className="mt-2 flex gap-1">
          {[1, 2, 3, 4, 5].map(i => (
            <div
              key={i}
              className={`flex-1 h-2 ${i <= barrysThisWeek ? 'bg-[#B39DDB]' : 'bg-white'} border border-[#2D2D2D]`}
            />
          ))}
        </div>
      </div>
      
      {/* Today's Class */}
      <div className="mb-6">
        <h4 className="font-display text-sm mb-2">TODAY'S CLASS</h4>
        <div className="p-4 bg-[#E8F5E9] border-2 border-[#2D2D2D] text-center">
          <p className="font-display text-xl">{getBarrysToday()}</p>
          <p className="text-sm text-gray-600">
            {new Date().toLocaleDateString('en-US', { weekday: 'long' })}
          </p>
        </div>
      </div>
      
      {/* Workout Type */}
      <div className="mb-6">
        <h4 className="font-display text-sm mb-2">WORKOUT TYPE</h4>
        <div className="grid grid-cols-4 gap-2">
          <button
            onClick={() => setWorkoutType('barrys')}
            className={`py-3 text-sm font-medium border-2 border-[#2D2D2D] transition-all
              ${workoutType === 'barrys' ? 'bg-[#A5D6A7]' : 'bg-white'}`}
          >
            Barry's
          </button>
          <button
            onClick={() => setWorkoutType('pilates')}
            className={`py-3 text-sm font-medium border-2 border-[#2D2D2D] transition-all
              ${workoutType === 'pilates' ? 'bg-[#90CAF9]' : 'bg-white'}`}
          >
            Pilates
          </button>
          <button
            onClick={() => setWorkoutType('other')}
            className={`py-3 text-sm font-medium border-2 border-[#2D2D2D] transition-all
              ${workoutType === 'other' ? 'bg-[#FFAB91]' : 'bg-white'}`}
          >
            Other
          </button>
          <button
            onClick={() => setWorkoutType('rest')}
            className={`py-3 text-sm font-medium border-2 border-[#2D2D2D] transition-all
              ${workoutType === 'rest' ? 'bg-[#B39DDB]' : 'bg-white'}`}
          >
            Rest
          </button>
        </div>
      </div>
      
      {/* Double Floor Option (for Barry's) */}
      {workoutType === 'barrys' && (
        <div className="mb-6">
          <button
            onClick={() => setIsDoubleFloor(!isDoubleFloor)}
            className={`w-full py-3 text-sm font-medium border-2 border-[#2D2D2D] transition-all flex items-center justify-center gap-2
              ${isDoubleFloor ? 'bg-[#B39DDB]' : 'bg-white'}`}
          >
            <span>{isDoubleFloor ? '✓' : '○'}</span>
            Double Floor
          </button>
          <p className="text-xs text-gray-500 mt-1 text-center">
            Select if you did floor exercises for both halves
          </p>
        </div>
      )}
      
      {/* Submit Button */}
      <Button
        variant="dark"
        onClick={logWorkout}
        disabled={isLogging || workoutType === 'rest'}
        className="w-full py-3 font-display"
      >
        {isLogging ? 'LOGGING...' : workoutType === 'rest' ? 'REST DAY' : 'LOG WORKOUT'}
      </Button>
    </Modal>
  )
}
