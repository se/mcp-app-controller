import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getAudit, getState, type AppInfo, type AuditEntry } from '@/lib/api'
import { logBus, stateBus } from '@/lib/log-bus'
import { ThemeProvider } from '@/lib/theme'
import { AppCard } from '@/components/app-card'
import { ActivityPage } from '@/components/activity-page'
import { LogDock, type LogDockHandle } from '@/components/log-dock'
import { AppFormDialog } from '@/components/app-form-dialog'
import { Sidebar, type View } from '@/components/sidebar'
import { StatTiles } from '@/components/stat-tiles'
import { ThemeToggle } from '@/components/theme-toggle'
import { Plus } from 'lucide-react'

function Dashboard() {
  const [apps, setApps] = useState<AppInfo[]>([])
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [connected, setConnected] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editApp, setEditApp] = useState<AppInfo | null>(null)
  const [view, setView] = useState<View>('overview')
  const dockRef = useRef<LogDockHandle>(null)

  const refresh = useCallback(() => {
    getState().then((s) => { setApps(s.apps); stateBus.emit(s.apps) }).catch(() => {})
    getAudit().then(setAudit).catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    let es: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    const connect = () => {
      es = new EventSource('/api/events')
      es.onopen = () => {
        setConnected(true)
        refresh()
      }
      es.onerror = () => {
        setConnected(false)
        es?.close()
        retry = setTimeout(connect, 3000)
      }
      es.onmessage = (ev) => {
        const { type, data } = JSON.parse(ev.data)
        if (type === 'state') getState().then((s) => { setApps(s.apps); stateBus.emit(s.apps) }).catch(() => {})
        if (type === 'audit') getAudit().then(setAudit).catch(() => {})
        if (type === 'log') logBus.emit(data)
      }
    }
    connect()
    const interval = setInterval(refresh, 15000)
    return () => {
      es?.close()
      if (retry) clearTimeout(retry)
      clearInterval(interval)
    }
  }, [refresh])

  const scrollToApp = (name: string) => {
    setView('overview')
    setTimeout(() => {
      document.getElementById(`app-${name}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 50)
  }

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar
        apps={apps}
        view={view}
        onNavigate={setView}
        onNewApp={() => { setEditApp(null); setFormOpen(true) }}
        onSelectApp={scrollToApp}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between border-b bg-background px-5 py-2.5">
          <div>
            <h1 className="text-sm font-semibold">{view === 'overview' ? 'Overview' : 'Activity'}</h1>
            <p className="text-[11px] text-muted-foreground">
              {view === 'overview'
                ? 'Monitor and control your local apps'
                : 'Who did what, when, and why — across sessions, UI and system'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={connected
                ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                : 'border-red-500/40 text-red-600 dark:text-red-400'}
            >
              <span className={`mr-1 size-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-red-500'}`} />
              {connected ? 'live' : 'disconnected'}
            </Badge>
            <ThemeToggle />
            <Button size="sm" onClick={() => { setEditApp(null); setFormOpen(true) }}>
              <Plus className="size-4" /> New App
            </Button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto bg-muted/30 dark:bg-background">
          <div className="mx-auto flex max-w-6xl flex-col gap-4 p-5">
            {view === 'overview' ? (
              <>
                <StatTiles apps={apps} />
                <section className="flex min-w-0 flex-col gap-4">
                  {apps.length === 0 ? (
                    <div className="rounded-xl border border-dashed bg-card p-16 text-center text-muted-foreground">
                      No apps defined yet. Click <span className="font-medium text-foreground">New App</span> to add one.
                    </div>
                  ) : (
                    apps.map((app) => (
                      <div key={app.name} id={`app-${app.name}`}>
                        <AppCard
                          app={app}
                          onLogs={(proc) => dockRef.current?.open(app.name, proc)}
                          onEdit={() => { setEditApp(app); setFormOpen(true) }}
                          onChanged={refresh}
                        />
                      </div>
                    ))
                  )}
                </section>
              </>
            ) : (
              <ActivityPage entries={audit} apps={apps} />
            )}
          </div>
        </main>

        <LogDock ref={dockRef} />
      </div>

      <AppFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editApp={editApp}
        onSaved={refresh}
      />
    </div>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <Dashboard />
    </ThemeProvider>
  )
}
