/**
 * Today's Results: how the simulations sent today ended, over the platform's day (the same day
 * `Sent Today` counts), and the best Sharpe among those that completed.
 */

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { today } from '@/api/core'
import { cn } from '@/lib/cn'
import { fmt } from '@/lib/format'
import { useRefetchOn } from '@/lib/ws'
import { Empty, ErrorNotice, LINK, Metric, Panel, Skeleton, signTone, TEXT_TONE } from '@/ui/kit'
import { CountUp } from './count-up'
import { ResultsHeatmap, RunningFlask } from './heatmap'

const SEGMENTS = [
  { key: 'completed', label: 'Completed', bar: 'bg-pnl-positive' },
  { key: 'errored', label: 'Errored', bar: 'bg-pnl-negative' },
  { key: 'cancelled', label: 'Cancelled', bar: 'bg-status-warning' },
  { key: 'running', label: 'Running', bar: 'bg-ink-subtle' },
] as const

export function TodayResultsPanel() {
  const results = useQuery({ queryKey: ['today-results'], queryFn: () => today.results() })
  useRefetchOn('simulations', ['today-results'], 5000)
  const r = results.data
  const total = r ? r.completed + r.errored + r.cancelled + r.running + r.unresolved : 0
  const settled = r ? r.completed + r.errored + r.cancelled : 0

  return (
    <Panel
      title="Today's Results"
      description="How the simulations sent today ended"
      className="live-tile"
      bodyClassName="flex flex-col gap-4"
    >
      {results.isPending ? (
        <Skeleton className="h-28" label="Loading today's results" />
      ) : results.isError ? (
        <ErrorNotice error={results.error} title="Today's results could not load" />
      ) : !r || total === 0 ? (
        <Empty title="No simulations sent today yet" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Metric label="Completed" tone="profit" value={<CountUp value={r.completed} />} />
            <Metric label="Errored" tone="loss" value={<CountUp value={r.errored} />} />
            <Metric label="Cancelled" tone="warn" value={<CountUp value={r.cancelled} />} />
            <Metric
              label={
                <span className="flex items-center gap-1.5">
                  {r.running > 0 && <RunningFlask />}
                  Running
                </span>
              }
              value={<CountUp value={r.running} />}
            />
          </div>

          <div className="flex flex-col gap-2">
            <div
              className="flex h-2 overflow-hidden rounded-pill bg-surface-3"
              role="img"
              aria-label={SEGMENTS.map((s) => `${fmt.int(r[s.key])} ${s.label}`).join(', ')}
            >
              {SEGMENTS.map((s) =>
                r[s.key] > 0 ? (
                  <div key={s.key} className={s.bar} style={{ flexGrow: r[s.key] }} />
                ) : null,
              )}
            </div>
            <p className="text-body-compact text-ink-subtle">
              <span className="num text-ink">
                {fmt.pct(settled ? r.completed / settled : null, 0)}
              </span>{' '}
              of today's finished simulations completed
              {r.unresolved > 0 && (
                <>
                  {' · '}
                  <span className="num">{fmt.int(r.unresolved)}</span> still being matched
                </>
              )}
            </p>
          </div>

          {r.best && (
            <div className="flex flex-col gap-1.5 border-t border-hairline pt-3">
              <span className="text-caption font-medium uppercase tracking-wide text-ink-subtle">
                Best Sharpe Today
              </span>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span
                  className={cn(
                    'num text-headline font-semibold leading-none',
                    TEXT_TONE[signTone(r.best.sharpe)],
                  )}
                >
                  {fmt.ratio(r.best.sharpe)}
                </span>
                <span className="text-body-compact text-ink-subtle">
                  Fitness <span className="num text-ink">{fmt.ratio(r.best.fitness)}</span>
                </span>
                <Link to="/alpha/$alphaId" params={{ alphaId: r.best.alphaId }} className={LINK}>
                  Open Alpha
                </Link>
              </div>
              {r.best.expression && (
                <code className="block truncate rounded-md bg-canvas px-2 py-1.5 font-mono text-caption text-ink-muted">
                  {r.best.expression}
                </code>
              )}
            </div>
          )}

          <ResultsHeatmap counts={r} />
        </>
      )}
    </Panel>
  )
}
