import { useEffect, useRef, useState } from "react"
import type { ServerEvent } from "./api.ts"

type Listener = (ev: ServerEvent) => void

/** Một kết nối SSE dùng chung cho cả app; mỗi trang đăng ký listener. */
class EventHub {
  private listeners = new Set<Listener>()
  private source?: EventSource
  state: "connecting" | "open" | "closed" = "connecting"
  private stateListeners = new Set<(s: EventHub["state"]) => void>()

  start() {
    if (this.source) return
    const es = new EventSource("/api/events")
    this.source = es
    es.onopen = () => this.setState("open")
    es.onerror = () => this.setState(es.readyState === EventSource.CLOSED ? "closed" : "connecting")
    es.onmessage = (m) => {
      let ev: ServerEvent
      try {
        ev = JSON.parse(m.data)
      } catch {
        return
      }
      for (const l of this.listeners) l(ev)
    }
  }

  private setState(s: EventHub["state"]) {
    this.state = s
    for (const l of this.stateListeners) l(s)
  }

  on(l: Listener) {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }

  onState(l: (s: EventHub["state"]) => void) {
    this.stateListeners.add(l)
    return () => {
      this.stateListeners.delete(l)
    }
  }
}

export const hub = new EventHub()

export function useServerEvents(handler: Listener) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    hub.start()
    return hub.on((ev) => ref.current(ev))
  }, [])
}

export function useConnectionState() {
  const [state, setState] = useState(hub.state)
  useEffect(() => {
    hub.start()
    return hub.onState(setState)
  }, [])
  return state
}
