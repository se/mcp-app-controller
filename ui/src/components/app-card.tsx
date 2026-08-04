import { memo, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { appAction, appActionWithTakeover, cleanApp, deleteApp, fmtElapsed, getLogs, isStarting, releaseLease, revealInFinder, type AppInfo, type ProcInfo } from '@/lib/api'
import { Elapsed, Uptime } from '@/components/uptime'
import { logBus } from '@/lib/log-bus'
import { ChevronDown, ChevronRight, Eraser, FileText, FolderOpen, Lock, Pencil, Pin, Play, RotateCw, Square, Timer, Trash2, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

function ProcTooltipContent({ p }: { p: ProcInfo }) {
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      <div className="font-semibold">{p.name}</div>
      <div className="capitalize">
        {p.status}
        {p.status === 'running' && p.mode ? ` · ${p.mode} mode` : ''}
        {p.health ? ` · ${p.health}` : ''}
      </div>
      {p.status === 'running' && (
        <div>pid {p.pid} · up <Uptime startedAt={p.startedAt!} /></div>
      )}
      {p.metrics && <div>cpu {p.metrics.cpu}% · mem {p.metrics.memMb} MB</div>}
      {p.status === 'crashed' && (
        <div className="max-w-64 text-red-400">
          exit {p.lastExit?.code ?? '?'}{p.lastExit?.summary ? ` — ${p.lastExit.summary}` : ''}
        </div>
      )}
    </div>
  )
}

/** Strip the `[ISO timestamp] ` prefix and ANSI color codes off a raw log line. */
const cleanLogLine = (raw: string) =>
  raw
    .replace(/^\[[^\]]*\]\s*/, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .trim()

/**
 * Live tail of the app's `prepare` build: shows the latest log line while preparing,
 * so the strip reflects actual progress instead of the static command. Seeds from the
 * log file (page might be opened mid-build), then follows the SSE log bus.
 */
function PrepareTail({ app, fallback }: { app: string; fallback: string | null }) {
  const [line, setLine] = useState<string | null>(null)
  useEffect(() => {
    setLine(null)
    let alive = true
    getLogs(app, 'prepare', 5)
      .then((r) => {
        if (!alive) return
        const lines = r.logs.split('\n').map(cleanLogLine).filter(Boolean)
        if (lines.length) setLine((prev) => prev ?? lines[lines.length - 1])
      })
      .catch(() => {})
    const unsub = logBus.subscribe((e) => {
      if (e.app !== app || e.proc !== 'prepare') return
      const s = cleanLogLine(e.line)
      if (s) setLine(s)
    })
    return () => {
      alive = false
      unsub()
    }
  }, [app])
  const text = line ?? fallback
  if (!text) return null
  return (
    <span className="min-w-0 truncate font-mono opacity-70" title={text}>
      {text}
    </span>
  )
}

// dot | process | pid | uptime | ready | cpu | memory | command (flex) | actions
const PROC_GRID_COLS = '14px minmax(6rem, 10rem) 3.25rem 3.5rem 4.25rem 3.25rem 4.25rem minmax(10rem, 1fr) max-content'

function StatusDot({ p }: { p: ProcInfo }) {
  const { status, health } = p
  // Blue while starting (running, health check configured, never healthy yet this run);
  // green only after the first healthy check; amber = degraded after having been ready.
  const starting = isStarting(p)
  const unhealthy = !starting && status === 'running' && health === 'unhealthy'
  return (
    <span
      title={starting ? 'starting — waiting for first healthy check' : unhealthy ? 'running but unhealthy' : health ? `${status} (${health})` : status}
      className={cn(
        'size-2.5 shrink-0 rounded-full',
        starting && 'animate-pulse bg-sky-500 shadow-[0_0_6px_theme(colors.sky.500)]',
        unhealthy && 'animate-pulse bg-amber-500 shadow-[0_0_6px_theme(colors.amber.500)]',
        !starting && !unhealthy && status === 'running' && 'bg-emerald-500 shadow-[0_0_6px_theme(colors.emerald.500)]',
        status === 'stopped' && 'bg-muted-foreground/50',
        status === 'crashed' && 'bg-red-500 shadow-[0_0_6px_theme(colors.red.500)]'
      )}
    />
  )
}

function AppCardInner({
  app,
  pinned,
  collapsed,
  onTogglePin,
  onToggleCollapse,
  onOpen,
  onLogs,
  onEdit,
  onChanged,
}: {
  app: AppInfo
  pinned: boolean
  collapsed: boolean
  onTogglePin: () => void
  onToggleCollapse: () => void
  onOpen: () => void
  onLogs: (proc: string) => void
  onEdit: () => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    try {
      await fn()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
      onChanged()
    }
  }

  const leaseMinsLeft = app.lease ? Math.max(0, Math.round((app.lease.expires_at - Date.now()) / 60000)) : 0
  const runningCount = app.processes.filter((p) => p.status === 'running').length
  const allRunning = runningCount === app.processes.length
  // Server-side state survives page refreshes (local `busy` does not) — while a
  // prepare/start is in flight, re-pressing start all / clean must stay blocked.
  const inFlight = app.preparing || app.processes.some(isStarting)
  const totals = app.processes.reduce(
    (acc, p) => (p.metrics && p.status === 'running' ? { cpu: acc.cpu + p.metrics.cpu, memMb: acc.memMb + p.metrics.memMb } : acc),
    { cpu: 0, memMb: 0 }
  )

  return (
    <Card className="group gap-0 overflow-hidden py-0">
      <CardHeader className="flex flex-row items-center justify-between gap-4 px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <button
            onClick={onToggleCollapse}
            title={collapsed ? 'Expand' : 'Collapse'}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <button
                onClick={onOpen}
                title="Open app view"
                className="truncate text-[15px] font-semibold tracking-tight hover:underline"
              >
                {app.name}
              </button>
              {app.description && (
                <span className="truncate text-xs font-medium text-muted-foreground/80">{app.description}</span>
              )}
              {app.source && (
                <Badge
                  variant="outline"
                  title={`Definition comes from a shared config file:\n${app.source}\n\nEditing it here forks a personal copy into your apps.yaml.`}
                  className="h-4 shrink-0 border-violet-500/40 px-1.5 text-[9px] font-medium uppercase tracking-wide text-violet-600 dark:text-violet-400"
                >
                  shared
                </Badge>
              )}
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); void revealInFinder(app.name).catch((err) => toast.error(err.message)) }}
              title="Show in Finder"
              className="group/cwd mt-0.5 flex max-w-full items-center gap-1 truncate font-mono text-[11px] leading-4 text-muted-foreground/70 hover:text-foreground"
            >
              <FolderOpen className="size-3 shrink-0 opacity-0 transition-opacity group-hover/cwd:opacity-100" />
              <span className="truncate group-hover/cwd:underline">{app.cwd}</span>
            </button>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!allRunning && (
            <Button variant="outline" size="sm" disabled={busy !== null || inFlight}
              title={inFlight ? 'Start already in progress (preparing/starting)' : undefined}
              className="gap-1.5 font-medium text-emerald-700 hover:border-emerald-500/50 hover:bg-emerald-500/10 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-300"
              onClick={() => run('start-all', () => appActionWithTakeover(app.name, 'start', { mode: 'start', reason: 'manual start-all from UI' }))}>
              <Play className="size-3.5" /> start all
            </Button>
          )}
          {runningCount > 0 && (
            <Button variant="outline" size="sm" disabled={busy !== null || inFlight}
              title={inFlight
                ? 'Start already in progress (preparing/starting)'
                : `Restart all running processes (${runningCount}) — keeps each process's current mode`}
              className="gap-1.5 font-medium text-sky-700 hover:border-sky-500/50 hover:bg-sky-500/10 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-300"
              onClick={() => run('restart-all', () => appActionWithTakeover(app.name, 'restart', { reason: 'manual restart-all from UI' }))}>
              <RotateCw className="size-3.5" /> {busy === 'restart-all' ? 'restarting…' : 'restart all'}
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={busy !== null || runningCount === 0}
            title={runningCount === 0 ? 'Nothing is running' : undefined}
            className="gap-1.5 font-medium text-red-700 hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300"
            onClick={() => run('stop-all', () => appActionWithTakeover(app.name, 'stop', { reason: 'manual stop-all from UI' }))}>
            <Square className="size-3.5" /> stop all
          </Button>
          {app.clean && (
            <span title={inFlight
              ? 'A build/start is in progress — cleaning now would delete files the build is writing'
              : runningCount > 0
              ? `Rebuild from scratch: stop all → clean (${app.clean}) → start all (prepare runs a full fresh build)`
              : `Clear build cache: ${app.clean}\nNext build restores fresh packages (slower once).`}>
              <Button variant="outline" size="sm" disabled={busy !== null || inFlight}
                className="gap-1.5 font-medium text-amber-700 hover:border-amber-500/50 hover:bg-amber-500/10 hover:text-amber-600 dark:text-amber-500 dark:hover:text-amber-400"
                onClick={() => {
                  if (runningCount > 0) {
                    toast.info(`Rebuilding '${app.name}': stop all → clean → start all`)
                    void run('clean', async () => {
                      const stopRes = await appAction(app.name, 'stop', { reason: 'stop before clean (rebuild from UI)' })
                      if (!Array.isArray(stopRes)) {
                        toast.error('Blocked: another session holds a lease on this app — rebuild aborted.')
                        return
                      }
                      const stopErr = stopRes.find((r) => r.error)
                      if (stopErr?.error) {
                        toast.error(`Stop failed: ${stopErr.error} — rebuild aborted before clean.`)
                        return
                      }
                      const r = await cleanApp(app.name)
                      toast.success(r.message)
                      toast.info(`Starting '${app.name}' — prepare runs a full fresh build`)
                      await appActionWithTakeover(app.name, 'start', { mode: 'start', reason: 'start after clean (rebuild from UI)' })
                    })
                  } else {
                    toast.info(`Cleaning '${app.name}' — ${app.clean}`)
                    void run('clean', async () => {
                      const r = await cleanApp(app.name)
                      toast.success(r.message)
                    })
                  }
                }}>
                <Eraser className="size-3.5" /> {busy === 'clean' ? (runningCount > 0 ? 'rebuilding…' : 'cleaning…') : 'clean'}
              </Button>
            </span>
          )}
          <div className="ml-1 flex items-center gap-0.5 border-l pl-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onTogglePin}
              title={pinned ? 'Unpin app from top' : 'Pin app to top'}
              className={pinned ? 'text-primary' : 'text-muted-foreground/70 hover:text-foreground'}
            >
              <Pin className={cn('size-3.5', pinned && 'fill-current')} />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onEdit}
              title="Edit app config — definition of the whole app (cwd, prepare/clean, processes), not a single process"
              className="text-muted-foreground/70 hover:text-foreground">
              <Pencil className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon-sm"
              title="Delete app config — removes the whole app definition (its processes are stopped first)"
              className="text-muted-foreground/70 hover:text-red-500"
              onClick={() => {
                if (confirm(`Delete the app config of '${app.name}'?\n\nThis removes the whole app definition (all its processes) from the controller — running processes are stopped first. It does not touch any files of the app itself.`))
                  run('delete', () => deleteApp(app.name))
              }}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>

      {collapsed && (
        <div className="flex items-center gap-3 border-t px-5 py-2.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            {app.processes.map((p) => (
              <Tooltip key={p.name}>
                <TooltipTrigger asChild>
                  <span className="inline-flex cursor-default">
                    <StatusDot p={p} />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <ProcTooltipContent p={p} />
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
          {(() => {
            const running = app.processes.filter((p) => p.status === 'running').length
            const crashed = app.processes.filter((p) => p.status === 'crashed').length
            const unhealthy = app.processes.filter((p) => p.status === 'running' && p.health === 'unhealthy').length
            return (
              <>
                <span className={cn(running > 0 && 'text-emerald-600 dark:text-emerald-400')}>
                  {running}/{app.processes.length} running
                </span>
                {crashed > 0 && <span className="text-red-600 dark:text-red-400">{crashed} crashed</span>}
                {unhealthy > 0 && <span className="text-amber-600 dark:text-amber-400">{unhealthy} unhealthy</span>}
              </>
            )
          })()}
          {app.lease && (
            <span className="flex min-w-0 items-center gap-1 text-amber-700 dark:text-amber-500">
              <Lock className="size-3 shrink-0" />
              <span className="truncate">{app.lease.session} — “{app.lease.reason}”</span>
            </span>
          )}
        </div>
      )}

      {!collapsed && app.lease && (
        <div className="flex items-center justify-between gap-2 border-t bg-amber-500/10 px-5 py-2 text-xs text-amber-700 dark:text-amber-500">
          <span className="flex min-w-0 items-center gap-1.5">
            <Lock className="size-3.5 shrink-0" />
            <span className="truncate">
              held by <b>{app.lease.session}</b> — “{app.lease.reason}” ({leaseMinsLeft}m left)
            </span>
          </span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-amber-700 hover:text-amber-600 dark:text-amber-500 dark:hover:text-amber-400"
            onClick={() => run('release', () => releaseLease(app.name))}>
            release
          </Button>
        </div>
      )}


      {!collapsed && (
      <CardContent className="px-0 pb-0">
        {/* Column header — the per-row labels (pid, up, ready, cpu...) live here now.
            Inline gridTemplateColumns: numeric cols stay tight, Command absorbs the rest. */}
        <Separator />
        <div className="grid items-center gap-x-3 px-5 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground" style={{ gridTemplateColumns: PROC_GRID_COLS }}>
          <span />
          <span>Process</span>
          <span className="text-right">PID</span>
          <span className="text-right">Uptime</span>
          <span className="text-right">Ready in</span>
          <span className="text-right">CPU</span>
          <span className="text-right">Memory</span>
          <span>Command</span>
          <span className="text-right">Actions</span>
        </div>
        {app.processes.map((p) => (
          <div key={p.name}>
            <Separator />
            <div className="grid items-center gap-x-3 px-5 py-2" style={{ gridTemplateColumns: PROC_GRID_COLS }}>
              <StatusDot p={p} />
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-sm font-medium">{p.name}</span>
                {p.status === 'running' && p.mode === 'dev' && (
                  <Badge variant="outline" className="h-4 border-sky-500/40 px-1 text-[9px] uppercase text-sky-600 dark:text-sky-400">dev</Badge>
                )}
              </span>
              <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">{p.pid ?? '—'}</span>
              <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                {p.status === 'running' ? <Uptime startedAt={p.startedAt!} /> : '—'}
              </span>
              <span className="text-right font-mono text-[11px] tabular-nums">
                {isStarting(p) ? (
                  <span className="animate-pulse text-sky-600 dark:text-sky-400"><Elapsed since={p.startedAt!} />…</span>
                ) : p.readyInMs !== null ? (
                  <span className="text-muted-foreground">{fmtElapsed(p.readyInMs)}</span>
                ) : (
                  <span className="text-muted-foreground" title="no health check configured (healthUrl / healthPort)">—</span>
                )}
              </span>
              <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                {p.metrics && p.status === 'running' ? `${p.metrics.cpu}%` : '—'}
              </span>
              <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                {p.metrics && p.status === 'running' ? `${p.metrics.memMb} MB` : '—'}
              </span>
              <span
                className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
                title={p.status === 'crashed' && p.lastExit?.summary ? p.lastExit.summary : p.command}
              >
                {p.status === 'crashed' ? (
                  <span className="text-red-600 dark:text-red-400">
                    exit {p.lastExit?.code ?? '?'}{p.lastExit?.summary ? ` · ${p.lastExit.summary}` : ''}
                  </span>
                ) : (
                  p.command
                )}
              </span>
              <div className="flex shrink-0 justify-end gap-1">
                {p.status === 'running' ? (
                  <>
                    <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy !== null}
                      onClick={() => run(p.name, () => appActionWithTakeover(app.name, 'restart', { process: p.name, reason: 'manual restart from UI' }))}>
                      <RotateCw className="size-3" /> restart
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 px-2 text-xs hover:border-red-500/60 hover:text-red-400" disabled={busy !== null}
                      onClick={() => run(p.name, () => appActionWithTakeover(app.name, 'stop', { process: p.name, reason: 'manual stop from UI' }))}>
                      <Square className="size-3" /> stop
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy !== null}
                      onClick={() => run(p.name, () => appActionWithTakeover(app.name, 'start', { process: p.name, mode: 'start', reason: 'manual start from UI' }))}>
                      <Play className="size-3" /> start
                    </Button>
                    {p.devCommand && (
                      <Button variant="outline" size="sm" className="h-7 px-2 text-xs text-sky-600 dark:text-sky-400" disabled={busy !== null}
                        onClick={() => run(p.name, () => appActionWithTakeover(app.name, 'start', { process: p.name, mode: 'dev', reason: 'manual dev start from UI' }))}>
                        <Wrench className="size-3" /> dev
                      </Button>
                    )}
                  </>
                )}
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onLogs(p.name)}>
                  <FileText className="size-3" /> logs
                </Button>
              </div>
            </div>
          </div>
        ))}
      </CardContent>
      )}

      {(app.preparing || app.processes.some(isStarting) || app.lastStart || runningCount > 0) && (
        <div
          className={cn(
            'flex items-center gap-2 border-t px-5 text-[11px]',
            inFlight
              ? 'border-sky-500/10 bg-sky-500/5 py-2 text-xs text-sky-700 dark:bg-sky-500/[0.08] dark:text-sky-400'
              : 'bg-muted/40 py-1.5 text-muted-foreground'
          )}
        >
          {app.preparing ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="size-2 shrink-0 animate-pulse rounded-full bg-sky-500 shadow-[0_0_6px_theme(colors.sky.500)]" />
              <span className="shrink-0 rounded-md bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                preparing
              </span>
              <PrepareTail app={app.name} fallback={app.prepare} />
            </span>
          ) : app.processes.some(isStarting) ? (
            <span className="flex items-center gap-2">
              <span className="size-2 shrink-0 animate-pulse rounded-full bg-sky-500 shadow-[0_0_6px_theme(colors.sky.500)]" />
              <span className="shrink-0 rounded-md bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                starting
              </span>
              <span className="opacity-70">waiting for first healthy check</span>
            </span>
          ) : app.lastStart ? (
            <span
              className="flex items-center gap-1.5 tabular-nums"
              title={`last full start: ${fmtElapsed(app.lastStart.totalMs)} total (prepare ${fmtElapsed(app.lastStart.prepareMs)}), ${app.lastStart.procs} processes`}
            >
              <Timer className="size-3" />
              last start {fmtElapsed(app.lastStart.totalMs)}
              {app.lastStart.prepareMs > 0 && <span className="opacity-70">(prepare {fmtElapsed(app.lastStart.prepareMs)})</span>}
            </span>
          ) : (
            // Running but no timing recorded (e.g. processes adopted after a daemon restart)
            <span className="flex items-center gap-1.5"><Timer className="size-3" /> running</span>
          )}
          {runningCount > 0 && (totals.cpu > 0 || totals.memMb > 0) && (
            <span className="ml-auto shrink-0 tabular-nums opacity-80" title="total of all running processes">
              Σ {totals.cpu.toFixed(1)}% · {totals.memMb >= 1024 ? `${(totals.memMb / 1024).toFixed(1)} GB` : `${Math.round(totals.memMb)} MB`}
            </span>
          )}
        </div>
      )}
    </Card>
  )
}

/**
 * Memoized on data props only. The dashboard re-creates the callback props on every
 * render, so comparing them would defeat the memo — and they are all "stale-safe":
 * they capture only stable refs/setters (functional updates) or values that, when
 * they change, also change one of the compared props (`app`, `pinned`, `collapsed`)
 * and thus produce a fresh render with fresh closures. Keep new callbacks that way.
 * Combined with the referential-equality guard in the metrics SSE handler, a 5s
 * metrics tick only re-renders cards whose cpu/mem actually changed.
 */
export const AppCard = memo(
  AppCardInner,
  (prev, next) => prev.app === next.app && prev.pinned === next.pinned && prev.collapsed === next.collapsed
)
