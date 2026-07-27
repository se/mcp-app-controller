export interface ProcMetrics {
  cpu: number
  memMb: number
  at: number
}

export interface ProcInfo {
  name: string
  command: string
  devCommand: string | null
  cwd: string | null
  env: Record<string, string>
  autoRestart: boolean
  healthUrl: string | null
  healthPort: number | null
  ownLogTimestamps: boolean
  ports: number[]
  dependsOn: string[]
  health: 'healthy' | 'unhealthy' | 'unknown' | null
  metrics: ProcMetrics | null
  status: 'running' | 'stopped' | 'crashed'
  pid?: number
  mode?: 'start' | 'dev'
  startedAt?: number
  lastExit?: { code: number | null; signal: string | null; at: number; summary?: string }
}

export interface Lease {
  app: string
  session: string
  reason: string
  acquired_at: number
  expires_at: number
}

export interface AppInfo {
  name: string
  description: string
  cwd: string
  lease: Lease | null
  processes: ProcInfo[]
}

export interface AuditEntry {
  id: number
  ts: number
  session: string
  source: 'mcp' | 'ui' | 'system'
  action: string
  app: string
  proc?: string | null
  detail?: string | null
  result: string
}

export interface AppDefInput {
  name: string
  description: string
  cwd: string
  processes: {
    name: string
    command: string
    devCommand?: string
    cwd?: string
    env: Record<string, string>
    autoRestart: boolean
    healthUrl?: string
    healthPort?: number
    ownLogTimestamps?: boolean
    ports?: number[]
    dependsOn?: string[]
  }[]
}

export async function api<T = unknown>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string })
    throw new Error((body as { error?: string }).error || res.statusText)
  }
  return res.json() as Promise<T>
}

export const getState = () => api<{ apps: AppInfo[]; profiles: Record<string, string[]> }>('/state')

export const profileAction = (name: string, action: 'start' | 'stop') =>
  api(`/profiles/${encodeURIComponent(name)}/${action}`, { method: 'POST', body: '{}' })
export const getAudit = (limit = 60) => api<AuditEntry[]>(`/audit?limit=${limit}`)
export const getMetricsHistory = (app: string, proc: string) =>
  api<ProcMetrics[]>(`/apps/${encodeURIComponent(app)}/metrics/${encodeURIComponent(proc)}`)

export const getLogs = (app: string, proc: string, lines = 300) =>
  api<{ logs: string }>(`/apps/${encodeURIComponent(app)}/logs/${encodeURIComponent(proc)}?lines=${lines}`)

export interface ActionResult {
  proc: string
  error?: string
  superseded?: string
}

export const appAction = (
  app: string,
  action: 'start' | 'stop' | 'restart',
  body: { process?: string; mode?: 'start' | 'dev'; reason?: string; takeover?: boolean }
) =>
  api<ActionResult[] | { blocked: true }>(`/apps/${encodeURIComponent(app)}/${action}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })

/**
 * Run a start/stop/restart action; on a port-in-use error, offer to take over the
 * foreign process (stop it and run ours under the controller) and retry.
 */
export async function appActionWithTakeover(
  app: string,
  action: 'start' | 'stop' | 'restart',
  body: { process?: string; mode?: 'start' | 'dev'; reason?: string }
): Promise<void> {
  const findErr = (res: ActionResult[] | { blocked: true }) =>
    Array.isArray(res) ? res.find((r) => r.error) : undefined
  const res = await appAction(app, action, body)
  const err = findErr(res)
  if (!err?.error) return
  if (/already in use/.test(err.error)) {
    const ok = confirm(
      `${err.error}\n\nTake over? The process holding the port will be stopped and this one will run under App Controller instead.`
    )
    if (!ok) return
    const retry = await appAction(app, action, { ...body, takeover: true })
    const still = findErr(retry)
    if (still?.error) alert(still.error)
    return
  }
  alert(err.error)
}

export const releaseLease = (app: string) =>
  api(`/apps/${encodeURIComponent(app)}/release-lease`, { method: 'POST', body: '{}' })

export const clearAudit = (olderThanDays?: number) =>
  api<{ removed: number }>(`/audit${olderThanDays ? `?olderThanDays=${olderThanDays}` : ''}`, { method: 'DELETE' })

export const saveApp = (def: AppDefInput) => api('/apps', { method: 'POST', body: JSON.stringify(def) })
export const deleteApp = (app: string) => api(`/apps/${encodeURIComponent(app)}`, { method: 'DELETE' })

// Small persisted UI preference lists (pinned apps, collapsed cards)
export function loadPref(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function savePref(key: string, value: string[]): void {
  localStorage.setItem(key, JSON.stringify(value))
}

export function fmtAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return new Date(ts).toLocaleString()
}

export function fmtUptime(startedAt: number): string {
  const s = Math.round((Date.now() - startedAt) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`
}
