import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { appActionWithTakeover, deleteApp, fmtUptime, releaseLease, type AppInfo, type ProcInfo } from '@/lib/api'
import { ChevronDown, ChevronRight, FileText, Lock, Pencil, Pin, Play, RotateCw, Square, Trash2, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'

function StatusDot({ status, health }: { status: ProcInfo['status']; health: ProcInfo['health'] }) {
  const unhealthy = status === 'running' && health === 'unhealthy'
  return (
    <span
      title={unhealthy ? 'running but unhealthy' : health ? `${status} (${health})` : status}
      className={cn(
        'size-2.5 shrink-0 rounded-full',
        unhealthy && 'animate-pulse bg-amber-500 shadow-[0_0_6px_theme(colors.amber.500)]',
        !unhealthy && status === 'running' && 'bg-emerald-500 shadow-[0_0_6px_theme(colors.emerald.500)]',
        status === 'stopped' && 'bg-muted-foreground/50',
        status === 'crashed' && 'bg-red-500 shadow-[0_0_6px_theme(colors.red.500)]'
      )}
    />
  )
}

export function AppCard({
  app,
  pinned,
  collapsed,
  onTogglePin,
  onToggleCollapse,
  onLogs,
  onEdit,
  onChanged,
}: {
  app: AppInfo
  pinned: boolean
  collapsed: boolean
  onTogglePin: () => void
  onToggleCollapse: () => void
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
      alert((err as Error).message)
    } finally {
      setBusy(null)
      onChanged()
    }
  }

  const leaseMinsLeft = app.lease ? Math.max(0, Math.round((app.lease.expires_at - Date.now()) / 60000)) : 0

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="flex flex-row items-start justify-between gap-4 px-5 py-4">
        <div className="flex min-w-0 items-start gap-1.5">
          <button
            onClick={onToggleCollapse}
            title={collapsed ? 'Expand' : 'Collapse'}
            className="mt-0.5 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
          </button>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="text-base font-semibold">{app.name}</span>
              {pinned && <Pin className="size-3 shrink-0 self-center fill-current text-primary" />}
              {app.description && <span className="truncate text-xs text-muted-foreground">{app.description}</span>}
            </div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">{app.cwd}</div>
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button variant="outline" size="sm" disabled={busy !== null}
            onClick={() => run('start-all', () => appActionWithTakeover(app.name, 'start', { mode: 'start', reason: 'manual start-all from UI' }))}>
            <Play className="size-3.5" /> start all
          </Button>
          <Button variant="outline" size="sm" disabled={busy !== null}
            onClick={() => run('stop-all', () => appActionWithTakeover(app.name, 'stop', { reason: 'manual stop-all from UI' }))}>
            <Square className="size-3.5" /> stop all
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onTogglePin}
            title={pinned ? 'Unpin' : 'Pin to top'}
            className={pinned ? 'text-primary' : 'text-muted-foreground'}
          >
            <Pin className={cn('size-3.5', pinned && 'fill-current')} />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onEdit} title="Edit app">
            <Pencil className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" title="Delete app"
            className="text-muted-foreground hover:text-red-500"
            onClick={() => {
              if (confirm(`Delete app '${app.name}'? Running processes will be stopped.`))
                run('delete', () => deleteApp(app.name))
            }}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </CardHeader>

      {collapsed && (
        <div className="flex items-center gap-3 border-t px-5 py-2.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            {app.processes.map((p) => (
              <StatusDot key={p.name} status={p.status} health={p.health} />
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
        {app.processes.map((p, i) => (
          <div key={p.name}>
            {(i > 0 || true) && <Separator />}
            <div className="flex items-center gap-3 px-5 py-2.5">
              <StatusDot status={p.status} health={p.health} />
              <span className="w-24 shrink-0 truncate text-sm font-medium">{p.name}</span>
              {p.status === 'running' && (
                <Badge variant="outline" className="h-5 px-1.5 text-[10px] uppercase text-sky-600 dark:text-sky-400 border-sky-500/40">
                  {p.mode}
                </Badge>
              )}
              {p.status === 'running' && p.health === 'unhealthy' && (
                <Badge variant="outline" className="h-5 border-amber-500/50 px-1.5 text-[10px] uppercase text-amber-500">
                  unhealthy
                </Badge>
              )}
              <span
                className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
                title={p.status === 'crashed' && p.lastExit?.summary ? p.lastExit.summary : undefined}
              >
                {p.status === 'running' && `pid ${p.pid} · up ${fmtUptime(p.startedAt!)} · `}
                {p.status === 'crashed' && (
                  <span className="text-red-600 dark:text-red-400">
                    exit {p.lastExit?.code ?? '?'}{p.lastExit?.summary ? ` · ${p.lastExit.summary}` : ''} ·{' '}
                  </span>
                )}
                {p.command}
              </span>
              <div className="flex shrink-0 gap-1">
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
    </Card>
  )
}
