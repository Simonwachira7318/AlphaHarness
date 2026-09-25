/**
 * The Dashboard's live pieces: the running flask, and the heat maps that fill the lower half of
 * Today's Results and Work in Flight.
 *
 * Every motion here is `motion-safe:`, so a consultant who asks for reduced motion sees the same
 * colours standing still.
 */

import { FlaskConicalIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import type { EngineStatus } from '@/api/types'
import { cn } from '@/lib/cn'
import { fmt } from '@/lib/format'

/** A flask that keeps swirling while something runs. */
export function RunningFlask({ className }: { className?: string }) {
  return (
    <FlaskConicalIcon
      aria-hidden
      className={cn(
        'size-3.5 shrink-0 origin-bottom text-primary motion-safe:animate-shake',
        className,
      )}
    />
  )
}

function Legend({ items }: { items: { label: string; swatch: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-subtle">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5">
          <span className={cn('size-2 rounded-[2px]', item.swatch)} aria-hidden />
          {item.label}
        </span>
      ))}
    </div>
  )
}

/** A scan line crossing the map while work is live. */
function Scan() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 bg-[length:200%_100%] bg-[linear-gradient(90deg,transparent_40%,color-mix(in_srgb,var(--color-primary)_22%,transparent)_50%,transparent_60%)] motion-safe:animate-sweep"
    />
  )
}

// -- Today's Results --------------------------------------------------------------------

/** At most this many cells; past it each cell stands for several simulations. */
const RESULT_CELLS = 160

const OUTCOMES = [
  { key: 'completed', label: 'Completed', cell: 'bg-pnl-positive' },
  { key: 'errored', label: 'Errored', cell: 'bg-pnl-negative' },
  { key: 'cancelled', label: 'Cancelled', cell: 'bg-status-warning' },
  { key: 'running', label: 'Running', cell: 'bg-primary motion-safe:animate-pulse' },
  { key: 'unresolved', label: 'Being matched', cell: 'bg-ink-subtle' },
] as const

type Outcome = (typeof OUTCOMES)[number]['key']

/** One cell per simulation sent today (or per few, on a busy day), coloured by how it ended. */
export function ResultsHeatmap({ counts }: { counts: Record<Outcome, number> }) {
  const total = OUTCOMES.reduce((sum, o) => sum + counts[o.key], 0)
  if (total === 0) return null
  const per = Math.max(1, Math.ceil(total / RESULT_CELLS))
  // Every outcome that happened keeps at least one cell, however small its share.
  const cells = OUTCOMES.flatMap((o) =>
    Array.from(
      { length: counts[o.key] ? Math.max(1, Math.round(counts[o.key] / per)) : 0 },
      () => o,
    ),
  )
  return (
    <div className="flex flex-col gap-2 border-t border-hairline pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-caption font-medium uppercase tracking-wide text-ink-subtle">
          Today's Overall Results
        </span>
        <span className="text-caption text-ink-subtle">
          {per === 1 ? 'One cell per simulation' : `One cell per ${fmt.int(per)} simulations`}
        </span>
      </div>
      <div
        className="relative grid grid-cols-[repeat(auto-fill,minmax(12px,1fr))] gap-[3px] overflow-hidden rounded-sm"
        role="img"
        aria-label={OUTCOMES.map((o) => `${fmt.int(counts[o.key])} ${o.label}`).join(', ')}
      >
        {cells.map((o, i) => (
          <span
            key={i}
            className={cn(
              'aspect-square rounded-[2px] opacity-85 transition-colors duration-500 motion-safe:animate-rise',
              o.cell,
            )}
            style={{ animationDelay: `${Math.min(i * 6, 900)}ms` }}
          />
        ))}
        {counts.running > 0 && <Scan />}
      </div>
      <Legend
        items={OUTCOMES.filter((o) => counts[o.key] > 0).map((o) => ({
          label: o.label,
          swatch: o.cell.split(' ')[0] ?? '',
        }))}
      />
    </div>
  )
}

// -- Work in Flight ----------------------------------------------------------------------

/** Columns kept: two seconds each, so the map spans the last ninety seconds. */
const HISTORY = 45
const SAMPLE_MS = 2000

interface Sample {
  id: number
  used: number
  slots: number
  queued: number
}

/** Kept outside the component, so leaving the Dashboard and coming back keeps the history. */
const useSlotHistory = create<{ samples: Sample[]; push: (s: Omit<Sample, 'id'>) => void }>()(
  (set) => ({
    samples: [],
    push: (s) =>
      set((state) => {
        const id = (state.samples.at(-1)?.id ?? 0) + 1
        return { samples: [...state.samples, { ...s, id }].slice(-HISTORY) }
      }),
  }),
)

const HEAT = [
  { label: 'Idle', cell: 'bg-surface-3', max: 0 },
  { label: 'Light', cell: 'bg-pnl-positive', max: 0.5 },
  { label: 'Busy', cell: 'bg-status-warning', max: 0.85 },
  { label: 'Saturated', cell: 'bg-pnl-negative', max: Number.POSITIVE_INFINITY },
] as const

const heatOf = (share: number) => HEAT.find((h) => share <= h.max) ?? HEAT[3]

/**
 * The engine's slots over the last ninety seconds: a row per slot, a column per sample, the
 * newest on the right. A busy slot is lit in the colour of how full the engine was then.
 */
export function SlotHeatmap({ status }: { status: EngineStatus | undefined }) {
  const samples = useSlotHistory((s) => s.samples)
  const latest = useRef(status)
  latest.current = status

  useEffect(() => {
    const push = () => {
      const s = latest.current
      if (s)
        useSlotHistory.getState().push({ used: s.slotsUsed, slots: s.slots, queued: s.queuedTotal })
    }
    push()
    const timer = setInterval(push, SAMPLE_MS)
    return () => clearInterval(timer)
  }, [])

  const slots = Math.max(1, status?.slots ?? samples.at(-1)?.slots ?? 1)
  const padded: (Sample | null)[] = [
    ...Array.from({ length: HISTORY - samples.length }, () => null),
    ...samples,
  ]
  const now = samples.at(-1)
  const share = now ? now.used / Math.max(1, now.slots) : 0
  const live = (now?.used ?? 0) > 0

  return (
    <div className="flex flex-col gap-2 border-t border-hairline pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 text-caption font-medium uppercase tracking-wide text-ink-subtle">
          {live && <RunningFlask />}
          Slot Overview · Last 90s
        </span>
        <span className="text-caption text-ink-subtle">
          Now <span className={cn('num', live ? 'text-ink' : '')}>{fmt.pct(share, 0)}</span> of{' '}
          <span className="num">{fmt.int(slots)}</span> slots
          {now && now.queued > 0 && (
            <>
              {' · '}
              <span className="num">{fmt.int(now.queued)}</span> waiting
            </>
          )}
        </span>
      </div>
      <div
        className="relative flex gap-[3px] overflow-hidden rounded-sm"
        role="img"
        aria-label={`Slot usage over the last 90 seconds; ${fmt.pct(share, 0)} busy now`}
      >
        {padded.map((sample, col) => {
          const colShare = sample ? sample.used / Math.max(1, sample.slots) : 0
          const heat = heatOf(colShare)
          const newest = sample !== null && sample.id === now?.id
          return (
            <div
              key={sample?.id ?? `empty-${col}`}
              className={cn(
                'flex flex-1 flex-col-reverse gap-[3px]',
                newest && 'motion-safe:animate-rise',
              )}
            >
              {Array.from({ length: slots }, (_, row) => {
                const busy = sample !== null && row < sample.used
                return (
                  <span
                    key={row}
                    className={cn(
                      'h-2.5 rounded-[2px] transition-colors duration-500',
                      busy ? heat.cell : 'bg-surface-3',
                      !sample && 'opacity-40',
                      busy && newest && 'motion-safe:animate-pulse',
                    )}
                  />
                )
              })}
            </div>
          )
        })}
        {live && <Scan />}
      </div>
      <Legend items={HEAT.map((h) => ({ label: h.label, swatch: h.cell }))} />
    </div>
  )
}
