import { Button } from '@/components/ui/button'
import type { AppInfo } from '@/lib/api'
import { cn } from '@/lib/utils'
import { History, LayoutDashboard, Plus, Settings2 } from 'lucide-react'

export type View = 'overview' | 'activity' | `app:${string}`

function appDotClass(app: AppInfo): string {
  const procs = app.processes
  if (procs.some((p) => p.status === 'crashed')) return 'bg-red-500'
  if (procs.some((p) => p.status === 'running' && p.health === 'unhealthy')) return 'bg-amber-500'
  if (procs.some((p) => p.status === 'running')) return 'bg-emerald-500'
  return 'bg-muted-foreground/40'
}

export function Sidebar({
  apps,
  view,
  onNavigate,
  onNewApp,
  onSelectApp,
}: {
  apps: AppInfo[]
  view: View
  onNavigate: (v: View) => void
  onNewApp: () => void
  onSelectApp: (name: string) => void
}) {
  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
      <div className="flex items-center gap-2 border-b px-4 py-3.5">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Settings2 className="size-4" />
        </div>
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
      </nav>

      <div className="border-t p-3">
        <Button size="sm" className="w-full" onClick={onNewApp}>
          <Plus className="size-4" /> New App
        </Button>
      </div>
    </aside>
  )
}
