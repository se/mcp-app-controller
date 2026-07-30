import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { saveAppEnv, type AppInfo } from '@/lib/api'
import { Check, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

type KV = { key: string; value: string }
const toKv = (r: Record<string, string>): KV[] => Object.entries(r).map(([key, value]) => ({ key, value }))
const fromKv = (rows: KV[]): Record<string, string> =>
  Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]))

function KvTable({ rows, onChange }: { rows: KV[]; onChange: (rows: KV[]) => void }) {
  const set = (i: number, patch: Partial<KV>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div className="flex flex-col gap-1.5">
      {rows.length === 0 && <div className="text-[11px] text-muted-foreground">No variables.</div>}
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input value={r.key} onChange={(e) => set(i, { key: e.target.value })}
            placeholder="KEY" className="h-7 w-56 font-mono text-xs" />
          <Input value={r.value} onChange={(e) => set(i, { value: e.target.value })}
            placeholder="value" className="h-7 flex-1 font-mono text-xs" />
          <Button variant="ghost" size="icon-xs" className="shrink-0 text-muted-foreground hover:text-red-500"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <Trash2 className="size-3" />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" className="mt-1 h-7 w-fit text-xs"
        onClick={() => onChange([...rows, { key: '', value: '' }])}>
        <Plus className="size-3" /> add variable
      </Button>
    </div>
  )
}

/**
 * Environment layers editor for an app:
 * app-wide vars < active environment set (dev/test/staging/prod...) < per-process vars.
 */
export function EnvCard({ app, onChanged }: { app: AppInfo; onChanged: () => void }) {
  const [appEnv, setAppEnv] = useState<KV[]>(toKv(app.env))
  const [envs, setEnvs] = useState<Record<string, KV[]>>(
    Object.fromEntries(Object.entries(app.environments).map(([k, v]) => [k, toKv(v)]))
  )
  const [active, setActive] = useState<string>(app.activeEnvironment ?? '')
  const [selectedEnv, setSelectedEnv] = useState<string>(app.activeEnvironment ?? Object.keys(app.environments)[0] ?? '')
  const [newEnvName, setNewEnvName] = useState('')
  const [selectedProc, setSelectedProc] = useState<string>(app.processes[0]?.name ?? '')
  const [procEnvs, setProcEnvs] = useState<Record<string, KV[]>>(
    Object.fromEntries(app.processes.map((p) => [p.name, toKv(p.env)]))
  )
  const [dirty, setDirty] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')

  // Re-sync when a different app is opened
  useEffect(() => {
    setAppEnv(toKv(app.env))
    setEnvs(Object.fromEntries(Object.entries(app.environments).map(([k, v]) => [k, toKv(v)])))
    setActive(app.activeEnvironment ?? '')
    setSelectedEnv(app.activeEnvironment ?? Object.keys(app.environments)[0] ?? '')
    setSelectedProc(app.processes[0]?.name ?? '')
    setProcEnvs(Object.fromEntries(app.processes.map((p) => [p.name, toKv(p.env)])))
    setDirty(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.name])

  const markDirty = () => setDirty(true)

  const save = async () => {
    try {
      await saveAppEnv(app.name, {
        env: fromKv(appEnv),
        environments: Object.fromEntries(Object.entries(envs).map(([k, v]) => [k, fromKv(v)])),
        activeEnvironment: active,
        processEnv: Object.fromEntries(Object.entries(procEnvs).map(([k, v]) => [k, fromKv(v)])),
      })
      setDirty(false)
      setSavedMsg('Saved — restart processes to apply the new variables.')
      setTimeout(() => setSavedMsg(''), 5000)
      onChanged()
    } catch (err) {
      alert((err as Error).message)
    }
  }

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-row items-center justify-between border-b px-4 py-2.5">
        <div>
          <span className="text-sm font-medium">Environment</span>
          <span className="ml-2 text-[11px] text-muted-foreground">
            layering: shell env → app-wide → active set → per-process
          </span>
        </div>
        <div className="flex items-center gap-2">
          {savedMsg && <span className="text-[11px] text-emerald-600 dark:text-emerald-400">{savedMsg}</span>}
          <Button size="sm" className="h-7 text-xs" disabled={!dirty} onClick={save}>
            <Check className="size-3.5" /> Save
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-5 px-4 py-4 lg:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label className="text-xs font-medium">App-wide variables</Label>
          <KvTable rows={appEnv} onChange={(r) => { setAppEnv(r); markDirty() }} />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-medium">Environment sets</Label>
            <div className="flex items-center gap-1.5">
              <Label className="text-[11px] text-muted-foreground">active:</Label>
              <Select value={active || '__none__'} onValueChange={(v) => { setActive(v === '__none__' ? '' : v); markDirty() }}>
                <SelectTrigger size="sm" className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">(none)</SelectItem>
                  {Object.keys(envs).map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {Object.keys(envs).map((n) => (
              <button key={n}
                className={cn(
                  'rounded-md border px-2 py-0.5 text-[11px] transition-colors',
                  selectedEnv === n ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
                  active === n && selectedEnv !== n && 'border-emerald-500/60 text-emerald-600 dark:text-emerald-400'
                )}
                onClick={() => setSelectedEnv(n)}>
                {n}{active === n ? ' ●' : ''}
              </button>
            ))}
            <Input value={newEnvName} onChange={(e) => setNewEnvName(e.target.value)}
              placeholder="dev / prod…" className="h-6 w-24 text-[11px]" />
            <Button variant="outline" size="icon-xs" title="Add environment set"
              disabled={!newEnvName.trim() || newEnvName.trim() in envs}
              onClick={() => {
                const n = newEnvName.trim()
                setEnvs((prev) => ({ ...prev, [n]: [] }))
                setSelectedEnv(n)
                setNewEnvName('')
                markDirty()
              }}>
              <Plus className="size-3" />
            </Button>
          </div>
          {selectedEnv && envs[selectedEnv] !== undefined ? (
            <>
              <KvTable rows={envs[selectedEnv]} onChange={(r) => { setEnvs((prev) => ({ ...prev, [selectedEnv]: r })); markDirty() }} />
              <Button variant="ghost" size="sm" className="h-6 w-fit px-2 text-[11px] text-muted-foreground hover:text-red-500"
                onClick={() => {
                  if (!confirm(`Delete environment set '${selectedEnv}'?`)) return
                  setEnvs((prev) => {
                    const next = { ...prev }
                    delete next[selectedEnv]
                    return next
                  })
                  if (active === selectedEnv) setActive('')
                  setSelectedEnv('')
                  markDirty()
                }}>
                <Trash2 className="size-3" /> delete set
              </Button>
            </>
          ) : (
            <div className="text-[11px] text-muted-foreground">Add a set (dev, test, staging, prod…) and switch between them.</div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-medium">Per-process overrides</Label>
            <Select value={selectedProc} onValueChange={setSelectedProc}>
              <SelectTrigger size="sm" className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {app.processes.map((p) => <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {selectedProc && (
            <KvTable rows={procEnvs[selectedProc] ?? []}
              onChange={(r) => { setProcEnvs((prev) => ({ ...prev, [selectedProc]: r })); markDirty() }} />
          )}
        </div>
      </CardContent>
    </Card>
  )
}
