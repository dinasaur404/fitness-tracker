export default function LoadingScreen() {
  return (
    <div className="fixed inset-0 bg-gradient-to-br from-[#E8F5E9] to-[#E3F2FD] flex items-center justify-center">
      <div className="text-center">
        <div className="text-6xl mb-6 float">✦</div>
        <h1 className="font-display text-4xl text-charcoal">LOADING</h1>
        <div className="mt-4 flex items-center justify-center gap-2">
          <span className="mono text-gray-600">Please wait</span>
          <span className="text-gray-600 blink">_</span>
        </div>
        <div className="mt-6 w-64 mx-auto h-2 bg-white border-2 border-[#2D2D2D] rounded-full overflow-hidden">
          <div className="xp-fill h-full" style={{ width: '60%' }}></div>
        </div>
      </div>
    </div>
  )
}
