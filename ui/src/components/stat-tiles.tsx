import { Card } from '@/components/ui/card'
import type { AppInfo } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Activity, AlertTriangle, Boxes, Lock } from 'lucide-react'

export function StatTiles({ apps }: { apps: AppInfo[] }) {
  const procs = apps.flatMap((a) => a.processes)
  const running = procs.filter((p) => p.status === 'running').length
  const crashed = procs.filter((p) => p.status === 'crashed').length
  const unhealthy = procs.filter((p) => p.status === 'running' && p.health === 'unhealthy').length
  const leases = apps.filter((a) => a.lease).length

  const tiles = [
    { label: 'Apps', value: apps.length, sub: `${procs.length} processes`, icon: Boxes, tone: '' },
    { label: 'Running', value: running, sub: `of ${procs.length} processes`, icon: Activity, tone: 'text-emerald-600 dark:text-emerald-400' },
    {
      label: 'Problems', value: crashed + unhealthy,
      sub: `${crashed} crashed · ${unhealthy} unhealthy`, icon: AlertTriangle,
      tone: crashed + unhealthy > 0 ? 'text-red-600 dark:text-red-400' : '',
    },
    { label: 'Active leases', value: leases, sub: 'apps held by a session', icon: Lock, tone: leases > 0 ? 'text-amber-600 dark:text-amber-400' : '' },
  ]

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {tiles.map((t) => (
        <Card key={t.label} className="gap-1 p-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            {t.label}
            <t.icon className="size-3.5" />
          </div>
          <div className={cn('text-2xl font-semibold tabular-nums', t.tone)}>{t.value}</div>
          <div className="text-[11px] text-muted-foreground">{t.sub}</div>
        </Card>
      ))}
    </div>
  )
}
