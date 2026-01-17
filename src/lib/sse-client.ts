/**
 * SSE Client utilities for real-time render progress updates
 */

export type SSEEvent = {
  type: "progress" | "completed" | "error"
  renderId: string
  data: {
    status?: "rendering" | "completed" | "error"
    progress?: number
    etaSeconds?: number
    videoUrl?: string
    errorMessage?: string
  }
}

export class SSEClient {
  private eventSource: EventSource | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 1000
  private listeners: Map<string, Set<(event: SSEEvent) => void>> = new Map()
  private isConnecting = false

  constructor(private url: string) {}

  /**
   * Connect to SSE endpoint
   */
  connect(renderIds: string[]): void {
    if (this.isConnecting || this.eventSource?.readyState === EventSource.OPEN) {
      return
    }

    this.isConnecting = true
    this.reconnectAttempts = 0

    try {
      const params = new URLSearchParams()
      renderIds.forEach((id) => params.append("renderId", id))
      const fullUrl = `${this.url}?${params.toString()}`

      this.eventSource = new EventSource(fullUrl)

      this.eventSource.onopen = () => {
        this.isConnecting = false
        this.reconnectAttempts = 0
        console.log("SSE connection opened")
      }

      this.eventSource.onerror = (error) => {
        console.error("SSE connection error:", error)
        this.isConnecting = false
        this.handleReconnect(renderIds)
      }

      this.eventSource.onmessage = (event) => {
        try {
          const sseEvent: SSEEvent = JSON.parse(event.data)
          this.notifyListeners(sseEvent)
        } catch (error) {
          console.error("Failed to parse SSE event:", error)
        }
      }
    } catch (error) {
      console.error("Failed to create SSE connection:", error)
      this.isConnecting = false
      this.handleReconnect(renderIds)
    }
  }

  /**
   * Subscribe to events for a specific render ID
   */
  subscribe(renderId: string, callback: (event: SSEEvent) => void): () => void {
    if (!this.listeners.has(renderId)) {
      this.listeners.set(renderId, new Set())
    }
    this.listeners.get(renderId)!.add(callback)

    // Return unsubscribe function
    return () => {
      const callbacks = this.listeners.get(renderId)
      if (callbacks) {
        callbacks.delete(callback)
        if (callbacks.size === 0) {
          this.listeners.delete(renderId)
        }
      }
    }
  }

  /**
   * Update render IDs to monitor
   */
  updateRenderIds(renderIds: string[]): void {
    if (this.eventSource?.readyState === EventSource.OPEN) {
      // Close existing connection and reconnect with new IDs
      this.disconnect()
      this.connect(renderIds)
    } else if (renderIds.length > 0) {
      this.connect(renderIds)
    }
  }

  /**
   * Disconnect from SSE endpoint
   */
  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close()
      this.eventSource = null
    }
    this.isConnecting = false
    this.listeners.clear()
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.eventSource?.readyState === EventSource.OPEN
  }

  private notifyListeners(event: SSEEvent): void {
    const callbacks = this.listeners.get(event.renderId)
    if (callbacks) {
      callbacks.forEach((callback) => {
        try {
          callback(event)
        } catch (error) {
          console.error("Error in SSE callback:", error)
        }
      })
    }
  }

  private handleReconnect(renderIds: string[]): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("Max reconnect attempts reached, giving up")
      return
    }

    this.reconnectAttempts++
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1) // Exponential backoff

    setTimeout(() => {
      if (renderIds.length > 0) {
        this.connect(renderIds)
      }
    }, delay)
  }
}
