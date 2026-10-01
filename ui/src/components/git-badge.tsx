import { Badge } from '@/components/ui/badge'
import type { ProcInfo } from '@/lib/api'
import { cn } from '@/lib/utils'
import { GitCommitHorizontal } from 'lucide-react'

const short = (sha: string) => sha.slice(0, 7)
/** Inline label — 4 chars is enough to tell runs apart; the tooltip keeps 7 for git */
const tiny = (sha: string) => sha.slice(0, 4)

/**
 * Whether a running process's code matches its repo. Out of date = HEAD moved (pull,
 * commit, checkout) or uncommitted files changed since the process was spawned — a
 * restart picks it up. Renders nothing when not running or not a git repo.
 */
export function GitBadge({ p, className }: { p: ProcInfo; className?: string }) {
  const g = p.git
  if (!g || p.status !== 'running') return null
  const branch = g.branch ?? 'detached HEAD'
  const headMoved = g.startCommit !== g.headCommit
  // Uncommitted files present at spawn: the running code is "<sha> + local edits" (git's -dirty)
  const dirtyLines = g.dirtyAtStart > 0
    ? ['', `Started with uncommitted changes (${g.dirtyAtStart}):`, ...g.dirtySample.map((f) => `  ${f}`),
        ...(g.dirtyAtStart > g.dirtySample.length ? [`  … and ${g.dirtyAtStart - g.dirtySample.length} more`] : [])]
    : []
  if (!headMoved && g.changedFiles === 0) {
    return (
      <span className={cn('inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-muted-foreground', className)}
        title={[`Up to date — ${branch} @ ${short(g.headCommit)}, no file changes since start`, ...dirtyLines].join('\n')}>
        <GitCommitHorizontal className="size-3" />{tiny(g.headCommit)}{g.dirtyAtStart > 0 ? '*' : ''}
      </span>
    )
  }
  // Plain-words status; the exact counts live in the tooltip
  const newCommits = headMoved && g.behind > 0 && g.ahead === 0
  const label = !headMoved ? 'new changes' : newCommits && g.changedFiles === 0 ? 'new commits' : 'out of date'

  const lines = ['Not up to date — restart to pick up the changes.']
  if (headMoved) {
    lines.push(`Running: ${short(g.startCommit)}`, `HEAD:    ${short(g.headCommit)} (${branch})`)
    if (g.behind > 0) lines.push(`${g.behind} new commit(s)`)
    if (g.ahead > 0) lines.push(`${g.ahead} commit(s) no longer on HEAD`)
  }
  if (g.changedFiles > 0) {
    lines.push('', `Uncommitted changes since start (${g.changedFiles}):`, ...g.changedSample.map((f) => `  ${f}`))
    if (g.changedFiles > g.changedSample.length) lines.push(`  … and ${g.changedFiles - g.changedSample.length} more`)
  }
  lines.push(...dirtyLines)
  if (p.mode === 'dev') lines.push('', 'Dev mode: a watcher/hot reload may already have picked up the changes.')

  return (
    <Badge variant="outline"
      className={cn('h-4 shrink-0 gap-0.5 border-amber-500/50 px-1 text-[9px] text-amber-600 dark:text-amber-400', className)}
      title={lines.join('\n')}>
      <GitCommitHorizontal className="size-2.5" />{label}
    </Badge>
  )
}
