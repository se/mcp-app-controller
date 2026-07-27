import { useEffect, useMemo, useRef, useState } from 'react'
import type { IDockviewPanelProps } from 'dockview-react'
import { AnsiUp } from 'ansi_up'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { appAction, getLogs, getState, type ProcInfo } from '@/lib/api'
import { logBus, stateBus } from '@/lib/log-bus'
import { cn } from '@/lib/utils'
import { Play, RotateCw, Square, Trash2, Wrench } from 'lucide-react'

// Controller-added prefix: "[2026-07-25T17:41:20.052Z] "
const TS_PREFIX_RE = /^\[\d{4}-\d{2}-\d{2}T[0-9:.]+Z\]\s?/

const MAX_LINES = 5000
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]/g
const stripAnsi = (s: string) => s.replace(ANSI_RE, '')

// fzf-style subsequence match: every char of `term` appears in `text` in order
function fuzzyTerm(term: string, text: string): boolean {
  let i = 0
  for (let j = 0; j < text.length && i < term.length; j++) {
    if (text[j] === term[i]) i++
  }
  return i === term.length
}

type SearchMode = 'fuzzy' | 'text' | 'regex'

const MODES: { key: SearchMode; label: string; title: string }[] = [
  { key: 'fuzzy', label: 'fuzzy', title: 'fzf-style subsequence match; space-separated terms are AND-ed' },
  { key: 'text', label: 'text', title: 'plain substring match; space-separated terms are AND-ed' },
  { key: 'regex', label: '.*', title: 'JavaScript regex (case-insensitive)' },
]

export function LogViewPanel({ params }: IDockviewPanelProps<{ app: string; proc: string }>) {
  const { app, proc } = params
  const [lines, setLines] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [mode, setMode] = useState<SearchMode>('fuzzy')
  const [follow, setFollow] = useState(true)
  const [hideTs, setHideTs] = useState(false)
  const [procInfo, setProcInfo] = useState<ProcInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(follow)
  followRef.current = follow


  useEffect(() => {
    const pick = (apps: { name: string; processes: ProcInfo[] }[]) =>
      apps.find((a) => a.name === app)?.processes.find((x) => x.name === proc) ?? null
    // Initial value: cached state if present, otherwise fetch once
    const cached = pick(stateBus.get())
    if (cached) {
      setProcInfo(cached)
      if (cached.ownLogTimestamps) setHideTs(true)
    } else {
      getState()
        .then((s) => {
          const p = pick(s.apps)
          setProcInfo(p)
          if (p?.ownLogTimestamps) setHideTs(true)
        })
        .catch(() => {})
    }
    return stateBus.subscribe((apps) => setProcInfo(pick(apps)))
  }, [app, proc])

  const act = async (action: 'start' | 'stop' | 'restart', runMode?: 'start' | 'dev') => {
    setBusy(true)
    try {
      await appAction(app, action, {
        process: proc,
        mode: runMode,
        reason: `manual ${action}${runMode === 'dev' ? ' (dev)' : ''} from log panel`,
      })
    } catch (err) {
      alert((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    getLogs(app, proc, 500)
      .then(({ logs }) => {
        if (!cancelled) setLines(logs ? logs.split('\n') : [])
      })
      .catch((err) => {
        if (!cancelled) setLines([`error loading logs: ${err.message}`])
      })
    const unsub = logBus.subscribe((e) => {
      if (e.app !== app || e.proc !== proc) return
      setLines((prev) => {
        const next = [...prev, e.line]
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next
      })
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [app, proc])

  const query = search.trim()
  const regex = useMemo(() => {
    if (mode !== 'regex' || !query) return null
    try {
      return { re: new RegExp(query, 'i'), error: null }
    } catch (err) {
      return { re: null, error: (err as Error).message }
    }
  }, [mode, query])

  const visible = useMemo(() => {
    if (!query) return lines
    if (mode === 'regex') {
      if (!regex?.re) return lines // invalid regex: show all, error shown in toolbar
      return lines.filter((l) => regex.re!.test(stripAnsi(l)))
    }
    const terms = query.toLowerCase().split(/\s+/)
    return lines.filter((l) => {
      const text = stripAnsi(l).toLowerCase()
      return mode === 'fuzzy' ? terms.every((t) => fuzzyTerm(t, text)) : terms.every((t) => text.includes(t))
    })
  }, [lines, query, mode, regex])

  // Fresh AnsiUp per conversion: it is stateful across calls (open-color carry-over),
  // so converting the whole visible block at once keeps multi-line colors correct.
  const html = useMemo(() => {
    if (visible.length === 0) return ''
    const shown = hideTs ? visible.map((l) => l.replace(TS_PREFIX_RE, '')) : visible
    const au = new AnsiUp()
    return au.ansi_to_html(shown.join('\n'))
  }, [visible, hideTs])

  useEffect(() => {
    if (followRef.current && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [visible])

  const running = procInfo?.status === 'running'

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex shrink-0 items-center gap-3 border-b px-3 py-1.5">
        <div className="flex items-center gap-1 border-r pr-2">
          <span
            title={procInfo ? `${procInfo.status}${procInfo.mode ? ` (${procInfo.mode})` : ''}` : 'unknown'}
            className={cn(
              'mr-1 size-2 shrink-0 rounded-full',
              running && 'bg-emerald-500',
              procInfo?.status === 'stopped' && 'bg-muted-foreground/50',
              procInfo?.status === 'crashed' && 'bg-red-500'
            )}
          />
          {running ? (
            <>
              <Button variant="ghost" size="icon-xs" title="Restart" disabled={busy}
                onClick={() => act('restart')}>
                <RotateCw className="size-3" />
              </Button>
              <Button variant="ghost" size="icon-xs" title="Stop" disabled={busy}
                className="hover:text-red-500" onClick={() => act('stop')}>
                <Square className="size-3" />
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="icon-xs" title="Start" disabled={busy}
                className="hover:text-emerald-500" onClick={() => act('start', 'start')}>
                <Play className="size-3" />
              </Button>
              {procInfo?.devCommand && (
                <Button variant="ghost" size="icon-xs" title="Start in dev mode" disabled={busy}
                  className="hover:text-sky-500" onClick={() => act('start', 'dev')}>
                  <Wrench className="size-3" />
                </Button>
              )}
            </>
          )}
        </div>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={mode === 'regex' ? 'regex search logs…' : mode === 'fuzzy' ? 'fuzzy search logs…' : 'search logs…'}
          className={`h-7 w-56 text-xs ${regex?.error ? 'border-red-500/70' : ''}`}
        />
        <div className="flex overflow-hidden rounded-md border">
          {MODES.map((m) => (
            <button
              key={m.key}
              title={m.title}
              onClick={() => setMode(m.key)}
              className={`px-2 py-0.5 font-mono text-[11px] transition-colors ${
                mode === m.key
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        {regex?.error ? (
          <span className="max-w-72 truncate text-[11px] text-red-400" title={regex.error}>
            invalid regex
          </span>
        ) : (
          query && (
            <span className="text-[11px] text-muted-foreground">
              {visible.length} / {lines.length} lines
            </span>
          )
        )}
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Checkbox
              id={`ts-${app}-${proc}`}
              checked={!hideTs}
              onCheckedChange={(v) => setHideTs(v !== true)}
              className="size-3.5"
            />
            <Label htmlFor={`ts-${app}-${proc}`} className="text-[11px] text-muted-foreground">
              timestamps
            </Label>
          </div>
          <div className="flex items-center gap-1.5">
            <Checkbox
              id={`follow-${app}-${proc}`}
              checked={follow}
              onCheckedChange={(v) => setFollow(v === true)}
              className="size-3.5"
            />
            <Label htmlFor={`follow-${app}-${proc}`} className="text-[11px] text-muted-foreground">
              follow
            </Label>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            title="Clear view"
            className="text-muted-foreground"
            onClick={() => setLines([])}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {visible.length === 0 ? (
          <pre className="font-mono text-xs text-muted-foreground">
            {query ? 'no matching lines' : '(no logs yet)'}
          </pre>
        ) : (
          <pre
            className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground/80"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
    </div>
  )
}
