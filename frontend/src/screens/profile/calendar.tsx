/**
 * A calendar heat map of one daily series: a column per week, a row per weekday, the newest on
 * the right. Shades come from the series' own spread over the window, so a quiet account and a
 * busy one both use the whole scale.
 */

import { cn } from '@/lib/cn'
import { fmt } from '@/lib/format'

const SHADES = [
  'bg-surface-3',
  'bg-primary/25',
  'bg-primary/45',
  'bg-primary/70',
  'bg-primary',
] as const

const DAY_MS = 86_400_000
const iso = (d: Date) => d.toISOString().slice(0, 10)

export function HeatCalendar({
  records,
  weeks = 26,
  unit,
  format = fmt.int,
}: {
  records: [string, number][]
  weeks?: number
  unit: string
  format?: (v: number) => string
}) {
  const byDay = new Map(records)
  const today = new Date()
  const end = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()))
  // Start on the Sunday `weeks` columns back, so every column is one whole week.
  const start = new Date(end.getTime() - ((weeks - 1) * 7 + end.getUTCDay()) * DAY_MS)

  const days: { date: string; value: number; future: boolean }[] = []
  for (let t = start.getTime(); days.length < weeks * 7; t += DAY_MS) {
    const d = new Date(t)
    days.push({ date: iso(d), value: byDay.get(iso(d)) ?? 0, future: t > end.getTime() })
  }
  const active = days
    .filter((d) => d.value > 0)
    .map((d) => d.value)
    .sort((a, b) => a - b)
  const cut = (q: number) => active[Math.min(active.length - 1, Math.floor(q * active.length))] ?? 0
  const bounds = [cut(0.25), cut(0.5), cut(0.75)]
  const shade = (v: number) =>
    v <= 0
      ? 0
      : v <= (bounds[0] ?? 0)
        ? 1
        : v <= (bounds[1] ?? 0)
          ? 2
          : v <= (bounds[2] ?? 0)
            ? 3
            : 4
  const total = days.reduce((sum, d) => sum + d.value, 0)
  const columns = Array.from({ length: weeks }, (_, w) => days.slice(w * 7, w * 7 + 7))

  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex gap-[3px] overflow-x-auto pb-1"
        role="img"
        aria-label={`${format(total)} ${unit} over the last ${weeks} weeks`}
      >
        {columns.map((week, w) => (
          <div
            key={week[0]?.date ?? w}
            className="flex flex-col gap-[3px] motion-safe:animate-rise"
            style={{ animationDelay: `${w * 18}ms` }}
          >
            {week.map((d) => (
              <span
                key={d.date}
                title={d.future ? undefined : `${fmt.date(d.date)} · ${format(d.value)} ${unit}`}
                className={cn(
                  'size-3 rounded-[2px] transition-colors',
                  d.future ? 'opacity-0' : SHADES[shade(d.value)],
                  d.date === iso(end) && d.value > 0 && 'motion-safe:animate-pulse',
                )}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-caption text-ink-subtle">
        <span>
          <span className="num text-ink">{format(total)}</span> {unit} in the last {weeks} weeks
        </span>
        <span className="flex items-center gap-1">
          Less
          {SHADES.map((s) => (
            <span key={s} className={cn('size-2.5 rounded-[2px]', s)} aria-hidden />
          ))}
          More
        </span>
      </div>
    </div>
  )
}
