const colorClasses = {
  mint: 'bg-[#A5D6A7]',
  sky: 'bg-[#90CAF9]',
  peach: 'bg-[#FFAB91]',
  lavender: 'bg-[#B39DDB]',
  blush: 'bg-[#F48FB1]',
  green: 'bg-green-500',
  yellow: 'bg-yellow-500',
  red: 'bg-red-500',
}

export default function ProgressBar({ 
  value = 0, 
  max = 100, 
  color = 'mint',
  showLabel = false,
  label = '',
  className = '',
}) {
  const percentage = Math.min(100, Math.max(0, (value / max) * 100))
  const colorClass = colorClasses[color] || colorClasses.mint
  
  return (
    <div className={`w-full ${className}`}>
      {showLabel && (
        <div className="flex justify-between text-xs mb-1">
          <span className="font-medium">{label}</span>
          <span className="mono">{Math.round(percentage)}%</span>
        </div>
      )}
      <div className="progress-bar">
        <div 
          className={`progress-fill ${colorClass}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  )
}
