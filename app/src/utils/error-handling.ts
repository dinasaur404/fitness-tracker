/// <reference types="@cloudflare/workers-types" />

/**
 * Error Handling Utilities
 * 
 * Provides safe wrappers for common operations that can fail:
 * - JSON parsing
 * - Fetch with timeout
 * - Promise.allSettled with defaults
 */

/**
 * Safely parse JSON with a default value on failure
 */
export function safeJsonParse<T>(value: unknown, defaultValue: T): T {
  if (!value || typeof value !== 'string') return defaultValue;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.warn('Invalid JSON in safeJsonParse:', typeof value === 'string' ? value.substring(0, 100) : typeof value);
    return defaultValue;
  }
}

/**
 * Fetch with timeout - prevents hung requests
 * 
 * @param url - URL to fetch
 * @param options - Fetch options + optional timeout in ms (default 30000)
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeout?: number } = {}
): Promise<Response> {
  const { timeout = 30000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeout}ms: ${url}`);
    }
    throw error;
  }
}

/**
 * Fetch with timeout using Request object
 */
export async function fetchRequestWithTimeout(
  request: Request,
  timeout: number = 30000
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  // Clone request and add abort signal
  const requestWithSignal = new Request(request, {
    signal: controller.signal
  });

  try {
    const response = await fetch(requestWithSignal);
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeout}ms: ${request.url}`);
    }
    throw error;
  }
}

/**
 * Execute Promise.allSettled and return values with defaults for failures
 * 
 * @param promises - Array of promises to execute
 * @param defaults - Default values for each promise if it fails
 * @param logPrefix - Optional prefix for error logs
 */
export async function promiseAllWithDefaults<T extends readonly unknown[]>(
  promises: { [K in keyof T]: Promise<T[K]> },
  defaults: { [K in keyof T]: T[K] },
  logPrefix: string = 'Query'
): Promise<T> {
  const results = await Promise.allSettled(promises);
  
  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    console.error(`${logPrefix} ${index} failed:`, result.reason);
    return defaults[index];
  }) as unknown as T;
}

/**
 * Wrap an async function with try/catch and return default on error
 */
export async function withDefault<T>(
  fn: () => Promise<T>,
  defaultValue: T,
  errorContext?: string
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    console.error(errorContext || 'Operation failed:', error);
    return defaultValue;
  }
}

/**
 * Create a simple hash from a string (for cache keys)
 */
export function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Normalize a food description for consistent cache keys
 */
export function normalizeFoodDescription(description: string): string {
  return description
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')        // Normalize whitespace
    .replace(/[^\w\s]/g, '');    // Remove punctuation
}

/**
 * Get current ISO timestamp in user's timezone
 * Falls back to UTC if timezone is invalid
 */
export function getNowInTimezone(timezone?: string): string {
  try {
    if (!timezone) {
      return new Date().toISOString();
    }
    
    // Get current time formatted in the user's timezone
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    
    const parts = formatter.formatToParts(now);
    const get = (type: string) => parts.find(p => p.type === type)?.value || '00';
    
    // Build ISO-like string: YYYY-MM-DDTHH:MM:SS
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
  } catch (error) {
    console.warn('Invalid timezone, falling back to UTC:', timezone);
    return new Date().toISOString();
  }
}

/**
 * Get today's date in user's timezone as YYYY-MM-DD
 */
export function getTodayInTimezone(timezone?: string): string {
  try {
    if (!timezone) {
      return new Date().toISOString().split('T')[0];
    }
    
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    
    return formatter.format(now); // Returns YYYY-MM-DD
  } catch (error) {
    console.warn('Invalid timezone, falling back to UTC:', timezone);
    return new Date().toISOString().split('T')[0];
  }
}
