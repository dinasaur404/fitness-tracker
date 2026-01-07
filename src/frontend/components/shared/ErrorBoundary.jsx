import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo })
    // Log to console in development
    console.error('ErrorBoundary caught an error:', error, errorInfo)
    
    // In production, you could send this to an error tracking service
    // e.g., Sentry, LogRocket, etc.
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null })
  }

  handleRefresh = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      // Custom fallback UI
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div className="min-h-screen bg-[#FFFDF7] flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white border-2 border-[#2D2D2D] p-6 text-center">
            <div className="text-5xl mb-4">😵</div>
            <h1 className="font-display text-xl mb-2">SOMETHING WENT WRONG</h1>
            <p className="text-sm text-gray-600 mb-4">
              The app encountered an unexpected error. Don't worry, your data is safe.
            </p>
            
            {process.env.NODE_ENV === 'development' && this.state.error && (
              <details className="text-left mb-4 p-3 bg-red-50 border border-red-200 text-xs">
                <summary className="cursor-pointer font-medium text-red-700">
                  Error Details
                </summary>
                <pre className="mt-2 overflow-auto text-red-600">
                  {this.state.error.toString()}
                  {this.state.errorInfo?.componentStack}
                </pre>
              </details>
            )}
            
            <div className="flex gap-2 justify-center">
              <button
                onClick={this.handleReset}
                className="px-4 py-2 bg-[#A5D6A7] border-2 border-[#2D2D2D] font-medium text-sm hover:bg-[#81C784] transition-colors"
              >
                Try Again
              </button>
              <button
                onClick={this.handleRefresh}
                className="px-4 py-2 bg-[#2D2D2D] text-white border-2 border-[#2D2D2D] font-medium text-sm hover:bg-[#1D1D1D] transition-colors"
              >
                Refresh Page
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
