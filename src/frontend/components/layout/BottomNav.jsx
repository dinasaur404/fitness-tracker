import { useApp } from '../../context/AppContext'

export default function BottomNav() {
  const { currentView, setCurrentView, setShowQuickAdd } = useApp()
  
  const navItems = [
    { id: 'dashboard', label: 'Home', icon: HomeIcon },
    { id: 'goals', label: 'Goals', icon: GoalsIcon },
    { id: 'log', label: 'Log', icon: PlusIcon, isAction: true },
    { id: 'data', label: 'Data', icon: ChartIcon },
    { id: 'coach', label: 'Coach', icon: ChatIcon },
  ]
  
  const handleClick = (item) => {
    if (item.isAction) {
      setShowQuickAdd(true)
    } else {
      setCurrentView(item.id)
    }
  }
  
  const getActiveClass = (id) => {
    if (id === 'log') return 'bg-[#2D2D2D] text-white'
    if (currentView === id) {
      if (id === 'coach') return 'bg-[#B39DDB]'
      if (id === 'goals') return 'bg-[#FFF59D]' // Yellow for goals
      return 'bg-[#A5D6A7]'
    }
    return ''
  }
  
  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-white border-t-2 border-[#2D2D2D] pb-safe" role="navigation" aria-label="Main navigation">
      <div className="max-w-2xl mx-auto px-2 py-2 flex justify-around">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => handleClick(item)}
            className={`flex flex-col items-center gap-1 px-3 py-2 transition-all ${getActiveClass(item.id)}`}
            aria-label={item.isAction ? `Open ${item.label.toLowerCase()} modal` : `Go to ${item.label}`}
            aria-current={!item.isAction && currentView === item.id ? 'page' : undefined}
          >
            <item.icon className="w-5 h-5" aria-hidden="true" />
            <span className="text-xs font-bold">{item.label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}

// Icons
function HomeIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
    </svg>
  )
}

function ChartIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
  )
}

function PlusIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
    </svg>
  )
}

function ChatIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  )
}

function GoalsIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
    </svg>
  )
}
