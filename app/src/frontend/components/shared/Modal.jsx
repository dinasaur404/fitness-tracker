import { useEffect, useRef, useCallback } from 'react'

export default function Modal({ 
  isOpen, 
  onClose, 
  title,
  children,
  showClose = true,
  className = '',
}) {
  const modalRef = useRef(null)
  const previousActiveElement = useRef(null)
  const hasInitialFocus = useRef(false)
  
  // Stable reference to onClose
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  
  // Reset initial focus flag when modal closes
  useEffect(() => {
    if (!isOpen) {
      hasInitialFocus.current = false
    }
  }, [isOpen])
  
  // Close on escape key and manage focus trap
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    
    // Focus trap - keep focus within modal
    const handleTab = (e) => {
      if (e.key !== 'Tab' || !modalRef.current) return
      
      const focusableElements = modalRef.current.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      const firstElement = focusableElements[0]
      const lastElement = focusableElements[focusableElements.length - 1]
      
      if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault()
        lastElement?.focus()
      } else if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault()
        firstElement?.focus()
      }
    }
    
    if (isOpen) {
      // Store currently focused element to restore later (only on initial open)
      if (!hasInitialFocus.current) {
        previousActiveElement.current = document.activeElement
      }
      
      document.addEventListener('keydown', handleEscape)
      document.addEventListener('keydown', handleTab)
      document.body.style.overflow = 'hidden'
      
      // Only do initial focus once when modal opens
      if (!hasInitialFocus.current) {
        hasInitialFocus.current = true
        
        // Focus the modal or first focusable element
        // Prioritize inputs/textareas over buttons for better UX in forms
        requestAnimationFrame(() => {
          if (!modalRef.current) return
          
          // Helper to check if element is actually visible
          const isVisible = (el) => {
            if (!el) return false
            const style = window.getComputedStyle(el)
            return style.display !== 'none' && 
                   style.visibility !== 'hidden' && 
                   style.opacity !== '0' &&
                   el.offsetParent !== null &&
                   !el.classList.contains('hidden') &&
                   !el.classList.contains('sr-only')
          }
          
          // First, try to find a visible input or textarea (most likely what user wants to interact with)
          const inputElements = modalRef.current.querySelectorAll(
            'input:not([type="hidden"]):not([disabled]):not([type="checkbox"]), textarea:not([disabled])'
          )
          for (const inputElement of inputElements) {
            if (isVisible(inputElement)) {
              inputElement.focus()
              return
            }
          }
          
          // Otherwise, focus first visible focusable element that's not a close button
          const focusableElements = modalRef.current.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          )
          for (const el of focusableElements) {
            // Skip close buttons (usually have aria-label="Close modal" or contain &times;)
            if (el.getAttribute('aria-label')?.toLowerCase().includes('close')) continue
            if (el.textContent?.trim() === '×') continue
            if (isVisible(el)) {
              el.focus()
              return
            }
          }
          
          // Fallback to modal itself
          modalRef.current?.focus()
        })
      }
    }
    
    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.removeEventListener('keydown', handleTab)
      document.body.style.overflow = ''
      
      // Restore focus to previous element
      if (previousActiveElement.current && typeof previousActiveElement.current.focus === 'function') {
        previousActiveElement.current.focus()
      }
    }
  }, [isOpen])
  
  if (!isOpen) return null
  
  return (
    <div 
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? "modal-title" : undefined}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div 
        ref={modalRef}
        className={`modal-content ${className}`}
        tabIndex={-1}
      >
        {(title || showClose) && (
          <div className="flex items-center justify-between p-4 border-b-2 border-[#2D2D2D]">
            {title && <h2 id="modal-title" className="font-display text-lg">{title}</h2>}
            {showClose && (
              <button 
                onClick={onClose}
                className="text-2xl font-bold hover:opacity-70 ml-auto"
                aria-label="Close modal"
              >
                &times;
              </button>
            )}
          </div>
        )}
        <div className="p-4">
          {children}
        </div>
      </div>
    </div>
  )
}
