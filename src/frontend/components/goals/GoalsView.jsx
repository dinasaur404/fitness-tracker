import { useState, useEffect } from 'react'
import { useApp } from '../../context/AppContext'
import Card from '../shared/Card'
import Modal from '../shared/Modal'

export default function GoalsView() {
  const { api, setErrorMessage } = useApp()
  
  // Tab state
  const [goalTab, setGoalTab] = useState('daily')
  
  // Goals data
  const [goals, setGoals] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  
  // Modal states
  const [showAddModal, setShowAddModal] = useState(false)
  const [goalInput, setGoalInput] = useState('')
  const [addingGoal, setAddingGoal] = useState(false)
  const [aiInsights, setAiInsights] = useState(null)
  
  // Expanded goal for viewing AI tips
  const [expandedGoal, setExpandedGoal] = useState(null)
  
  // Fetch goals based on tab
  useEffect(() => {
    fetchGoals()
    fetchSummary()
  }, [goalTab])
  
  const fetchGoals = async () => {
    setLoading(true)
    try {
      let endpoint = '/api/goals'
      if (goalTab === 'daily') {
        endpoint = '/api/goals/today'
      } else {
        endpoint = `/api/goals?type=${goalTab}`
      }
      
      const data = await api(endpoint)
      setGoals(goalTab === 'daily' ? (data.goals || []) : (data || []))
    } catch (error) {
      console.error('Failed to fetch goals:', error)
      setErrorMessage('Failed to load goals')
    } finally {
      setLoading(false)
    }
  }
  
  const fetchSummary = async () => {
    try {
      const data = await api('/api/goals/summary')
      setSummary(data)
    } catch (error) {
      console.error('Failed to fetch summary:', error)
      // Don't show error for summary - non-critical
    }
  }
  
  // Toggle goal completion
  const toggleGoal = async (goalId) => {
    try {
      const result = await api(`/api/goals/${goalId}/toggle`, { method: 'POST' })
      
      // Update local state
      setGoals(goals.map(g => 
        g.id === goalId 
          ? { ...g, status: result.status, completed_at: result.completed_at }
          : g
      ))
      
      // Refresh summary
      fetchSummary()
    } catch (error) {
      console.error('Failed to toggle goal:', error)
      setErrorMessage('Failed to update goal')
    }
  }
  
  // Add new goal with AI processing
  const addGoal = async (e) => {
    e.preventDefault()
    
    if (!goalInput.trim()) return
    
    setAddingGoal(true)
    setAiInsights(null)
    
    try {
      // Call API which will use AI to process the goal
      const result = await api('/api/goals/smart', {
        method: 'POST',
        body: JSON.stringify({
          input: goalInput,
          goal_type: goalTab
        })
      })
      
      // Show AI insights
      setAiInsights(result)
      
      // Reset input
      setGoalInput('')
      
      // Refresh goals list
      fetchGoals()
      fetchSummary()
    } catch (error) {
      console.error('Failed to add goal:', error)
      setErrorMessage('Failed to add goal')
    } finally {
      setAddingGoal(false)
    }
  }
  
  // Delete goal
  const deleteGoal = async (goalId, e) => {
    e.stopPropagation()
    
    try {
      await api(`/api/goals/${goalId}`, { method: 'DELETE' })
      fetchGoals()
      fetchSummary()
    } catch (error) {
      console.error('Failed to delete goal:', error)
      setErrorMessage('Failed to delete goal')
    }
  }
  
  // Get tab label
  const getTabLabel = (tab) => {
    switch (tab) {
      case 'daily': return 'Today'
      case 'weekly': return 'This Week'
      case 'monthly': return 'This Month'
      case 'yearly': return 'This Year'
      default: return tab
    }
  }
  
  return (
    <div className="space-y-5">
      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-4 gap-2">
          {['daily', 'weekly', 'monthly', 'yearly'].map(type => (
            <button
              key={type}
              onClick={() => setGoalTab(type)}
              className={`p-3 border-2 border-[#2D2D2D] transition-all ${
                goalTab === type ? 'bg-[#FFF59D] shadow-[2px_2px_0px_#2D2D2D]' : 'bg-white hover:bg-gray-50'
              }`}
            >
              <div className="font-display text-xl">
                {summary[type]?.completed || 0}/{summary[type]?.total || 0}
              </div>
              <div className="text-[10px] text-gray-600 capitalize">{type}</div>
            </button>
          ))}
        </div>
      )}
      
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg">{getTabLabel(goalTab).toUpperCase()}</h2>
        <button
          onClick={() => setShowAddModal(true)}
          className="btn btn-dark px-4 py-2 text-sm font-display"
        >
          + ADD
        </button>
      </div>
      
      {/* Goals List */}
      {loading ? (
        <Card className="p-8 text-center">
          <div className="text-4xl mb-4 animate-pulse">...</div>
          <p className="mono text-gray-600">Loading goals...</p>
        </Card>
      ) : goals.length === 0 ? (
        <Card className="p-8 text-center">
          <div className="text-4xl mb-4">*</div>
          <h3 className="font-display text-lg mb-2">NO GOALS YET</h3>
          <p className="text-sm text-gray-600 mb-4">
            Add your first {goalTab} goal!
          </p>
          <button
            onClick={() => setShowAddModal(true)}
            className="btn btn-dark px-6 py-3"
          >
            Add Goal
          </button>
        </Card>
      ) : (
        <div className="space-y-3">
          {goals.map(goal => (
            <Card 
              key={goal.id} 
              className={`p-4 transition-all cursor-pointer ${
                goal.status === 'completed' ? 'opacity-60' : ''
              }`}
              onClick={() => setExpandedGoal(expandedGoal === goal.id ? null : goal.id)}
            >
              <div className="flex items-start gap-3">
                {/* Checkbox */}
                <button
                  onClick={(e) => { e.stopPropagation(); toggleGoal(goal.id); }}
                  className={`w-6 h-6 flex-shrink-0 border-2 border-[#2D2D2D] flex items-center justify-center transition-all ${
                    goal.status === 'completed' ? 'bg-[#A5D6A7]' : 'bg-white hover:bg-gray-100'
                  }`}
                >
                  {goal.status === 'completed' && (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
                
                {/* Goal Content */}
                <div className="flex-1 min-w-0">
                  <h3 className={`font-bold ${goal.status === 'completed' ? 'line-through text-gray-500' : ''}`}>
                    {goal.title}
                  </h3>
                  
                  {goal.rolled_from_id && (
                    <span className="text-[10px] text-orange-500 font-bold">ROLLED OVER</span>
                  )}
                  
                  {/* AI Summary - always show if exists */}
                  {goal.ai_summary && (
                    <p className="text-sm text-gray-600 mt-1">{goal.ai_summary}</p>
                  )}
                  
                  {/* AI Tips - show when expanded */}
                  {expandedGoal === goal.id && goal.ai_tips && (
                    <div className="mt-3 p-3 bg-[#FFF59D] border-2 border-[#2D2D2D]">
                      <div className="text-xs font-bold mb-2">TIPS TO ACHIEVE THIS:</div>
                      <ul className="text-sm space-y-1">
                        {(typeof goal.ai_tips === 'string' ? JSON.parse(goal.ai_tips) : goal.ai_tips).map((tip, i) => (
                          <li key={i} className="flex gap-2">
                            <span className="text-gray-400">-</span>
                            <span>{tip}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                
                {/* Delete */}
                <button
                  onClick={(e) => deleteGoal(goal.id, e)}
                  className="text-gray-400 hover:text-red-500 p-1"
                  aria-label={`Delete goal: ${goal.title}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
      
      {/* Simple Add Goal Modal */}
      <Modal isOpen={showAddModal} onClose={() => { setShowAddModal(false); setAiInsights(null); setGoalInput(''); }} title={`Add ${goalTab} Goal`}>
        <div className="p-4">
          {!aiInsights ? (
            <form onSubmit={addGoal}>
              <label htmlFor="goal-input" className="sr-only">Goal description</label>
              <input
                id="goal-input"
                type="text"
                value={goalInput}
                onChange={(e) => setGoalInput(e.target.value)}
                placeholder="What do you want to achieve?"
                className="w-full p-4 border-2 border-[#2D2D2D] text-lg focus:outline-none focus:ring-2 focus:ring-[#FFF59D]"
                autoFocus
                disabled={addingGoal}
                aria-describedby="goal-input-hint"
              />
              <p id="goal-input-hint" className="sr-only">Describe your goal and AI will help break it down</p>
              <button
                type="submit"
                disabled={!goalInput.trim() || addingGoal}
                className="w-full mt-4 btn btn-dark py-3 font-display disabled:opacity-50"
              >
                {addingGoal ? 'THINKING...' : 'ADD GOAL'}
              </button>
            </form>
          ) : (
            <div className="space-y-4">
              {/* AI Generated Summary */}
              <div>
                <div className="text-xs font-bold text-gray-500 mb-1">YOUR GOAL</div>
                <h3 className="font-bold text-lg">{aiInsights.title}</h3>
                {aiInsights.summary && (
                  <p className="text-sm text-gray-600 mt-1">{aiInsights.summary}</p>
                )}
              </div>
              
              {/* AI Tips */}
              {aiInsights.tips && aiInsights.tips.length > 0 && (
                <div className="p-3 bg-[#FFF59D] border-2 border-[#2D2D2D]">
                  <div className="text-xs font-bold mb-2">TIPS TO ACHIEVE THIS:</div>
                  <ul className="text-sm space-y-1">
                    {aiInsights.tips.map((tip, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="text-gray-500">-</span>
                        <span>{tip}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              
              {/* Category detected */}
              {aiInsights.category && (
                <div className="text-xs text-gray-500">
                  Category: <span className="font-bold capitalize">{aiInsights.category}</span>
                </div>
              )}
              
              <button
                onClick={() => { setShowAddModal(false); setAiInsights(null); setGoalInput(''); }}
                className="w-full btn btn-dark py-3 font-display"
              >
                DONE
              </button>
            </div>
          )}
        </div>
      </Modal>
    </div>
  )
}
