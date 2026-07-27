import { useEffect, useState } from 'react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { appActionWithTakeover, type AppInfo } from '@/lib/api'
import { useTheme } from '@/lib/theme'
import type { View } from '@/components/sidebar'
import { History, LayoutDashboard, Monitor, Moon, Play, RotateCw, Square, Sun } from 'lucide-react'

export function CommandPalette({
  apps,
  onNavigate,
  onRefresh,
}: {
  apps: AppInfo[]
  onNavigate: (v: View) => void
  onRefresh: () => void
}) {
  const [open, setOpen] = useState(false)
  const { setTheme } = useTheme()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const run = (fn: () => void | Promise<unknown>) => {
    setOpen(false)
    void Promise.resolve(fn()).then(onRefresh)
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Command palette" description="Search apps and actions">
      <CommandInput placeholder="Search apps and actions…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Navigate">
          <CommandItem onSelect={() => run(() => onNavigate('overview'))}>
            <LayoutDashboard className="size-4" /> Overview
          </CommandItem>
          <CommandItem onSelect={() => run(() => onNavigate('activity'))}>
            <History className="size-4" /> Activity
          </CommandItem>
          {apps.map((a) => (
            <CommandItem key={`nav-${a.name}`} onSelect={() => run(() => onNavigate(`app:${a.name}`))}>
              <span className="size-2 rounded-full bg-emerald-500" style={{
                background: a.processes.some((p) => p.status === 'crashed') ? 'var(--color-red-500, #ef4444)' :
                  a.processes.some((p) => p.status === 'running') ? undefined : 'var(--color-muted-foreground)',
              }} />
              {a.name}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Actions">
          {apps.flatMap((a) => [
            <CommandItem key={`restart-${a.name}`}
              onSelect={() => run(() => appActionWithTakeover(a.name, 'restart', { reason: 'restart from command palette' }))}>
              <RotateCw className="size-4" /> Restart {a.name}
            </CommandItem>,
            <CommandItem key={`start-${a.name}`}
              onSelect={() => run(() => appActionWithTakeover(a.name, 'start', { mode: 'start', reason: 'start from command palette' }))}>
              <Play className="size-4" /> Start {a.name}
            </CommandItem>,
            <CommandItem key={`stop-${a.name}`}
              onSelect={() => run(() => appActionWithTakeover(a.name, 'stop', { reason: 'stop from command palette' }))}>
              <Square className="size-4" /> Stop {a.name}
            </CommandItem>,
          ])}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Theme">
          <CommandItem onSelect={() => run(() => setTheme('light'))}><Sun className="size-4" /> Light theme</CommandItem>
          <CommandItem onSelect={() => run(() => setTheme('dark'))}><Moon className="size-4" /> Dark theme</CommandItem>
          <CommandItem onSelect={() => run(() => setTheme('system'))}><Monitor className="size-4" /> System theme</CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
