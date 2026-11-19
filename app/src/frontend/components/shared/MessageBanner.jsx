export default function MessageBanner({ type, message, onClose }) {
  const bgClass = type === 'error' 
    ? 'bg-[#FCE4EC]' 
    : 'bg-[#E8F5E9]'
  
  return (
    <div className={`mb-4 p-4 ${bgClass} border-2 border-[#2D2D2D] flex items-center justify-between`}>
      <span className="text-sm font-medium">{message}</span>
      <button 
        onClick={onClose} 
        className="ml-4 font-bold text-lg hover:opacity-70"
      >
        &times;
      </button>
    </div>
  )
}
