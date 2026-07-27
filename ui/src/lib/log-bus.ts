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
