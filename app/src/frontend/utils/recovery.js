/**
 * Get recovery color class based on score
 */
export function getRecoveryColor(score) {
  if (score >= 67) return 'text-green-600'
  if (score >= 34) return 'text-yellow-600'
  return 'text-red-600'
}

/**
 * Get recovery card background class
 */
export function getRecoveryCardClass(score) {
  if (score >= 67) return 'bg-green-50'
  if (score >= 34) return 'bg-yellow-50'
  return 'bg-red-50'
}

/**
 * Get recovery badge class
 */
export function getRecoveryBadgeClass(score) {
  if (score >= 67) return 'bg-green-100 text-green-800'
  if (score >= 34) return 'bg-yellow-100 text-yellow-800'
  return 'bg-red-100 text-red-800'
}

/**
 * Get recovery bar color class
 */
export function getRecoveryBarClass(score) {
  if (score >= 67) return 'bg-green-500'
  if (score >= 34) return 'bg-yellow-500'
  return 'bg-red-500'
}

/**
 * Get recovery label
 */
export function getRecoveryLabel(score) {
  if (score >= 67) return 'Green'
  if (score >= 34) return 'Yellow'
  return 'Red'
}

/**
 * Get strain status text
 */
export function getStrainStatus(strain, recovery) {
  const optimal = getOptimalStrainRange(recovery)
  if (!strain) return 'No strain data'
  if (strain < optimal.min) return 'Below optimal'
  if (strain > optimal.max) return 'Above optimal'
  return 'In optimal zone'
}

/**
 * Get strain status color
 */
export function getStrainStatusColor(strain, recovery) {
  const optimal = getOptimalStrainRange(recovery)
  if (!strain) return 'text-gray-500'
  if (strain < optimal.min) return 'text-blue-600'
  if (strain > optimal.max) return 'text-red-600'
  return 'text-green-600'
}

/**
 * Get optimal strain range based on recovery
 */
export function getOptimalStrainRange(recovery) {
  if (!recovery) return { min: 10, max: 14 }
  if (recovery >= 67) return { min: 14, max: 18 }
  if (recovery >= 34) return { min: 10, max: 14 }
  return { min: 5, max: 10 }
}

/**
 * Get strain zone width percentage for visualization
 */
export function getStrainZoneWidth(zone, recovery) {
  const optimal = getOptimalStrainRange(recovery)
  const maxStrain = 21
  
  switch (zone) {
    case 'low':
      return (optimal.min / maxStrain) * 100
    case 'optimal':
      return ((optimal.max - optimal.min) / maxStrain) * 100
    case 'high':
      return ((maxStrain - optimal.max) / maxStrain) * 100
    default:
      return 0
  }
}

/**
 * Get trend arrow based on change
 */
export function getTrendArrow(current, previous) {
  if (!previous) return '→'
  if (current > previous) return '↑'
  if (current < previous) return '↓'
  return '→'
}

/**
 * Get trend color class
 */
export function getTrendClass(current, previous, metric = 'recovery') {
  if (!previous) return 'text-gray-500'
  
  const increased = current > previous
  
  // For recovery and HRV, higher is better
  // For resting HR, lower is better
  if (metric === 'rhr') {
    return increased ? 'text-red-500' : 'text-green-500'
  }
  
  return increased ? 'text-green-500' : 'text-red-500'
}

/**
 * Get recovery insight text
 */
export function getRecoveryInsight(score, trend) {
  if (!score) return 'No recovery data available'
  
  const label = getRecoveryLabel(score)
  const trendText = trend > 0 ? 'improving' : trend < 0 ? 'declining' : 'stable'
  
  if (score >= 67) {
    return `Great recovery! You're in the green zone and ${trendText}. Today is a good day to push hard.`
  }
  if (score >= 34) {
    return `Moderate recovery. Your body is ${trendText}. Consider a moderate workout today.`
  }
  return `Low recovery. Your body needs rest and is ${trendText}. Focus on recovery activities.`
}

/**
 * Get strain insight text
 */
export function getStrainInsight(strain, recovery) {
  if (!strain) return 'No strain data available'
  
  const optimal = getOptimalStrainRange(recovery)
  
  if (strain < optimal.min) {
    return `Your strain is below the optimal zone. You have room to push harder today.`
  }
  if (strain > optimal.max) {
    return `You've exceeded your optimal strain. Consider taking it easy for the rest of the day.`
  }
  return `You're in the optimal strain zone for your recovery level. Great job managing your effort!`
}

/**
 * Get sleep insight text
 */
export function getSleepInsight(hours, performance) {
  if (!hours) return 'No sleep data available'
  
  if (hours >= 8 && performance >= 85) {
    return `Excellent sleep! ${hours.toFixed(1)} hours with ${performance}% performance sets you up for success.`
  }
  if (hours >= 7) {
    return `Solid sleep at ${hours.toFixed(1)} hours. Aim for 8+ hours for optimal recovery.`
  }
  if (hours >= 6) {
    return `Sleep was a bit short at ${hours.toFixed(1)} hours. Try to get more rest tonight.`
  }
  return `Poor sleep at only ${hours.toFixed(1)} hours. Prioritize rest today and aim for earlier bedtime.`
}
