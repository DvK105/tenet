/**
 * Retry utility for API calls with exponential backoff
 */

export interface RetryOptions {
  maxAttempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
  backoffMultiplier?: number
  retryable?: (error: unknown) => boolean
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "retryable">> = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
}

/**
 * Retry a function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  let lastError: unknown
  let delay = opts.initialDelayMs

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error

      // Check if error is retryable
      if (opts.retryable && !opts.retryable(error)) {
        throw error
      }

      // Don't retry on last attempt
      if (attempt === opts.maxAttempts) {
        break
      }

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay))

      // Calculate next delay with exponential backoff
      delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelayMs)
    }
  }

  throw lastError
}

/**
 * Retry a fetch request with exponential backoff
 */
export async function retryFetch(
  url: string,
  options: RequestInit = {},
  retryOptions: RetryOptions = {}
): Promise<Response> {
  return retry(
    async () => {
      const response = await fetch(url, options)
      // Retry on 5xx errors and network errors
      if (!response.ok && response.status >= 500) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      return response
    },
    {
      ...retryOptions,
      retryable: (error) => {
        // Retry on network errors or 5xx errors
        if (error instanceof TypeError && error.message.includes("fetch")) {
          return true
        }
        if (error instanceof Error && error.message.includes("HTTP 5")) {
          return true
        }
        return retryOptions.retryable ? retryOptions.retryable(error) : true
      },
    }
  )
}
