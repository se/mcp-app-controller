import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { getVersion, profileAction, type AppInfo, type VersionInfo } from '@/lib/api'
import { cn } from '@/lib/utils'
import { History, LayoutDashboard, Layers, Play, Plus, Settings, Square } from 'lucide-react'

const fmtBuildDate = (ms: number) =>
  new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

/** Version of the RUNNING daemon (commit + build date) — quiet line at the sidebar bottom. */
function VersionFooter() {
  const [v, setV] = useState<VersionInfo | null>(null)
  useEffect(() => {
    getVersion().then(setV).catch(() => setV(null)) // older daemons have no /version
  }, [])
  if (!v) return null
  return (
    <div
      className="mt-2 truncate text-center font-mono text-[10px] text-muted-foreground/60"
      title={`Running daemon\ncommit: ${v.commit}${v.builtAt ? `\nbuilt: ${new Date(v.builtAt).toLocaleString()}` : ''}\nstarted: ${new Date(v.startedAt).toLocaleString()}`}
    >
      {v.commit}
      {v.builtAt ? ` · ${fmtBuildDate(v.builtAt)}` : ''}
    </div>
  )
}

export type View = 'overview' | 'activity' | 'settings' | `app:${string}`

function appDotClass(app: AppInfo): string {
  const procs = app.processes
  if (procs.some((p) => p.status === 'crashed')) return 'bg-red-500'
  if (procs.some((p) => p.status === 'running' && p.health === 'unhealthy')) return 'bg-amber-500'
  if (procs.some((p) => p.status === 'running')) return 'bg-emerald-500'
  return 'bg-muted-foreground/40'
}

export function Sidebar({
  apps,
  profiles,
  view,
  onNavigate,
  onNewApp,
  onSelectApp,
}: {
  apps: AppInfo[]
  profiles: Record<string, string[]>
  view: View
  onNavigate: (v: View) => void
  onNewApp: () => void
  onSelectApp: (name: string) => void
}) {
  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
      <div className="flex items-center gap-2 border-b px-4 py-3.5">
        <img src="/logo.svg" alt="App Controller" className="size-7" />
        <div className="leading-tight">
          <div className="text-sm font-semibold">App Controller</div>
          <div className="text-[10px] text-muted-foreground">local process manager</div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto p-3">
        <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Dashboard
        </div>
        <button
          onClick={() => onNavigate('overview')}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
            view === 'overview' ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          )}
        >
          <LayoutDashboard className="size-4" /> Overview
        </button>
        <button
          onClick={() => onNavigate('activity')}
          className={cn(
            'mt-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
            view === 'activity' ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          )}
        >
          <History className="size-4" /> Activity
        </button>
        <button
          onClick={() => onNavigate('settings')}
          className={cn(
            'mt-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
            view === 'settings' ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          )}
        >
          <Settings className="size-4" /> Settings
        </button>

        <div className="px-2 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Apps
        </div>
        {apps.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">No apps yet</div>
        )}
        {apps.map((app) => {
          const running = app.processes.filter((p) => p.status === 'running').length
          return (
            <button
              key={app.name}
              onClick={() => onSelectApp(app.name)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                view === `app:${app.name}`
                  ? 'bg-accent font-medium'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <span className={cn('size-2 shrink-0 rounded-full', appDotClass(app))} />
              <span className="truncate">{app.name}</span>
              <span className="ml-auto text-[10px] tabular-nums">
                {running}/{app.processes.length}
              </span>
            </button>
          )
        })}
        {Object.keys(profiles).length > 0 && (
          <>
            <div className="px-2 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Profiles
            </div>
            {Object.entries(profiles).map(([name, targets]) => (
              <div
                key={name}
                className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground"
                title={targets.join(', ')}
              >
                <Layers className="size-4 shrink-0" />
                <span className="truncate">{name}</span>
                <span className="ml-auto flex gap-0.5 opacity-60 group-hover:opacity-100">
                  <button
                    className="rounded p-0.5 hover:bg-accent hover:text-emerald-500"
                    title={`Start profile '${name}'`}
                    onClick={() => void profileAction(name, 'start')}
                  >
                    <Play className="size-3.5" />
                  </button>
                  <button
                    className="rounded p-0.5 hover:bg-accent hover:text-red-500"
                    title={`Stop profile '${name}'`}
                    onClick={() => void profileAction(name, 'stop')}
                  >
                    <Square className="size-3.5" />
                  </button>
                </span>
              </div>
            ))}
          </>
        )}
      </nav>

      <div className="border-t p-3">
        <Button size="sm" className="w-full" onClick={onNewApp}>
          <Plus className="size-4" /> New App
        </Button>
        <VersionFooter />
      </div>
    </aside>
  )
}
