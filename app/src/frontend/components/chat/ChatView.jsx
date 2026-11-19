import { useState, useEffect, useRef, useCallback } from 'react'
import { useApp } from '../../context/AppContext'
import { formatChatTime } from '../../utils/formatters'
import { formatMarkdown } from '../../utils/markdown'

// Quick prompts moved outside component to avoid recreation on every render
const QUICK_PROMPTS = [
  { emoji: '💬', text: 'How am I doing today?' },
  { emoji: '🍗', text: 'What should I eat to hit my protein?' },
  { emoji: '🍷', text: 'How does alcohol affect my recovery?' },
  { emoji: '📊', text: 'Give me a weekly summary' },
]

export default function ChatView() {
  const { userId, setErrorMessage } = useApp()
  
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [isConnected, setIsConnected] = useState(false)
  const [isTyping, setIsTyping] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState('connecting') // 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
  const [confirmingClear, setConfirmingClear] = useState(false)
  
  // Performance metrics
  const [metrics, setMetrics] = useState({ connectionTime: null, lastResponseTime: null })
  
  const socketRef = useRef(null)
  const messagesEndRef = useRef(null)
  const reconnectTimeoutRef = useRef(null)
  const reconnectAttemptsRef = useRef(0)
  const maxReconnectAttempts = 5
  const isMountedRef = useRef(true)
  const connectStartRef = useRef(null)
  const sendStartRef = useRef(null)
  
  // Scroll to bottom
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
      }, 50)
    })
  }, [])
  
  // Connect to WebSocket with reconnection logic
  const connect = useCallback(() => {
    if (!isMountedRef.current) return
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const wsUrl = `${protocol}//${window.location.host}/agents/chat-agent/demo?userId=${userId}&tz=${encodeURIComponent(tz)}`
    
    console.log('Connecting to chat agent:', wsUrl)
    setConnectionStatus(reconnectAttemptsRef.current > 0 ? 'reconnecting' : 'connecting')
    connectStartRef.current = performance.now()
    
    const socket = new WebSocket(wsUrl)
    socketRef.current = socket
    
    socket.onopen = () => {
      if (!isMountedRef.current) return
      const connectionTime = Math.round(performance.now() - connectStartRef.current)
      console.log('Chat connected in', connectionTime, 'ms')
      setMetrics(prev => ({ ...prev, connectionTime }))
      setIsConnected(true)
      setConnectionStatus('connected')
      reconnectAttemptsRef.current = 0 // Reset reconnect attempts on successful connection
    }
    
    socket.onmessage = (event) => {
      if (!isMountedRef.current) return
      try {
        const data = JSON.parse(event.data)
        console.log('Chat message received:', data.type)
        
        if (data.type === 'state') {
          setMessages(data.messages || [])
          scrollToBottom()
        } else if (data.type === 'message') {
          // Track response time for assistant messages
          if (data.message.role === 'assistant' && sendStartRef.current) {
            const responseTime = Math.round(performance.now() - sendStartRef.current)
            console.log('Response time:', responseTime, 'ms')
            setMetrics(prev => ({ ...prev, lastResponseTime: responseTime }))
            sendStartRef.current = null
          }
          setMessages(prev => {
            const existingIndex = prev.findIndex(m => m.id === data.message.id)
            if (existingIndex === -1) {
              return [...prev, data.message]
            }
            return prev
          })
          scrollToBottom()
        } else if (data.type === 'typing') {
          setIsTyping(data.isTyping)
          if (data.isTyping) scrollToBottom()
        } else if (data.type === 'cleared') {
          setMessages([])
        } else if (data.type === 'error') {
          console.error('Chat error:', data.message)
          setErrorMessage(data.message || 'Chat error occurred')
        }
      } catch (e) {
        console.error('Failed to parse chat message:', e)
      }
    }
    
    socket.onclose = (event) => {
      if (!isMountedRef.current) return
      console.log('Chat disconnected', event.code, event.reason)
      setIsConnected(false)
      
      // Attempt reconnection with exponential backoff
      if (reconnectAttemptsRef.current < maxReconnectAttempts) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000) // Max 30s
        console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current + 1}/${maxReconnectAttempts})`)
        setConnectionStatus('reconnecting')
        
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectAttemptsRef.current++
          connect()
        }, delay)
      } else {
        setConnectionStatus('disconnected')
        setErrorMessage('Chat connection lost. Please refresh the page.')
      }
    }
    
    socket.onerror = (error) => {
      console.error('Chat WebSocket error:', error)
      // Don't set disconnected here - onclose will handle reconnection
    }
  }, [userId, scrollToBottom, setErrorMessage])
  
  // Initial connection and cleanup
  useEffect(() => {
    isMountedRef.current = true
    document.body.classList.add('chat-open')
    connect()
    
    return () => {
      isMountedRef.current = false
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (socketRef.current) {
        socketRef.current.close()
      }
      document.body.classList.remove('chat-open')
    }
  }, [connect])
  
  // Send message - accepts optional message parameter to fix stale closure issue
  const sendMessage = useCallback((messageText) => {
    const textToSend = typeof messageText === 'string' ? messageText : input
    
    if (!textToSend.trim() || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      return
    }
    
    const message = textToSend.trim()
    setInput('')
    setIsTyping(true)
    sendStartRef.current = performance.now()
    
    socketRef.current.send(JSON.stringify({
      type: 'chat',
      content: message
    }))
  }, [input])
  
  // Clear history
  const clearHistory = () => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'clear' }))
      setConfirmingClear(false)
    }
  }
  
  // Handle key down (using onKeyDown instead of deprecated onKeyPress)
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }
  
  // Handle quick prompt click - passes message directly to avoid stale closure
  const handleQuickPrompt = useCallback((promptText) => {
    sendMessage(promptText)
  }, [sendMessage])
  
  return (
    <div className="chat-container">
      {/* Chat Header - No Card wrapper, just styled div */}
      <div className="card-no-hover p-4 mb-3 bg-gradient-to-r from-[#EDE7F6] to-[#E3F2FD] flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-gradient-to-br from-[#B39DDB] to-[#90CAF9] rounded-full flex items-center justify-center text-white text-lg font-bold border-2 border-[#2D2D2D]">
              AI
            </div>
            <div>
              <h2 className="font-display text-lg">YOUR COACH</h2>
              <div className="flex items-center gap-2">
                <p className={`text-xs ${isConnected ? 'text-green-600' : connectionStatus === 'reconnecting' ? 'text-yellow-600' : 'text-gray-400'}`}>
                  {connectionStatus === 'connected' ? 'Online via WebSocket' : 
                   connectionStatus === 'reconnecting' ? 'Reconnecting...' :
                   connectionStatus === 'disconnected' ? 'Disconnected' :
                   'Connecting...'}
                </p>
                {metrics.connectionTime && (
                  <span className="text-xs text-gray-400">
                    | Connect: {metrics.connectionTime}ms
                  </span>
                )}
                {metrics.lastResponseTime && (
                  <span className="text-xs text-purple-500">
                    | Last: {metrics.lastResponseTime}ms
                  </span>
                )}
              </div>
            </div>
          </div>
          {confirmingClear ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setConfirmingClear(false)}
                className="px-2 py-1 text-xs text-gray-600 hover:text-gray-800 transition-colors"
                aria-label="Cancel clear"
              >
                Cancel
              </button>
              <button
                onClick={clearHistory}
                className="px-2 py-1 text-xs bg-red-500 text-white rounded hover:bg-red-600 transition-colors"
                aria-label="Confirm clear chat"
              >
                Confirm
              </button>
            </div>
          ) : (
            <button 
              onClick={() => setConfirmingClear(true)}
              className="p-2 text-gray-400 hover:text-red-500 transition-colors"
              title="Clear chat history"
              aria-label="Clear chat history"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}
        </div>
      </div>
      
      {/* Chat Messages Area */}
      <div className="chat-messages px-1">
        {messages.length === 0 ? (
          // Welcome message
          <div className="flex flex-col justify-center items-center h-full text-center py-8">
            <div className="text-6xl mb-4">💪</div>
            <h3 className="font-display text-xl mb-2">HEY! I'M YOUR AI COACH</h3>
            <p className="text-sm text-gray-600 mb-6 max-w-sm mx-auto">
              Ask me about your nutrition, workouts, recovery, or get personalized advice based on your actual data.
            </p>
            
            {/* Quick prompts */}
            <div className="space-y-2 max-w-sm mx-auto w-full">
              {QUICK_PROMPTS.map((prompt, i) => (
                <button
                  key={i}
                  onClick={() => handleQuickPrompt(prompt.text)}
                  className="w-full text-left p-3 bg-white border-2 border-[#2D2D2D] hover:bg-[#E8F5E9] transition-colors text-sm"
                >
                  <span className="text-gray-400 mr-2">{prompt.emoji}</span> "{prompt.text}"
                </button>
              ))}
            </div>
          </div>
        ) : (
          // Messages wrapper - pushes to bottom
          <div className="chat-messages-inner pb-4">
            {messages.map((msg, idx) => (
              <div key={msg.id || idx}>
                {msg.role === 'user' ? (
                  // User message
                  <div className="flex justify-end">
                    <div className="max-w-[85%] bg-[#2D2D2D] text-white p-4 rounded-2xl rounded-br-sm">
                      <p className="text-sm leading-relaxed">{msg.content}</p>
                      <p className="text-xs text-gray-400 mt-2">{formatChatTime(msg.timestamp)}</p>
                    </div>
                  </div>
                ) : (
                  // Assistant message
                  <div className="flex justify-start">
                    <div className="max-w-[85%] bg-white border-2 border-[#2D2D2D] p-4 rounded-2xl rounded-bl-sm shadow-sm">
                      <div 
                        className="text-sm leading-relaxed chat-message"
                        dangerouslySetInnerHTML={{ __html: formatMarkdown(msg.content) }}
                      />
                      <p className="text-xs text-gray-400 mt-2">{formatChatTime(msg.timestamp)}</p>
                    </div>
                  </div>
                )}
              </div>
            ))}
            
            {/* Typing indicator */}
            {isTyping && (
              <div className="flex justify-start">
                <div className="bg-white border-2 border-[#2D2D2D] p-4 rounded-2xl rounded-bl-sm">
                  <div className="flex gap-1.5 items-center">
                    <span className="w-2.5 h-2.5 bg-[#B39DDB] rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-2.5 h-2.5 bg-[#90CAF9] rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-2.5 h-2.5 bg-[#A5D6A7] rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            )}
            
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>
      
      {/* Chat Input */}
      <div className="pt-3 border-t-2 border-[#2D2D2D] bg-[#FFFDF7] flex-shrink-0">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            type="text"
            placeholder="Ask your coach anything..."
            className="flex-1 px-4 py-3 border-2 border-[#2D2D2D] text-sm focus:outline-none focus:ring-2 focus:ring-[#B39DDB] bg-white"
            disabled={!isConnected}
            aria-label="Chat message input"
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || !isConnected || isTyping}
            className="px-6 py-3 bg-gradient-to-r from-[#B39DDB] to-[#90CAF9] text-white font-bold text-sm disabled:opacity-50 transition-all hover:opacity-90 border-2 border-[#2D2D2D]"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
