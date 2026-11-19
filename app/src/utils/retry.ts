/**
 * Retry utility for Durable Object and other async operations
 * Based on Cloudflare best practices for error handling
 */

interface RetryOptions {
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  shouldRetry?: (error: unknown) => boolean;
}

const defaultOptions: Required<RetryOptions> = {
  maxAttempts: 3,
  baseBackoffMs: 100,
  maxBackoffMs: 5000,
  shouldRetry: (error: unknown) => {
    // Check for retryable property (Durable Objects set this)
    if (error && typeof error === 'object' && 'retryable' in error) {
      return (error as { retryable: boolean }).retryable === true;
    }
    // Don't retry overload errors
    if (error && typeof error === 'object' && 'overloaded' in error) {
      return false;
    }
    // Retry network errors
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return message.includes('network') || 
             message.includes('timeout') ||
             message.includes('connection');
    }
    return false;
  }
};

/**
 * Execute a function with exponential backoff retry
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...defaultOptions, ...options };
  let lastError: unknown;
  
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (!opts.shouldRetry(error) || attempt >= opts.maxAttempts - 1) {
        throw error;
      }
      
      // Exponential backoff with jitter
      const backoffMs = Math.min(
        opts.maxBackoffMs,
        opts.baseBackoffMs * Math.random() * Math.pow(2, attempt)
      );
      
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
  
  throw lastError;
}

/**
 * Helper to get a Durable Object stub with retry logic
 * Creates a new stub on each attempt to avoid broken stub issues
 */
export async function withDORetry<T>(
  namespace: DurableObjectNamespace,
  name: string,
  fn: (stub: DurableObjectStub) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  return withRetry(async () => {
    const id = namespace.idFromName(name);
    const stub = namespace.get(id);
    return fn(stub);
  }, options);
}

/**
 * Safely fetch from a Durable Object with retry
 */
export async function fetchDOWithRetry(
  namespace: DurableObjectNamespace,
  name: string,
  request: Request | string,
  options: RetryOptions = {}
): Promise<Response> {
  return withDORetry(
    namespace,
    name,
    async (stub) => {
      const req = typeof request === 'string' 
        ? new Request(request) 
        : request;
      return stub.fetch(req);
    },
    options
  );
}
