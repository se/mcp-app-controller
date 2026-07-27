import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTheme, type Theme } from '@/lib/theme'
import { Check, Monitor, Moon, Sun } from 'lucide-react'

const OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

export function ThemeToggle() {
  const { theme, resolved, setTheme } = useTheme()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" title="Theme">
          {resolved === 'dark' ? <Moon className="size-4" /> : <Sun className="size-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        {OPTIONS.map((o) => (
          <DropdownMenuItem key={o.value} onClick={() => setTheme(o.value)}>
            <o.icon className="size-4" />
            {o.label}
            {theme === o.value && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
