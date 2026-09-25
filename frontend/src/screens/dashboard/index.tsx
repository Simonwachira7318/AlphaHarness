/**
 * Dashboard (spec §4.1): the day in one sentence, the Submittable Alphas counter, today's
 * allowance and queue, today's results and the work in flight. Which of these show, and in
 * what order, is the consultant's choice (./layout). The live matrix has its own screen.
 */

import { useQuery } from '@tanstack/react-query'
import {
  AwardIcon,
  CalendarCheckIcon,
  CpuIcon,
  LayersIcon,
  SendIcon,
  SlidersHorizontalIcon,
} from 'lucide-react'
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react'
import { today } from '@/api/core'
import type { components } from '@/api/generated'
import { http } from '@/api/http'
import { cn } from '@/lib/cn'
import { fmt } from '@/lib/format'

type QuarterStanding = components['schemas']['QuarterStanding']

import { useRefetchOn } from '@/lib/ws'
import { Avatar } from '@/shell/avatar'
import { GeniusBadge } from '@/shell/genius'
import {
  Button,
  ErrorNotice,
  Page,
  Panel,
  QuotaGauge,
  Skeleton,
  TEXT_TONE,
  type Tone,
} from '@/ui/kit'
import { CountUp } from './count-up'
import { Customize } from './customize'
import { GettingStarted } from './getting-started'
import { ordered, PANELS, TILES, type TileId, useLayout } from './layout'
import { TodayResultsPanel } from './results'
import { WorkInFlight } from './work'

export function DashboardScreen() {
  const day = useQuery({ queryKey: ['today'], queryFn: () => today.get() })
  useRefetchOn('simulations', ['today'], 10_000)
  const sims = day.data?.simulations

  // The quarter BRAIN judges on: submitted Alphas and the pyramids they formed. It moves
  // only when something is submitted, which is rare, so it is not worth polling hard.
  const quarter = useQuery({
    queryKey: ['quarter'],
    queryFn: () => http.get<QuarterStanding>('/api/quarter'),
    staleTime: 10 * 60 * 1000,
  })

  const [customizing, setCustomizing] = useState(false)
  const { order, hidden } = useLayout()
  const shownTiles = ordered(order, TILES).filter((id) => !hidden.includes(id))
  const shownPanels = ordered(order, PANELS).filter((id) => !hidden.includes(id))

  const tiles: Record<TileId, ReactNode> = {
    submitted: (
      <StatTile
        icon={<AwardIcon />}
        label="Submitted Alphas"
        loading={quarter.isPending}
        value={quarter.isError ? '—' : <CountUp value={quarter.data?.submitted} />}
        tone={quarter.data?.submitted ? 'profit' : 'neutral'}
        hint={
          quarter.isError
            ? 'The count could not load.'
            : `Submitted in ${quarter.data?.label ?? 'this quarter'}`
        }
      />
    ),
    today: (
      <StatTile
        icon={<CalendarCheckIcon />}
        label="Submitted Today"
        loading={quarter.isPending}
        value={quarter.isError ? '—' : <CountUp value={quarter.data?.submittedToday} />}
        tone={quarter.data?.submittedToday ? 'profit' : 'neutral'}
        hint={quarter.isError ? 'The count could not load.' : "BRAIN's count for today"}
      />
    ),
    left: (
      <StatTile
        icon={<CpuIcon />}
        label="Simulations Left Today"
        loading={!sims}
        value={
          sims && (
            <>
              {sims.exact ? '' : '~'}
              <CountUp value={sims.remaining} />
              <span className="text-body text-ink-subtle"> / {fmt.int(sims.limit)}</span>
            </>
          )
        }
        extra={
          sims && (
            <QuotaGauge used={sims.used} limit={sims.limit} label="Simulation quota depletion" />
          )
        }
        hint={
          sims && (
            <>
              Resets in <ResetCountdown seconds={sims.resetsInSeconds} since={day.dataUpdatedAt} />
              {sims.exact ? '' : ' · estimate until the first result today'}
            </>
          )
        }
      />
    ),
    sent: (
      <StatTile
        icon={<SendIcon />}
        label="Sent Today"
        loading={!sims}
        value={sims && <CountUp value={sims.used} />}
        hint={
          sims && (
            <>
              <span className="num">{fmt.pct(sims.limit ? sims.used / sims.limit : null, 0)}</span>{' '}
              of the allowance
            </>
          )
        }
      />
    ),
    pyramids: (
      <StatTile
        icon={<LayersIcon />}
        label="Pyramids Completed"
        loading={quarter.isPending}
        value={quarter.isError ? '—' : <CountUp value={quarter.data?.pyramidsFormulated} />}
        hint={
          quarter.isError ? (
            'The count could not load.'
          ) : (
            <>
              <span className="num">{fmt.int(quarter.data?.alphasPerPyramid)}</span> submitted
              Alphas complete one
              {quarter.data?.pyramidsStarted ? (
                <>
                  {' · '}
                  <span className="num">{fmt.int(quarter.data.pyramidsStarted)}</span> started
                </>
              ) : null}
            </>
          )
        }
      />
    ),
  }

  return (
    <Page>
      {sims ? (
        <Hero
          name={day.data?.you.fullName}
          userId={day.data?.you.userId}
          level={day.data?.you.geniusLevel}
          text={sims.headline}
          action={
            <Button variant="ghost" size="sm" onClick={() => setCustomizing(true)}>
              <SlidersHorizontalIcon /> Customize
            </Button>
          }
        />
      ) : (
        !day.isError && (
          <Skeleton className="mx-1 mt-2 h-18 w-2/3" label="Loading today's figures" />
        )
      )}
      {/* `RunToday` (./run-today) is deliberately unmounted, not dead: dispatching from the
          Dashboard is coming back. */}
      <GettingStarted today={day.data} />
      {day.isError && <ErrorNotice error={day.error} title="Today's figures could not load" />}

      {shownTiles.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {shownTiles.map((id, i) => (
            // DESIGN.md → Motion, `rise`: the tiles arrive one after another on mount.
            <div
              key={id}
              className="animate-rise"
              // The rise staggers in; the border beam starts each tile at its own point of the lap.
              style={
                {
                  animationDelay: `${200 + i * 70}ms`,
                  '--beam-delay': `${-i * 1.1}s`,
                } as CSSProperties
              }
            >
              {tiles[id]}
            </div>
          ))}
        </div>
      )}

      {shownPanels.map((id, i) => (
        <div
          key={id}
          className="animate-rise"
          style={
            {
              animationDelay: `${200 + (shownTiles.length + i) * 70}ms`,
              '--beam-delay': `${-(shownTiles.length + i) * 1.1}s`,
            } as CSSProperties
          }
        >
          {id === 'results' ? <TodayResultsPanel /> : <WorkInFlight />}
        </div>
      ))}

      <Customize open={customizing} onOpenChange={setCustomizing} />
    </Page>
  )
}

/**
 * The day in one sentence, as the page's heading, greeted by the account's name from
 * `/api/today` (BRAIN profile, falling back to the email). Figures keep tabular digits.
 */
function Hero({
  name,
  userId,
  level,
  text,
  action,
}: {
  name?: string | null | undefined
  userId?: string | null | undefined
  level?: string | null | undefined
  text: string
  action?: ReactNode
}) {
  const parts = text.split(/(~?\d[\d,.]*%?)/)
  return (
    // DESIGN.md → Motion, `rise`: once on mount, a line at a time. Refetches change the text,
    // not the elements, so the figures update in place without replaying it.
    <header className="flex items-center gap-4 px-1 pt-2 pb-1">
      {name && (
        <span className="animate-rise">
          <Avatar name={name} userId={userId} size="lg" />
        </span>
      )}
      <div className="flex min-w-0 flex-col">
        {name && (
          <div className="flex animate-rise flex-wrap items-center gap-x-3 gap-y-1 [animation-delay:80ms]">
            <p className="text-display text-ink">
              {greeting()}, {name}
            </p>
            <GeniusBadge level={level} size="md" />
          </div>
        )}
        {/* text-wrap beats the base h1 balance rule, which splits this into an extra short line. */}
        <h1 className="animate-rise text-display text-wrap text-ink-muted [animation-delay:160ms]">
          {parts.map((part, i) =>
            i % 2 === 1 ? (
              <span key={i} className="num text-display text-primary">
                {part}
              </span>
            ) : (
              part
            ),
          )}
        </h1>
      </div>
      {action && <div className="ml-auto shrink-0 self-start">{action}</div>}
    </header>
  )
}

/** By the local clock: before noon, before five, then evening. */
function greeting(hour = new Date().getHours()): string {
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 17) return 'Good afternoon'
  return 'Good evening'
}

/** One layout for every tile: icon + label (and action) on top, the figure, then a hint. */
function StatTile({
  icon,
  label,
  action,
  value,
  hint,
  tone = 'neutral',
  loading,
  extra,
}: {
  icon?: ReactNode
  label: string
  action?: ReactNode
  value: ReactNode
  hint?: ReactNode
  tone?: Tone
  loading: boolean
  extra?: ReactNode
}) {
  return (
    <Panel
      className="live-tile group isolate h-full overflow-hidden transition-[transform,border-color,background-color] duration-200 ease-out hover:-translate-y-1 hover:border-primary hover:bg-surface-2"
      bodyClassName="flex h-full flex-col justify-between gap-3"
    >
      {/* Live: a corner glow that breathes all the time, and a grid that wakes on hover. */}
      <div
        aria-hidden
        className="lab-glow pointer-events-none absolute inset-0 -z-10 animate-breathe group-hover:animate-none group-hover:opacity-100"
      />
      <div
        aria-hidden
        className="lab-grid pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity duration-300 group-hover:opacity-50"
      />
      <div className="flex min-h-5 items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {icon && (
            <span className="text-ink-subtle transition-colors duration-200 group-hover:text-primary [&_svg]:size-3.5 [&_svg]:origin-center motion-safe:group-hover:[&_svg]:animate-shake">
              {icon}
            </span>
          )}
          <span className="text-caption font-medium uppercase tracking-wide text-ink-subtle transition-colors group-hover:text-ink-muted">
            {label}
          </span>
        </div>
        {action}
      </div>
      {loading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-4 w-40" />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <span className={cn('num text-headline font-semibold leading-none', TEXT_TONE[tone])}>
            {value}
          </span>
          {extra}
          {hint && <span className="text-body-compact text-ink-subtle">{hint}</span>}
        </div>
      )}
    </Panel>
  )
}

/** Ticks locally between refetches, in its own component so the page does not re-render. */
function ResetCountdown({ seconds, since }: { seconds: number; since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <span className="num">{fmt.countdown(seconds - Math.max(0, (now - since) / 1000))}</span>
}
