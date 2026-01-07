const variantClasses = {
  default: 'badge',
  mint: 'badge',
  lavender: 'badge badge-lavender',
  peach: 'badge badge-peach',
  sky: 'badge badge-sky',
  blush: 'badge badge-blush',
}

export default function Badge({ 
  variant = 'default', 
  className = '', 
  children,
}) {
  return (
    <span className={`${variantClasses[variant]} ${className}`}>
      {children}
    </span>
  )
}
