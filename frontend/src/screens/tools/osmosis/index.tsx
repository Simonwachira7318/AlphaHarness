/**
 * Osmosis (Tools): every scope's 100,000 points spread over your strongest submitted Alphas.
 *
 * Shows what BRAIN holds now against what the harness would set, before anything is applied.
 * With Auto on, the harness applies the plan itself every Saturday, ahead of Sunday's lock.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CheckIcon, SaveIcon, SparklesIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/api/http'
import { cn } from '@/lib/cn'
import { DASH, fmt } from '@/lib/format'
import { Setting } from '@/screens/research-labs/task-settings'
import {
  Badge,
  Button,
  Checkbox,
  Empty,
  ErrorNotice,
  Input,
  LINK,
  Metric,
  Notice,
  Page,
  PageHeader,
  Panel,
  Segmented,
  Skeleton,
} from '@/ui/kit'
import { Confirm } from '@/ui/overlay'
import { type OsmosisSettings, type OsmosisView, osmosisApi, type ScopeView } from './api'

const WEIGHTINGS = [
  { value: 'fitness' as const, label: 'Fitness' },
  { value: 'sharpe' as const, label: 'Sharpe' },
  { value: 'equal' as const, label: 'Equal' },
]

/** Seconds to the next Sunday 23:59 US Eastern, when BRAIN locks the week's allocation. */
function toLock(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  const minutes = Number(get('hour')) * 60 + Number(get('minute'))
  const lock = 23 * 60 + 59
  let daysAhead = (7 - day) % 7
  if (daysAhead === 0 && minutes > lock) daysAhead = 7
  return (daysAhead * 24 * 60 + (lock - minutes)) * 60
}

export function OsmosisScreen() {
  const client = useQueryClient()
  const view = useQuery({ queryKey: ['osmosis'], queryFn: osmosisApi.view })
  const [confirming, setConfirming] = useState(false)
  const refresh = () => client.invalidateQueries({ queryKey: ['osmosis'] })

  const apply = useMutation({
    mutationFn: osmosisApi.apply,
    onSuccess: (out) => {
      if (out.eligible && out.failed.length === 0) toast.success(out.message)
      else toast.error('Osmosis was not fully applied', { description: out.message })
      setConfirming(false)
      void refresh()
    },
    onError: (e) => {
      setConfirming(false)
      toast.error('Could not apply', { description: errorMessage(e) })
    },
  })

  const d = view.data
  return (
    <Page>
      <PageHeader
        title="Osmosis"
        description="Every scope's 100,000 points, spread over your strongest submitted Alphas. BRAIN locks the week's allocation each Sunday at 23:59 US Eastern."
        actions={
          d && (
            <Button
              variant="primary"
              disabled={!d.plannedEligible || d.changes === 0}
              loading={apply.isPending}
              onClick={() => setConfirming(true)}
            >
              <SparklesIcon />
              {d.changes === 0 ? 'Up to Date' : `Allocate Now · ${fmt.int(d.changes)} changes`}
            </Button>
          )
        }
      />
      {view.isPending && <Skeleton className="h-48" label="Reading your submitted Alphas" />}
      {view.isError && <ErrorNotice error={view.error} title="Could not read your allocation" />}
      {d && (
        <>
          <Status d={d} />
          <SettingsPanel d={d} />
          {d.problems.map((p) => (
            <Notice key={p} tone="error" title={p} />
          ))}
          <div className="grid gap-4 xl:grid-cols-2">
            {d.scopes
              .filter((s) => s.eligible > 0 || s.currentAlphas > 0)
              .map((s) => (
                <ScopePanel key={s.scope} s={s} />
              ))}
          </div>
        </>
      )}
      <Confirm
        open={confirming}
        onOpenChange={(open) => !open && !apply.isPending && setConfirming(false)}
        title="Allocate Osmosis points now?"
        confirmLabel="Allocate"
        pending={apply.isPending}
        onConfirm={() => apply.mutate()}
      >
        This sets Osmosis points on {fmt.int(d?.changes)} of your submitted Alphas on BRAIN, and
        clears them from Alphas not in the plan. You can change them again any time before Sunday
        23:59 US Eastern.
      </Confirm>
    </Page>
  )
}

function Status({ d }: { d: OsmosisView }) {
  const allocated = d.scopes.filter((s) => s.allocated).length
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Metric
        boxed
        label="On BRAIN Now"
        value={d.currentEligible ? 'Eligible' : 'Not eligible'}
        tone={d.currentEligible ? 'profit' : 'loss'}
        hint={d.currentProblems.join(' · ') || 'Meets every rule'}
      />
      <Metric
        boxed
        label="Harness Plan"
        value={d.plannedEligible ? `${allocated} scopes` : 'Not possible'}
        tone={d.plannedEligible ? 'profit' : 'warn'}
        hint={`${fmt.int(d.rules['pointsPerScope'])} points over ${fmt.int(d.rules['minAlphas'])}+ Alphas in ${fmt.int(d.rules['minScopes'])}+ scopes`}
      />
      <Metric
        boxed
        label="Locks In"
        value={fmt.countdown(toLock())}
        hint="Sunday 23:59 US Eastern"
      />
      <Metric
        boxed
        label="Automatic"
        value={d.auto ? 'On · Saturdays' : 'Off'}
        tone={d.auto ? 'profit' : 'neutral'}
        hint={
          d.lastApplied
            ? `Last applied ${fmt.ago(d.lastApplied)}${d.lastResult ? ` · ${d.lastResult}` : ''}`
            : 'Not applied yet'
        }
      />
    </div>
  )
}

function SettingsPanel({ d }: { d: OsmosisView }) {
  const client = useQueryClient()
  const saved: OsmosisSettings = {
    auto: d.auto,
    per_scope: d.perScope,
    weighting: d.weighting as OsmosisSettings['weighting'],
    include_super: d.includeSuper,
  }
  const [draft, setDraft] = useState(saved)
  const key = JSON.stringify(saved)
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the saved values by content
  useEffect(() => setDraft(saved), [key])
  const dirty = JSON.stringify(draft) !== key
  const save = useMutation({
    mutationFn: () => osmosisApi.save(draft),
    onSuccess: () => {
      toast.success('Osmosis settings saved')
      void client.invalidateQueries({ queryKey: ['osmosis'] })
    },
    onError: (e) => toast.error('Could not save', { description: errorMessage(e) }),
  })
  return (
    <Panel
      title="How to Allocate"
      description="Changing these only changes the plan; nothing reaches BRAIN until it is allocated."
      className="live-tile"
    >
      <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
        <Setting label="Alphas per scope">
          <Input
            type="number"
            min={10}
            max={100}
            className="w-24"
            aria-label="Alphas per scope"
            value={draft.per_scope}
            onChange={(e) =>
              setDraft({
                ...draft,
                per_scope: Math.min(100, Math.max(10, Math.floor(Number(e.target.value) || 10))),
              })
            }
          />
        </Setting>
        <Setting label="Weight points by">
          <Segmented
            label="Weight points by"
            items={WEIGHTINGS}
            value={draft.weighting}
            onChange={(weighting) => setDraft({ ...draft, weighting })}
          />
        </Setting>
        <Checkbox
          label="Include SuperAlphas"
          hint="Off: only regular Alphas take points."
          checked={draft.include_super}
          onChange={(include_super) => setDraft({ ...draft, include_super })}
        />
        <Checkbox
          label="Allocate automatically"
          hint="Every Saturday, before Sunday's lock."
          checked={draft.auto}
          onChange={(auto) => setDraft({ ...draft, auto })}
        />
        <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
          <SaveIcon />
          Save
        </Button>
      </div>
    </Panel>
  )
}

function ScopePanel({ s }: { s: ScopeView }) {
  const peak = Math.max(1, ...s.alphas.map((a) => Math.max(a.planned ?? 0, a.current ?? 0)))
  const planned = s.alphas.reduce((sum, a) => sum + (a.planned ?? 0), 0)
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <span className="num">{s.scope}</span>
          {s.allocated ? (
            <Badge tone="profit">
              <CheckIcon className="size-3" /> {fmt.int(planned)} points
            </Badge>
          ) : (
            <Badge tone="outline">Too few Alphas</Badge>
          )}
        </span>
      }
      description={`${fmt.int(s.eligible)} eligible Alphas · now ${fmt.int(s.currentAlphas)} hold ${fmt.int(s.currentTotal)} points`}
      className="live-tile"
    >
      {s.alphas.length === 0 ? (
        <Empty title="Nothing allocated here">
          A scope needs at least 10 eligible submitted Alphas.
        </Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-body">
            <thead>
              <tr className="border-b border-hairline text-body-compact text-ink-subtle">
                <th className="px-2 py-1.5 text-left font-medium">Alpha</th>
                <th className="px-2 py-1.5 text-right font-medium">Fitness</th>
                <th className="px-2 py-1.5 text-right font-medium">Sharpe</th>
                <th className="px-2 py-1.5 text-right font-medium">Now</th>
                <th className="px-2 py-1.5 text-left font-medium">Planned</th>
              </tr>
            </thead>
            <tbody>
              {s.alphas.map((a, i) => (
                <tr key={a.alphaId} className="border-b border-hairline-subtle last:border-b-0">
                  <td className="num px-2 py-1">
                    <Link to="/alpha/$alphaId" params={{ alphaId: a.alphaId }} className={LINK}>
                      {a.alphaId}
                    </Link>
                    {a.type === 'SUPER' && (
                      <Badge tone="outline" className="ml-1.5">
                        Super
                      </Badge>
                    )}
                  </td>
                  <td className="num px-2 py-1 text-right">{fmt.ratio(a.fitness)}</td>
                  <td className="num px-2 py-1 text-right">{fmt.ratio(a.sharpe)}</td>
                  <td
                    className={cn(
                      'num px-2 py-1 text-right',
                      a.current && !a.planned ? 'text-pnl-negative line-through' : 'text-ink-muted',
                    )}
                  >
                    {a.current ? fmt.int(a.current) : DASH}
                  </td>
                  <td className="px-2 py-1">
                    <span className="flex items-center gap-2">
                      <span className="h-1.5 w-24 overflow-hidden rounded-pill bg-surface-3">
                        <span
                          className="block h-full origin-left rounded-pill bg-primary motion-safe:animate-rise"
                          style={{
                            width: `${((a.planned ?? 0) / peak) * 100}%`,
                            animationDelay: `${i * 20}ms`,
                          }}
                        />
                      </span>
                      <span className="num text-ink">{a.planned ? fmt.int(a.planned) : DASH}</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}
