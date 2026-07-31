import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getAudit, getState, loadPref, savePref, type AppInfo, type AuditEntry } from '@/lib/api'
import { alarmsBus, anchorBus, logBus, stateBus } from '@/lib/log-bus'
import { ThemeProvider } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppCard } from '@/components/app-card'
import { AppView } from '@/components/app-view'
import { AlarmsBell } from '@/components/alarms-bell'
import { CommandPalette } from '@/components/command-palette'
import { ActivityPage } from '@/components/activity-page'
import { SettingsPage } from '@/components/settings-page'
import { LogDock, type LogDockHandle } from '@/components/log-dock'
import { AppFormDialog } from '@/components/app-form-dialog'
import { Sidebar, type View } from '@/components/sidebar'
import { StatTiles } from '@/components/stat-tiles'
import { ThemeToggle } from '@/components/theme-toggle'
import { EnvModal } from '@/components/env-modal'
import { Plus, RotateCw, SquareTerminal } from 'lucide-react'

function Dashboard() {
  const [apps, setApps] = useState<AppInfo[]>([])
  const [profiles, setProfiles] = useState<Record<string, string[]>>({})
  const [audit, setAudit] = useState<AuditEntry[]>([])
  // 'connecting' until the stream settles — a page load must not flash red
  const [connection, setConnection] = useState<'connecting' | 'live' | 'down'>('connecting')
  const [formOpen, setFormOpen] = useState(false)
  const [editApp, setEditApp] = useState<AppInfo | null>(null)
  const [view, setView] = useState<View>('overview')
  const [envOpen, setEnvOpen] = useState(false)
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

  const [refreshing, setRefreshing] = useState(false)
  const refresh = useCallback(() => {
    setRefreshing(true)
    Promise.allSettled([
      getState().then((s) => { setApps(s.apps); setProfiles(s.profiles ?? {}); stateBus.emit(s.apps) }),
      getAudit().then(setAudit),
    ]).finally(() => setTimeout(() => setRefreshing(false), 400))
  }, [])

  // Keyboard shortcut: R refreshes state + audit (ignored while typing in a field)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'r' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return
      e.preventDefault()
      refresh()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [refresh])

  useEffect(() => {
    refresh()
    let es: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let lastEventAt = Date.now()
    const connect = () => {
      es?.close()
      setConnection((prev) => (prev === 'live' ? prev : 'connecting'))
      es = new EventSource('/api/events')
      lastEventAt = Date.now()
      es.onopen = () => {
        setConnection('live')
        refresh()
      }
      es.onerror = () => {
        setConnection('down')
        // onerror can fire repeatedly — detach handlers and coalesce into ONE retry
        if (es) { es.onerror = null; es.onopen = null; es.onmessage = null; es.close(); es = null }
        if (retry) clearTimeout(retry)
        retry = setTimeout(connect, 3000)
      }
      es.onmessage = (ev) => {
        lastEventAt = Date.now()
        setConnection('live')
        const { type, data } = JSON.parse(ev.data)
        if (type === 'state') getState().then((s) => { setApps(s.apps); setProfiles(s.profiles ?? {}); stateBus.emit(s.apps) }).catch(() => {})
        if (type === 'audit') getAudit().then(setAudit).catch(() => {})
        if (type === 'log') logBus.emit(data)
        if (type === 'alarm') alarmsBus.emit()
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
    // Watchdog: the server sends a 'ping' event every 25s — if nothing arrived for 60s
    // the stream is silently dead (sleep/wake, proxy drop): force a reconnect.
    const watchdog = setInterval(() => {
      if (Date.now() - lastEventAt > 60000) {
        setConnection('down')
        if (retry) clearTimeout(retry)
        if (es) { es.onerror = null; es.onopen = null; es.onmessage = null; es.close(); es = null }
        connect()
      }
    }, 10000)
    return () => {
      es?.close()
      if (retry) clearTimeout(retry)
      clearInterval(interval)
      clearInterval(watchdog)
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
              {viewedApp ? viewedApp.name : view === 'activity' ? 'Activity' : view === 'settings' ? 'Settings' : 'Overview'}
            </h1>
            <p className="text-[11px] text-muted-foreground">
              {viewedApp
                ? viewedApp.description || 'App details, processes and metrics'
                : view === 'activity'
                  ? 'Who did what, when, and why — across sessions, UI and system'
                  : view === 'settings'
                    ? 'Environment, notifications and profiles'
                    : 'Monitor and control your local apps'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {refreshing && <RotateCw className="size-3.5 animate-spin text-muted-foreground" />}
            <Button variant="outline" size="sm" onClick={() => setEnvOpen(true)} title="Environment variables inherited by managed processes">
              <SquareTerminal className="size-3.5" /> env
            </Button>
            <AlarmsBell
              onOpenLog={(app, proc, ts) => {
                dockRef.current?.open(app, proc)
                if (ts) anchorBus.emit({ app, proc, ts })
              }}
            />
            {/* Fixed width: label length varies (live / connecting / disconnected) and a
                shrinking badge would shift the whole header row on every state change. */}
            <Badge
              variant="outline"
              title={
                connection === 'live'
                  ? 'connected — receiving live updates'
                  : connection === 'connecting'
                    ? 'connecting to the daemon…'
                    : 'disconnected — retrying every 3s'
              }
              className={cn(
                'w-16 justify-start',
                connection === 'live'
                  ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                  : connection === 'connecting'
                    ? 'animate-pulse border-amber-500/40 text-amber-600 dark:text-amber-400'
                    : 'border-red-500/40 text-red-600 dark:text-red-400'
              )}
            >
              <span className={cn(
                'mr-1 size-1.5 shrink-0 rounded-full',
                connection === 'live' ? 'bg-emerald-500' : connection === 'connecting' ? 'bg-amber-500' : 'bg-red-500'
              )} />
              {connection === 'live' ? 'live' : connection === 'connecting' ? '…' : 'down'}
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
            ) : view === 'settings' ? (
              <SettingsPage apps={apps} onChanged={refresh} />
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

      <CommandPalette
        apps={apps}
        onNavigate={setView}
        onRefresh={refresh}
        onLogs={(app, proc) => dockRef.current?.open(app, proc)}
      />
      <AppFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editApp={editApp}
        onSaved={refresh}
      />
      <EnvModal open={envOpen} onOpenChange={setEnvOpen} />
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
