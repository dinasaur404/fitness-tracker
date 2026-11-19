import { lazy, Suspense, useState } from 'react'
import { useApp } from './context/AppContext'
import Header from './components/layout/Header'
import BottomNav from './components/layout/BottomNav'
import Marquee from './components/layout/Marquee'
import LoadingScreen from './components/shared/LoadingScreen'
import MessageBanner from './components/shared/MessageBanner'

// Lazy load views for code splitting
const Dashboard = lazy(() => import('./components/dashboard/Dashboard'))
const ChatView = lazy(() => import('./components/chat/ChatView'))
const ChatViewCapnWeb = lazy(() => import('./components/chat/ChatViewCapnWeb'))
const DataView = lazy(() => import('./components/data/DataView'))
const GoalsView = lazy(() => import('./components/goals/GoalsView'))
const SettingsView = lazy(() => import('./components/settings/SettingsView'))

// Modals - kept in main bundle as they're frequently used
import QuickAddModal from './components/modals/QuickAddModal'
import MealDetailModal from './components/modals/MealDetailModal'
import MacroBreakdownModal from './components/modals/MacroBreakdownModal'
import WorkoutLogModal from './components/modals/WorkoutLogModal'

// Inline loading fallback for lazy components
function ViewLoader() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="text-center">
        <div className="text-4xl mb-4 animate-pulse">...</div>
        <p className="mono text-gray-500 text-sm">Loading...</p>
      </div>
    </div>
  )
}

export default function App() {
  const { currentView, loading, errorMessage, successMessage, setErrorMessage, setSuccessMessage } = useApp()
  
  // Toggle between original WebSocket and Cap'n Web RPC
  const [useCapnWeb, setUseCapnWeb] = useState(false)

  if (loading) {
    return <LoadingScreen />
  }

  return (
    <div className="min-h-screen bg-[#FFFDF7]">
      <Marquee />
      <Header />
      
      {/* Chat View - Toggle between implementations */}
      {currentView === 'coach' && (
        <>
          {/* Toggle Button */}
          <div className="fixed top-16 right-4 z-50">
            <button
              onClick={() => setUseCapnWeb(!useCapnWeb)}
              className={`px-3 py-1.5 text-xs font-bold border-2 border-[#2D2D2D] shadow-[2px_2px_0px_#2D2D2D] transition-all ${
                useCapnWeb 
                  ? 'bg-[#E0F7FA] text-[#00796B]' 
                  : 'bg-[#EDE7F6] text-[#5E35B1]'
              }`}
              title={useCapnWeb ? 'Using Cap\'n Web RPC' : 'Using WebSocket'}
            >
              {useCapnWeb ? 'RPC Mode' : 'WS Mode'}
            </button>
          </div>
          
          <Suspense fallback={<ViewLoader />}>
            {useCapnWeb ? <ChatViewCapnWeb /> : <ChatView />}
          </Suspense>
        </>
      )}
      
      {/* Main Content - Hidden when chat is open */}
      {currentView !== 'coach' && (
        <main className="px-4 py-6 max-w-2xl mx-auto pb-32">
          {/* Error Message Banner */}
          {errorMessage && (
            <MessageBanner 
              type="error" 
              message={errorMessage} 
              onClose={() => setErrorMessage(null)} 
            />
          )}
          
          {/* Success Message Banner */}
          {successMessage && (
            <MessageBanner 
              type="success" 
              message={successMessage} 
              onClose={() => setSuccessMessage(null)} 
            />
          )}
          
          {/* Main Content - Lazy loaded with Suspense */}
          <Suspense fallback={<ViewLoader />}>
            {currentView === 'dashboard' && <Dashboard />}
            {currentView === 'data' && <DataView />}
            {currentView === 'goals' && <GoalsView />}
            {currentView === 'settings' && <SettingsView />}
          </Suspense>
        </main>
      )}
      
      <BottomNav />
      
      {/* Modals */}
      <QuickAddModal />
      <MealDetailModal />
      <MacroBreakdownModal />
      <WorkoutLogModal />
    </div>
  )
}
