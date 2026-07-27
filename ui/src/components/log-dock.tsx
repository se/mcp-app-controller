import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  DockviewReact,
  themeAbyss,
  themeLight,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
} from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import { LogViewPanel } from './log-view-panel'
import { stateBus } from '@/lib/log-bus'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { X } from 'lucide-react'

function LogTab(props: IDockviewPanelHeaderProps<{ app: string; proc: string }>) {
  const { app, proc } = props.params
  const [status, setStatus] = useState<string | undefined>()

  useEffect(() => {
    const pick = () =>
      stateBus.get().find((a) => a.name === app)?.processes.find((p) => p.name === proc)?.status
    setStatus(pick())
    return stateBus.subscribe(() => setStatus(pick()))
  }, [app, proc])

  return (
    <div className="flex h-full items-center gap-1.5 px-2 text-xs">
      <span
        title={status ?? 'unknown'}
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          status === 'running' && 'bg-emerald-500',
          status === 'crashed' && 'bg-red-500',
          (status === 'stopped' || !status) && 'bg-muted-foreground/50'
        )}
      />
      <span className="whitespace-nowrap">{app}/{proc}</span>
      <button
        className="ml-1 rounded p-0.5 opacity-50 hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation()
          props.api.close()
        }}
        title="Close"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

const tabComponents = { logTab: LogTab }

export interface LogDockHandle {
  open(app: string, proc: string): void
}

const components = { logView: LogViewPanel }

const MIN_HEIGHT = 160
const LAYOUT_KEY = 'appctrl-dock-layout'
const HEIGHT_KEY = 'appctrl-dock-height'

function initialHeight(): number {
  const saved = Number(localStorage.getItem(HEIGHT_KEY))
  const fallback = Math.round(window.innerHeight * 0.42)
  return Number.isFinite(saved) && saved >= MIN_HEIGHT ? saved : fallback
}

export const LogDock = forwardRef<LogDockHandle>(function LogDock(_props, ref) {
  const apiRef = useRef<DockviewApi | null>(null)
  const dockElRef = useRef<HTMLDivElement | null>(null)
  const [panelCount, setPanelCount] = useState(0)
  const [height, setHeight] = useState(initialHeight)
  const { resolved } = useTheme()

  // Middle-click on a tab closes it (browser-tab behavior). Native listeners so it
  // also works on tabs restored from a persisted layout (default tab component).
  useEffect(() => {
    const el = dockElRef.current
    if (!el) return
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1 && (e.target as HTMLElement).closest('.dv-tab')) e.preventDefault()
    }
    const onAuxClick = (e: MouseEvent) => {
      if (e.button !== 1) return
      const tabEl = (e.target as HTMLElement).closest('.dv-tab')
      if (!tabEl || !apiRef.current) return
      e.preventDefault()
      const id = (tabEl.textContent ?? '').trim()
      apiRef.current.panels.find((p) => p.id === id)?.api.close()
    }
    el.addEventListener('mousedown', onMouseDown)
    el.addEventListener('auxclick', onAuxClick)
    return () => {
      el.removeEventListener('mousedown', onMouseDown)
      el.removeEventListener('auxclick', onAuxClick)
    }
  }, [])

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api
    event.api.onDidAddPanel(() => setPanelCount(event.api.panels.length))
    event.api.onDidRemovePanel(() => setPanelCount(event.api.panels.length))

    // Restore saved layout (open tabs + splits), then persist changes debounced
    const saved = localStorage.getItem(LAYOUT_KEY)
    if (saved) {
      try {
        event.api.fromJSON(JSON.parse(saved))
        setPanelCount(event.api.panels.length)
      } catch {
        localStorage.removeItem(LAYOUT_KEY)
      }
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    event.api.onDidLayoutChange(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        try {
          if (event.api.panels.length === 0) localStorage.removeItem(LAYOUT_KEY)
          else localStorage.setItem(LAYOUT_KEY, JSON.stringify(event.api.toJSON()))
        } catch {
          // persistence is best-effort
        }
      }, 500)
    })
  }, [])

  useImperativeHandle(ref, () => ({
    open(app: string, proc: string) {
      const api = apiRef.current
      if (!api) return
      const id = `${app}/${proc}`
      const existing = api.getPanel(id)
      if (existing) {
        existing.api.setActive()
        return
      }
      api.addPanel({
        id,
        component: 'logView',
        tabComponent: 'logTab',
        title: id,
        params: { app, proc },
      })
    },
  }))

  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = height
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(
        Math.max(startHeight + (startY - ev.clientY), MIN_HEIGHT),
        window.innerHeight - 120
      )
      setHeight(next)
    }
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const finalHeight = Math.min(
        Math.max(startHeight + (startY - ev.clientY), MIN_HEIGHT),
        window.innerHeight - 120
      )
      localStorage.setItem(HEIGHT_KEY, String(finalHeight))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      className="shrink-0 border-t bg-background"
      style={{ height: panelCount > 0 ? height : 0, display: panelCount > 0 ? 'flex' : 'none', flexDirection: 'column' }}
    >
      <div
        className="h-1.5 shrink-0 cursor-row-resize bg-border/40 transition-colors hover:bg-primary/50"
        onMouseDown={startResize}
        title="Drag to resize"
      />
      <div className="min-h-0 flex-1" ref={dockElRef}>
        <DockviewReact
          components={components}
          tabComponents={tabComponents}
          onReady={onReady}
          theme={resolved === 'dark' ? themeAbyss : themeLight}
        />
      </div>
    </div>
  )
})
