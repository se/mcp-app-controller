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
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
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
      setStaggerMs('')
      setProcs([{ ...emptyProc }])
    }
  }, [open, editApp])

  const updateProc = (i: number, patch: Partial<ProcForm>) => {
    setProcs((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  }

  const submit = async () => {
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
      ...(prepare.trim() ? { prepare: prepare.trim() } : {}),
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
      await saveApp(def)
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editApp ? `Edit ${editApp.name}` : 'New App'}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="app-name">Name</Label>
              <Input id="app-name" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="my-app" disabled={!!editApp} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="app-desc">Description</Label>
              <Input id="app-desc" value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="Next.js frontend" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="app-cwd">Working directory</Label>
            <Input id="app-cwd" value={cwd} onChange={(e) => setCwd(e.target.value)}
              placeholder="/path/to/my-app" className="font-mono text-xs" />
          </div>
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="app-prepare">Prepare command (optional)</Label>
              <Input id="app-prepare" value={prepare} onChange={(e) => setPrepare(e.target.value)}
                placeholder="dotnet build Shared.sln — build-once before starting 2+ processes" className="font-mono text-xs" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="app-stagger">Stagger (ms)</Label>
              <Input id="app-stagger" value={staggerMs} onChange={(e) => setStaggerMs(e.target.value)}
                placeholder="0" inputMode="numeric" className="text-xs" />
            </div>
          </div>

          <Separator />
          <div className="text-sm font-medium text-muted-foreground">Processes</div>

          {procs.map((p, i) => (
            <div key={i} className="relative grid gap-3 rounded-lg border p-3">
              {procs.length > 1 && (
                <Button variant="ghost" size="icon-sm" className="absolute right-1.5 top-1.5"
                  onClick={() => setProcs((prev) => prev.filter((_, j) => j !== i))}>
                  <X className="size-3.5" />
                </Button>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label>Process name</Label>
                  <Input value={p.name} onChange={(e) => updateProc(i, { name: e.target.value })} placeholder="web" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Subdirectory (optional)</Label>
                  <Input value={p.cwd} onChange={(e) => updateProc(i, { cwd: e.target.value })}
                    placeholder="packages/web" className="font-mono text-xs" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Start command</Label>
                  <Input value={p.command} onChange={(e) => updateProc(i, { command: e.target.value })}
                    placeholder="npm run start" className="font-mono text-xs" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Dev command (optional)</Label>
                  <Input value={p.devCommand} onChange={(e) => updateProc(i, { devCommand: e.target.value })}
                    placeholder="npm run dev" className="font-mono text-xs" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Health URL (optional)</Label>
                  <Input value={p.healthUrl} onChange={(e) => updateProc(i, { healthUrl: e.target.value })}
                    placeholder="http://127.0.0.1:3000/" className="font-mono text-xs" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Health TCP port (optional)</Label>
                  <Input value={p.healthPort} onChange={(e) => updateProc(i, { healthPort: e.target.value })}
                    placeholder="3000" inputMode="numeric" className="font-mono text-xs" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Ports (optional, comma separated)</Label>
                  <Input value={p.ports} onChange={(e) => updateProc(i, { ports: e.target.value })}
                    placeholder="4070, 4470" className="font-mono text-xs" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Depends on (optional, process names)</Label>
                  <Input value={p.dependsOn} onChange={(e) => updateProc(i, { dependsOn: e.target.value })}
                    placeholder="api, account" className="font-mono text-xs" />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <div className="flex items-center gap-2">
                  <Switch checked={p.autoRestart} onCheckedChange={(v) => updateProc(i, { autoRestart: v })} />
                  <Label className="text-xs text-muted-foreground">auto-restart on crash</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={p.ownLogTimestamps} onCheckedChange={(v) => updateProc(i, { ownLogTimestamps: v })} />
                  <Label className="text-xs text-muted-foreground">logs contain own timestamps</Label>
                </div>
              </div>
            </div>
          ))}

          <Button variant="outline" size="sm" className="w-fit"
            onClick={() => setProcs((prev) => [...prev, { ...emptyProc }])}>
            <Plus className="size-3.5" /> add process
          </Button>

          {error && <div className="whitespace-pre-wrap text-xs text-red-400">{error}</div>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !name.trim() || !cwd.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
