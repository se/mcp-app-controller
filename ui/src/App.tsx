import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getAudit, getState, loadPref, savePref, type AppInfo, type AuditEntry } from '@/lib/api'
import { logBus, stateBus } from '@/lib/log-bus'
import { ThemeProvider } from '@/lib/theme'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppCard } from '@/components/app-card'
import { AppView } from '@/components/app-view'
import { CommandPalette } from '@/components/command-palette'
import { ActivityPage } from '@/components/activity-page'
import { LogDock, type LogDockHandle } from '@/components/log-dock'
import { AppFormDialog } from '@/components/app-form-dialog'
import { Sidebar, type View } from '@/components/sidebar'
import { StatTiles } from '@/components/stat-tiles'
import { ThemeToggle } from '@/components/theme-toggle'
import { Plus } from 'lucide-react'

function Dashboard() {
  const [apps, setApps] = useState<AppInfo[]>([])
  const [profiles, setProfiles] = useState<Record<string, string[]>>({})
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [connected, setConnected] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editApp, setEditApp] = useState<AppInfo | null>(null)
  const [view, setView] = useState<View>('overview')
  const [pinned, setPinned] = useState<string[]>(() => loadPref('appctrl-pinned'))
  const [collapsed, setCollapsed] = useState<string[]>(() => loadPref('appctrl-collapsed'))
  const dockRef = useRef<LogDockHandle>(null)

  const togglePin = (name: string) =>
    setPinned((prev) => {
      const next = prev.includes(name) ? prev.filter((x) => x !== name) : [name, ...prev]
      savePref('appctrl-pinned', next)
      return next
    })

  const toggleCollapse = (name: string) =>
    setCollapsed((prev) => {
      const next = prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]
      savePref('appctrl-collapsed', next)
      return next
    })

  // Pinned apps first (in pin order), the rest in config order
  const sortedApps = useMemo(() => {
    const pinnedApps = pinned.map((n) => apps.find((a) => a.name === n)).filter(Boolean) as AppInfo[]
    return [...pinnedApps, ...apps.filter((a) => !pinned.includes(a.name))]
  }, [apps, pinned])

  const refresh = useCallback(() => {
    getState().then((s) => { setApps(s.apps); setProfiles(s.profiles ?? {}); stateBus.emit(s.apps) }).catch(() => {})
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
        if (type === 'state') getState().then((s) => { setApps(s.apps); setProfiles(s.profiles ?? {}); stateBus.emit(s.apps) }).catch(() => {})
        if (type === 'audit') getAudit().then(setAudit).catch(() => {})
        if (type === 'log') logBus.emit(data)
        if (type === 'metrics') {
          setApps((prev) =>
            prev.map((a) => ({
              ...a,
              processes: a.processes.map((p) => ({ ...p, metrics: data[`${a.name}/${p.name}`] ?? null })),
            }))
          )
        }
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

  const openApp = (name: string) => setView(`app:${name}`)
  const viewedApp = view.startsWith('app:') ? apps.find((a) => a.name === view.slice(4)) : undefined

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar
        apps={sortedApps}
        profiles={profiles}
        view={view}
        onNavigate={setView}
        onNewApp={() => { setEditApp(null); setFormOpen(true) }}
        onSelectApp={openApp}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between border-b bg-background px-5 py-2.5">
          <div>
            <h1 className="text-sm font-semibold">
              {viewedApp ? viewedApp.name : view === 'activity' ? 'Activity' : 'Overview'}
            </h1>
            <p className="text-[11px] text-muted-foreground">
              {viewedApp
                ? viewedApp.description || 'App details, processes and metrics'
                : view === 'activity'
                  ? 'Who did what, when, and why — across sessions, UI and system'
                  : 'Monitor and control your local apps'}
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
            {viewedApp ? (
              <AppView
                app={viewedApp}
                audit={audit}
                onBack={() => setView('overview')}
                onEdit={() => { setEditApp(viewedApp); setFormOpen(true) }}
                onLogs={(proc) => dockRef.current?.open(viewedApp.name, proc)}
                onChanged={refresh}
              />
            ) : view !== 'activity' ? (
              <>
                <StatTiles apps={apps} />
                <section className="flex min-w-0 flex-col gap-4">
                  {apps.length === 0 ? (
                    <div className="rounded-xl border border-dashed bg-card p-16 text-center text-muted-foreground">
                      No apps defined yet. Click <span className="font-medium text-foreground">New App</span> to add one.
                    </div>
                  ) : (
                    sortedApps.map((app) => (
                      <div key={app.name} id={`app-${app.name}`}>
                        <AppCard
                          app={app}
                          pinned={pinned.includes(app.name)}
                          collapsed={collapsed.includes(app.name)}
                          onTogglePin={() => togglePin(app.name)}
                          onToggleCollapse={() => toggleCollapse(app.name)}
                          onOpen={() => openApp(app.name)}
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

      <CommandPalette apps={apps} onNavigate={setView} onRefresh={refresh} />
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
      <TooltipProvider delayDuration={200}>
        <Dashboard />
      </TooltipProvider>
    </ThemeProvider>
  )
}
