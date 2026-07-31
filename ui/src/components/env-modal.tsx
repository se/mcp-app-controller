import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { getDaemonEnv, recaptureDaemonEnv } from '@/lib/api'
import { cn } from '@/lib/utils'
import { DownloadCloud } from 'lucide-react'

/**
 * Lists the environment captured from the login shell at daemon startup — the base
 * layer every managed process inherits (below app-level and per-process env).
 * Sensitive values are masked server-side unless "reveal" is switched on.
 */
export function EnvModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [vars, setVars] = useState<Record<string, string>>({})
  const [shell, setShell] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [reveal, setReveal] = useState(false)
  const [loading, setLoading] = useState(false)
  const [recapturing, setRecapturing] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    getDaemonEnv(reveal)
      .then((r) => { setVars(r.vars); setShell(r.shell) })
      .catch(() => setVars({}))
      .finally(() => setLoading(false))
  }, [reveal])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  const entries = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return Object.entries(vars)
      .filter(([k, v]) => !q || k.toLowerCase().includes(q) || v.toLowerCase().includes(q))
      .sort(([a], [b]) => a.localeCompare(b))
  }, [vars, filter])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Environment variables</DialogTitle>
          <p className="text-xs text-muted-foreground">
            Captured from {shell ?? 'the daemon environment'} — inherited by every managed process
            (app-level and per-process env override these). After editing your shell config, use
            <span className="font-medium"> re-capture</span>; it applies to processes started afterwards.
          </p>
        </DialogHeader>

        <div className="flex items-center gap-3">
          <Input
            placeholder="Filter by name or value…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8 text-xs"
          />
          <div className="flex shrink-0 items-center gap-1.5">
            <Switch id="env-reveal" checked={reveal} onCheckedChange={setReveal} />
            <Label htmlFor="env-reveal" className="text-xs text-muted-foreground">reveal secrets</Label>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 px-2 text-xs"
            title="Re-run the login shell and reload this list — new values apply to processes started afterwards"
            disabled={recapturing || loading}
            onClick={async () => {
              setRecapturing(true)
              try {
                await recaptureDaemonEnv()
                load()
              } catch (err) {
                alert((err as Error).message)
              } finally {
                setRecapturing(false)
              }
            }}
          >
            <DownloadCloud className={cn('size-3.5', recapturing && 'animate-pulse')} /> re-capture
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
          {loading ? (
            <div className="p-6 text-center text-xs text-muted-foreground">Loading…</div>
          ) : entries.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">No variables match</div>
          ) : (
            entries.map(([k, v], i) => (
              <div key={k} className={`flex items-baseline gap-3 px-3 py-1.5 ${i > 0 ? 'border-t' : ''}`}>
                <span className="w-64 shrink-0 truncate font-mono text-[11px] font-medium" title={k}>{k}</span>
                <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-muted-foreground" title={v}>{v}</span>
              </div>
            ))
          )}
        </div>

        <div className="text-right text-[10px] text-muted-foreground">{entries.length} variable(s)</div>
      </DialogContent>
    </Dialog>
  )
}
