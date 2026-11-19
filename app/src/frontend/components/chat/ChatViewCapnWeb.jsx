/**
 * ChatViewCapnWeb - Cap'n Web RPC implementation
 * 
 * Compare this to ChatView.jsx:
 * - ChatView.jsx: ~300 lines with manual WebSocket handling
 * - ChatViewCapnWeb.jsx: ~150 lines with clean RPC calls
 * 
 * Key differences:
 * - No manual JSON.parse/JSON.stringify
 * - No manual message type handling (onmessage switch/case)
 * - No manual reconnection logic (built into Cap'n Web)
 * - Bidirectional RPC via callbacks
 * - Promise-based API instead of event-based
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { newWebSocketRpcSession } from 'capnweb'
import { useApp } from '../../context/AppContext'
import { formatChatTime } from '../../utils/formatters'
import { formatMarkdown } from '../../utils/markdown'

// Quick prompts - same as original
const QUICK_PROMPTS = [
  { emoji: '💬', text: 'How am I doing today?' },
  { emoji: '🍗', text: 'What should I eat to hit my protein?' },
  { emoji: '🍷', text: 'How does alcohol affect my recovery?' },
  { emoji: '📊', text: 'Give me a weekly summary' },
]

export default function ChatViewCapnWeb() {
  const { userId, setErrorMessage } = useApp()
  
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [isConnected, setIsConnected] = useState(false)
  const [isTyping, setIsTyping] = useState(false)
  const [isLoading, setIsLoading] = useState(true) // Loading history state
  const [confirmingClear, setConfirmingClear] = useState(false)
  
  // Performance metrics
  const [metrics, setMetrics] = useState({ connectionTime: null, lastResponseTime: null })
  
  // Cap'n Web session ref
  const sessionRef = useRef(null)
  const messagesEndRef = useRef(null)
  const connectStartRef = useRef(null)
  
  // Scroll to bottom
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
      }, 50)
    })
  }, [])
  
  // Initialize Cap'n Web session
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const wsUrl = `${protocol}//${window.location.host}/api/chat/rpc?userId=${userId}&tz=${encodeURIComponent(tz)}`
    
    console.log('[CapnWeb] Connecting to:', wsUrl)
    connectStartRef.current = performance.now()
    
    // Create Cap'n Web session - ONE LINE vs 80+ lines in ChatView.jsx!
    const session = newWebSocketRpcSession(wsUrl)
    sessionRef.current = session
    
    // Simple request/response pattern - no callbacks needed
    // Just load initial history when session is ready
    const initSession = async () => {
      setIsLoading(true)
      try {
        // Give WebSocket time to connect
        await new Promise(resolve => setTimeout(resolve, 100))
        
        console.log('[CapnWeb] Loading history...')
        const history = await session.getHistory()
        
        const connectionTime = Math.round(performance.now() - connectStartRef.current)
        console.log('[CapnWeb] Connected in', connectionTime, 'ms')
        setMetrics(prev => ({ ...prev, connectionTime }))
        
        console.log('[CapnWeb] Loaded history:', history?.length || 0, 'messages')
        setMessages(history || [])
        setIsConnected(true)
        scrollToBottom()
      } catch (err) {
        console.error('[CapnWeb] Setup error:', err)
        setErrorMessage('Failed to connect to chat')
      } finally {
        setIsLoading(false)
      }
    }
    
    initSession()
    
    document.body.classList.add('chat-open')
    
    return () => {
      // Cleanup - dispose the session
      if (sessionRef.current) {
        sessionRef.current[Symbol.dispose]?.()
      }
      document.body.classList.remove('chat-open')
    }
  }, [userId, scrollToBottom, setErrorMessage])
  
  // Send message - SO MUCH CLEANER than manual WebSocket!
  const sendMessage = useCallback(async (messageText) => {
    const textToSend = typeof messageText === 'string' ? messageText : input
    if (!textToSend.trim() || !sessionRef.current) return
    
    setInput('')
    setIsTyping(true)
    const sendStart = performance.now()
    
    try {
      // Just call the RPC method - no JSON.stringify, no message types!
      // Returns both user message and assistant response
      const result = await sessionRef.current.send(textToSend)
      
      const responseTime = Math.round(performance.now() - sendStart)
      console.log('[CapnWeb] Response time:', responseTime, 'ms')
      setMetrics(prev => ({ ...prev, lastResponseTime: responseTime }))
      
      // Add both messages to state
      setMessages(prev => [...prev, result.userMessage, result.assistantMessage])
      scrollToBottom()
    } catch (error) {
      console.error('[CapnWeb] Send error:', error)
      setErrorMessage('Failed to send message')
    } finally {
      setIsTyping(false)
    }
  }, [input, setErrorMessage, scrollToBottom])
  
  // Clear history
  const clearHistory = useCallback(async () => {
    if (!sessionRef.current) return
    
    try {
      await sessionRef.current.clear()
      setMessages([])
      setConfirmingClear(false)
    } catch (error) {
      console.error('[CapnWeb] Clear error:', error)
      setErrorMessage('Failed to clear history')
    }
  }, [setErrorMessage])
  
  // Handle key down
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }
  
  return (
    <div className="chat-container">
      {/* Chat Header */}
      <div className="card-no-hover p-4 mb-3 bg-gradient-to-r from-[#E0F7FA] to-[#E8F5E9] flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-gradient-to-br from-[#26A69A] to-[#66BB6A] rounded-full flex items-center justify-center text-white text-lg font-bold border-2 border-[#2D2D2D]">
              RPC
            </div>
            <div>
              <h2 className="font-display text-lg">CAP'N WEB COACH</h2>
              <div className="flex items-center gap-2">
                <p className={`text-xs ${isConnected ? 'text-green-600' : 'text-gray-400'}`}>
                  {isConnected ? 'Connected via RPC' : 'Connecting...'}
                </p>
                {metrics.connectionTime && (
                  <span className="text-xs text-gray-400">
                    | Connect: {metrics.connectionTime}ms
                  </span>
                )}
                {metrics.lastResponseTime && (
                  <span className="text-xs text-blue-500">
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
              aria-label="Clear chat history"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}
        </div>
      </div>
      
      {/* Chat Messages */}
      <div className="chat-messages px-1">
        {messages.length === 0 && !isLoading ? (
          <div className="flex flex-col justify-center items-center h-full text-center py-8">
            <div className="text-6xl mb-4">🚀</div>
            <h3 className="font-display text-xl mb-2">CAP'N WEB RPC MODE</h3>
            <p className="text-sm text-gray-600 mb-6 max-w-sm mx-auto">
              This uses Cap'n Web for cleaner, more efficient RPC communication.
              Same AI coach, better code!
            </p>
            
            <div className="space-y-2 max-w-sm mx-auto w-full">
              {QUICK_PROMPTS.map((prompt, i) => (
                <button
                  key={i}
                  onClick={() => sendMessage(prompt.text)}
                  className="w-full text-left p-3 bg-white border-2 border-[#2D2D2D] hover:bg-[#E0F7FA] transition-colors text-sm"
                >
                  <span className="text-gray-400 mr-2">{prompt.emoji}</span> "{prompt.text}"
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="chat-messages-inner pb-4">
            {messages.map((msg, idx) => (
              <div key={msg.id || idx}>
                {msg.role === 'user' ? (
                  <div className="flex justify-end">
                    <div className="max-w-[85%] bg-[#2D2D2D] text-white p-4 rounded-2xl rounded-br-sm">
                      <p className="text-sm leading-relaxed">{msg.content}</p>
                      <p className="text-xs text-gray-400 mt-2">{formatChatTime(msg.timestamp)}</p>
                    </div>
                  </div>
                ) : (
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
            
            {(isTyping || isLoading) && (
              <div className="flex justify-start">
                <div className="bg-white border-2 border-[#2D2D2D] p-4 rounded-2xl rounded-bl-sm">
                  <div className="flex gap-1.5 items-center">
                    <span className="w-2.5 h-2.5 bg-[#26A69A] rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-2.5 h-2.5 bg-[#66BB6A] rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-2.5 h-2.5 bg-[#26A69A] rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
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
            className="flex-1 px-4 py-3 border-2 border-[#2D2D2D] text-sm focus:outline-none focus:ring-2 focus:ring-[#26A69A] bg-white"
            disabled={!isConnected}
            aria-label="Chat message input"
          />
          <button
            onClick={() => sendMessage()}
            disabled={!input.trim() || !isConnected || isTyping}
            className="px-6 py-3 bg-gradient-to-r from-[#26A69A] to-[#66BB6A] text-white font-bold text-sm disabled:opacity-50 transition-all hover:opacity-90 border-2 border-[#2D2D2D]"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
