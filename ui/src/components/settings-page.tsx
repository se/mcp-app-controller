import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  deleteProfile,
  deleteTrigger,
  getSettings,
  saveProfile,
  saveSettings,
  saveTrigger,
  type AppInfo,
  type Settings,
  type Trigger,
} from '@/lib/api'
import { Check, Plus, Trash2 } from 'lucide-react'

const emptyTrigger: Trigger = { name: '', target: '*', pattern: '', severity: 'warning', notify: true, cooldownSeconds: 60 }

function TriggerRow({
  trigger,
  isNew,
  onSaved,
  onDeleted,
}: {
  trigger: Trigger
  isNew?: boolean
  onSaved: () => void
  onDeleted?: () => void
}) {
  const [t, setT] = useState<Trigger>(trigger)
  const patternValid = (() => {
    if (!t.pattern) return true
    try { new RegExp(t.pattern, 'i'); return true } catch { return false }
  })()
  const set = (patch: Partial<Trigger>) => setT((prev) => ({ ...prev, ...patch }))

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={t.name} onChange={(e) => set({ name: e.target.value })} disabled={!isNew}
          placeholder="trigger name" className="h-8 w-40 text-xs" />
        <Input value={t.target} onChange={(e) => set({ target: e.target.value })}
          placeholder='* | app | app/process' className="h-8 w-40 font-mono text-xs" />
        <Input value={t.pattern} onChange={(e) => set({ pattern: e.target.value })}
          placeholder="regex, e.g. error|ECONNREFUSED"
          className={`h-8 min-w-52 flex-1 font-mono text-xs ${patternValid ? '' : 'border-red-500/70'}`} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Select value={t.severity} onValueChange={(v) => set({ severity: v as Trigger['severity'] })}>
          <SelectTrigger size="sm" className="w-28 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="info">info</SelectItem>
            <SelectItem value="warning">warning</SelectItem>
            <SelectItem value="critical">critical</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1.5">
          <Switch checked={t.notify} onCheckedChange={(v) => set({ notify: v })} />
          <Label className="text-[11px] text-muted-foreground">notify</Label>
        </div>
        <div className="flex items-center gap-1.5">
          <Label className="text-[11px] text-muted-foreground">cooldown (s)</Label>
          <Input value={String(t.cooldownSeconds)} inputMode="numeric"
            onChange={(e) => set({ cooldownSeconds: Number(e.target.value) || 0 })}
            className="h-8 w-20 text-xs" />
        </div>
        <div className="ml-auto flex gap-1.5">
          <Button variant="outline" size="sm" className="h-8 text-xs"
            disabled={!t.name.trim() || !t.pattern || !patternValid}
            onClick={async () => {
              try {
                await saveTrigger({ ...t, name: t.name.trim() })
                if (isNew) setT(emptyTrigger)
                onSaved()
              } catch (err) { alert((err as Error).message) }
            }}>
            {isNew ? <><Plus className="size-3.5" /> Add</> : 'Save'}
          </Button>
          {!isNew && onDeleted && (
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-red-500" title="Delete trigger"
              onClick={async () => {
                if (!confirm(`Delete trigger '${t.name}'?`)) return
                await deleteTrigger(t.name)
                onDeleted()
              }}>
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

export function SettingsPage({ apps, onChanged }: { apps: AppInfo[]; onChanged: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [envShell, setEnvShell] = useState('')
  const [macos, setMacos] = useState(true)
  const [slack, setSlack] = useState('')
  const [profileEdits, setProfileEdits] = useState<Record<string, string>>({})
  const [newName, setNewName] = useState('')
  const [newTargets, setNewTargets] = useState('')
  const [msg, setMsg] = useState('')

  const load = () => {
    getSettings().then((s) => {
      setSettings(s)
      setEnvShell(s.envShell)
      setMacos(s.notify.macos)
      setSlack(s.notify.slackWebhook ?? '')
      setProfileEdits(Object.fromEntries(Object.entries(s.profiles).map(([k, v]) => [k, v.join(', ')])))
    }).catch(() => {})
  }
  useEffect(load, [])

  const flash = (text: string) => {
    setMsg(text)
    setTimeout(() => setMsg(''), 4000)
  }

  const parseTargets = (s: string) => s.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean)

  const submitSettings = async () => {
    try {
      await saveSettings({ envShell, notify: { macos, slackWebhook: slack || undefined } })
      flash('Settings saved — environment re-captured with the configured shell.')
      load()
      onChanged()
    } catch (err) {
      alert((err as Error).message)
    }
  }

  const submitProfile = async (name: string, targetsStr: string) => {
    try {
      await saveProfile(name, parseTargets(targetsStr))
      flash(`Profile '${name}' saved.`)
      load()
      onChanged()
    } catch (err) {
      alert((err as Error).message)
    }
  }

  if (!settings) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>

  const targetHint = apps.map((a) => a.name).join(', ')

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      {msg && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-600 dark:text-emerald-400">
          {msg}
        </div>
      )}

      <Card className="gap-0 py-0">
        <CardHeader className="border-b px-5 py-3">
          <div className="text-sm font-medium">App environment</div>
          <p className="text-[11px] text-muted-foreground">
            Login shell whose environment is captured at startup and injected into every managed
            process — independent of the machine's default shell.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-5 py-4">
          <div className="grid gap-1.5">
            <Label htmlFor="env-shell">Environment shell (absolute path, empty = inherit daemon env)</Label>
            <Input id="env-shell" value={envShell} onChange={(e) => setEnvShell(e.target.value)}
              placeholder="/opt/homebrew/bin/fish" className="font-mono text-xs" />
          </div>
          <div className="text-[11px] text-muted-foreground">
            Currently captured: <b>{settings.envVarCount}</b> variables
            {settings.envShell ? ` from ${settings.envShell}` : ' (no envShell configured)'}
          </div>
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader className="border-b px-5 py-3">
          <div className="text-sm font-medium">Crash notifications</div>
          <p className="text-[11px] text-muted-foreground">Throttled to one per process per 5 minutes.</p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-5 py-4">
          <div className="flex items-center gap-2">
            <Switch checked={macos} onCheckedChange={setMacos} />
            <Label className="text-xs">macOS notification center</Label>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="slack-hook">Slack webhook URL (optional)</Label>
            <Input id="slack-hook" value={slack} onChange={(e) => setSlack(e.target.value)}
              placeholder="https://hooks.slack.com/services/…" className="font-mono text-xs" />
          </div>
          <div>
            <Button size="sm" onClick={submitSettings}>
              <Check className="size-3.5" /> Save environment & notifications
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader className="border-b px-5 py-3">
          <div className="text-sm font-medium">Triggers</div>
          <p className="text-[11px] text-muted-foreground">
            Fire an alarm (header bell{' + '}optional notification) whenever a log line matches a
            regex. Target: <span className="font-mono">*</span>, <span className="font-mono">app</span> or{' '}
            <span className="font-mono">app/process</span>. Alarms link back to the matching log line.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 px-5 py-4">
          {settings.triggers.length === 0 && (
            <div className="text-xs text-muted-foreground">No triggers yet — add one below.</div>
          )}
          {settings.triggers.map((t) => (
            <TriggerRow key={t.name} trigger={t}
              onSaved={() => { flash(`Trigger saved.`); load() }}
              onDeleted={() => { flash(`Trigger removed.`); load() }} />
          ))}
          <div className="border-t pt-3">
            <TriggerRow trigger={emptyTrigger} isNew
              onSaved={() => { flash('Trigger added.'); load() }} />
          </div>
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader className="border-b px-5 py-3">
          <div className="text-sm font-medium">Profiles</div>
          <p className="text-[11px] text-muted-foreground">
            Named groups startable/stoppable in one action (sidebar, Cmd+K, or MCP{' '}
            <span className="font-mono">start_profile</span>). Targets: <span className="font-mono">app</span> or{' '}
            <span className="font-mono">app/process</span>, comma separated. Apps: <span className="font-mono">{targetHint}</span>
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 px-5 py-4">
          {Object.keys(profileEdits).length === 0 && (
            <div className="text-xs text-muted-foreground">No profiles yet — add one below.</div>
          )}
          {Object.entries(profileEdits).map(([name, targetsStr]) => (
            <div key={name} className="flex items-center gap-2">
              <span className="w-28 shrink-0 truncate text-xs font-medium">{name}</span>
              <Input value={targetsStr}
                onChange={(e) => setProfileEdits((prev) => ({ ...prev, [name]: e.target.value }))}
                className="font-mono text-xs" />
              <Button variant="outline" size="sm" className="h-8 shrink-0 text-xs"
                onClick={() => submitProfile(name, targetsStr)}>
                Save
              </Button>
              <Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground hover:text-red-500"
                title="Delete profile"
                onClick={async () => {
                  if (!confirm(`Delete profile '${name}'?`)) return
                  await deleteProfile(name)
                  flash(`Profile '${name}' removed.`)
                  load()
                  onChanged()
                }}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          <div className="mt-2 flex items-center gap-2 border-t pt-3">
            <Input value={newName} onChange={(e) => setNewName(e.target.value)}
              placeholder="profile name" className="w-28 shrink-0 text-xs" />
            <Input value={newTargets} onChange={(e) => setNewTargets(e.target.value)}
              placeholder="monosign, monopam/app-vue" className="font-mono text-xs" />
            <Button variant="outline" size="sm" className="h-8 shrink-0 text-xs"
              disabled={!newName.trim() || !newTargets.trim()}
              onClick={async () => {
                await submitProfile(newName.trim(), newTargets)
                setNewName('')
                setNewTargets('')
              }}>
              <Plus className="size-3.5" /> Add
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
