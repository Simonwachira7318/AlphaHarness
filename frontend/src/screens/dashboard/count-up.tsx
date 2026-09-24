/**
 * A figure that counts up from zero the first time it appears (DESIGN.md → Motion, `count`),
 * then changes in place: a refetch never replays it.
 */

import { useEffect, useRef, useState } from 'react'
import { fmt } from '@/lib/format'

const DURATION_MS = 600

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

export function CountUp({
  value,
  format = fmt.int,
}: {
  value: number | null | undefined
  format?: (v: number | null | undefined) => string
}) {
  const [shown, setShown] = useState<number | null>(null)
  // Set once the first count has run to the end; after that, new values just replace.
  const finished = useRef(false)

  useEffect(() => {
    if (value == null) return
    if (finished.current || reducedMotion()) {
      finished.current = true
      setShown(value)
      return
    }
    const start = performance.now()
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / DURATION_MS)
      setShown(value * (1 - (1 - t) ** 3))
      if (t < 1) frame = requestAnimationFrame(tick)
      else finished.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [value])

  return <>{format(value == null ? value : (shown ?? 0))}</>
}
