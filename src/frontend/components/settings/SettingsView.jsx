import { useState, useEffect, useCallback } from 'react'
import { useApp } from '../../context/AppContext'
import Card from '../shared/Card'
import Button from '../shared/Button'

export default function SettingsView() {
  const { 
    integrations, 
    syncingWhoop, 
    syncStatus,
    syncWhoopQuick,
    backfillStatus,
    backfillLoading,
    setBackfillLoading,
    api,
    setErrorMessage,
    setSuccessMessage,
  } = useApp()
  
  // Separate loading state for full sync
  const [syncingFull, setSyncingFull] = useState(false)
  
  // Data health state
  const [gapInfo, setGapInfo] = useState(null)
  const [gapLoading, setGapLoading] = useState(false)
  const [fillingGaps, setFillingGaps] = useState(false)
  
  // Full sync
  const syncWhoopFull = async () => {
    try {
      setSyncingFull(true)
      await api('/api/whoop/sync/full', { method: 'POST' })
      setSuccessMessage('Full sync complete!')
    } catch (error) {
      setErrorMessage('Full sync failed')
    } finally {
      setSyncingFull(false)
    }
  }
  
  // Start backfill
  const startBackfill = async () => {
    try {
      setBackfillLoading(true)
      await api('/api/whoop/backfill/start', { 
        method: 'POST',
        body: JSON.stringify({ days: 180 })
      })
      setSuccessMessage('Backfill started!')
    } catch (error) {
      setErrorMessage('Failed to start backfill')
    } finally {
      setBackfillLoading(false)
    }
  }
  
  // Check for data gaps
  const checkGaps = useCallback(async () => {
    if (!integrations.whoop) return
    
    try {
      setGapLoading(true)
      const response = await api('/api/whoop/gaps?days=180')
      if (response.ok !== false) {
        setGapInfo(response)
      }
    } catch (error) {
      console.error('Failed to check gaps:', error)
    } finally {
      setGapLoading(false)
    }
  }, [api, integrations.whoop])
  
  // Fill gaps
  const fillGaps = async () => {
    try {
      setFillingGaps(true)
      const response = await api('/api/whoop/fill-gaps', {
        method: 'POST',
        body: JSON.stringify({ daysBack: 180, maxDates: 30 })
      })
      
      if (response.rateLimited) {
        setErrorMessage(`Rate limited - retry in ${Math.ceil(response.retryAfter / 3600)} hours`)
        return
      }
      
      if (response.needsReconnect) {
        setErrorMessage('Whoop needs to be reconnected')
        return
      }
      
      setSuccessMessage(`Filled ${response.filledDates?.length || 0} missing dates!`)
      
      // Refresh gap info
      await checkGaps()
    } catch (error) {
      setErrorMessage('Failed to fill gaps')
    } finally {
      setFillingGaps(false)
    }
  }
  
  // Check gaps when Whoop is connected
  useEffect(() => {
    if (integrations.whoop) {
      checkGaps()
    }
  }, [integrations.whoop, checkGaps])
  
  return (
    <div className="space-y-5">
      <h2 className="font-display text-2xl">SETTINGS</h2>
      
      {/* Whoop Integration */}
      <Card className="p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-black rounded-full flex items-center justify-center text-white text-xl">
              W
            </div>
            <div>
              <h3 className="font-display">WHOOP</h3>
              <p className={`text-xs ${integrations.whoop ? 'text-green-600' : 'text-gray-400'}`}>
                {integrations.whoop ? 'Connected' : 'Not connected'}
              </p>
            </div>
          </div>
          
          {integrations.whoop ? (
            <a 
              href="/api/whoop/auth?user_id=demo"
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Reconnect
            </a>
          ) : (
            <a 
              href="/api/whoop/auth?user_id=demo"
              className="btn btn-dark px-4 py-2 text-sm"
            >
              Connect
            </a>
          )}
        </div>
        
        {integrations.whoop && (
          <div className="space-y-3 pt-4 border-t border-gray-200">
            <p className="text-sm text-gray-600">
              Sync your Whoop data to get recovery, strain, and sleep metrics.
            </p>
            
            <div className="flex gap-2">
              <Button
                variant="default"
                onClick={syncWhoopQuick}
                disabled={syncingWhoop || syncingFull}
                className="flex-1 py-2 text-sm"
              >
                {syncingWhoop ? 'Syncing...' : 'Quick Sync (7 days)'}
              </Button>
              <Button
                variant="sky"
                onClick={syncWhoopFull}
                disabled={syncingWhoop || syncingFull}
                className="flex-1 py-2 text-sm"
              >
                {syncingFull ? 'Syncing...' : 'Full Sync (30 days)'}
              </Button>
            </div>
            
            {(syncStatus || syncingWhoop || syncingFull) && (
              <p className="text-xs text-center text-gray-500">
                {syncStatus || (syncingWhoop ? 'Syncing 7 days...' : 'Syncing 30 days...')}
              </p>
            )}
            
            {/* Backfill Section */}
            <div className="pt-3 border-t border-gray-200">
              <p className="text-sm font-medium mb-2">Historical Data</p>
              <Button
                variant="lavender"
                onClick={startBackfill}
                disabled={backfillLoading}
                className="w-full py-2 text-sm"
              >
                {backfillLoading ? 'Starting...' : 'Backfill 180 Days'}
              </Button>
              
              {backfillStatus && (
                <div className="mt-2 text-xs text-gray-500">
                  <p>Progress: {backfillStatus.daysProcessed} / {backfillStatus.targetDays} days</p>
                </div>
              )}
            </div>
            
            {/* Data Health Section */}
            <div className="pt-3 border-t border-gray-200">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium">Data Health</p>
                <button
                  onClick={checkGaps}
                  disabled={gapLoading}
                  className="text-xs text-gray-500 hover:text-gray-700"
                >
                  {gapLoading ? 'Checking...' : 'Refresh'}
                </button>
              </div>
              
              {gapInfo && (
                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Coverage (180 days)</span>
                    <span className={gapInfo.summary?.coveragePercent >= 90 ? 'text-green-600' : 'text-orange-500'}>
                      {gapInfo.summary?.coveragePercent || 0}%
                    </span>
                  </div>
                  
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Days with data</span>
                    <span>{gapInfo.existingDays || 0} / {gapInfo.totalDays || 0}</span>
                  </div>
                  
                  {gapInfo.hasGaps && gapInfo.missingDates?.length > 0 && (
                    <>
                      <div className="flex justify-between text-xs">
                        <span className="text-gray-500">Missing dates</span>
                        <span className="text-orange-500">{gapInfo.missingDates.length}</span>
                      </div>
                      
                      {/* Show gap months */}
                      {gapInfo.gapsByMonth && Object.keys(gapInfo.gapsByMonth).length > 0 && (
                        <div className="text-xs text-gray-400 mt-1">
                          Gaps in: {Object.entries(gapInfo.gapsByMonth)
                            .filter(([, dates]) => dates.length > 5)
                            .map(([month, dates]) => `${month} (${dates.length})`)
                            .join(', ')}
                        </div>
                      )}
                      
                      <Button
                        variant="mint"
                        onClick={fillGaps}
                        disabled={fillingGaps || gapLoading}
                        className="w-full py-2 text-sm mt-2"
                      >
                        {fillingGaps ? 'Filling gaps...' : `Fill ${Math.min(30, gapInfo.missingDates.length)} Missing Dates`}
                      </Button>
                    </>
                  )}
                  
                  {!gapInfo.hasGaps && (
                    <p className="text-xs text-green-600 text-center py-2">
                      No gaps detected - data is complete!
                    </p>
                  )}
                </div>
              )}
              
              {!gapInfo && !gapLoading && (
                <p className="text-xs text-gray-400 text-center py-2">
                  Click refresh to check data health
                </p>
              )}
            </div>
          </div>
        )}
      </Card>
      
      {/* Goals Section (Placeholder) */}
      <Card className="p-5">
        <h3 className="font-display mb-4">DAILY GOALS</h3>
        <div className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-600">Calories</span>
            <span className="font-medium">1,800</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Protein</span>
            <span className="font-medium">135g</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Carbs</span>
            <span className="font-medium">180g</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Fat</span>
            <span className="font-medium">60g</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Water</span>
            <span className="font-medium">3 bottles</span>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-4">
          Goals are dynamically adjusted based on your activity and recovery.
        </p>
      </Card>
      
      {/* About Section */}
      <Card className="p-5">
        <h3 className="font-display mb-4">ABOUT</h3>
        <div className="space-y-2 text-sm text-gray-600">
          <p><span className="font-medium">Version:</span> 1.0.0</p>
          <p><span className="font-medium">Built with:</span> React + Cloudflare Workers</p>
          <p><span className="font-medium">AI:</span> GPT-4o powered nutrition analysis</p>
        </div>
      </Card>
    </div>
  )
}
