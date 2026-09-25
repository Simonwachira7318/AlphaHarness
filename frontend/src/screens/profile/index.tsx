/**
 * Profile: the BRAIN account in full. Who you are, how you rank, what you simulated, submitted
 * and earned, where your Alphas sit, and this harness's own settings for submitting them.
 *
 * Everything shown is read from BRAIN by the backend and stays on this computer.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ActivityIcon,
  AwardIcon,
  BadgeCheckIcon,
  CalendarIcon,
  CoinsIcon,
  CpuIcon,
  GraduationCapIcon,
  LayersIcon,
  MapPinIcon,
  RefreshCwIcon,
  SendIcon,
  TrophyIcon,
} from 'lucide-react'
import { type CSSProperties, type ReactNode, useState } from 'react'
import { cn } from '@/lib/cn'
import { DASH, fmt } from '@/lib/format'
import { CapsEditor } from '@/screens/tools/submit-queue/caps'
import { Avatar } from '@/shell/avatar'
import { GeniusBadge } from '@/shell/genius'
import {
  Badge,
  Button,
  Empty,
  ErrorNotice,
  KV,
  Metric,
  Notice,
  Page,
  Panel,
  Segmented,
  Skeleton,
  type Tone,
} from '@/ui/kit'
import { type Activity, type ProfileView, profileApi } from './api'
import { HeatCalendar } from './calendar'

// -- reading BRAIN's loosely typed blocks ------------------------------------------------

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const words = (v: unknown) =>
  str(v)
    ?.toLowerCase()
    .replaceAll('_', ' ')
    .replace(/^\w/, (c) => c.toUpperCase()) ?? DASH
const yesNo = (v: unknown) => (v === true ? 'Yes' : v === false ? 'No' : DASH)
const money = (v: number | null | undefined, currency = 'USD') =>
  v == null ? DASH : new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(v)

const COUNTRIES = new Intl.DisplayNames(['en'], { type: 'region' })
const country = (code: string | null) => {
  if (!code) return null
  try {
    return COUNTRIES.of(code) ?? code
  } catch {
    return code
  }
}

/** Correlation is better low: amber from 0.5, red from 0.7 (BRAIN's production limit). */
const corrTone = (v: number | null): Tone =>
  v == null ? 'neutral' : v >= 0.7 ? 'loss' : v >= 0.5 ? 'warn' : 'profit'

export function ProfileScreen() {
  const client = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)
  const profile = useQuery({ queryKey: ['profile'], queryFn: () => profileApi.get() })

  const refresh = async () => {
    setRefreshing(true)
    try {
      client.setQueryData(['profile'], await profileApi.get(true))
    } finally {
      setRefreshing(false)
    }
  }

  if (profile.isPending)
    return (
      <Page>
        <Skeleton className="h-64" label="Reading your BRAIN profile" />
      </Page>
    )
  if (profile.isError)
    return (
      <Page>
        <ErrorNotice error={profile.error} title="Your profile could not be read" />
      </Page>
    )
  const p = profile.data
  return (
    <Page>
      <Hero p={p} onRefresh={refresh} refreshing={refreshing} />
      {p.problems.length > 0 && (
        <Notice tone="warn" title="Some parts could not be read from BRAIN">
          {p.problems.join(' · ')}
        </Notice>
      )}
      <Headlines p={p} />
      <div className="grid gap-4 xl:grid-cols-2">
        <PerformancePanel p={p} />
        <ActivityPanel p={p} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <EarningsPanel p={p} />
        <DiversityPanel p={p} />
      </div>
      <PyramidsPanel p={p} />
      <div className="grid gap-4 xl:grid-cols-2">
        <CompetitionsPanel p={p} />
        <ReferralsPanel p={p} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <AccountPanel p={p} />
        <div className="flex flex-col gap-4">
          <Panel
            title="Auto-Submit"
            description="The Submit Queue's daily caps for this account."
            className="live-tile"
          >
            <CapsEditor />
          </Panel>
          <HarnessPanel p={p} />
        </div>
      </div>
      <MessagesPanel p={p} />
    </Page>
  )
}

// -- hero ---------------------------------------------------------------------------------

function Hero({
  p,
  onRefresh,
  refreshing,
}: {
  p: ProfileView
  onRefresh: () => void
  refreshing: boolean
}) {
  const u = p.user as Obj
  const name =
    str(u['fullName']) ?? `${str(u['firstName']) ?? ''} ${str(u['lastName']) ?? ''}`.trim()
  const address = obj(u['address'])
  const place = [str(address['city']), country(str(address['country']))].filter(Boolean).join(', ')
  const started = str(obj(p.consultant)['dateStarted'])
  return (
    <section className="live-tile panel-highlight group relative isolate overflow-hidden rounded-lg border border-hairline bg-surface-1 p-5 motion-safe:animate-rise sm:p-6">
      <div
        aria-hidden
        className="lab-glow pointer-events-none absolute inset-0 -z-10 animate-breathe"
      />
      <div aria-hidden className="lab-grid pointer-events-none absolute inset-0 -z-10 opacity-60" />
      <div className="flex flex-wrap items-center gap-5">
        <span className="rounded-2xl ring-2 ring-primary/60 ring-offset-2 ring-offset-surface-1">
          <Avatar name={name || String(u['id'] ?? '?')} userId={str(u['id'])} size="xl" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-display text-balance text-ink">{name || DASH}</h1>
            <GeniusBadge level={str(u['geniusLevel']) ?? str(u['level'])} size="md" />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body text-ink-subtle">
            <span className="num text-ink-muted">{str(u['id']) ?? DASH}</span>
            {place && (
              <span className="flex items-center gap-1">
                <MapPinIcon className="size-3.5" aria-hidden /> {place}
              </span>
            )}
            {str(u['dateCreated']) && (
              <span className="flex items-center gap-1">
                <CalendarIcon className="size-3.5" aria-hidden /> Member since{' '}
                {fmt.date(str(u['dateCreated']))}
              </span>
            )}
            {started && (
              <span className="flex items-center gap-1">
                <AwardIcon className="size-3.5" aria-hidden /> Consultant since {fmt.date(started)}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {u['verified'] === true && (
              <Badge tone="profit">
                <BadgeCheckIcon className="size-3" /> Verified
              </Badge>
            )}
            {u['approved'] === true && <Badge tone="profit">Approved</Badge>}
            {str(obj(u['onboarding'])['status']) && (
              <Badge tone="outline">{words(obj(u['onboarding'])['status'])}</Badge>
            )}
          </div>
        </div>
        <Button variant="ghost" loading={refreshing} onClick={onRefresh} className="self-start">
          <RefreshCwIcon /> Refresh
        </Button>
      </div>
    </section>
  )
}

// -- headline tiles -----------------------------------------------------------------------

function Tile({
  icon,
  label,
  value,
  hint,
  index,
  tone = 'neutral',
}: {
  icon: ReactNode
  label: string
  value: ReactNode
  hint?: ReactNode
  index: number
  tone?: Tone
}) {
  return (
    <div
      className="motion-safe:animate-rise"
      style={
        {
          animationDelay: `${120 + index * 70}ms`,
          '--beam-delay': `${-index * 1.1}s`,
        } as CSSProperties
      }
    >
      <Panel
        className="live-tile group isolate h-full overflow-hidden transition-[transform,border-color,background-color] duration-200 ease-out hover:-translate-y-1 hover:border-primary hover:bg-surface-2"
        bodyClassName="flex h-full flex-col justify-between gap-3"
      >
        <div
          aria-hidden
          className="lab-glow pointer-events-none absolute inset-0 -z-10 animate-breathe group-hover:animate-none group-hover:opacity-100"
        />
        <div className="flex items-center gap-2">
          <span className="text-ink-subtle transition-colors group-hover:text-primary [&_svg]:size-3.5 [&_svg]:origin-center motion-safe:group-hover:[&_svg]:animate-shake">
            {icon}
          </span>
          <span className="text-caption font-medium uppercase tracking-wide text-ink-subtle">
            {label}
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <Metric label="" value={value} tone={tone} />
          {hint && <span className="text-body-compact text-ink-subtle">{hint}</span>}
        </div>
      </Panel>
    </div>
  )
}

function Headlines({ p }: { p: ProfileView }) {
  const earned =
    (p.basePayment?.total?.value ?? 0) + p.otherPayments.reduce((s, x) => s + x.amount, 0)
  const lb = obj(obj(p.consultant)['leaderboard'])
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      <Tile
        index={0}
        icon={<CpuIcon />}
        label="Simulated Alphas"
        value={fmt.int(p.simulations?.total?.value)}
        hint={`${fmt.int(p.simulations?.current?.value)} this month · ${fmt.int(p.simulations?.ytd?.value)} this year`}
      />
      <Tile
        index={1}
        icon={<SendIcon />}
        label="Submitted Alphas"
        value={fmt.int(p.submissions?.total?.value)}
        tone="profit"
        hint={`${fmt.int(p.submissions?.current?.value)} this month · ${fmt.int(p.submissions?.previous?.value)} last month`}
      />
      <Tile
        index={2}
        icon={<CoinsIcon />}
        label="Earned"
        value={money(earned, p.currency)}
        tone="profit"
        hint={`${money(p.basePayment?.total?.value, p.currency)} base · ${money(earned - (p.basePayment?.total?.value ?? 0), p.currency)} quarterly`}
      />
      <Tile
        index={3}
        icon={<LayersIcon />}
        label="Alphas on BRAIN"
        value={fmt.int((p.alphas['is'] ?? 0) + (p.alphas['os'] ?? 0) + (p.alphas['prod'] ?? 0))}
        hint={`${fmt.int(p.alphas['is'])} IS · ${fmt.int(p.alphas['os'])} OS · ${fmt.int(p.alphas['prod'])} prod`}
      />
      <Tile
        index={4}
        icon={<TrophyIcon />}
        label="Value Factor"
        value={fmt.ratio(num(lb['valueFactor']))}
        hint={`Weight factor ${fmt.ratio(num(lb['weightFactor']))}`}
      />
    </div>
  )
}

// -- performance --------------------------------------------------------------------------

function PerformancePanel({ p }: { p: ProfileView }) {
  const lb = obj(obj(p.consultant)['leaderboard'])
  if (!Object.keys(lb).length)
    return (
      <Panel title="Performance">
        <Empty title="BRAIN shows no consultant leaderboard for this account" />
      </Panel>
    )
  const cell = (label: string, value: string, tone: Tone = 'neutral', hint?: string) => (
    <Metric boxed size="sm" label={label} value={value} tone={tone} hint={hint} />
  )
  return (
    <Panel
      title="Performance"
      description="Your line on BRAIN's consultant leaderboard."
      className="live-tile"
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {cell('Value Factor', fmt.ratio(num(lb['valueFactor'])), 'profit')}
          {cell('Weight Factor', fmt.ratio(num(lb['weightFactor'])))}
          {cell('Daily Osmosis Rank', fmt.ratio(num(lb['dailyOsmosisRank'])))}
          {cell('Data Fields Used', fmt.int(num(lb['dataFieldsUsed'])))}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-2 rounded-md border border-hairline p-3">
            <span className="text-caption font-medium uppercase tracking-wide text-ink-subtle">
              Regular Alphas
            </span>
            <div className="grid grid-cols-3 gap-2">
              {cell('Submitted', fmt.int(num(lb['submissionsCount'])))}
              {cell(
                'Prod Corr',
                fmt.ratio(num(lb['meanProdCorrelation'])),
                corrTone(num(lb['meanProdCorrelation'])),
                'mean',
              )}
              {cell(
                'Self Corr',
                fmt.ratio(num(lb['meanSelfCorrelation'])),
                corrTone(num(lb['meanSelfCorrelation'])),
                'mean',
              )}
            </div>
          </div>
          <div className="flex flex-col gap-2 rounded-md border border-hairline p-3">
            <span className="text-caption font-medium uppercase tracking-wide text-ink-subtle">
              SuperAlphas
            </span>
            <div className="grid grid-cols-3 gap-2">
              {cell('Submitted', fmt.int(num(lb['superAlphaSubmissionsCount'])))}
              {cell(
                'Prod Corr',
                fmt.ratio(num(lb['superAlphaMeanProdCorrelation'])),
                corrTone(num(lb['superAlphaMeanProdCorrelation'])),
                'mean',
              )}
              {cell(
                'Self Corr',
                fmt.ratio(num(lb['superAlphaMeanSelfCorrelation'])),
                corrTone(num(lb['superAlphaMeanSelfCorrelation'])),
                'mean',
              )}
            </div>
          </div>
        </div>
        <p className="text-body-compact text-ink-subtle">
          Correlation reads green below 0.5, amber to 0.7 and red from BRAIN's 0.7 production limit.
        </p>
      </div>
    </Panel>
  )
}

// -- activity -----------------------------------------------------------------------------

const SERIES = [
  { value: 'simulations', label: 'Simulated' },
  { value: 'submissions', label: 'Submitted' },
  { value: 'basePayment', label: 'Base Payment' },
] as const
type Series = (typeof SERIES)[number]['value']

/** Enough weeks to reach the first record: at least half a year, at most about sixteen months. */
function weeksFor(records: [string, number][]): number {
  const first = records[0]?.[0]
  if (!first) return 26
  const weeks = Math.ceil((Date.now() - new Date(first).getTime()) / (7 * 86_400_000)) + 1
  return Math.min(70, Math.max(26, weeks))
}

function ActivityPanel({ p }: { p: ProfileView }) {
  const [series, setSeries] = useState<Series>('simulations')
  const a: Activity | null | undefined = p[series]
  const isMoney = series === 'basePayment'
  const show = (v: number | null | undefined) => (isMoney ? money(v, p.currency) : fmt.int(v))
  return (
    <Panel
      title="Activity"
      description="Day by day, as BRAIN records it."
      className="live-tile"
      actions={
        <Segmented
          label="Series"
          items={SERIES.map((s) => ({ value: s.value, label: s.label }))}
          value={series}
          onChange={setSeries}
        />
      }
    >
      {!a ? (
        <Empty title="BRAIN has no record of this yet" />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Metric size="sm" label="Yesterday" value={show(a.yesterday?.value)} />
            <Metric size="sm" label="This Month" value={show(a.current?.value)} />
            <Metric size="sm" label="Last Month" value={show(a.previous?.value)} />
            <Metric size="sm" label="This Year" value={show(a.ytd?.value)} />
            <Metric size="sm" label="All Time" value={show(a.total?.value)} tone="profit" />
          </div>
          <HeatCalendar
            key={series}
            records={a.records}
            weeks={weeksFor(a.records)}
            unit={isMoney ? 'paid' : series === 'simulations' ? 'simulated' : 'submitted'}
            format={isMoney ? (v) => money(v, p.currency) : fmt.int}
          />
        </div>
      )}
    </Panel>
  )
}

// -- earnings -----------------------------------------------------------------------------
//
// BRAIN pays two ways, and its activity feeds say which: a *base payment* on days whose
// submissions it pays for (``DAILY`` rows), and *other payments*, the quarterly ones (``LIST``
// rows carrying their quarter). The feed holds the whole history, so everything below is
// computed from it rather than from a window.

const DAY_MS = 86_400_000
const monthKey = (date: string) => date.slice(0, 7)
const monthLabel = (key: string) => {
  const [y, m] = key.split('-')
  const name = new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  })
  return m === '01' ? `${name} ’${y?.slice(2)}` : name
}

/** Every month from `first` through the current one, so a month with nothing still shows. */
function monthsSince(first: string): string[] {
  const out: string[] = []
  const now = new Date()
  let y = Number(first.slice(0, 4))
  let m = Number(first.slice(5, 7))
  while (y < now.getFullYear() || (y === now.getFullYear() && m <= now.getMonth() + 1)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return out
}

function EarningsPanel({ p }: { p: ProfileView }) {
  const cur = p.currency
  const base = p.basePayment?.records ?? []
  const quarterly = p.otherPayments
  const baseTotal = base.reduce((sum, [, v]) => sum + v, 0)
  const quarterlyTotal = quarterly.reduce((sum, x) => sum + x.amount, 0)
  const dates = [...base.map(([d]) => d), ...quarterly.map((x) => x.date)].sort()
  const first = dates[0]

  if (!first)
    return (
      <Panel title="Earnings" description={`Paid in ${cur}.`} className="live-tile">
        <Empty title="BRAIN shows no payments on this account yet" />
      </Panel>
    )

  // Month by month, base and quarterly apart, every month since the first payment.
  const months = monthsSince(first).map((key) => ({
    key,
    base: base.filter(([d]) => monthKey(d) === key).reduce((s, [, v]) => s + v, 0),
    quarterly: quarterly.filter((x) => monthKey(x.date) === key).reduce((s, x) => s + x.amount, 0),
  }))
  const peak = Math.max(1e-9, ...months.map((m) => m.base + m.quarterly))

  const years = [...new Set(months.map((m) => m.key.slice(0, 4)))].map((year) => {
    const inYear = months.filter((m) => m.key.startsWith(year))
    const b = inYear.reduce((s, m) => s + m.base, 0)
    const q = inYear.reduce((s, m) => s + m.quarterly, 0)
    return { year, base: b, quarterly: q, total: b + q }
  })

  // The base payment's own shape.
  const lastBase = base.at(-1)
  const best = base.reduce<[string, number] | null>(
    (top, row) => (!top || row[1] > top[1] ? row : top),
    null,
  )
  const since = lastBase
    ? Math.floor((Date.now() - new Date(lastBase[0]).getTime()) / DAY_MS)
    : null

  // Against submissions: which days you submitted on were paid a base payment.
  const paid = new Set(base.map(([d]) => d))
  const firstBase = base[0]?.[0] ?? first
  const submitted = (p.submissions?.records ?? []).filter(([d, v]) => d >= firstBase && v > 0)
  const paidOfSubmitted = submitted.filter(([d]) => paid.has(d)).length
  const afterLast = lastBase ? submitted.filter(([d]) => d > lastBase[0]) : []
  const alphasAfterLast = afterLast.reduce((s, [, v]) => s + v, 0)
  const thisYear = String(new Date().getFullYear())

  return (
    <Panel
      title="Earnings"
      description={`Everything BRAIN has paid this account, in ${cur}.`}
      className="live-tile"
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric
            boxed
            size="sm"
            label="Total Earned"
            value={money(baseTotal + quarterlyTotal, cur)}
            tone="profit"
          />
          <Metric
            boxed
            size="sm"
            label="Base Payments"
            value={money(baseTotal, cur)}
            hint={`${fmt.int(base.length)} paid days`}
          />
          <Metric
            boxed
            size="sm"
            label="Quarterly Payments"
            value={money(quarterlyTotal, cur)}
            hint={`${fmt.int(quarterly.length)} quarters`}
          />
          <Metric
            boxed
            size="sm"
            label="This Year"
            value={money(years.find((y) => y.year === thisYear)?.total ?? 0, cur)}
            hint={`${money(p.basePayment?.ytd?.value ?? 0, cur)} of it base`}
          />
        </div>

        {since !== null && since > 30 && lastBase && (
          <Notice tone="warn" title={`No base payment for ${fmt.int(since)} days`}>
            The last one was {money(lastBase[1], cur)} on {fmt.date(lastBase[0])}. Since then you
            submitted <span className="num">{fmt.int(alphasAfterLast)}</span> Alphas on{' '}
            <span className="num">{fmt.int(afterLast.length)}</span> days, and none of those days
            has a base payment in BRAIN's record.
            {quarterly.some((x) => x.date > lastBase[0]) ? ' Quarterly payments continued.' : ''}
          </Notice>
        )}

        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-caption font-medium uppercase tracking-wide text-ink-subtle">
              Paid by month · since {fmt.date(first)}
            </span>
            <span className="flex items-center gap-3 text-caption text-ink-subtle">
              <span className="flex items-center gap-1">
                <span className="size-2 rounded-[2px] bg-pnl-positive" aria-hidden /> Base
              </span>
              <span className="flex items-center gap-1">
                <span className="size-2 rounded-[2px] bg-primary" aria-hidden /> Quarterly
              </span>
            </span>
          </div>
          <div className="overflow-x-auto">
            <div
              className="flex h-32 items-end gap-1"
              style={{ width: `max(100%, ${months.length * 30}px)` }}
              role="img"
              aria-label="Payments by month"
            >
              {months.map((m, i) => {
                const total = m.base + m.quarterly
                return (
                  <div
                    key={m.key}
                    className="flex h-full flex-1 flex-col items-center justify-end gap-1"
                    title={`${monthLabel(m.key)} ${m.key.slice(0, 4)}: ${money(m.base, cur)} base · ${money(m.quarterly, cur)} quarterly`}
                  >
                    {total > 0 ? (
                      <div
                        className="flex w-full flex-col-reverse overflow-hidden rounded-t-[3px] motion-safe:animate-rise"
                        style={{
                          height: `${Math.max(3, (total / peak) * 100)}%`,
                          animationDelay: `${i * 30}ms`,
                        }}
                      >
                        <div className="bg-pnl-positive/85" style={{ flexGrow: m.base }} />
                        <div className="bg-primary/85" style={{ flexGrow: m.quarterly }} />
                      </div>
                    ) : (
                      <span className="h-px w-full bg-hairline-strong" aria-hidden />
                    )}
                    <span className="num text-[10px] whitespace-nowrap text-ink-subtle">
                      {monthLabel(m.key)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5 rounded-md border border-hairline p-3">
            <span className="text-caption font-medium uppercase tracking-wide text-ink-subtle">
              Base payment
            </span>
            <KV
              items={[
                ['Paid days', fmt.int(base.length)],
                ['Average day', money(base.length ? baseTotal / base.length : null, cur)],
                ['Best day', best ? `${money(best[1], cur)} · ${fmt.date(best[0])}` : DASH],
                [
                  'Last paid',
                  lastBase ? `${fmt.date(lastBase[0])} · ${fmt.int(since)} days ago` : DASH,
                ],
                [
                  'Submission days paid',
                  submitted.length
                    ? `${fmt.int(paidOfSubmitted)} of ${fmt.int(submitted.length)} (${fmt.pct(paidOfSubmitted / submitted.length, 0)})`
                    : DASH,
                ],
              ]}
            />
          </div>
          <div className="flex flex-col gap-1.5 rounded-md border border-hairline p-3">
            <span className="text-caption font-medium uppercase tracking-wide text-ink-subtle">
              By year
            </span>
            <table className="w-full text-body">
              <thead>
                <tr className="text-body-compact text-ink-subtle">
                  <th className="py-1 text-left font-medium">Year</th>
                  <th className="py-1 text-right font-medium">Base</th>
                  <th className="py-1 text-right font-medium">Quarterly</th>
                  <th className="py-1 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {years.map((y) => (
                  <tr key={y.year} className="border-t border-hairline-subtle">
                    <td className="num py-1 text-ink-muted">{y.year}</td>
                    <td className="num py-1 text-right">{money(y.base, cur)}</td>
                    <td className="num py-1 text-right">{money(y.quarterly, cur)}</td>
                    <td className="num py-1 text-right text-pnl-positive">{money(y.total, cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {quarterly.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-caption font-medium uppercase tracking-wide text-ink-subtle">
              Quarterly payments
            </span>
            <ul className="flex flex-col divide-y divide-hairline-subtle">
              {quarterly.map((x) => (
                <li
                  key={`${x.date}-${x.kind}`}
                  className="flex items-center justify-between gap-3 py-1.5 text-body"
                >
                  <span className="text-ink-muted">{x.kind || 'Payment'}</span>
                  <span className="text-body-compact text-ink-subtle">paid {fmt.date(x.date)}</span>
                  <span className="num text-pnl-positive">{money(x.amount, cur)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Panel>
  )
}

// -- diversity ----------------------------------------------------------------------------

const CHECK_TONE: Record<string, Tone> = { PASS: 'profit', WARN: 'warn', FAIL: 'loss' }

function DiversityPanel({ p }: { p: ProfileView }) {
  const rows = [...p.diversity].sort((a, b) => b.alphas - a.alphas)
  const max = Math.max(1, ...rows.map((r) => r.alphas))
  return (
    <Panel
      title="Data Diversity"
      description="Submitted Alphas by market and data category, against BRAIN's diversity limit."
      className="live-tile"
    >
      {rows.length === 0 ? (
        <Empty title="Nothing submitted to measure yet" />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <li
              key={`${r.region}-${r.delay}-${r.category}`}
              className="flex items-center gap-3 text-body"
            >
              <span className="num w-16 shrink-0 text-ink-muted">
                {r.region} D{r.delay}
              </span>
              <span className="w-28 shrink-0 truncate text-ink">{r.category}</span>
              <span className="relative h-2 flex-1 overflow-hidden rounded-pill bg-surface-3">
                <span
                  className={cn(
                    'absolute inset-y-0 left-0 origin-left rounded-pill motion-safe:animate-rise',
                    r.check === 'FAIL'
                      ? 'bg-pnl-negative'
                      : r.check === 'WARN'
                        ? 'bg-status-warning'
                        : 'bg-pnl-positive',
                  )}
                  style={{ width: `${(r.alphas / max) * 100}%` }}
                />
              </span>
              <span className="num w-8 text-right text-ink">{r.alphas}</span>
              <Badge tone={CHECK_TONE[r.check ?? ''] ?? 'outline'} className="w-12 justify-center">
                {r.check ?? DASH}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

// -- pyramids -----------------------------------------------------------------------------

function PyramidsPanel({ p }: { p: ProfileView }) {
  const markets = [...new Set(p.pyramids.map((x) => `${x.region} D${x.delay}`))].sort()
  const [market, setMarket] = useState<string | null>(null)
  const chosen = market && markets.includes(market) ? market : (markets[0] ?? null)
  const rows = p.pyramids
    .filter((x) => `${x.region} D${x.delay}` === chosen)
    .sort((a, b) => b.multiplier - a.multiplier)
  const tone = (m: number) =>
    m >= 1.6
      ? 'border-pnl-positive-edge bg-pnl-positive-tint text-pnl-positive'
      : m >= 1.3
        ? 'border-status-warning-edge bg-status-warning-tint text-status-warning'
        : 'border-hairline bg-surface-2 text-ink-muted'
  return (
    <Panel
      title="Pyramid Multipliers"
      description="What a submission in each data category is worth, by market. Higher pays more."
      className="live-tile"
    >
      {markets.length === 0 ? (
        <Empty title="BRAIN lists no pyramids for this account" />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">
            {markets.map((m) => (
              <button
                type="button"
                key={m}
                aria-pressed={m === chosen}
                onClick={() => setMarket(m)}
                className={cn(
                  'num h-7 rounded-sm border px-2 text-body-compact transition-colors',
                  m === chosen
                    ? 'border-primary bg-surface-3 text-ink'
                    : 'border-hairline text-ink-subtle hover:text-ink',
                )}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {rows.map((x, i) => (
              <div
                key={x.category}
                className={cn(
                  'flex items-center justify-between gap-2 rounded-md border px-3 py-2 motion-safe:animate-rise',
                  tone(x.multiplier),
                )}
                style={{ animationDelay: `${i * 25}ms` }}
              >
                <span className="truncate text-body">{x.category}</span>
                <span className="num text-body font-semibold">×{x.multiplier.toFixed(1)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  )
}

// -- competitions and referrals ----------------------------------------------------------

function CompetitionsPanel({ p }: { p: ProfileView }) {
  const now = Date.now()
  return (
    <Panel
      title="Competitions"
      description="The ones you joined, and your rank in each."
      className="live-tile"
    >
      {p.competitions.length === 0 ? (
        <Empty title="No competitions joined" />
      ) : (
        <ul className="flex flex-col divide-y divide-hairline-subtle">
          {p.competitions.map((c) => {
            const live = c.end ? new Date(c.end).getTime() > now : false
            return (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <TrophyIcon
                  className={cn(
                    'size-4',
                    live ? 'text-primary motion-safe:animate-shake' : 'text-ink-subtle',
                  )}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-body text-ink">{c.name}</span>
                {live ? <Badge tone="profit">Running</Badge> : <Badge tone="outline">Ended</Badge>}
                <span className="num text-body-compact text-ink-subtle">
                  Rank{' '}
                  <span className="text-ink">{c.rank == null ? DASH : `#${fmt.int(c.rank)}`}</span>
                </span>
                <span className="num text-body-compact text-ink-subtle">
                  {fmt.int(c.alphas)} Alphas
                </span>
                <span className="w-full text-caption text-ink-subtle">
                  {fmt.date(c.start)} – {fmt.date(c.end)}
                  {c.scoring ? ` · scored on ${words(c.scoring).toLowerCase()}` : ''}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

function ReferralsPanel({ p }: { p: ProfileView }) {
  const active = p.referrals.filter((r) => r.active).length
  return (
    <Panel
      title="Referrals"
      description={`${fmt.int(p.referrals.length)} invited · ${fmt.int(active)} active`}
      className="live-tile"
    >
      {p.referrals.length === 0 ? (
        <Empty title="Nobody referred yet" />
      ) : (
        <ul className="flex flex-col divide-y divide-hairline-subtle">
          {p.referrals.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-body">
              <span
                className={cn(
                  'size-2 rounded-full',
                  r.active ? 'bg-pnl-positive motion-safe:animate-pulse' : 'bg-ink-subtle',
                )}
                aria-hidden
              />
              <span className="num text-ink">{r.id}</span>
              <span className="text-ink-subtle">{country(r.country) ?? DASH}</span>
              <span className="ml-auto text-body-compact text-ink-subtle">
                Signed in {words(r.signIn).toLowerCase()} · {r.eligibleAlphas ?? '0'} eligible
                Alphas
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

// -- account details ----------------------------------------------------------------------

function AccountPanel({ p }: { p: ProfileView }) {
  const u = p.user as Obj
  const edu = obj(u['education'])
  const job = obj(u['employment'])
  const rec = obj(u['recruitment'])
  const privacy = obj(obj(u['settings'])['privacy'])
  const address = obj(u['address'])
  const interests = Array.isArray(rec['roleInterest']) ? (rec['roleInterest'] as string[]) : []
  return (
    <Panel
      title="Account Details"
      description="As BRAIN holds them. Change them on the BRAIN platform."
      className="live-tile"
    >
      <div className="flex flex-col gap-4">
        <KV
          items={[
            ['Email', str(u['email']) ?? DASH],
            ['Telephone', str(u['telephone']) ?? DASH],
            ['Gender', words(u['gender'])],
            [
              'Location',
              [str(address['city']), country(str(address['country']))].filter(Boolean).join(', ') ||
                DASH,
            ],
            ['Approved', str(u['dateApproved']) ? fmt.date(str(u['dateApproved'])) : DASH],
            [
              'Session',
              p.sessionExpiresInSeconds == null
                ? DASH
                : `Expires in ${fmt.duration(p.sessionExpiresInSeconds)}`,
            ],
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5 rounded-md border border-hairline p-3">
            <span className="flex items-center gap-1.5 text-caption font-medium uppercase tracking-wide text-ink-subtle">
              <GraduationCapIcon className="size-3.5" aria-hidden /> Education
            </span>
            <span className="text-body text-ink">{str(edu['university']) ?? DASH}</span>
            <span className="text-body-compact text-ink-subtle">
              {words(edu['degree'])} · {str(edu['major']) ?? DASH}
              {num(edu['graduationYear']) ? ` · ${edu['graduationYear']}` : ''}
              {edu['stem'] === true ? ' · STEM' : ''}
            </span>
          </div>
          <div className="flex flex-col gap-1.5 rounded-md border border-hairline p-3">
            <span className="flex items-center gap-1.5 text-caption font-medium uppercase tracking-wide text-ink-subtle">
              <ActivityIcon className="size-3.5" aria-hidden /> Employment
            </span>
            <span className="text-body text-ink">
              {str(job['title']) ?? DASH} · {str(job['employer']) ?? DASH}
            </span>
            <span className="text-body-compact text-pretty text-ink-subtle">
              {str(job['business']) ?? ''}
            </span>
          </div>
        </div>
        <KV
          items={[
            ['English', words(rec['englishProficiency'])],
            ['Coding', words(rec['codingProficiency'])],
            ['Interests', interests.map((i) => words(i)).join(', ') || DASH],
            ['Name shown', words(obj(privacy['name'])['visibility'])],
            ['Picture shown', words(obj(privacy['image'])['visibility'])],
            ['SMS allowed', yesNo(obj(obj(u['settings'])['communication'])['allowSMS'])],
          ]}
        />
        <div className="flex flex-col gap-1.5">
          <span className="text-caption font-medium uppercase tracking-wide text-ink-subtle">
            Account Features
          </span>
          <div className="flex flex-wrap gap-1.5">
            {p.features.map((f) => (
              <Badge key={f} tone="outline">
                {words(f)}
              </Badge>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  )
}

// -- the harness itself -------------------------------------------------------------------

function HarnessPanel({ p }: { p: ProfileView }) {
  return (
    <Panel
      title="In This Harness"
      description="What this app did for the account."
      className="live-tile"
    >
      <div className="grid grid-cols-3 gap-3">
        <Metric
          boxed
          size="sm"
          label="Simulations Sent"
          value={fmt.int(p.harness.simulationsSent)}
        />
        <Metric boxed size="sm" label="Tasks" value={fmt.int(p.harness.tasks)} />
        <Metric
          boxed
          size="sm"
          label="Submitted Here"
          value={fmt.int(p.harness.submissions)}
          tone="profit"
        />
      </div>
    </Panel>
  )
}

function MessagesPanel({ p }: { p: ProfileView }) {
  return (
    <Panel
      title="Latest from BRAIN"
      description="Announcements and messages, newest first."
      className="live-tile"
    >
      {p.messages.length === 0 ? (
        <Empty title="No messages" />
      ) : (
        <ul className="flex flex-col divide-y divide-hairline-subtle">
          {p.messages.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <Badge tone="outline">{words(m.type)}</Badge>
              <span className="min-w-0 flex-1 truncate text-body text-ink">{m.title}</span>
              <span className="text-body-compact text-ink-subtle">{fmt.ago(m.date)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
