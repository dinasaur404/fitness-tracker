const variantClasses = {
  default: 'bg-white',
  mint: 'bg-[#E8F5E9]',
  lavender: 'bg-[#EDE7F6]',
  peach: 'bg-[#FFF3E0]',
  sky: 'bg-[#E3F2FD]',
  blush: 'bg-[#FCE4EC]',
}

export default function Card({ 
  variant = 'default', 
  className = '', 
  children, 
  hover = true,
  onClick,
  ...props 
}) {
  const baseClass = hover ? 'card' : 'card-no-hover'
  const variantClass = variantClasses[variant] || variantClasses.default
  
  return (
    <div 
      className={`${baseClass} ${variantClass} p-4 ${className} ${onClick ? 'cursor-pointer' : ''}`}
      onClick={onClick}
      {...props}
    >
      {children}
    </div>
  )
}
