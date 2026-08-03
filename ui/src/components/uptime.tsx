import { useEffect, useState } from 'react'
import { fmtElapsed, fmtUptime } from '@/lib/api'

/**
 * 1s tick for time-since displays. Lives inside tiny leaf components so only the
 * text node re-renders every second — NOT the dashboard or the cards. Without this,
 * uptime only updated when a metrics/state event happened to re-render the card
 * (every ~5s, and a fresh process showed a frozen "0s").
 */
function useNow(periodMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), periodMs)
    return () => clearInterval(t)
  }, [periodMs])
  return now
}

/** Self-ticking `fmtUptime(startedAt)` — "42s", "3m", "2h 15m". */
export function Uptime({ startedAt }: { startedAt: number }) {
  useNow()
  return <>{fmtUptime(startedAt)}</>
}

/** Self-ticking `fmtElapsed(now - since)` — for "starting… 7s" style counters. */
export function Elapsed({ since }: { since: number }) {
  const now = useNow()
  return <>{fmtElapsed(Math.max(0, now - since))}</>
}
