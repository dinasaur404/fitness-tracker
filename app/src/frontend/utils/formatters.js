/**
 * Format a date as "Monday, Jan 6"
 */
export function formatDate(date) {
  if (!date) return ''
  const d = new Date(date)
  return d.toLocaleDateString('en-US', { 
    weekday: 'long', 
    month: 'short', 
    day: 'numeric' 
  })
}

/**
 * Format a date as "YYYY-MM-DD" in local timezone
 */
export function formatLocalDate(date) {
  if (!date) return ''
  const d = new Date(date)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Format time as "3:45 PM"
 */
export function formatChatTime(timestamp) {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  return date.toLocaleTimeString('en-US', { 
    hour: 'numeric', 
    minute: '2-digit' 
  })
}

/**
 * Format sleep duration from minutes to "7h 30m"
 */
export function formatSleepDuration(minutes) {
  if (!minutes) return '0h'
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (mins === 0) return `${hours}h`
  return `${hours}h ${mins}m`
}

/**
 * Format sync date from "YYYY-MM-DD" to "Oct 8"
 */
export function formatSyncDate(dateStr) {
  if (!dateStr) return ''
  const date = new Date(dateStr + 'T12:00:00')
  return date.toLocaleDateString('en-US', { 
    month: 'short', 
    day: 'numeric' 
  })
}

/**
 * Format trend day from date string to first letter of weekday
 */
export function formatTrendDay(dateStr) {
  if (!dateStr) return ''
  const date = new Date(dateStr + 'T12:00:00')
  return date.toLocaleDateString('en-US', { weekday: 'narrow' })
}

/**
 * Format weekday from date string
 */
export function formatWeekDay(dateStr) {
  if (!dateStr) return ''
  const date = new Date(dateStr + 'T12:00:00')
  return date.toLocaleDateString('en-US', { weekday: 'long' })
}

/**
 * Get month name from date
 */
export function getMonthName(date) {
  if (!date) return ''
  const d = new Date(date)
  return d.toLocaleDateString('en-US', { 
    month: 'long', 
    year: 'numeric' 
  })
}

/**
 * Get day of week with date
 */
export function getDayOfWeek() {
  const now = new Date()
  return now.toLocaleDateString('en-US', { 
    weekday: 'long', 
    month: 'short', 
    day: 'numeric' 
  })
}

/**
 * Get motivational day message based on day of week
 */
export function getDayMessage() {
  const day = new Date().getDay()
  const messages = {
    0: "SUNDAY FUNDAY",
    1: "MONDAY MOTIVATION",
    2: "TRANSFORMATION TUESDAY",
    3: "WORKOUT WEDNESDAY",
    4: "THANKFUL THURSDAY",
    5: "FINISH STRONG FRIDAY",
    6: "STRONG SATURDAY"
  }
  return messages[day] || "LET'S GO"
}

/**
 * Format a number with commas
 */
export function formatNumber(num) {
  if (num === null || num === undefined) return '0'
  return num.toLocaleString()
}

/**
 * Format percentage
 */
export function formatPercentage(value, total) {
  if (!total) return 0
  return Math.round((value / total) * 100)
}
