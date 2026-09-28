import { useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { setAppEnabled, type AppInfo } from '@/lib/api'
import { toast } from 'sonner'

/** On/off switch for a whole app. Off stops its processes, blocks every start path
 * (manual, profile, boot restore, auto-restart) and hides it from crash reporting. */
export function AppEnabledSwitch({ app, onChanged, onBeforeToggle }: { app: AppInfo; onChanged: () => void; onBeforeToggle?: () => void }) {
  const [busy, setBusy] = useState(false)
  const running = app.processes.filter((p) => p.status === 'running').length
  return (
    <Switch
      size="sm"
      checked={app.enabled}
      disabled={busy}
      title={app.enabled
        ? 'On — click to switch the app off (stops it; it will not be started or auto-restarted, and is never shown as crashed)'
        : 'Off — click to switch the app back on'}
      onCheckedChange={async (next) => {
        if (!next && running > 0 && !confirm(`Switch '${app.name}' off?\n\n${running} running process(es) will be stopped, and the app won't be started or auto-restarted until you switch it back on.`)) return
        onBeforeToggle?.()
        setBusy(true)
        try {
          await setAppEnabled(app.name, next)
        } catch (err) {
          toast.error((err as Error).message)
        } finally {
          setBusy(false)
          onChanged()
        }
      }}
    />
  )
}
