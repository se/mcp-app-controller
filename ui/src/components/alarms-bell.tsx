import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ackAlarm, ackAllAlarms, fmtAgo, getAlarms, type Alarm } from '@/lib/api'
import { alarmsBus } from '@/lib/log-bus'
import { cn } from '@/lib/utils'
import { Bell, Check, ExternalLink } from 'lucide-react'

const sevClass = (s: Alarm['severity']) =>
  s === 'critical'
    ? 'bg-red-500'
    : s === 'warning'
      ? 'bg-amber-500'
      : 'bg-sky-500'

// Extract the "[ISO]" prefix of the matched log line for jump-to-line
const anchorTs = (line: string) => line.match(/^\[([0-9T:.Zz-]+)\]/)?.[1] ?? null

export function AlarmsBell({ onOpenLog }: { onOpenLog: (app: string, proc: string, ts: string | null) => void }) {
  const [alarms, setAlarms] = useState<Alarm[]>([])

  const load = () => getAlarms(true, 50).then(setAlarms).catch(() => {})
  useEffect(() => {
    load()
    return alarmsBus.subscribe(load)
  }, [])

  const critical = alarms.some((a) => a.severity === 'critical')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" title="Alarms" className="relative">
          <Bell className="size-4" />
          {alarms.length > 0 && (
            <span
              className={cn(
                'absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full text-[9px] font-bold text-white',
                critical ? 'bg-red-500' : 'bg-amber-500'
              )}
            >
              {alarms.length > 9 ? '9+' : alarms.length}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[420px] p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">Alarms</span>
          {alarms.length > 0 && (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs"
              onClick={async () => { await ackAllAlarms(); load() }}>
              <Check className="size-3" /> Ack all
            </Button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {alarms.length === 0 && (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No active alarms. Define triggers in Settings.
            </div>
          )}
          {alarms.map((a) => (
            <div key={a.id} className="flex items-start gap-2 border-b px-3 py-2 last:border-b-0">
              <span className={cn('mt-1 size-2 shrink-0 rounded-full', sevClass(a.severity))} title={a.severity} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs font-medium">{a.trigger_name}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{fmtAgo(a.ts)}</span>
                </div>
                <div className="font-mono text-[10px] text-muted-foreground">{a.app}/{a.proc}</div>
                <div className="mt-0.5 line-clamp-2 break-all font-mono text-[10px] text-muted-foreground">
                  {a.line.replace(/^\[[^\]]+\]\s?/, '')}
                </div>
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                <Button variant="outline" size="icon-xs" title="Open in logs"
                  onClick={() => onOpenLog(a.app, a.proc, anchorTs(a.line))}>
                  <ExternalLink className="size-3" />
                </Button>
                <Button variant="ghost" size="icon-xs" title="Acknowledge"
                  onClick={async () => { await ackAlarm(a.id); load() }}>
                  <Check className="size-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
