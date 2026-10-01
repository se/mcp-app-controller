import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ProcInfo } from '@/lib/api'
import { cn } from '@/lib/utils'
import { CircleCheck, FilePen, GitCommitVertical, TriangleAlert } from 'lucide-react'

const short = (sha: string) => sha.slice(0, 7)
/** Inline label — 4 chars is enough to tell runs apart; the tooltip keeps 7 for git */
const tiny = (sha: string) => sha.slice(0, 4)

type Tone = 'ok' | 'warn' | 'bad'

const TONES: Record<Tone, string> = {
  ok: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  warn: 'border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-400',
  bad: 'border-red-500/50 bg-red-500/15 text-red-700 dark:text-red-400',
}

function FileList({ title, files, total }: { title: string; files: string[]; total: number }) {
  return (
    <div>
      <div className="font-semibold">{title}</div>
      <ul className="mt-0.5 font-mono text-[10px] opacity-90">
        {files.map((f) => <li key={f} className="truncate">{f}</li>)}
        {total > files.length && <li>… and {total - files.length} more</li>}
      </ul>
    </div>
  )
}

/**
 * Whether a running process's code matches its repo — green: running HEAD; amber:
 * files edited / new commits since it started; red: both, or HEAD switched/reset.
 * Amber and red mean a restart picks up the changes. Renders nothing when the process
 * isn't running or its folder isn't a git repo. `compact` drops the words (card rows).
 */
export function GitBadge({ p, compact = false, className }: { p: ProcInfo; compact?: boolean; className?: string }) {
  const g = p.git
  if (!g || p.status !== 'running') return null
  const branch = g.branch ?? 'detached HEAD'
  const headMoved = g.startCommit !== g.headCommit
  const filesChanged = g.changedFiles > 0
  const dirty = g.dirtyAtStart > 0

  let tone: Tone
  let icon: ReactNode
  let label: string
  let headline: string
  if (!headMoved && !filesChanged) {
    tone = 'ok'
    icon = <CircleCheck />
    label = tiny(g.headCommit) + (dirty ? '*' : '')
    headline = dirty ? 'Up to date — running HEAD plus uncommitted changes' : 'Up to date — running HEAD'
  } else if (!headMoved) {
    tone = 'warn'
    icon = <FilePen />
    label = 'new changes'
    headline = 'Files changed since start — restart to pick them up'
  } else if (!filesChanged && g.behind > 0 && g.ahead === 0) {
    tone = 'warn'
    icon = <GitCommitVertical />
    label = 'new commits'
    headline = 'New commits since start — restart to pick them up'
  } else {
    tone = 'bad'
    icon = <TriangleAlert />
    label = 'out of date'
    headline = 'Out of date — restart to pick up the changes'
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex h-5 shrink-0 cursor-default items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium [&_svg]:size-3.5 [&_svg]:shrink-0',
            tone === 'ok' && 'font-mono',
            TONES[tone],
            className
          )}
        >
          {icon}
          {(!compact || tone === 'ok') && label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="block max-w-sm space-y-1.5">
        <div className="font-semibold">{headline}</div>
        <div className="font-mono text-[10px] opacity-90">
          {headMoved ? (
            <>
              <div>running {short(g.startCommit)}</div>
              <div>HEAD&nbsp;&nbsp;&nbsp; {short(g.headCommit)} ({branch})</div>
              {g.behind > 0 && <div>{g.behind} new commit{g.behind === 1 ? '' : 's'} on HEAD</div>}
              {g.ahead > 0 && <div>{g.ahead} commit{g.ahead === 1 ? '' : 's'} no longer on HEAD</div>}
              {g.behind < 0 && <div>start commit no longer in the repo</div>}
            </>
          ) : (
            <div>{branch} @ {short(g.headCommit)}</div>
          )}
        </div>
        {filesChanged && <FileList title={`Changed since start (${g.changedFiles})`} files={g.changedSample} total={g.changedFiles} />}
        {dirty && <FileList title={`Started with uncommitted changes (${g.dirtyAtStart})`} files={g.dirtySample} total={g.dirtyAtStart} />}
        {tone !== 'ok' && p.mode === 'dev' && (
          <div className="opacity-80">Dev mode: a watcher / hot reload may already have picked these up.</div>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
