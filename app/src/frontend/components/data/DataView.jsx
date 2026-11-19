import { useState, useEffect } from 'react'
import { useApp } from '../../context/AppContext'
import Card from '../shared/Card'
import Modal from '../shared/Modal'
import { formatLocalDate, formatDate, getMonthName } from '../../utils/formatters'
import { getRecoveryColor, getRecoveryBarClass, getRecoveryBadgeClass, getRecoveryLabel, getRecoveryCardClass } from '../../utils/recovery'

// Tooltip component for metric explanations
function Tooltip({ children, content }) {
  const [show, setShow] = useState(false)
  
  return (
    <div className="relative inline-block">
      <div 
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onClick={() => setShow(!show)}
        className="cursor-help"
      >
        {children}
      </div>
      {show && (
        <div className="absolute z-50 bottom-full left-1/2 transform -translate-x-1/2 mb-2 w-48 p-2 bg-[#2D2D2D] text-white text-xs rounded border-2 border-[#2D2D2D] shadow-[2px_2px_0px_rgba(0,0,0,0.3)]">
          {content}
          <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-[#2D2D2D]" />
        </div>
      )}
    </div>
  )
}

// Metric explanations
const METRIC_INFO = {
  hrv: {
    title: 'Heart Rate Variability (HRV)',
    description: 'Measures variation between heartbeats. Higher = better recovery & stress resilience. Low HRV may indicate fatigue or stress.'
  },
  rhr: {
    title: 'Resting Heart Rate (RHR)',
    description: 'Your heart rate at complete rest. Lower = better cardiovascular fitness. Higher than usual may indicate stress or illness.'
  },
  spo2: {
    title: 'Blood Oxygen Saturation (SpO2)',
    description: 'Percentage of oxygen in your blood. Normal is 95-100%. Lower values during sleep may indicate breathing issues.'
  }
}

export default function DataView() {
  const { 
    api, 
    integrations, 
    dataTab, 
    setDataTab,
    dataDate,
    setDataDate,
    dataLoading,
    setDataLoading,
    dailyData,
    setDailyData,
    weeklyData,
    setWeeklyData,
    monthlyData,
    setMonthlyData,
    trendData,
    trendStats,
    setErrorMessage,
  } = useApp()
  
  // Calendar metric selector
  const [calendarMetric, setCalendarMetric] = useState('recovery')
  
  // Weight history modal
  const [showWeightModal, setShowWeightModal] = useState(false)
  const [weightHistory, setWeightHistory] = useState([])
  const [weightLoading, setWeightLoading] = useState(false)
  const [weightChartMetric, setWeightChartMetric] = useState('weight') // 'weight' or 'body_fat'
  
  // Fetch data based on current tab
  // Always fetch from database - historical data should display regardless of sync/rate limit status
  useEffect(() => {
    const fetchData = async () => {
      setDataLoading(true)
      try {
        const dateStr = formatLocalDate(dataDate)
        console.log('[DataView] Fetching data for tab:', dataTab, 'date:', dateStr)
        
        if (dataTab === 'daily') {
          const data = await api(`/api/whoop/daily/${dateStr}`)
          console.log('[DataView] Daily data:', data)
          setDailyData(data || {})
        } else if (dataTab === 'weekly') {
          // Get Monday of current week
          const date = new Date(dataDate)
          const day = date.getDay()
          const diff = date.getDate() - day + (day === 0 ? -6 : 1)
          date.setDate(diff)
          const weekStart = formatLocalDate(date)
          
          console.log('[DataView] Weekly fetch, weekStart:', weekStart)
          const data = await api(`/api/whoop/summary/week?start=${weekStart}`)
          console.log('[DataView] Weekly data:', data)
          setWeeklyData(data || { daily_data: [] })
        } else if (dataTab === 'monthly') {
          const year = dataDate.getFullYear()
          const month = dataDate.getMonth() + 1
          console.log('[DataView] Monthly fetch, year:', year, 'month:', month)
          const data = await api(`/api/whoop/summary/month?year=${year}&month=${month}`)
          console.log('[DataView] Monthly data:', data)
          setMonthlyData(data || { daily_data: [] })
        }
      } catch (error) {
        console.error('[DataView] Failed to fetch data:', error)
        setErrorMessage('Failed to load data')
      } finally {
        setDataLoading(false)
      }
    }
    
    fetchData()
  }, [api, dataTab, dataDate, setDataLoading, setDailyData, setWeeklyData, setMonthlyData, setErrorMessage])
  
  // Navigate date
  const navigateDate = (direction) => {
    const newDate = new Date(dataDate)
    if (dataTab === 'daily') {
      newDate.setDate(newDate.getDate() + direction)
    } else if (dataTab === 'weekly') {
      newDate.setDate(newDate.getDate() + (direction * 7))
    } else {
      newDate.setMonth(newDate.getMonth() + direction)
    }
    setDataDate(newDate)
  }
  
  // Go to today
  const goToToday = () => {
    setDataDate(new Date())
  }
  
  // Check if current date is today
  const isDataDateToday = () => {
    const today = new Date()
    return dataDate.toDateString() === today.toDateString()
  }
  
  // Get date range label
  const getDataDateRange = () => {
    if (dataTab === 'daily') {
      return formatDate(dataDate)
    } else if (dataTab === 'weekly') {
      const start = new Date(dataDate)
      const day = start.getDay()
      const diff = start.getDate() - day + (day === 0 ? -6 : 1)
      start.setDate(diff)
      const end = new Date(start)
      end.setDate(end.getDate() + 6)
      return `${start.getMonth() + 1}/${start.getDate()} - ${end.getMonth() + 1}/${end.getDate()}`
    } else {
      return getMonthName(dataDate)
    }
  }
  
  // Format sleep duration
  const formatSleepDuration = (minutes) => {
    if (!minutes) return '--'
    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60
    return `${hours}h ${mins}m`
  }
  
  // Get sleep stage percentage
  const getSleepStagePercent = (stage) => {
    const total = dailyData.sleep_duration_minutes || 1
    switch(stage) {
      case 'deep': return ((dailyData.deep_duration_minutes || 0) / total * 100).toFixed(1)
      case 'rem': return ((dailyData.rem_duration_minutes || 0) / total * 100).toFixed(1)
      case 'light': return ((dailyData.light_duration_minutes || 0) / total * 100).toFixed(1)
      case 'awake': return ((dailyData.awake_duration_minutes || 0) / total * 100).toFixed(1)
      default: return 0
    }
  }
  
  // Strain zone helpers
  const getStrainZones = () => {
    const recovery = dailyData.recovery_score || 50
    if (recovery >= 67) {
      return { light: 0, optimal: [8, 18], overreaching: [18, 21], excessive: 21 }
    } else if (recovery >= 34) {
      return { light: 0, optimal: [6, 14], overreaching: [14, 18], excessive: 18 }
    } else {
      return { light: 0, optimal: [4, 10], overreaching: [10, 14], excessive: 14 }
    }
  }
  
  const getStrainZoneWidth = (zone) => {
    const zones = getStrainZones()
    if (zone === 'light') return (zones.optimal[0] / 21) * 100
    if (zone === 'optimal') return ((zones.optimal[1] - zones.optimal[0]) / 21) * 100
    if (zone === 'overreaching') return ((zones.overreaching[1] - zones.overreaching[0]) / 21) * 100
    if (zone === 'excessive') return ((21 - zones.excessive) / 21) * 100
    return 0
  }
  
  const getOptimalStrainRange = () => {
    const zones = getStrainZones()
    return `${zones.optimal[0]} - ${zones.optimal[1]}`
  }
  
  const getStrainStatus = () => {
    const strain = dailyData.day_strain || 0
    const zones = getStrainZones()
    if (strain < zones.optimal[0]) return 'Light day'
    if (strain <= zones.optimal[1]) return 'Optimal'
    if (strain <= zones.overreaching[1]) return 'Pushing it'
    return 'Overreaching'
  }
  
  const getStrainStatusColor = () => {
    const status = getStrainStatus()
    if (status === 'Light day') return 'text-blue-600'
    if (status === 'Optimal') return 'text-green-600'
    if (status === 'Pushing it') return 'text-yellow-600'
    return 'text-red-600'
  }
  
  // Format weekday
  const formatWeekDay = (dateStr) => {
    const date = new Date(dateStr + 'T12:00:00')
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  }
  
  // Format trend day
  const formatTrendDay = (dateStr) => {
    if (!dateStr) return '--'
    const date = new Date(dateStr + 'T12:00:00')
    return date.toLocaleDateString('en-US', { weekday: 'short' }).charAt(0)
  }
  
  // Go to specific day
  const goToDay = (dateStr) => {
    setDataTab('daily')
    setDataDate(new Date(dateStr + 'T12:00:00'))
  }
  
  // Fetch weight history
  const fetchWeightHistory = async () => {
    setWeightLoading(true)
    setShowWeightModal(true)
    try {
      const data = await api('/api/progress/weight?days=90')
      setWeightHistory(data || [])
    } catch (error) {
      console.error('Failed to fetch weight history:', error)
      setErrorMessage('Failed to load weight history')
    } finally {
      setWeightLoading(false)
    }
  }
  
  // Format weight date
  const formatWeightDate = (dateStr) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  
  return (
    <div className="space-y-5">
      {/* Tab Navigation */}
      <div className="flex border-2 border-[#2D2D2D]" role="tablist" aria-label="Data view period">
        {['daily', 'weekly', 'monthly'].map(tab => (
          <button
            key={tab}
            onClick={() => setDataTab(tab)}
            role="tab"
            aria-selected={dataTab === tab}
            aria-controls={`${tab}-panel`}
            className={`flex-1 py-3 font-display text-sm transition-all border-r border-[#2D2D2D] last:border-r-0
              ${dataTab === tab ? 'bg-[#A5D6A7]' : 'bg-white'}`}
          >
            {tab.toUpperCase()}
          </button>
        ))}
      </div>
      
      {/* Date Navigation */}
      <div className="flex items-center justify-between card-no-hover p-3">
        <button
          onClick={() => navigateDate(-1)}
          className="btn px-3 py-2"
          aria-label={`Previous ${dataTab === 'daily' ? 'day' : dataTab === 'weekly' ? 'week' : 'month'}`}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        
        <div className="text-center flex-1">
          <div className="font-display text-lg">
            {dataTab === 'monthly' ? getMonthName(dataDate) : formatDate(dataDate)}
          </div>
          <div className="text-xs mono text-gray-500">{getDataDateRange()}</div>
        </div>
        
        {!isDataDateToday() && (
          <button
            onClick={goToToday}
            className="btn btn-sky px-3 py-2 mr-2 text-xs font-display"
          >
            TODAY
          </button>
        )}
        
        <button
          onClick={() => navigateDate(1)}
          disabled={isDataDateToday()}
          className="btn px-3 py-2 disabled:opacity-30"
          aria-label={`Next ${dataTab === 'daily' ? 'day' : dataTab === 'weekly' ? 'week' : 'month'}`}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
      
      {/* Loading State */}
      {dataLoading && (
        <div className="card-no-hover p-8 text-center">
          <div className="text-4xl mb-4 animate-pulse">...</div>
          <p className="mono text-gray-600">Loading data...</p>
        </div>
      )}
      
      {/* Daily Tab Content */}
      {!dataLoading && dataTab === 'daily' && (
        <div className="space-y-4">
          {/* Hero Recovery Card */}
          <Card className="p-5">
            <div className="flex items-center gap-4 mb-4">
              {/* Recovery Circle - The main focus */}
              <div className={`w-20 h-20 rounded-full border-4 flex items-center justify-center flex-shrink-0 ${
                dailyData.recovery_score >= 67 ? 'border-green-500 bg-green-50' : 
                dailyData.recovery_score >= 34 ? 'border-yellow-500 bg-yellow-50' : 
                dailyData.recovery_score != null ? 'border-red-500 bg-red-50' :
                'border-gray-300 bg-gray-50'
              }`}>
                <span className={`font-display text-2xl ${getRecoveryColor(dailyData.recovery_score)}`}>
                  {dailyData.recovery_score ? Math.round(dailyData.recovery_score) : '--'}
                </span>
              </div>
              
              {/* Recovery Details */}
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="font-display text-lg">RECOVERY</h3>
                  {dailyData.recovery_score != null && (
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      dailyData.recovery_score >= 67 ? 'bg-green-100 text-green-700' :
                      dailyData.recovery_score >= 34 ? 'bg-yellow-100 text-yellow-700' :
                      'bg-red-100 text-red-700'
                    }`}>
                      {getRecoveryLabel(dailyData.recovery_score)}
                    </span>
                  )}
                </div>
                {/* What this means */}
                <p className="text-sm text-gray-600">
                  {dailyData.recovery_score >= 67 
                    ? "Your body is primed for peak performance. Great day to push hard!"
                    : dailyData.recovery_score >= 34 
                    ? "Moderate recovery. Listen to your body and train smart."
                    : dailyData.recovery_score != null
                    ? "Your body needs rest. Focus on recovery activities today."
                    : "No recovery data available."}
                </p>
              </div>
            </div>
            
            {/* Key Metrics with context */}
            <div className="grid grid-cols-3 gap-3 pt-3 border-t border-gray-100">
              <Tooltip content={<><strong>{METRIC_INFO.hrv.title}</strong><br/>{METRIC_INFO.hrv.description}</>}>
                <div className="text-center">
                  <div className={`font-display text-xl ${
                    dailyData.hrv_rmssd && trendStats?.avg_hrv 
                      ? dailyData.hrv_rmssd > trendStats.avg_hrv ? 'text-green-600' : 'text-red-600'
                      : ''
                  }`}>
                    {dailyData.hrv_rmssd ? Math.round(dailyData.hrv_rmssd) : '--'}
                  </div>
                  <div className="text-[10px] text-gray-500 flex items-center justify-center gap-1">
                    HRV (ms)
                    <svg className="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  {trendStats?.avg_hrv && (
                    <div className="text-[10px] text-gray-400">avg: {Math.round(trendStats.avg_hrv)}</div>
                  )}
                </div>
              </Tooltip>
              <Tooltip content={<><strong>{METRIC_INFO.rhr.title}</strong><br/>{METRIC_INFO.rhr.description}</>}>
                <div className="text-center">
                  <div className={`font-display text-xl ${
                    dailyData.resting_heart_rate && trendStats?.avg_rhr
                      ? dailyData.resting_heart_rate < trendStats.avg_rhr ? 'text-green-600' : 'text-red-600'
                      : ''
                  }`}>
                    {dailyData.resting_heart_rate ? Math.round(dailyData.resting_heart_rate) : '--'}
                  </div>
                  <div className="text-[10px] text-gray-500 flex items-center justify-center gap-1">
                    RHR (bpm)
                    <svg className="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  {trendStats?.avg_rhr && (
                    <div className="text-[10px] text-gray-400">avg: {Math.round(trendStats.avg_rhr)}</div>
                  )}
                </div>
              </Tooltip>
              <Tooltip content={<><strong>{METRIC_INFO.spo2.title}</strong><br/>{METRIC_INFO.spo2.description}</>}>
                <div className="text-center">
                  <div className="font-display text-xl">{dailyData.spo2_percentage ? Math.round(dailyData.spo2_percentage) : '--'}</div>
                  <div className="text-[10px] text-gray-500 flex items-center justify-center gap-1">
                    SpO2 %
                    <svg className="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div className="text-[10px] text-gray-400">normal: 95-100</div>
                </div>
              </Tooltip>
            </div>
          </Card>
          
          {/* Strain & Sleep Row */}
          <div className="grid grid-cols-2 gap-3">
            {/* Strain */}
            <Card className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="font-display text-sm">STRAIN</span>
                <span className={`text-xs px-2 py-0.5 rounded ${
                  (dailyData.day_strain || 0) >= 14 ? 'bg-orange-100 text-orange-700' :
                  (dailyData.day_strain || 0) >= 8 ? 'bg-yellow-100 text-yellow-700' :
                  'bg-blue-100 text-blue-700'
                }`}>
                  {getStrainStatus()}
                </span>
              </div>
              <div className="font-display text-3xl">{dailyData.day_strain?.toFixed(1) || '--'}</div>
              <div className="text-xs text-gray-500 mt-1">{dailyData.day_calories || 0} cal burned</div>
            </Card>
            
            {/* Sleep */}
            <Card className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="font-display text-sm">SLEEP</span>
                {dailyData.sleep_performance && (
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    dailyData.sleep_performance >= 85 ? 'bg-green-100 text-green-700' :
                    dailyData.sleep_performance >= 70 ? 'bg-yellow-100 text-yellow-700' :
                    'bg-red-100 text-red-700'
                  }`}>
                    {Math.round(dailyData.sleep_performance)}% perf
                  </span>
                )}
              </div>
              <div className="font-display text-3xl">
                {dailyData.sleep_duration_minutes ? (dailyData.sleep_duration_minutes / 60).toFixed(1) : '--'}
                <span className="text-lg text-gray-500">h</span>
              </div>
              <div className="text-xs text-gray-500 mt-1">
                {dailyData.sleep_efficiency ? `${Math.round(dailyData.sleep_efficiency)}% efficiency` : ''}
              </div>
            </Card>
          </div>
          
          {/* 7-Day Trend - Neo-brutalist style */}
          {trendData && trendData.some(d => d.recovery_score !== null) && (
            <Card className="p-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-display text-sm">7-DAY TREND</h4>
                {trendStats?.avg_recovery && (
                  <span className="text-xs text-gray-500 mono">30d avg: {trendStats.avg_recovery}%</span>
                )}
              </div>
              <div className="flex items-end justify-between gap-1">
                {trendData.map((day, idx) => (
                  <div key={idx} className="flex-1 flex flex-col items-center">
                    {/* Score label */}
                    <div className={`text-[10px] font-bold mb-1 ${day.recovery_score !== null ? 'text-[#2D2D2D]' : 'text-gray-300'}`}>
                      {day.recovery_score !== null ? Math.round(day.recovery_score) : '-'}
                    </div>
                    {/* Bar - Neo-brutalist with hard edges */}
                    <div className="w-full h-14 bg-[#F5F5F5] border-2 border-[#2D2D2D] relative">
                      {day.recovery_score !== null ? (
                        <div
                          className={`absolute bottom-0 left-0 right-0 transition-all ${
                            day.recovery_score >= 67 ? 'bg-[#A5D6A7]' :
                            day.recovery_score >= 34 ? 'bg-[#FFF59D]' : 'bg-[#EF9A9A]'
                          }`}
                          style={{ height: Math.max(day.recovery_score, 5) + '%' }}
                        />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="w-4 h-0.5 bg-gray-300" />
                        </div>
                      )}
                    </div>
                    <div className="text-[10px] font-bold text-gray-500 mt-1">{formatTrendDay(day.date)}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}
          
          {/* Strain Details Card */}
          {dailyData.day_strain != null && (
            <Card className="p-4">
              <h3 className="font-display text-sm mb-3">STRAIN ZONES</h3>
              
              {/* Strain zones bar */}
              <div className="relative h-6 bg-gray-100 overflow-hidden rounded">
                <div className="absolute inset-0 flex">
                  <div className="bg-blue-200" style={{ width: getStrainZoneWidth('light') + '%' }} />
                  <div className="bg-green-300" style={{ width: getStrainZoneWidth('optimal') + '%' }} />
                  <div className="bg-yellow-300" style={{ width: getStrainZoneWidth('overreaching') + '%' }} />
                  <div className="bg-red-300" style={{ width: getStrainZoneWidth('excessive') + '%' }} />
                </div>
                <div 
                  className="absolute top-0 bottom-0 w-1 bg-[#2D2D2D] transition-all"
                  style={{ left: Math.min((dailyData.day_strain || 0) / 21 * 100, 100) + '%' }}
                />
              </div>
              
              {/* Zone labels */}
              <div className="flex text-[10px] text-gray-500 mt-1">
                <div style={{ width: getStrainZoneWidth('light') + '%' }} className="text-center">Rest</div>
                <div style={{ width: getStrainZoneWidth('optimal') + '%' }} className="text-center font-medium text-green-600">Optimal</div>
                <div style={{ width: getStrainZoneWidth('overreaching') + '%' }} className="text-center">Push</div>
                <div style={{ width: getStrainZoneWidth('excessive') + '%' }} className="text-center">Max</div>
              </div>
              
              {/* Optimal range */}
              {dailyData.recovery_score && (
                <div className="mt-2 text-xs text-gray-500">
                  Target: <span className="font-medium text-green-600">{getOptimalStrainRange()}</span> based on recovery
                </div>
              )}
            </Card>
          )}
          
          {/* Sleep Details Card */}
          {dailyData.sleep_duration_minutes && (
            <Card className="p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-display text-sm">SLEEP BREAKDOWN</h3>
                <span className="text-xs text-gray-500">
                  {formatSleepDuration(dailyData.sleep_duration_minutes)} total
                </span>
              </div>
              
              {/* Sleep Stages Bar */}
              <div className="flex h-6 bg-gray-100 overflow-hidden rounded mb-2">
                <div className="bg-indigo-700" style={{ width: getSleepStagePercent('deep') + '%' }} />
                <div className="bg-indigo-500" style={{ width: getSleepStagePercent('rem') + '%' }} />
                <div className="bg-indigo-300" style={{ width: getSleepStagePercent('light') + '%' }} />
                <div className="bg-gray-300" style={{ width: getSleepStagePercent('awake') + '%' }} />
              </div>
              
              {/* Sleep stages grid */}
              <div className="grid grid-cols-4 gap-2 text-center">
                <div>
                  <div className="flex items-center justify-center gap-1 mb-1">
                    <span className="w-2 h-2 bg-indigo-700 rounded-sm"></span>
                    <span className="font-display text-sm">{dailyData.deep_duration_minutes || 0}m</span>
                  </div>
                  <div className="text-[10px] text-gray-500">Deep</div>
                </div>
                <div>
                  <div className="flex items-center justify-center gap-1 mb-1">
                    <span className="w-2 h-2 bg-indigo-500 rounded-sm"></span>
                    <span className="font-display text-sm">{dailyData.rem_duration_minutes || 0}m</span>
                  </div>
                  <div className="text-[10px] text-gray-500">REM</div>
                </div>
                <div>
                  <div className="flex items-center justify-center gap-1 mb-1">
                    <span className="w-2 h-2 bg-indigo-300 rounded-sm"></span>
                    <span className="font-display text-sm">{dailyData.light_duration_minutes || 0}m</span>
                  </div>
                  <div className="text-[10px] text-gray-500">Light</div>
                </div>
                <div>
                  <div className="flex items-center justify-center gap-1 mb-1">
                    <span className="w-2 h-2 bg-gray-300 rounded-sm"></span>
                    <span className="font-display text-sm">{dailyData.awake_duration_minutes || 0}m</span>
                  </div>
                  <div className="text-[10px] text-gray-500">Awake</div>
                </div>
              </div>
              
              {/* Respiratory rate if available */}
              {dailyData.respiratory_rate && (
                <div className="mt-3 pt-3 border-t border-gray-100 text-center">
                  <span className="text-xs text-gray-500">Respiratory Rate: </span>
                  <span className="font-medium text-sm">{dailyData.respiratory_rate.toFixed(1)} breaths/min</span>
                </div>
              )}
            </Card>
          )}
          
          {/* Workouts Card - only show if we have actual workouts with data */}
          {dailyData.workouts && dailyData.workouts.length > 0 && (
            <Card className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-display text-sm">WORKOUTS</h3>
                  <div className="text-xs text-gray-500">{dailyData.workouts.length} session{dailyData.workouts.length !== 1 ? 's' : ''}</div>
                </div>
                <div className="flex gap-4 text-center">
                  <div>
                    <div className="font-display text-xl">{dailyData.total_workout_strain?.toFixed(1) || '0'}</div>
                    <div className="text-[10px] text-gray-500">Strain</div>
                  </div>
                  <div>
                    <div className="font-display text-xl">{dailyData.total_workout_calories ? Math.round(dailyData.total_workout_calories) : 0}</div>
                    <div className="text-[10px] text-gray-500">Calories</div>
                  </div>
                </div>
              </div>
            </Card>
          )}
          
          {/* Nutrition Card */}
          {(dailyData.meals_count > 0 || dailyData.total_calories > 0) && (
            <Card className="p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-display text-sm">NUTRITION</h3>
                <span className="text-xs text-gray-500">{dailyData.meals_count || 0} meal{dailyData.meals_count !== 1 ? 's' : ''}</span>
              </div>
              
              {/* Macro Summary */}
              <div className="flex justify-between text-center">
                <div>
                  <div className="font-display text-lg">{dailyData.total_calories || 0}</div>
                  <div className="text-[10px] text-gray-500">Cal</div>
                </div>
                <div>
                  <div className="font-display text-lg">{dailyData.total_protein || 0}g</div>
                  <div className="text-[10px] text-gray-500">Protein</div>
                </div>
                <div>
                  <div className="font-display text-lg">{dailyData.total_carbs || 0}g</div>
                  <div className="text-[10px] text-gray-500">Carbs</div>
                </div>
                <div>
                  <div className="font-display text-lg">{dailyData.total_fat || 0}g</div>
                  <div className="text-[10px] text-gray-500">Fat</div>
                </div>
              </div>
            </Card>
          )}
          
          {/* Habits & Weight Row */}
          <div className="grid grid-cols-2 gap-3">
            {/* Habits */}
            <Card className="p-4">
              <h3 className="font-display text-sm mb-2">HABITS</h3>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">Water</span>
                  <div className="flex gap-1">
                    {[1, 2, 3].map(i => (
                      <div 
                        key={i}
                        className={`w-4 h-4 rounded-full ${
                          i <= (dailyData.water_bottles || 0) ? 'bg-blue-400' : 'bg-gray-200'
                        }`}
                      />
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">Electrolytes</span>
                  <span className={`text-xs ${dailyData.took_electrolytes ? 'text-green-600' : 'text-gray-400'}`}>
                    {dailyData.took_electrolytes ? '✓' : '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">Alcohol</span>
                  <span className={`text-xs ${(dailyData.drinks_count || 0) === 0 ? 'text-green-600' : 'text-orange-500'}`}>
                    {(dailyData.drinks_count || 0) === 0 ? '✓' : dailyData.drinks_count}
                  </span>
                </div>
              </div>
            </Card>
            
            {/* Weight */}
            <Card 
              className="p-4 cursor-pointer"
              onClick={() => fetchWeightHistory()}
            >
              <h3 className="font-display text-sm mb-2">WEIGHT</h3>
              {dailyData.weight_kg ? (
                <div>
                  <div className="font-display text-2xl">{(dailyData.weight_kg * 2.205).toFixed(1)}</div>
                  <div className="text-[10px] text-gray-500">lbs • tap for history</div>
                </div>
              ) : (
                <div className="text-gray-400 text-sm">No data</div>
              )}
            </Card>
          </div>
          
          {/* No Data State */}
          {!dailyData.recovery_score && !dailyData.day_strain && !dailyData.sleep_duration_minutes && (
            <Card className="p-8 text-center">
              <div className="text-4xl mb-4">?</div>
              <h3 className="font-display text-lg mb-2">No Data Available</h3>
              <p className="text-sm text-gray-600">No data found for this date. Try syncing your Whoop.</p>
            </Card>
          )}
        </div>
      )}
      
      {/* Weekly Tab Content */}
      {!dataLoading && dataTab === 'weekly' && (
        <div className="space-y-4">
          {/* Weekly Summary */}
          <Card className="p-5">
            <h3 className="font-display text-lg mb-4">WEEKLY AVERAGES</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className={`text-center p-4 border-2 border-[#2D2D2D] ${getRecoveryCardClass(weeklyData.avg_recovery)}`}>
                <div className={`font-display text-4xl ${getRecoveryColor(weeklyData.avg_recovery)}`}>
                  {weeklyData.avg_recovery || '--'}%
                </div>
                <div className="mono text-xs text-gray-600 mt-1">Avg Recovery</div>
              </div>
              <div className="text-center p-4 border-2 border-[#2D2D2D] bg-[#FFF3E0]">
                <div className="font-display text-4xl">{weeklyData.avg_strain?.toFixed(1) || '--'}</div>
                <div className="mono text-xs text-gray-600 mt-1">Avg Strain</div>
              </div>
              <div className="text-center p-4 border-2 border-[#2D2D2D] bg-[#EDE7F6]">
                <div className="font-display text-4xl">{weeklyData.avg_sleep_hours?.toFixed(1) || '--'}</div>
                <div className="mono text-xs text-gray-600 mt-1">Avg Sleep (hrs)</div>
              </div>
              <div className="text-center p-4 border-2 border-[#2D2D2D] bg-[#E3F2FD]">
                <div className="font-display text-4xl">{weeklyData.total_workouts || 0}</div>
                <div className="mono text-xs text-gray-600 mt-1">Total Workouts</div>
              </div>
            </div>
          </Card>
          
          {/* Daily Breakdown - Cards style like Vue */}
          <div className="space-y-3">
            {(weeklyData.daily_data || []).map((day, i) => (
              <Card
                key={i}
                onClick={() => goToDay(day.date)}
                className="p-4 cursor-pointer hover:translate-x-1 transition-all"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-bold">{formatWeekDay(day.date)}</div>
                    <div className="text-xs mono text-gray-500">{day.date}</div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-center">
                      <div className={`font-display text-xl ${getRecoveryColor(day.recovery_score)}`}>
                        {day.recovery_score || '--'}%
                      </div>
                      <div className="text-xs text-gray-500">Recovery</div>
                    </div>
                    <div className="text-center">
                      <div className="font-display text-xl">{day.day_strain?.toFixed(1) || '--'}</div>
                      <div className="text-xs text-gray-500">Strain</div>
                    </div>
                    <div className="text-center">
                      <div className="font-display text-lg">{formatSleepDuration(day.sleep_duration_minutes)}</div>
                      <div className="text-xs text-gray-500">Sleep</div>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
            {(!weeklyData.daily_data || weeklyData.daily_data.length === 0) && (
              <Card className="p-8 text-center">
                <p className="text-gray-500">No data for this week</p>
              </Card>
            )}
          </div>
        </div>
      )}
      
      {/* Monthly Tab Content */}
      {!dataLoading && dataTab === 'monthly' && (
        <div className="space-y-4">
          {/* Monthly Summary */}
          <Card className="p-5">
            <h3 className="font-display text-lg mb-4">MONTHLY SUMMARY</h3>
            <div className="grid grid-cols-4 gap-2">
              <div className={`text-center p-3 border-2 border-[#2D2D2D] ${getRecoveryCardClass(monthlyData.avg_recovery)}`}>
                <div className={`font-display text-xl ${getRecoveryColor(monthlyData.avg_recovery)}`}>
                  {monthlyData.avg_recovery?.toFixed(0) || '--'}%
                </div>
                <div className="mono text-[10px] text-gray-600 mt-1">Recovery</div>
              </div>
              <div className="text-center p-3 border-2 border-[#2D2D2D] bg-[#FFF3E0]">
                <div className="font-display text-xl">{monthlyData.avg_strain?.toFixed(1) || '--'}</div>
                <div className="mono text-[10px] text-gray-600 mt-1">Strain</div>
              </div>
              <div className="text-center p-3 border-2 border-[#2D2D2D] bg-[#EDE7F6]">
                <div className="font-display text-xl">{monthlyData.avg_sleep_hours?.toFixed(1) || '--'}h</div>
                <div className="mono text-[10px] text-gray-600 mt-1">Sleep</div>
              </div>
              <div className="text-center p-3 border-2 border-[#2D2D2D] bg-[#E3F2FD]">
                <div className="font-display text-xl">{monthlyData.total_barrys || 0}</div>
                <div className="mono text-[10px] text-gray-600 mt-1">Barry's</div>
              </div>
            </div>
          </Card>
          
          {/* Calendar Grid */}
          <Card className="p-5">
            {/* Metric Selector */}
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-lg">CALENDAR</h3>
              <div className="flex border-2 border-[#2D2D2D]">
                {[
                  { key: 'recovery', label: 'REC' },
                  { key: 'strain', label: 'STR' },
                  { key: 'sleep', label: 'SLP' },
                ].map(metric => (
                  <button
                    key={metric.key}
                    onClick={() => setCalendarMetric(metric.key)}
                    className={`px-3 py-1 text-xs font-display border-r border-[#2D2D2D] last:border-r-0 transition-colors
                      ${calendarMetric === metric.key ? 'bg-[#2D2D2D] text-white' : 'bg-white hover:bg-gray-100'}`}
                  >
                    {metric.label}
                  </button>
                ))}
              </div>
            </div>
            
            <div className="grid grid-cols-7 gap-1 text-center text-sm">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                <div key={i} className="py-2 font-display text-xs text-gray-500">{d}</div>
              ))}
              {/* Build proper calendar grid */}
              {(() => {
                const year = dataDate.getFullYear()
                const month = dataDate.getMonth()
                const firstDay = new Date(year, month, 1).getDay()
                const daysInMonth = new Date(year, month + 1, 0).getDate()
                
                // Create a map of date -> data for quick lookup
                const dataMap = {}
                ;(monthlyData.daily_data || []).forEach(day => {
                  const dayNum = new Date(day.date + 'T12:00:00').getDate()
                  dataMap[dayNum] = day
                })
                
                // Barry's dates set
                const barrysSet = new Set(monthlyData.barrys_dates || [])
                
                const cells = []
                
                // Add padding for days before the 1st
                for (let i = 0; i < firstDay; i++) {
                  cells.push(<div key={`pad-${i}`} className="py-3" />)
                }
                
                // Add all days of the month
                for (let day = 1; day <= daysInMonth; day++) {
                  const dayData = dataMap[day]
                  const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
                  const hasBarrys = barrysSet.has(dateStr)
                  
                  // Get color based on selected metric
                  let bgColor = 'bg-white'
                  let textColor = 'text-gray-600'
                  let value = null
                  let tooltip = dateStr
                  
                  if (dayData) {
                    if (calendarMetric === 'recovery' && dayData.recovery_score != null) {
                      value = dayData.recovery_score
                      tooltip = `${dateStr}: ${Math.round(value)}% recovery`
                      if (value >= 67) {
                        bgColor = 'bg-[#A5D6A7]'
                      } else if (value >= 34) {
                        bgColor = 'bg-[#FFF59D]'
                      } else {
                        bgColor = 'bg-[#EF9A9A]'
                      }
                      textColor = 'text-[#2D2D2D]'
                    } else if (calendarMetric === 'strain' && dayData.day_strain != null) {
                      value = dayData.day_strain
                      tooltip = `${dateStr}: ${value.toFixed(1)} strain`
                      // Strain uses orange intensity scale
                      if (value >= 14) {
                        bgColor = 'bg-[#FF8A65]' // high strain = dark orange
                      } else if (value >= 8) {
                        bgColor = 'bg-[#FFAB91]' // moderate = medium orange
                      } else {
                        bgColor = 'bg-[#FFCCBC]' // low strain = light orange
                      }
                      textColor = 'text-[#2D2D2D]'
                    } else if (calendarMetric === 'sleep' && dayData.sleep_duration_minutes != null) {
                      value = dayData.sleep_duration_minutes / 60
                      tooltip = `${dateStr}: ${value.toFixed(1)}h sleep`
                      if (value >= 7) {
                        bgColor = 'bg-[#A5D6A7]' // good sleep = green
                      } else if (value >= 6) {
                        bgColor = 'bg-[#FFF59D]' // ok
                      } else {
                        bgColor = 'bg-[#EF9A9A]' // poor sleep = red
                      }
                      textColor = 'text-[#2D2D2D]'
                    }
                  }
                  
                  cells.push(
                    <button
                      key={day}
                      onClick={() => goToDay(dateStr)}
                      className={`relative py-3 border-2 ${hasBarrys ? 'border-[#2D2D2D] border-b-4 border-b-orange-500' : 'border-[#2D2D2D]'} ${bgColor} ${textColor} font-medium transition-all hover:shadow-[2px_2px_0px_#2D2D2D] hover:translate-x-[-1px] hover:translate-y-[-1px]`}
                      title={hasBarrys ? `${tooltip} • Barry's workout` : tooltip}
                    >
                      {day}
                      {hasBarrys && (
                        <span className="absolute -top-1 -right-1 w-3 h-3 bg-orange-500 rounded-full border border-white"></span>
                      )}
                    </button>
                  )
                }
                
                return cells
              })()}
            </div>
          </Card>
        </div>
      )}
      
      {/* Weight History Modal */}
      <Modal isOpen={showWeightModal} onClose={() => setShowWeightModal(false)} title="Weight & Body Composition" className="max-w-lg">
        {weightLoading ? (
          <div className="p-8 text-center">
            <div className="text-4xl mb-4 animate-pulse">...</div>
            <p className="mono text-gray-600">Loading weight data...</p>
          </div>
        ) : weightHistory.length === 0 ? (
          <div className="p-8 text-center">
            <div className="text-4xl mb-4">...</div>
            <p className="text-gray-600">No weight data recorded yet.</p>
            <p className="text-xs text-gray-400 mt-2">Weight syncs from your Whoop profile.</p>
          </div>
        ) : (
          <div className="p-4 space-y-4">
            {/* Current Stats */}
            <div className="grid grid-cols-2 gap-3">
              <div className="text-center p-3 border-2 border-[#2D2D2D] bg-[#E8F5E9]">
                <div className="font-display text-2xl">
                  {(weightHistory[0]?.weight * 2.205).toFixed(1)}
                </div>
                <div className="mono text-xs text-gray-600">Current (lbs)</div>
              </div>
              {weightHistory.length > 1 && (
                <div className="text-center p-3 border-2 border-[#2D2D2D] bg-[#FFF3E0]">
                  <div className={`font-display text-2xl ${
                    (weightHistory[0]?.weight - weightHistory[weightHistory.length - 1]?.weight) < 0 
                      ? 'text-green-600' : 'text-red-600'
                  }`}>
                    {((weightHistory[0]?.weight - weightHistory[weightHistory.length - 1]?.weight) * 2.205).toFixed(1)}
                  </div>
                  <div className="mono text-xs text-gray-600">Change (90d)</div>
                </div>
              )}
            </div>
            
            {/* Body Composition (if available) */}
            {weightHistory[0]?.body_fat && (
              <div className="grid grid-cols-3 gap-2">
                <div className="text-center p-2 border-2 border-[#2D2D2D] bg-[#EDE7F6]">
                  <div className="font-display text-lg">{weightHistory[0].body_fat?.toFixed(1)}%</div>
                  <div className="mono text-[10px] text-gray-600">Body Fat</div>
                </div>
                {weightHistory[0]?.muscle_mass && (
                  <div className="text-center p-2 border-2 border-[#2D2D2D] bg-[#E3F2FD]">
                    <div className="font-display text-lg">{(weightHistory[0].muscle_mass * 2.205).toFixed(1)}</div>
                    <div className="mono text-[10px] text-gray-600">Muscle (lbs)</div>
                  </div>
                )}
                {weightHistory[0]?.muscle_mass && weightHistory[0]?.body_fat && (
                  <div className="text-center p-2 border-2 border-[#2D2D2D] bg-[#FCE4EC]">
                    <div className="font-display text-lg">
                      {((weightHistory[0].weight * 2.205) - (weightHistory[0].muscle_mass * 2.205)).toFixed(1)}
                    </div>
                    <div className="mono text-[10px] text-gray-600">Fat (lbs)</div>
                  </div>
                )}
              </div>
            )}
            
            {/* Chart Metric Toggle */}
            {weightHistory.some(w => w.body_fat) && (
              <div className="flex border-2 border-[#2D2D2D]">
                <button
                  onClick={() => setWeightChartMetric('weight')}
                  className={`flex-1 py-2 text-xs font-display border-r border-[#2D2D2D] transition-colors
                    ${weightChartMetric === 'weight' ? 'bg-[#2D2D2D] text-white' : 'bg-white hover:bg-gray-100'}`}
                >
                  WEIGHT
                </button>
                <button
                  onClick={() => setWeightChartMetric('body_fat')}
                  className={`flex-1 py-2 text-xs font-display transition-colors
                    ${weightChartMetric === 'body_fat' ? 'bg-[#2D2D2D] text-white' : 'bg-white hover:bg-gray-100'}`}
                >
                  BODY FAT %
                </button>
              </div>
            )}
            
            {/* Line Chart - Neo-brutalist */}
            <div className="border-2 border-[#2D2D2D] p-3 bg-white">
              <div className="text-xs font-display mb-2">
                {weightChartMetric === 'weight' ? 'WEIGHT TREND' : 'BODY FAT TREND'}
              </div>
              {(() => {
                // Filter to only show points where the selected metric changed
                const sortedData = [...weightHistory].reverse()
                
                // Filter based on selected metric
                const dataWithMetric = weightChartMetric === 'body_fat' 
                  ? sortedData.filter(entry => entry.body_fat != null)
                  : sortedData.filter(entry => entry.weight != null)
                
                // Filter out consecutive duplicate values
                const uniquePoints = dataWithMetric.filter((entry, idx) => {
                  if (idx === 0) return true
                  const prevEntry = dataWithMetric[idx - 1]
                  if (weightChartMetric === 'body_fat') {
                    return Math.abs((entry.body_fat || 0) - (prevEntry.body_fat || 0)) > 0.1
                  }
                  return Math.abs(entry.weight - prevEntry.weight) > 0.01
                })
                
                if (uniquePoints.length < 2) {
                  return <div className="text-center text-gray-400 py-4">Not enough data points with changes</div>
                }
                
                const values = uniquePoints.map(w => weightChartMetric === 'body_fat' ? (w.body_fat || 0) : w.weight)
                // Add more padding to Y-axis for better visualization
                const minVal = Math.min(...values) - (weightChartMetric === 'body_fat' ? 1 : 2)
                const maxVal = Math.max(...values) + (weightChartMetric === 'body_fat' ? 1 : 2)
                const range = maxVal - minVal || 1
                
                const width = 420  // Wider chart to prevent smushedness
                const height = 220  // Taller chart for better visibility
                const padding = 35  // More padding for labels
                const leftPadding = 40  // More left padding for Y-axis labels
                const rightPadding = 25  // Right padding
                
                // Calculate minimum spacing between points (prevents overcrowding)
                const availableWidth = width - leftPadding - rightPadding
                const minPointSpacing = 50  // Minimum pixels between points
                const maxPoints = Math.floor(availableWidth / minPointSpacing)
                
                // If too many points, sample them to fit better
                const displayPoints = uniquePoints.length > maxPoints 
                  ? uniquePoints.filter((_, idx) => 
                      idx === 0 || idx === uniquePoints.length - 1 || 
                      idx % Math.ceil(uniquePoints.length / maxPoints) === 0
                    )
                  : uniquePoints
                
                // Create path points with better spacing
                const points = displayPoints.map((entry, idx) => {
                  const val = weightChartMetric === 'body_fat' ? (entry.body_fat || 0) : entry.weight
                  const x = leftPadding + 15 + (idx / Math.max(displayPoints.length - 1, 1)) * (width - leftPadding - rightPadding - 30)
                  const y = height - padding - ((val - minVal) / range) * (height - padding * 2)
                  return { x, y, value: val, date: entry.measured_at, weight: entry.weight, bodyFat: entry.body_fat }
                })
                
                // Create line path (straight lines for neo-brutalist)
                const pathD = points.reduce((acc, point, idx) => {
                  if (idx === 0) return `M ${point.x} ${point.y}`
                  return `${acc} L ${point.x} ${point.y}`
                }, '')
                
                const strokeColor = weightChartMetric === 'body_fat' ? '#8b5cf6' : '#3b82f6'
                const gradientId = weightChartMetric === 'body_fat' ? 'bodyFatGradient' : 'weightGradient2'
                
                return (
                  <div className="relative">
                    <svg width="100%" viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
                      {/* Grid lines - Neo-brutalist */}
                      <line x1={leftPadding} y1={padding} x2={leftPadding} y2={height - padding} stroke="#2D2D2D" strokeWidth="2" />
                      <line x1={leftPadding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="#2D2D2D" strokeWidth="2" />
                      
                      {/* Simple horizontal grid lines */}
                      {[0.25, 0.5, 0.75].map((fraction, i) => (
                        <line 
                          key={i}
                          x1={leftPadding} 
                          y1={padding + fraction * (height - padding * 2)} 
                          x2={width - padding} 
                          y2={padding + fraction * (height - padding * 2)} 
                          stroke="#e5e7eb" 
                          strokeWidth="1" 
                          strokeDasharray="4,4"
                        />
                      ))}
                      
                      {/* Area under curve */}
                      <path 
                        d={`${pathD} L ${points[points.length - 1].x} ${height - padding} L ${points[0].x} ${height - padding} Z`} 
                        fill={`url(#${gradientId})`} 
                      />
                      
                      {/* Line */}
                      <path d={pathD} fill="none" stroke={strokeColor} strokeWidth="3" strokeLinecap="square" />
                      
                      {/* Gradient definition */}
                      <defs>
                        <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
                          <stop offset="0%" stopColor={strokeColor} stopOpacity="0.3" />
                          <stop offset="100%" stopColor={strokeColor} stopOpacity="0.05" />
                        </linearGradient>
                      </defs>
                      
                      {/* Data points - Square for neo-brutalist with value labels */}
                      {points.map((point, idx) => {
                        // Smart label positioning algorithm
                        const prevPoint = points[idx - 1]
                        const nextPoint = points[idx + 1]
                        
                        // Check if this point is a local maximum or minimum
                        const isPeak = (!prevPoint || point.y < prevPoint.y) && (!nextPoint || point.y < nextPoint.y)
                        const isTrough = (!prevPoint || point.y > prevPoint.y) && (!nextPoint || point.y > nextPoint.y)
                        
                        // Check horizontal proximity to neighbors
                        const closeToLeft = prevPoint && (point.x - prevPoint.x) < 60
                        const closeToRight = nextPoint && (nextPoint.x - point.x) < 60
                        
                        // Determine label position
                        let labelY
                        if (isPeak) {
                          // Peaks: label above
                          labelY = point.y - 14
                        } else if (isTrough) {
                          // Troughs: label below
                          labelY = point.y + 24
                        } else if (idx % 2 === 0) {
                          // Even indices: above
                          labelY = point.y - 14
                        } else {
                          // Odd indices: below
                          labelY = point.y + 24
                        }
                        
                        // Ensure label stays within bounds
                        labelY = Math.max(14, Math.min(height - 10, labelY))
                        
                        return (
                          <g key={idx}>
                            <rect
                              x={point.x - 5}
                              y={point.y - 5}
                              width="10"
                              height="10"
                              fill="white"
                              stroke={strokeColor}
                              strokeWidth="2"
                              className="cursor-pointer"
                            />
                            {/* Show value label with smart positioning */}
                            <text
                              x={point.x}
                              y={labelY}
                              textAnchor="middle"
                              fontSize="10"
                              fontWeight="bold"
                              fill="#2D2D2D"
                            >
                              {weightChartMetric === 'body_fat' 
                                ? `${point.bodyFat?.toFixed(1)}%` 
                                : (point.weight * 2.205).toFixed(1)}
                            </text>
                            <title>{`${formatWeightDate(point.date)}: ${
                              weightChartMetric === 'body_fat' 
                                ? `${point.bodyFat?.toFixed(1)}%` 
                                : `${(point.weight * 2.205).toFixed(1)} lbs`
                            }`}</title>
                          </g>
                        )
                      })}
                      
                      {/* Y-axis min/max labels */}
                      <text x={leftPadding - 5} y={padding + 4} textAnchor="end" fontSize="10" fill="#666">
                        {weightChartMetric === 'body_fat' ? `${maxVal.toFixed(0)}%` : (maxVal * 2.205).toFixed(0)}
                      </text>
                      <text x={leftPadding - 5} y={height - padding + 4} textAnchor="end" fontSize="10" fill="#666">
                        {weightChartMetric === 'body_fat' ? `${minVal.toFixed(0)}%` : (minVal * 2.205).toFixed(0)}
                      </text>
                    </svg>
                  </div>
                )
              })()}
              <div className="flex justify-between text-[10px] text-gray-500 font-bold mt-1 border-t border-gray-200 pt-1">
                <span>{formatWeightDate(weightHistory[weightHistory.length - 1]?.measured_at)}</span>
                <span>{formatWeightDate(weightHistory[0]?.measured_at)}</span>
              </div>
            </div>
            
            {/* Recent Entries - Only show entries where value changed */}
            <div className="border-2 border-[#2D2D2D] bg-white">
              <div className="px-3 py-2 border-b-2 border-[#2D2D2D] bg-gray-50">
                <span className="text-xs font-display">RECENT CHANGES</span>
              </div>
              <div className="max-h-40 overflow-y-auto">
                {(() => {
                  // Filter to only show entries where weight actually changed
                  const uniqueEntries = weightHistory.filter((entry, idx) => {
                    if (idx === 0) return true
                    const prevEntry = weightHistory[idx - 1]
                    return Math.abs(entry.weight - prevEntry.weight) > 0.01 ||
                           (entry.body_fat && prevEntry.body_fat && Math.abs(entry.body_fat - prevEntry.body_fat) > 0.1)
                  })
                  
                  return uniqueEntries.slice(0, 10).map((entry, idx) => (
                    <div key={idx} className="flex items-center justify-between px-3 py-2 border-b border-gray-200 last:border-b-0">
                      <span className="text-sm text-gray-600 font-medium">{formatWeightDate(entry.measured_at)}</span>
                      <div className="text-right">
                        <span className="font-bold">{(entry.weight * 2.205).toFixed(1)} lbs</span>
                        {entry.body_fat && (
                          <span className="text-xs text-gray-500 ml-2">{entry.body_fat.toFixed(1)}% bf</span>
                        )}
                      </div>
                    </div>
                  ))
                })()}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
