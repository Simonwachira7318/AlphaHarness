/**
 * The top bar's core strip, made the consultant's own: how the cores are drawn, and a graph
 * of how many were busy over the last few minutes.
 *
 * The history is sampled here, in the browser, every couple of seconds while the app is open.
 * Nothing records it server-side, so it starts empty on each load.
 */

import { ActivityIcon, CheckIcon, Settings2Icon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { Button } from '@/ui/kit'
import { Menu, Tooltip } from '@/ui/overlay'

export type CoreStyle = 'labels' | 'compact' | 'hidden'
type Window = 5 | 15

interface CoreView {
  style: CoreStyle
  graph: boolean
  window: Window
  set: (patch: Partial<Pick<CoreView, 'style' | 'graph' | 'window'>>) => void
}

export const useCoreView = create<CoreView>()(
  persist((set) => ({ style: 'labels', graph: true, window: 5, set: (patch) => set(patch) }), {
    name: 'alpha-harness-cores',
    version: 1,
  }),
)

const SAMPLE_MS = 2_000
const KEEP_MS = 15 * 60_000

interface Sample {
  at: number
  busy: number
  slots: number
}

const useHistory = create<{ samples: Sample[]; push: (s: Omit<Sample, 'at'>) => void }>()(
  (set) => ({
    samples: [],
    push: (s) =>
      set((state) => {
        const at = Date.now()
        return { samples: [...state.samples.filter((x) => at - x.at <= KEEP_MS), { ...s, at }] }
      }),
  }),
)

/** Records the busy count every couple of seconds, whatever screen is open. */
export function useSampleCores(busy: number, slots: number) {
  const latest = useRef({ busy, slots })
  latest.current = { busy, slots }
  const push = useHistory((s) => s.push)
  useEffect(() => {
    push(latest.current)
    const timer = setInterval(() => push(latest.current), SAMPLE_MS)
    return () => clearInterval(timer)
  }, [push])
}

const W = 96
const H = 24

export function UsageGraph() {
  const samples = useHistory((s) => s.samples)
  const minutes = useCoreView((s) => s.window)
  const now = Date.now()
  const span = minutes * 60_000
  const shown = samples.filter((s) => now - s.at <= span)
  const last = shown.at(-1)
  const share = (s: Sample) => (s.slots > 0 ? Math.min(1, s.busy / s.slots) : 0)
  const peak = shown.reduce((m, s) => Math.max(m, s.busy), 0)

  const points = shown.map((s) => {
    const x = W - ((now - s.at) / span) * W
    const y = H - 1 - share(s) * (H - 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const line = points.join(' ')
  const area =
    points.length > 1
      ? `M${points[0]} L${points.join(' L')} L${W},${H} L${points[0]?.split(',')[0]},${H} Z`
      : ''

  const content = (
    <div className="flex flex-col gap-1 text-caption">
      <span className="font-medium text-ink">Cores busy, last {minutes} minutes</span>
      <span className="num text-ink-muted">
        Now {last ? `${last.busy} of ${last.slots}` : '—'} · Peak {peak}
      </span>
      <span className="text-ink-subtle">Sampled in this window while the app is open.</span>
    </div>
  )

  return (
    <Tooltip content={content}>
      <span
        className="flex items-center gap-1.5 rounded-xs px-1"
        role="img"
        aria-label={`Core usage over the last ${minutes} minutes: ${last ? `${last.busy} of ${last.slots} busy now` : 'no samples yet'}, peak ${peak}`}
      >
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          className="shrink-0 max-sm:hidden"
          aria-hidden
        >
          <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} className="stroke-hairline" />
          {area && <path d={area} className="fill-status-running opacity-25" />}
          {points.length > 1 && (
            <polyline
              points={line}
              fill="none"
              strokeWidth="1.5"
              strokeLinejoin="round"
              className="stroke-status-running"
            />
          )}
        </svg>
        <span className="num w-9 text-right text-caption text-ink-muted">
          {last ? `${Math.round(share(last) * 100)}%` : '—'}
        </span>
      </span>
    </Tooltip>
  )
}

export function CoreSettings() {
  const { style, graph, window: minutes, set } = useCoreView()
  const mark = (on: boolean) => (on ? <CheckIcon /> : <span className="size-3.5" />)
  return (
    <Menu
      trigger={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Core display options"
          title="Core display options"
        >
          <Settings2Icon />
        </Button>
      }
      items={[
        {
          label: 'Labelled cores',
          icon: mark(style === 'labels'),
          onClick: () => set({ style: 'labels' }),
        },
        {
          label: 'Compact cores',
          icon: mark(style === 'compact'),
          onClick: () => set({ style: 'compact' }),
        },
        {
          label: 'Hide cores',
          icon: mark(style === 'hidden'),
          onClick: () => set({ style: 'hidden' }),
        },
        {
          label: graph ? 'Hide usage graph' : 'Show usage graph',
          icon: <ActivityIcon />,
          onClick: () => set({ graph: !graph }),
        },
        {
          label: 'Graph: last 5 minutes',
          icon: mark(minutes === 5),
          onClick: () => set({ window: 5 }),
        },
        {
          label: 'Graph: last 15 minutes',
          icon: mark(minutes === 15),
          onClick: () => set({ window: 15 }),
        },
      ]}
    />
  )
}
