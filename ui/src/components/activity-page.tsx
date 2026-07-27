import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { clearAudit, fmtAgo, type AppInfo, type AuditEntry } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react'

const PAGE_SIZE = 15

const sourceClass = (source: AuditEntry['source']) =>
  cn(
    'font-mono text-[11px]',
    source === 'mcp' && 'border-sky-500/40 text-sky-600 dark:text-sky-400',
    source === 'ui' && 'border-amber-500/40 text-amber-600 dark:text-amber-400',
    source === 'system' && 'border-red-500/40 text-red-600 dark:text-red-400'
  )

const resultClass = (result: string) =>
  result.startsWith('error') || result === 'crashed'
    ? 'border-red-500/40 text-red-600 dark:text-red-400'
    : result === 'running' || result === 'saved' || result === 'released' || result === 'stopped' || result === 'removed' || result === 'ok'
      ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
      : 'text-muted-foreground'

export function ActivityPage({ entries, apps }: { entries: AuditEntry[]; apps: AppInfo[] }) {
  const [appFilter, setAppFilter] = useState('all')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter((e) => {
      if (appFilter !== 'all' && e.app !== appFilter) return false
      if (sourceFilter !== 'all' && e.source !== sourceFilter) return false
      if (q) {
        const text = `${e.session} ${e.action} ${e.app} ${e.proc ?? ''} ${e.result} ${e.detail ?? ''}`.toLowerCase()
        if (!text.includes(q)) return false
      }
      return true
    })
  }, [entries, appFilter, sourceFilter, search])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const current = Math.min(page, pageCount - 1)
  const visible = filtered.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0) }}
          placeholder="Search activity…"
          className="h-8 w-56 text-xs"
        />
        <Select value={appFilter} onValueChange={(v) => { setAppFilter(v); setPage(0) }}>
          <SelectTrigger size="sm" className="w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All apps</SelectItem>
            {apps.map((a) => (
              <SelectItem key={a.name} value={a.name}>{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sourceFilter} onValueChange={(v) => { setSourceFilter(v); setPage(0) }}>
          <SelectTrigger size="sm" className="w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="mcp">mcp</SelectItem>
            <SelectItem value="ui">ui</SelectItem>
            <SelectItem value="system">system</SelectItem>
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-muted-foreground">
          {filtered.length} entries
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 text-xs">
              <Trash2 className="size-3.5" /> Clear
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => void clearAudit(1)}>
              Older than 1 day
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void clearAudit(7)}>
              Older than 7 days
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => {
                if (confirm('Clear the entire activity log? This cannot be undone.')) void clearAudit()
              }}
            >
              Clear all
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-24">Time</TableHead>
              <TableHead className="w-32">Actor</TableHead>
              <TableHead className="w-32">Action</TableHead>
              <TableHead className="w-44">Target</TableHead>
              <TableHead className="w-28">Result</TableHead>
              <TableHead>Detail</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  No matching activity
                </TableCell>
              </TableRow>
            )}
            {visible.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground" title={new Date(e.ts).toLocaleString()}>
                  {fmtAgo(e.ts)}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={sourceClass(e.source)}>
                    {e.source}:{e.session}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs font-medium">{e.action}</TableCell>
                <TableCell className="font-mono text-xs">
                  {e.proc ? `${e.app}/${e.proc}` : e.app}
                </TableCell>
                <TableCell className="align-top">
                  <Badge variant="outline" className={cn('text-[11px]', resultClass(e.result))}>
                    {e.result.length > 24 ? e.result.slice(0, 24) + '…' : e.result}
                  </Badge>
                </TableCell>
                <TableCell className="min-w-52 max-w-xl whitespace-normal break-words align-top text-xs text-muted-foreground">
                  {e.result.length > 24 && (
                    <div className="mb-1 text-red-600 dark:text-red-400">{e.result}</div>
                  )}
                  {e.detail}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex items-center justify-between border-t px-4 py-2">
          <span className="text-[11px] text-muted-foreground">
            Page {current + 1} of {pageCount}
          </span>
          <div className="flex gap-1">
            <Button variant="outline" size="icon-sm" disabled={current === 0} onClick={() => setPage(current - 1)}>
              <ChevronLeft className="size-3.5" />
            </Button>
            <Button variant="outline" size="icon-sm" disabled={current >= pageCount - 1} onClick={() => setPage(current + 1)}>
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
