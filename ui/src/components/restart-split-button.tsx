import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChevronDown, Hammer, RotateCw } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Restart button with an optional ▾ half offering "Restart with Prepare".
 *
 * A plain restart just bounces the process(es) over whatever is already built; the
 * menu item is the only way to run the app's `prepare` build first. The ▾ half only
 * exists when the app HAS a prepare command — otherwise this is a single button.
 */
export function RestartSplitButton({
  prepare,
  onRestart,
  label,
  title,
  disabled = false,
  compact = false,
  className,
}: {
  /** The app's `prepare` command, or null when it has none. */
  prepare: string | null
  /** `true` = run prepare (build) before starting again. */
  onRestart: (withPrepare: boolean) => void
  label: ReactNode
  title?: string
  disabled?: boolean
  /** Compact h-7 sizing for the process table rows. */
  compact?: boolean
  /** Extra classes (e.g. accent colors) applied to BOTH halves. */
  className?: string
}) {
  const sizing = compact ? 'h-7 px-2 text-xs' : 'gap-1.5 font-medium'
  return (
    <div className="flex shrink-0 items-center">
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        title={title ? (prepare ? `${title}\nDoes NOT rebuild — use ▾ to restart with prepare.` : title) : undefined}
        className={cn(sizing, className, prepare && 'rounded-r-none border-r-0')}
        onClick={() => onRestart(false)}
      >
        <RotateCw className={compact ? 'size-3' : 'size-3.5'} />{label}
      </Button>
      {prepare && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              title="More restart options"
              className={cn(compact ? 'h-7 px-1' : 'px-1.5', className, 'rounded-l-none border-l border-l-border')}
            >
              <ChevronDown className={compact ? 'size-3' : 'size-3.5'} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuItem onSelect={() => onRestart(true)}>
              <Hammer className="size-3.5" />
              <div className="flex min-w-0 flex-col">
                <span>Restart with Prepare</span>
                <span className="truncate font-mono text-[10px] text-muted-foreground" title={prepare}>
                  {prepare}
                </span>
              </div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
