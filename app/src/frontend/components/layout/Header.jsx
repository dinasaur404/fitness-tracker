import { useApp } from '../../context/AppContext'
import { formatDate } from '../../utils/formatters'

export default function Header() {
  const { setCurrentView } = useApp()
  
  return (
    <header className="bg-white border-b-2 border-[#2D2D2D] px-4 py-3 sticky top-0 z-50">
      <div className="max-w-2xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-[#A5D6A7] to-[#90CAF9] rounded-full flex items-center justify-center font-display text-white text-lg border-2 border-[#2D2D2D]">
            D
          </div>
          <div>
            <h1 className="font-display text-lg leading-none">HI DINA!</h1>
            <p className="text-xs mono text-gray-500">{formatDate(new Date())}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => setCurrentView('settings')} 
            className="w-10 h-10 flex items-center justify-center border-2 border-[#2D2D2D] bg-white hover:bg-gray-100"
            aria-label="Open settings"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
            </svg>
          </button>
        </div>
      </div>
    </header>
  )
}
