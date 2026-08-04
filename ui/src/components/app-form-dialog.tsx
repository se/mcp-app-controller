import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { saveApp, type AppDefInput, type AppInfo } from '@/lib/api'
import { Plus, X } from 'lucide-react'

interface ProcForm {
  name: string
  command: string
  devCommand: string
  cwd: string
  env: Record<string, string>
  autoRestart: boolean
  healthUrl: string
  healthPort: string
  ownLogTimestamps: boolean
  ports: string
  dependsOn: string
}

const emptyProc: ProcForm = {
  name: '', command: '', devCommand: '', cwd: '', env: {}, autoRestart: false,
  healthUrl: '', healthPort: '', ownLogTimestamps: false, ports: '', dependsOn: '',
}

function SectionDivider({ label, className }: { label: string; className?: string }) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</span>
      <Separator className="flex-1" />
    </div>
  )
}

export function AppFormDialog({
  open,
  onOpenChange,
  editApp,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  editApp: AppInfo | null
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [cwd, setCwd] = useState('')
  const [prepare, setPrepare] = useState('')
  const [prepareOrder, setPrepareOrder] = useState<'after-stop' | 'before-stop'>('after-stop')
  const [clean, setClean] = useState('')
  const [staggerMs, setStaggerMs] = useState('')
  const [procs, setProcs] = useState<ProcForm[]>([{ ...emptyProc }])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setError('')
    if (editApp) {
      setName(editApp.name)
      setDescription(editApp.description)
      setCwd(editApp.cwd)
      setPrepare(editApp.prepare ?? '')
      setPrepareOrder(editApp.prepareOrder ?? 'after-stop')
      setClean(editApp.clean ?? '')
      setStaggerMs(editApp.staggerMs > 0 ? String(editApp.staggerMs) : '')
      setProcs(
        editApp.processes.map((p) => ({
          name: p.name,
          command: p.command,
          devCommand: p.devCommand ?? '',
          cwd: p.cwd ?? '',
          env: p.env ?? {},
          autoRestart: p.autoRestart,
          healthUrl: p.healthUrl ?? '',
          healthPort: p.healthPort != null ? String(p.healthPort) : '',
          ownLogTimestamps: p.ownLogTimestamps ?? false,
          ports: (p.ports ?? []).join(', '),
          dependsOn: (p.dependsOn ?? []).join(', '),
        }))
      )
    } else {
      setName('')
      setDescription('')
      setCwd('')
      setPrepare('')
      setPrepareOrder('after-stop')
      setClean('')
      setStaggerMs('')
      setProcs([{ ...emptyProc }])
    }
  }, [open, editApp])

  const updateProc = (i: number, patch: Partial<ProcForm>) => {
    setProcs((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  }

  const submit = async (saveTo?: 'source') => {
    setSaving(true)
    setError('')
    const def: AppDefInput = {
      name: name.trim(),
      description: description.trim(),
      cwd: cwd.trim(),
      // Preserve fields this dialog doesn't manage (saved def replaces the whole app)
      ...(editApp
        ? {
            env: editApp.env,
            environments: editApp.environments,
            ...(editApp.activeEnvironment ? { activeEnvironment: editApp.activeEnvironment } : {}),
          }
        : {}),
      ...(prepare.trim() ? { prepare: prepare.trim(), prepareOrder } : {}),
      ...(clean.trim() ? { clean: clean.trim() } : {}),
      ...(Number(staggerMs) > 0 ? { staggerMs: Number(staggerMs) } : {}),
      processes: procs.map((p) => ({
        name: p.name.trim(),
        command: p.command.trim(),
        devCommand: p.devCommand.trim() || undefined,
        cwd: p.cwd.trim() || undefined,
        env: p.env,
        autoRestart: p.autoRestart,
        healthUrl: p.healthUrl.trim() || undefined,
        healthPort: p.healthPort.trim() ? Number(p.healthPort.trim()) : undefined,
        ownLogTimestamps: p.ownLogTimestamps,
        ports: p.ports
          .split(/[\s,]+/)
          .map((x) => Number(x))
          .filter((n) => Number.isInteger(n) && n > 0),
        dependsOn: p.dependsOn.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
      })),
    }
    try {
      await saveApp(def, saveTo)
      onOpenChange(false)
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editApp ? `App config — ${editApp.name}` : 'New app config'}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4">
          <SectionDivider label="General" />
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label className="text-xs" htmlFor="app-name">Name</Label>
              <Input id="app-name" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="my-app" disabled={!!editApp} />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs" htmlFor="app-desc">Description</Label>
              <Input id="app-desc" value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="Next.js frontend" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs" htmlFor="app-cwd">Working directory</Label>
            <Input id="app-cwd" value={cwd} onChange={(e) => setCwd(e.target.value)}
              placeholder="/path/to/my-app" className="font-mono text-xs" />
          </div>
          <SectionDivider label="Build" className="mt-2" />
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div className="grid gap-1.5">
              <Label className="text-xs" htmlFor="app-prepare">Prepare command<span className="font-normal text-muted-foreground">optional</span></Label>
              <Input id="app-prepare" value={prepare} onChange={(e) => setPrepare(e.target.value)}
                placeholder="dotnet build Shared.sln — build-once before starting 2+ processes" className="font-mono text-xs" />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs" htmlFor="app-stagger">Stagger (ms)</Label>
              <Input id="app-stagger" value={staggerMs} onChange={(e) => setStaggerMs(e.target.value)}
                placeholder="0" inputMode="numeric" className="text-xs" />
            </div>
          </div>
          {prepare.trim() !== '' && (
            <div className="grid gap-1.5">
              <Label className="text-xs">Restart order</Label>
              <Select value={prepareOrder} onValueChange={(v) => setPrepareOrder(v as 'after-stop' | 'before-stop')}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="after-stop" className="text-xs">
                    Kill first, then build — no file locks; restart always serves the fresh build (default)
                  </SelectItem>
                  <SelectItem value="before-stop" className="text-xs">
                    Build first, then kill — old process keeps serving during the build; failed build leaves it running
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label className="text-xs" htmlFor="app-clean">Clean command<span className="font-normal text-muted-foreground">optional</span></Label>
            <Input id="app-clean" value={clean} onChange={(e) => setClean(e.target.value)}
              placeholder="e.g. bash core/fastBuild/build.sh --clean — run via the clean button to clear build caches" className="font-mono text-xs" />
          </div>

          <SectionDivider label="Processes" className="mt-2" />

          {procs.map((p, i) => (
            <div key={i} className="overflow-hidden rounded-lg border bg-muted/40 shadow-sm dark:bg-muted/20">
              <div className="flex items-center justify-between border-b bg-muted py-1.5 pl-3 pr-1.5 dark:bg-muted/60">
                <span className="flex items-center gap-2 text-xs font-semibold">
                  <span className="flex size-4 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">{i + 1}</span>
                  {p.name || `process ${i + 1}`}
                </span>
                {procs.length > 1 && (
                  <Button variant="ghost" size="icon-sm" className="size-6 text-muted-foreground hover:text-red-500"
                    title="Remove this process"
                    onClick={() => setProcs((prev) => prev.filter((_, j) => j !== i))}>
                    <X className="size-3.5" />
                  </Button>
                )}
              </div>
              <div className="grid gap-3 p-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label className="text-xs">Process name</Label>
                  <Input value={p.name} onChange={(e) => updateProc(i, { name: e.target.value })} placeholder="web" />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Subdirectory<span className="font-normal text-muted-foreground">optional</span></Label>
                  <Input value={p.cwd} onChange={(e) => updateProc(i, { cwd: e.target.value })}
                    placeholder="packages/web" className="font-mono text-xs" />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Start command</Label>
                  <Input value={p.command} onChange={(e) => updateProc(i, { command: e.target.value })}
                    placeholder="npm run start" className="font-mono text-xs" />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Dev command<span className="font-normal text-muted-foreground">optional</span></Label>
                  <Input value={p.devCommand} onChange={(e) => updateProc(i, { devCommand: e.target.value })}
                    placeholder="npm run dev" className="font-mono text-xs" />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Health URL<span className="font-normal text-muted-foreground">optional</span></Label>
                  <Input value={p.healthUrl} onChange={(e) => updateProc(i, { healthUrl: e.target.value })}
                    placeholder="http://127.0.0.1:3000/" className="font-mono text-xs" />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Health TCP port<span className="font-normal text-muted-foreground">optional</span></Label>
                  <Input value={p.healthPort} onChange={(e) => updateProc(i, { healthPort: e.target.value })}
                    placeholder="3000" inputMode="numeric" className="font-mono text-xs" />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Ports<span className="font-normal text-muted-foreground">optional, comma separated</span></Label>
                  <Input value={p.ports} onChange={(e) => updateProc(i, { ports: e.target.value })}
                    placeholder="4070, 4470" className="font-mono text-xs" />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Depends on<span className="font-normal text-muted-foreground">optional, process names</span></Label>
                  <Input value={p.dependsOn} onChange={(e) => updateProc(i, { dependsOn: e.target.value })}
                    placeholder="api, account" className="font-mono text-xs" />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <div className="flex items-center gap-2">
                  <Switch size="sm" checked={p.autoRestart} onCheckedChange={(v) => updateProc(i, { autoRestart: v })} />
                  <Label className="text-xs text-muted-foreground">auto-restart on crash</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch size="sm" checked={p.ownLogTimestamps} onCheckedChange={(v) => updateProc(i, { ownLogTimestamps: v })} />
                  <Label className="text-xs text-muted-foreground">logs contain own timestamps</Label>
                </div>
              </div>
              </div>
            </div>
          ))}

          <Button variant="outline" size="sm"
            className="w-full border-dashed text-muted-foreground hover:border-solid hover:text-foreground"
            onClick={() => setProcs((prev) => [...prev, { ...emptyProc }])}>
            <Plus className="size-3.5" /> add process
          </Button>

          {error && <div className="whitespace-pre-wrap text-xs text-red-400">{error}</div>}
        </div>

        <DialogFooter className="sticky -bottom-6 -mx-6 -mb-6 border-t bg-background/95 px-6 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          {editApp?.source && (
            <span className="mr-auto min-w-0 self-center truncate text-[11px] text-muted-foreground" title={editApp.source}>
              shared config: <span className="font-mono">{editApp.source}</span>
            </span>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          {editApp?.source ? (
            <>
              <Button variant="outline" onClick={() => submit()} disabled={saving || !name.trim() || !cwd.trim()}
                title={'Saves a personal copy into your apps.yaml — overrides the shared definition on this machine only.'}>
                {saving ? 'Saving…' : 'Save personal copy'}
              </Button>
              <Button onClick={() => submit('source')} disabled={saving || !name.trim() || !cwd.trim()}
                title={`Writes into the shared config file:\n${editApp.source}\n\nThe file is in the repo — committing the change affects the whole team. A .local.yaml override (if present) still merges on top.`}>
                {saving ? 'Saving…' : 'Save to shared file'}
              </Button>
            </>
          ) : (
            <Button onClick={() => submit()} disabled={saving || !name.trim() || !cwd.trim()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
