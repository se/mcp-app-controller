import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  appActionWithTakeover,
  fmtAgo,
  fmtElapsed,
  getMetricsHistory,
  isStarting,
  releaseLease,
  revealInFinder,
  type AppInfo,
  type AuditEntry,
  type ProcInfo,
  type ProcMetrics,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { EnvCard } from '@/components/env-editor'
import { Elapsed, Uptime } from '@/components/uptime'
import { Activity, ArrowLeft, Cpu, FileText, FolderOpen, Hammer, Lock, MemoryStick, Pencil, Play, RotateCw, Square, Wrench } from 'lucide-react'

function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return <span className="text-[10px] text-muted-foreground">—</span>
  const w = 96
  const h = 24
  const max = Math.max(...values, 1)
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / max) * (h - 2) - 1}`)
    .join(' ')
  return (
    <svg width={w} height={h} className={cn('overflow-visible', className)}>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Gantt-style visualization of the last whole-app start: the prepare bar first,
 * then one bar per process — offset by its spawn time relative to the operation
 * start, bar length = time until its first healthy check (live while starting).
 */
function StartupTimeline({ app }: { app: AppInfo }) {
  const op = app.lastStart
  const anyStarting = app.preparing || app.processes.some(isStarting)
  if (!op && !anyStarting) return null
  const t0 = op?.at ?? Math.min(...app.processes.filter((p) => p.startedAt).map((p) => p.startedAt!))
  const now = Date.now()
  const rows: { name: string; offset: number; dur: number; live: boolean; kind: 'prepare' | 'proc'; noCheck?: boolean }[] = []
  if (app.prepare && op && op.prepareMs > 0) rows.push({ name: 'prepare', offset: 0, dur: op.prepareMs, live: false, kind: 'prepare' })
  if (app.preparing) rows.push({ name: 'prepare', offset: 0, dur: now - t0, live: true, kind: 'prepare' })
  for (const p of app.processes) {
    if (!p.startedAt || p.startedAt < t0 - 2000) continue
    const offset = Math.max(0, p.startedAt - t0)
    if (isStarting(p)) rows.push({ name: p.name, offset, dur: now - p.startedAt, live: true, kind: 'proc' })
    else if (p.readyInMs !== null) rows.push({ name: p.name, offset, dur: p.readyInMs, live: false, kind: 'proc' })
    else if (p.status === 'running') rows.push({ name: p.name, offset, dur: 0, live: false, kind: 'proc', noCheck: true })
  }
  if (rows.length === 0) return null
  const total = Math.max(...rows.map((r) => r.offset + r.dur), op?.totalMs ?? 0, 1)
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <span className="text-sm font-medium">Startup timeline</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {anyStarting ? (
            <span className="animate-pulse text-sky-600 dark:text-sky-400">in progress — {fmtElapsed(now - t0)}</span>
          ) : op ? (
            <>total {fmtElapsed(op.totalMs)} · prepare {fmtElapsed(op.prepareMs)} · {fmtAgo(op.at)}</>
          ) : null}
        </span>
      </div>
      <div className="flex flex-col gap-1.5 px-4 py-3">
        {rows.map((r, i) => (
          <div key={`${r.name}-${i}`} className="flex items-center gap-2">
            <span className={cn('w-24 shrink-0 truncate text-right font-mono text-[11px]', r.kind === 'prepare' ? 'text-violet-600 dark:text-violet-400' : 'text-muted-foreground')}>
              {r.name}
            </span>
            <div className="relative h-4 flex-1 overflow-hidden rounded bg-muted/50">
              <div
                className={cn(
                  'absolute top-0 h-full rounded',
                  r.kind === 'prepare'
                    ? 'bg-violet-500/70'
                    : r.live
                      ? 'animate-pulse bg-sky-500/70'
                      : 'bg-emerald-500/60'
                )}
                style={{
                  left: `${(r.offset / total) * 100}%`,
                  width: r.noCheck ? '2px' : `${Math.max((r.dur / total) * 100, 0.5)}%`,
                }}
              />
            </div>
            <span className={cn('w-16 shrink-0 text-right font-mono text-[11px] tabular-nums', r.live ? 'text-sky-600 dark:text-sky-400' : 'text-muted-foreground')}>
              {r.noCheck ? 'spawned' : `${fmtElapsed(r.dur)}${r.live ? '…' : ''}`}
            </span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function statusBadge(p: ProcInfo) {
  // "starting" until the FIRST healthy check of this run; "unhealthy" only when it
  // degrades after having been ready — no more premature green on fresh starts.
  const starting = isStarting(p)
  const unhealthy = !starting && p.status === 'running' && p.health === 'unhealthy'
  return (
    <Badge
      variant="outline"
      className={cn(
        'text-[11px]',
        starting
          ? 'animate-pulse border-sky-500/50 text-sky-600 dark:text-sky-400'
          : unhealthy
            ? 'border-amber-500/50 text-amber-600 dark:text-amber-400'
            : p.status === 'running'
              ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
              : p.status === 'crashed'
                ? 'border-red-500/40 text-red-600 dark:text-red-400'
                : 'text-muted-foreground'
      )}
    >
      {starting ? 'starting' : unhealthy ? 'unhealthy' : p.status}
    </Badge>
  )
}

export function AppView({
  app,
  audit,
  onBack,
  onEdit,
  onLogs,
  onChanged,
}: {
  app: AppInfo
  audit: AuditEntry[]
  onBack: () => void
  onEdit: () => void
  onLogs: (proc: string) => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<Record<string, ProcMetrics[]>>({})

  // Initial CPU history per process; new points are appended from live metrics updates
  useEffect(() => {
    let cancelled = false
    Promise.all(
      app.processes.map((p) =>
        getMetricsHistory(app.name, p.name).then((h) => [p.name, h] as const).catch(() => [p.name, []] as const)
      )
    ).then((entries) => {
      if (!cancelled) setHistory(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.name])

  useEffect(() => {
    setHistory((prev) => {
      const next = { ...prev }
      for (const p of app.processes) {
        if (!p.metrics) continue
        const h = next[p.name] ?? []
        if (h.length === 0 || h[h.length - 1].at !== p.metrics.at) {
          next[p.name] = [...h.slice(-119), p.metrics]
        }
      }
      return next
    })
  }, [app])

  const act = async (action: 'start' | 'stop' | 'restart', proc?: string, mode?: 'start' | 'dev') => {
    setBusy(true)
    try {
      await appActionWithTakeover(app.name, action, {
        process: proc,
        mode,
        reason: `manual ${action}${mode === 'dev' ? ' (dev)' : ''} from app view`,
      })
    } catch (err) {
      alert((err as Error).message)
    } finally {
      setBusy(false)
      onChanged()
    }
  }

  const running = app.processes.filter((p) => p.status === 'running')
  const crashed = app.processes.filter((p) => p.status === 'crashed').length
  const unhealthy = app.processes.filter((p) => p.status === 'running' && p.health === 'unhealthy').length
  const totalCpu = Math.round(running.reduce((s, p) => s + (p.metrics?.cpu ?? 0), 0) * 10) / 10
  const totalMem = running.reduce((s, p) => s + (p.metrics?.memMb ?? 0), 0)
  const appAudit = audit.filter((e) => e.app === app.name).slice(0, 8)
  const leaseMinsLeft = app.lease ? Math.max(0, Math.round((app.lease.expires_at - Date.now()) / 60000)) : 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2">
          <Button variant="ghost" size="icon-sm" onClick={onBack} title="Back to overview">
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <h2 className="text-lg font-semibold">{app.name}</h2>
              {app.activeEnvironment && (
                <Badge variant="outline" className="border-violet-500/50 text-[10px] uppercase text-violet-600 dark:text-violet-400">
                  {app.activeEnvironment}
                </Badge>
              )}
              {app.description && <span className="truncate text-xs text-muted-foreground">{app.description}</span>}
            </div>
            <button
              onClick={() => void revealInFinder(app.name).catch(() => {})}
              title="Show in Finder"
              className="group/cwd flex max-w-full items-center gap-1 truncate font-mono text-[11px] text-muted-foreground hover:text-foreground"
            >
              <FolderOpen className="size-3 shrink-0 opacity-0 transition-opacity group-hover/cwd:opacity-100" />
              <span className="truncate group-hover/cwd:underline">{app.cwd}</span>
            </button>
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {running.length < app.processes.length && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => act('start')}>
              <Play className="size-3.5" /> start all
            </Button>
          )}
          {running.length > 0 && (
            <Button variant="outline" size="sm" disabled={busy}
              title={`Restart all running processes (${running.length})`}
              onClick={() => act('restart')}>
              <RotateCw className="size-3.5" /> restart all
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={busy} onClick={() => act('stop')}>
            <Square className="size-3.5" /> stop all
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onEdit} title="Edit app">
            <Pencil className="size-3.5" />
          </Button>
        </div>
      </div>

      {app.lease && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-500">
          <span className="flex min-w-0 items-center gap-1.5">
            <Lock className="size-3.5 shrink-0" />
            <span className="truncate">
              held by <b>{app.lease.session}</b> — “{app.lease.reason}” ({leaseMinsLeft}m left)
            </span>
          </span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs"
            onClick={async () => { await releaseLease(app.name); onChanged() }}>
            release
          </Button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Card className="gap-1 p-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">Running <Activity className="size-3.5" /></div>
          <div className="text-2xl font-semibold tabular-nums">{running.length}<span className="text-sm text-muted-foreground">/{app.processes.length}</span></div>
          <div className="text-[11px] text-muted-foreground">
            {crashed > 0 ? `${crashed} crashed` : unhealthy > 0 ? `${unhealthy} unhealthy` : 'all healthy'}
          </div>
        </Card>
        <Card className="gap-1 p-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">CPU <Cpu className="size-3.5" /></div>
          <div className="text-2xl font-semibold tabular-nums">{totalCpu}%</div>
          <div className="text-[11px] text-muted-foreground">sum of all processes</div>
        </Card>
        <Card className="gap-1 p-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">Memory <MemoryStick className="size-3.5" /></div>
          <div className="text-2xl font-semibold tabular-nums">
            {totalMem >= 1024 ? `${(totalMem / 1024).toFixed(1)} GB` : `${totalMem} MB`}
          </div>
          <div className="text-[11px] text-muted-foreground">resident set, incl. children</div>
        </Card>
        <Card className="gap-1 p-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">Uptime <Activity className="size-3.5" /></div>
          <div className="text-2xl font-semibold tabular-nums">
            {running.length > 0 ? <Uptime startedAt={Math.min(...running.map((p) => p.startedAt!))} /> : '—'}
          </div>
          <div className="text-[11px] text-muted-foreground">oldest running process</div>
        </Card>
        <Card className="gap-1 p-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">Last start <Hammer className="size-3.5" /></div>
          <div className="text-2xl font-semibold tabular-nums">
            {app.preparing || app.processes.some(isStarting)
              ? <span className="animate-pulse text-sky-600 dark:text-sky-400">…</span>
              : app.lastStart ? fmtElapsed(app.lastStart.totalMs) : '—'}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {app.lastStart
              ? `${app.lastStart.procs} procs · prepare ${fmtElapsed(app.lastStart.prepareMs)} · ${fmtAgo(app.lastStart.at)}`
              : 'total, incl. prepare, until healthy'}
          </div>
        </Card>
      </div>

      <StartupTimeline app={app} />

      {app.prepare && (
        <div
          className={cn(
            'flex items-center justify-between gap-2 rounded-lg border px-4 py-2 text-xs',
            app.preparing
              ? 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400'
              : 'border-border bg-muted/40 text-muted-foreground'
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <Hammer className={cn('size-3.5 shrink-0', app.preparing && 'animate-pulse')} />
            <span className="shrink-0 font-medium">{app.preparing ? 'prepare: building…' : 'prepare'}</span>
            <span className="truncate font-mono text-[11px]" title={app.prepare}>{app.prepare}</span>
            {app.staggerMs > 0 && <span className="shrink-0 text-[10px] opacity-70">stagger {app.staggerMs}ms</span>}
          </span>
          <Button variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-xs" onClick={() => onLogs('prepare')}>
            <FileText className="size-3" /> logs
          </Button>
        </div>
      )}

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Process</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className="w-20">PID</TableHead>
              <TableHead className="w-20">Uptime</TableHead>
              <TableHead className="w-20">Ready in</TableHead>
              <TableHead className="w-20">CPU</TableHead>
              <TableHead className="w-24">Memory</TableHead>
              <TableHead className="w-28">CPU (10m)</TableHead>
              <TableHead className="w-28">Mem (10m)</TableHead>
              <TableHead className="w-52 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {app.processes.map((p) => (
              <TableRow key={p.name} className="group/proc">
                <TableCell>
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    {p.name}
                    <button
                      onClick={() => void revealInFinder(app.name, p.name).catch(() => {})}
                      title="Show in Finder"
                      className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/proc:opacity-100"
                    >
                      <FolderOpen className="size-3" />
                    </button>
                  </div>
                  <div className="max-w-72 truncate font-mono text-[11px] text-muted-foreground"
                    title={p.status === 'crashed' && p.lastExit?.summary ? p.lastExit.summary : p.command}>
                    {p.status === 'crashed' && p.lastExit?.summary ? (
                      <span className="text-red-600 dark:text-red-400">{p.lastExit.summary}</span>
                    ) : (
                      p.command
                    )}
                  </div>
                </TableCell>
                <TableCell>{statusBadge(p)}</TableCell>
                <TableCell className="font-mono text-xs">{p.pid ?? '—'}</TableCell>
                <TableCell className="text-xs">{p.status === 'running' ? <Uptime startedAt={p.startedAt!} /> : '—'}</TableCell>
                <TableCell className="text-xs tabular-nums">
                  {isStarting(p) ? (
                    <span className="animate-pulse text-sky-600 dark:text-sky-400">
                      <Elapsed since={p.startedAt!} />…
                    </span>
                  ) : p.readyInMs !== null ? (
                    fmtElapsed(p.readyInMs)
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell className="text-xs tabular-nums">{p.metrics ? `${p.metrics.cpu}%` : '—'}</TableCell>
                <TableCell className="text-xs tabular-nums">{p.metrics ? `${p.metrics.memMb} MB` : '—'}</TableCell>
                <TableCell className="text-sky-600 dark:text-sky-400">
                  <Sparkline values={(history[p.name] ?? []).map((m) => m.cpu)} />
                </TableCell>
                <TableCell className="text-violet-600 dark:text-violet-400">
                  <Sparkline values={(history[p.name] ?? []).map((m) => m.memMb)} />
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    {p.status === 'running' ? (
                      <>
                        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy}
                          onClick={() => act('restart', p.name)}>
                          <RotateCw className="size-3" /> restart
                        </Button>
                        <Button variant="outline" size="sm" className="h-7 px-2 text-xs hover:border-red-500/60 hover:text-red-400"
                          disabled={busy} onClick={() => act('stop', p.name)}>
                          <Square className="size-3" /> stop
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy}
                          onClick={() => act('start', p.name, 'start')}>
                          <Play className="size-3" /> start
                        </Button>
                        {p.devCommand && (
                          <Button variant="outline" size="sm" className="h-7 px-2 text-xs text-sky-600 dark:text-sky-400"
                            disabled={busy} onClick={() => act('start', p.name, 'dev')}>
                            <Wrench className="size-3" /> dev
                          </Button>
                        )}
                      </>
                    )}
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onLogs(p.name)}>
                      <FileText className="size-3" /> logs
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <EnvCard app={app} onChanged={onChanged} />

      <Card className="gap-0 overflow-hidden py-0">
        <div className="border-b px-4 py-2.5 text-sm font-medium">Configuration</div>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Process</TableHead>
              <TableHead>Command</TableHead>
              <TableHead className="w-24">Ports</TableHead>
              <TableHead className="w-40">Health</TableHead>
              <TableHead className="w-28">Depends on</TableHead>
              <TableHead className="w-20">Env</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {app.processes.map((p) => (
              <TableRow key={p.name}>
                <TableCell className="text-xs font-medium">{p.name}</TableCell>
                <TableCell className="max-w-72 font-mono text-[11px] text-muted-foreground">
                  <div className="truncate" title={p.command}>{p.command}</div>
                  {p.devCommand && (
                    <div className="truncate text-sky-600 dark:text-sky-400" title={p.devCommand}>dev: {p.devCommand}</div>
                  )}
                  {p.cwd && (
                    <button
                      onClick={() => void revealInFinder(app.name, p.name).catch(() => {})}
                      title="Show in Finder"
                      className="flex max-w-full items-center gap-1 truncate hover:text-foreground hover:underline"
                    >
                      <FolderOpen className="size-3 shrink-0" /> cwd: {p.cwd}
                    </button>
                  )}
                </TableCell>
                <TableCell className="font-mono text-[11px]">{p.ports.length > 0 ? p.ports.join(', ') : '—'}</TableCell>
                <TableCell className="max-w-40 truncate font-mono text-[11px]" title={p.healthUrl ?? undefined}>
                  {p.healthUrl ?? (p.healthPort ? `tcp:${p.healthPort}` : '—')}
                </TableCell>
                <TableCell className="font-mono text-[11px]">{p.dependsOn.length > 0 ? p.dependsOn.join(', ') : '—'}</TableCell>
                <TableCell className="text-[11px] text-muted-foreground" title={Object.keys(p.env).join(', ')}>
                  {Object.keys(p.env).length > 0 ? `${Object.keys(p.env).length} vars` : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Card className="gap-0 py-0">
        <div className="border-b px-4 py-2.5 text-sm font-medium">Recent activity</div>
        {appAudit.length === 0 && (
          <div className="p-6 text-center text-xs text-muted-foreground">No activity for this app yet</div>
        )}
        {appAudit.map((e, i) => (
          <div key={e.id} className={cn('flex items-baseline gap-2 px-4 py-2 text-xs', i > 0 && 'border-t')}>
            <span className="shrink-0 text-[10px] text-muted-foreground">{fmtAgo(e.ts)}</span>
            <span
              className={cn(
                'shrink-0 font-mono',
                e.source === 'mcp' && 'text-sky-600 dark:text-sky-400',
                e.source === 'ui' && 'text-amber-600 dark:text-amber-400',
                e.source === 'system' && 'text-red-600 dark:text-red-400'
              )}
            >
              {e.source}:{e.session}
            </span>
            <span className="font-medium">{e.action}</span>
            <span className="text-muted-foreground">{e.proc ?? ''}</span>
            <span className={cn(
              e.result.startsWith('error') || e.result === 'crashed'
                ? 'text-red-600 dark:text-red-400'
                : 'text-emerald-600 dark:text-emerald-400'
            )}>
              {e.result.length > 40 ? e.result.slice(0, 40) + '…' : e.result}
            </span>
            {e.detail && <span className="min-w-0 truncate italic text-muted-foreground">{e.detail}</span>}
          </div>
        ))}
      </Card>
    </div>
  )
}
