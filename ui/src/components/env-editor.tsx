import { useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { saveAppEnv, type AppInfo } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Check, Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

/** One flat row of the environment table. Scope: 'app' | 'set:<name>' | 'proc:<name>'. */
interface EnvRow {
  id: number
  scope: string
  key: string
  value: string
  /** Storage target for include-provided apps: shared team file vs machine-local override. */
  origin: 'shared' | 'local'
}

function StoreBadge({
  origin,
  shared,
  onToggle,
}: {
  origin: 'shared' | 'local'
  shared: string
  onToggle: () => void
}) {
  return (
    <button
      onClick={onToggle}
      title={
        origin === 'shared'
          ? `Stored in the SHARED config (committed, whole team gets it):\n${shared}\n\nClick to make it machine-local instead.`
          : `Stored in your machine-local override (gitignored .local.yaml — only this machine).\n\nClick to move it into the shared config:\n${shared}`
      }
      className={cn(
        'rounded-md border px-1.5 py-0.5 font-mono text-[10px] transition-colors',
        origin === 'shared'
          ? 'border-violet-500/50 text-violet-600 hover:bg-violet-500/10 dark:text-violet-400'
          : 'border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400'
      )}
    >
      {origin}
    </button>
  )
}

const scopeLabel = (scope: string) =>
  scope === 'app' ? 'app-wide' : scope.startsWith('set:') ? scope.slice(4) : scope.slice(5)

function ScopeBadge({ scope, active }: { scope: string; active: string }) {
  const kind = scope === 'app' ? 'app' : scope.startsWith('set:') ? 'set' : 'proc'
  const name = scopeLabel(scope)
  const isActiveSet = kind === 'set' && name === active
  return (
    <Badge
      variant="outline"
      title={
        kind === 'app'
          ? 'Applied to every process of this app'
          : kind === 'set'
            ? isActiveSet
              ? `Environment set '${name}' — ACTIVE (applied on top of app-wide vars)`
              : `Environment set '${name}' — inactive (not applied until selected)`
            : `Only for process '${name}' (highest priority)`
      }
      className={cn(
        'h-5 px-1.5 font-mono text-[10px]',
        kind === 'app' && 'text-muted-foreground',
        kind === 'set' &&
          (isActiveSet
            ? 'border-violet-500/60 text-violet-600 dark:text-violet-400'
            : 'border-violet-500/25 text-violet-600/50 dark:text-violet-400/50'),
        kind === 'proc' && 'border-sky-500/40 text-sky-600 dark:text-sky-400'
      )}
    >
      {kind === 'app' ? 'app-wide' : name}
      {isActiveSet ? ' ●' : ''}
    </Badge>
  )
}

/**
 * Environment editor as one flat, filterable table.
 * Layering at spawn: shell env → app-wide → ACTIVE set → process (left overridden by right).
 */
export function EnvCard({ app, onChanged }: { app: AppInfo; onChanged: () => void }) {
  let nextId = useMemo(() => ({ n: 0 }), [app.name]) // eslint-disable-line react-hooks/exhaustive-deps
  const isShared = !!app.source
  const buildRows = (): { rows: EnvRow[]; sets: string[] } => {
    const rows: EnvRow[] = []
    const push = (scope: string, rec: Record<string, string>, origins?: Record<string, 'shared' | 'local'>) => {
      for (const [key, value] of Object.entries(rec))
        rows.push({ id: nextId.n++, scope, key, value, origin: origins?.[key] ?? 'local' })
    }
    push('app', app.env, app.envOrigins?.env)
    for (const [set, rec] of Object.entries(app.environments)) push(`set:${set}`, rec, app.envOrigins?.environments[set])
    for (const p of app.processes) push(`proc:${p.name}`, p.env, app.envOrigins?.processes[p.name])
    return { rows, sets: Object.keys(app.environments) }
  }

  const [rows, setRows] = useState<EnvRow[]>([])
  const [sets, setSets] = useState<string[]>([])
  const [active, setActive] = useState('')
  const [dirty, setDirty] = useState(false)
  const [query, setQuery] = useState('')
  const [scopeFilter, setScopeFilter] = useState('all')
  const [newSet, setNewSet] = useState('')
  const [draft, setDraft] = useState<{ scope: string; key: string; value: string; origin: 'shared' | 'local' }>({
    scope: 'app', key: '', value: '', origin: 'local',
  })
  // Values are masked by default — they may contain secrets
  const [revealAll, setRevealAll] = useState(false)
  const [revealed, setRevealed] = useState<Set<number>>(new Set())
  const isRevealed = (id: number) => revealAll || revealed.has(id)
  const toggleReveal = (id: number) =>
    setRevealed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  useEffect(() => {
    const b = buildRows()
    setRows(b.rows)
    setSets(b.sets)
    setActive(app.activeEnvironment ?? '')
    setDirty(false)
    setScopeFilter('all')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.name])

  const scopes = useMemo(
    () => ['app', ...sets.map((s) => `set:${s}`), ...app.processes.map((p) => `proc:${p.name}`)],
    [sets, app.processes]
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows
      .filter((r) => (scopeFilter === 'all' ? true : r.scope === scopeFilter))
      .filter((r) => !q || r.key.toLowerCase().includes(q) || r.value.toLowerCase().includes(q))
      .sort((a, b) => scopes.indexOf(a.scope) - scopes.indexOf(b.scope) || a.key.localeCompare(b.key))
  }, [rows, query, scopeFilter, scopes])

  /** Runtime priority of a scope (higher wins). Inactive sets never apply. */
  const priority = (scope: string) =>
    scope === 'app' ? 1 : scope === `set:${active}` ? 2 : scope.startsWith('proc:') ? 3 : 0

  /** Which higher-priority row shadows this one at runtime, if any. */
  const shadowedBy = (row: EnvRow): string | null => {
    const p = priority(row.scope)
    if (p === 0) return null // inactive set: not applied at all
    const winner = rows
      .filter((r) => r.key === row.key && r.id !== row.id && priority(r.scope) > p)
      .sort((a, b) => priority(b.scope) - priority(a.scope))[0]
    return winner ? scopeLabel(winner.scope) : null
  }

  const update = (id: number, patch: Partial<EnvRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    setDirty(true)
  }

  const save = async () => {
    try {
      const env: Record<string, string> = {}
      const environments: Record<string, Record<string, string>> = Object.fromEntries(sets.map((s) => [s, {}]))
      const processEnv: Record<string, Record<string, string>> = Object.fromEntries(app.processes.map((p) => [p.name, {}]))
      for (const r of rows) {
        const key = r.key.trim()
        if (!key) continue
        if (r.scope === 'app') env[key] = r.value
        else if (r.scope.startsWith('set:')) (environments[r.scope.slice(4)] ??= {})[key] = r.value
        else (processEnv[r.scope.slice(5)] ??= {})[key] = r.value
      }
      const origins = isShared
        ? {
            env: Object.fromEntries(rows.filter((r) => r.scope === 'app' && r.key.trim()).map((r) => [r.key.trim(), r.origin])),
            environments: Object.fromEntries(
              sets.map((s) => [
                s,
                Object.fromEntries(rows.filter((r) => r.scope === `set:${s}` && r.key.trim()).map((r) => [r.key.trim(), r.origin])),
              ])
            ),
            processes: Object.fromEntries(
              app.processes.map((p) => [
                p.name,
                Object.fromEntries(rows.filter((r) => r.scope === `proc:${p.name}` && r.key.trim()).map((r) => [r.key.trim(), r.origin])),
              ])
            ),
          }
        : undefined
      const result = await saveAppEnv(app.name, { env, environments, activeEnvironment: active, processEnv, origins })
      setDirty(false)
      toast.success(
        isShared
          ? `Saved — ${result.sharedChanged ? 'shared config updated, ' : ''}local overrides in .local.yaml. Restart to apply.`
          : 'Environment saved — restart processes to apply.'
      )
      onChanged()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const addDraft = () => {
    const key = draft.key.trim()
    if (!key) return
    setRows((prev) => [...prev, { id: nextId.n++, scope: draft.scope, key, value: draft.value, origin: isShared ? draft.origin : 'local' }])
    setDraft((d) => ({ ...d, key: '', value: '' }))
    setDirty(true)
  }

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <span className="text-sm font-medium">Environment</span>
        <span className="text-[11px] text-muted-foreground">
          app-wide → active set → process (right overrides left)
        </span>
        <div className="ml-auto flex items-center gap-2">
          {dirty && <span className="text-[11px] text-amber-600 dark:text-amber-400">unsaved changes</span>}
          <Button size="sm" className="h-7 text-xs" disabled={!dirty} onClick={save}>
            <Check className="size-3.5" /> Save
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2 dark:bg-muted/10">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by key or value…"
          className="h-7 w-56 text-xs"
        />
        <Select value={scopeFilter} onValueChange={setScopeFilter}>
          <SelectTrigger size="sm" className="h-7 w-40 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All scopes</SelectItem>
            <SelectItem value="app">app-wide</SelectItem>
            {sets.map((s) => <SelectItem key={s} value={`set:${s}`}>set: {s}</SelectItem>)}
            {app.processes.map((p) => <SelectItem key={p.name} value={`proc:${p.name}`}>process: {p.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">active set:</span>
          <Select value={active || '__none__'} onValueChange={(v) => { setActive(v === '__none__' ? '' : v); setDirty(true) }}>
            <SelectTrigger size="sm" className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">(none)</SelectItem>
              {sets.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1">
          <Input
            value={newSet}
            onChange={(e) => setNewSet(e.target.value)}
            placeholder="new set (dev, prod…)"
            className="h-7 w-32 text-xs"
          />
          <Button variant="outline" size="icon-xs" title="Add environment set"
            disabled={!newSet.trim() || sets.includes(newSet.trim())}
            onClick={() => { setSets((prev) => [...prev, newSet.trim()]); setNewSet(''); setDirty(true) }}>
            <Plus className="size-3" />
          </Button>
          {scopeFilter.startsWith('set:') && (
            <Button variant="ghost" size="icon-xs" title={`Delete set '${scopeFilter.slice(4)}' and its variables`}
              className="text-muted-foreground hover:text-red-500"
              onClick={() => {
                const s = scopeFilter.slice(4)
                if (!confirm(`Delete environment set '${s}' and its variables?`)) return
                setSets((prev) => prev.filter((x) => x !== s))
                setRows((prev) => prev.filter((r) => r.scope !== `set:${s}`))
                if (active === s) setActive('')
                setScopeFilter('all')
                setDirty(true)
              }}>
              <Trash2 className="size-3" />
            </Button>
          )}
        </div>
        <Button variant="outline" size="sm" className="h-7 text-xs"
          onClick={() => { setRevealAll((v) => !v); setRevealed(new Set()) }}>
          {revealAll ? <><EyeOff className="size-3.5" /> Hide all</> : <><Eye className="size-3.5" /> Reveal all</>}
        </Button>
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          {filtered.length} / {rows.length} vars
        </span>
      </div>

      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-32">Scope</TableHead>
            <TableHead className="w-72">Variable</TableHead>
            <TableHead>Value</TableHead>
            <TableHead className="w-28">Effective</TableHead>
            {isShared && <TableHead className="w-20">Store</TableHead>}
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.length === 0 && (
            <TableRow>
              <TableCell colSpan={isShared ? 6 : 5} className="py-8 text-center text-xs text-muted-foreground">
                {rows.length === 0 ? 'No variables defined yet — add one below.' : 'No variables match the filter.'}
              </TableCell>
            </TableRow>
          )}
          {filtered.map((r) => {
            const shadow = shadowedBy(r)
            const inactive = priority(r.scope) === 0
            return (
              <TableRow key={r.id} className={cn((shadow || inactive) && 'opacity-70')}>
                <TableCell><ScopeBadge scope={r.scope} active={active} /></TableCell>
                <TableCell>
                  <Input value={r.key} onChange={(e) => update(r.id, { key: e.target.value })}
                    className="h-7 border-transparent bg-transparent font-mono text-xs shadow-none hover:border-input focus-visible:border-input" />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Input
                      type={isRevealed(r.id) ? 'text' : 'password'}
                      value={r.value}
                      onChange={(e) => update(r.id, { value: e.target.value })}
                      autoComplete="off"
                      className="h-7 border-transparent bg-transparent font-mono text-xs shadow-none hover:border-input focus-visible:border-input"
                    />
                    <button
                      onClick={() => toggleReveal(r.id)}
                      title={isRevealed(r.id) ? 'Hide value' : 'Reveal value'}
                      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      {isRevealed(r.id) ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </button>
                  </div>
                </TableCell>
                <TableCell className="text-[11px]">
                  {inactive ? (
                    <span className="text-muted-foreground" title="This set is not active — the variable is not applied">inactive set</span>
                  ) : shadow ? (
                    <span className="text-amber-600 dark:text-amber-400" title={`A higher-priority scope defines the same key — at runtime the value from '${shadow}' wins`}>
                      overridden by {shadow}
                    </span>
                  ) : (
                    <span className="text-emerald-600 dark:text-emerald-400">applies</span>
                  )}
                </TableCell>
                {isShared && (
                  <TableCell>
                    <StoreBadge origin={r.origin} shared={app.source!}
                      onToggle={() => update(r.id, { origin: r.origin === 'shared' ? 'local' : 'shared' })} />
                  </TableCell>
                )}
                <TableCell>
                  <Button variant="ghost" size="icon-xs" title="Remove variable"
                    className="text-muted-foreground hover:text-red-500"
                    onClick={() => { setRows((prev) => prev.filter((x) => x.id !== r.id)); setDirty(true) }}>
                    <Trash2 className="size-3" />
                  </Button>
                </TableCell>
              </TableRow>
            )
          })}
          <TableRow className="hover:bg-transparent">
            <TableCell>
              <Select value={draft.scope} onValueChange={(v) => setDraft((d) => ({ ...d, scope: v }))}>
                <SelectTrigger size="sm" className="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="app">app-wide</SelectItem>
                  {sets.map((s) => <SelectItem key={s} value={`set:${s}`}>set: {s}</SelectItem>)}
                  {app.processes.map((p) => <SelectItem key={p.name} value={`proc:${p.name}`}>process: {p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </TableCell>
            <TableCell>
              <Input value={draft.key} onChange={(e) => setDraft((d) => ({ ...d, key: e.target.value }))}
                placeholder="NEW_VARIABLE" className="h-7 font-mono text-xs" />
            </TableCell>
            <TableCell>
              <Input value={draft.value} onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && addDraft()}
                placeholder="value" className="h-7 font-mono text-xs" />
            </TableCell>
            <TableCell colSpan={isShared ? 3 : 2}>
              <div className="flex items-center gap-2">
                {isShared && (
                  <Select value={draft.origin} onValueChange={(v) => setDraft((d) => ({ ...d, origin: v as 'shared' | 'local' }))}>
                    <SelectTrigger size="sm" className="h-7 w-24 text-xs" title="Where the new variable is stored">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="local">local</SelectItem>
                      <SelectItem value="shared">shared</SelectItem>
                    </SelectContent>
                  </Select>
                )}
                <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!draft.key.trim()} onClick={addDraft}>
                  <Plus className="size-3" /> Add
                </Button>
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </Card>
  )
}
