import type { AppInfo } from './api'

export interface LogEvent {
  app: string
  proc: string
  line: string
}

type Listener = (e: LogEvent) => void

const listeners = new Set<Listener>()

export const logBus = {
  emit(e: LogEvent) {
    listeners.forEach((fn) => fn(e))
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}

// Latest app state, shared with log panels (they live outside the React tree that owns state)
type StateListener = (apps: AppInfo[]) => void
const stateListeners = new Set<StateListener>()
let latestApps: AppInfo[] = []

export const stateBus = {
  emit(apps: AppInfo[]) {
    latestApps = apps
    stateListeners.forEach((fn) => fn(apps))
  },
  get(): AppInfo[] {
    return latestApps
  },
  subscribe(fn: StateListener): () => void {
    stateListeners.add(fn)
    return () => stateListeners.delete(fn)
  },
}

// Fired when a new alarm arrives over SSE (bell refetches)
type VoidListener = () => void
const alarmListeners = new Set<VoidListener>()
export const alarmsBus = {
  emit() {
    alarmListeners.forEach((fn) => fn())
  },
  subscribe(fn: VoidListener): () => void {
    alarmListeners.add(fn)
    return () => alarmListeners.delete(fn)
  },
}

// "Jump to this timestamped line" requests for log panels
export interface LogAnchor {
  app: string
  proc: string
  ts: string
}
type AnchorListener = (a: LogAnchor) => void
const anchorListeners = new Set<AnchorListener>()
let pendingAnchor: LogAnchor | null = null
export const anchorBus = {
  emit(a: LogAnchor) {
    pendingAnchor = a
    anchorListeners.forEach((fn) => fn(a))
  },
  consumePending(app: string, proc: string): LogAnchor | null {
    if (pendingAnchor && pendingAnchor.app === app && pendingAnchor.proc === proc) {
      const a = pendingAnchor
      pendingAnchor = null
      return a
    }
    return null
  },
  subscribe(fn: AnchorListener): () => void {
    anchorListeners.add(fn)
    return () => anchorListeners.delete(fn)
  },
}
