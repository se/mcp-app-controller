import { Badge } from '@/components/ui/badge'
import type { ProcInfo } from '@/lib/api'
import { cn } from '@/lib/utils'
import { GitCommitHorizontal } from 'lucide-react'

const short = (sha: string) => sha.slice(0, 7)

/**
 * Whether a running process's code matches its repo's HEAD. Out of date = HEAD moved
 * since the process was spawned (pull, commit, checkout) — a restart picks it up.
 * Renders nothing when not running or not a git repo.
 */
export function GitBadge({ p, className }: { p: ProcInfo; className?: string }) {
  const g = p.git
  if (!g || p.status !== 'running') return null
  const branch = g.branch ?? 'detached HEAD'
  if (g.startCommit === g.headCommit) {
    return (
      <span className={cn('inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-muted-foreground', className)}
        title={`Up to date with HEAD — ${branch} @ ${short(g.headCommit)}`}>
        <GitCommitHorizontal className="size-3" />{short(g.headCommit)}
      </span>
    )
  }
  const label = g.behind < 0 ? 'outdated' : g.behind > 0 ? `${g.behind} behind` : `${g.ahead} ahead`
  const dev = p.mode === 'dev' ? '\n\nDev mode: a watcher/hot reload may already have picked up the changes.' : ''
  return (
    <Badge variant="outline"
      className={cn('h-4 shrink-0 gap-0.5 border-amber-500/50 px-1 text-[9px] text-amber-600 dark:text-amber-400', className)}
      title={`Not up to date with HEAD — restart to pick up the changes.\nRunning: ${short(g.startCommit)}\nHEAD:    ${short(g.headCommit)} (${branch})${g.behind > 0 ? `\n${g.behind} new commit(s)` : ''}${g.ahead > 0 ? `\n${g.ahead} commit(s) no longer on HEAD` : ''}${dev}`}>
      <GitCommitHorizontal className="size-2.5" />{label}
    </Badge>
  )
}
