const variantClasses = {
  default: 'btn',
  mint: 'btn',
  lavender: 'btn btn-lavender',
  peach: 'btn btn-peach',
  sky: 'btn btn-sky',
  blush: 'btn btn-blush',
  dark: 'btn btn-dark',
}

export default function Button({ 
  variant = 'default', 
  className = '', 
  children, 
  disabled = false,
  type = 'button',
  onClick,
  ...props 
}) {
  return (
    <button
      type={type}
      className={`${variantClasses[variant]} px-4 py-2 ${className}`}
      disabled={disabled}
      onClick={onClick}
      {...props}
    >
      {children}
    </button>
  )
}
