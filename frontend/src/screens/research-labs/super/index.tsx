/**
 * Super Lab: the SUPER.ipynb workflow as a screen.
 *
 * Write selection expressions, ask BRAIN how many of your Alphas each one picks (free), queue a
 * SuperAlpha per kept selection and combo as a task, then re-run the checks and submit the ones
 * that pass. Submission is one Alpha at a time and always asks first.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { PlusIcon, RefreshCwIcon, SendIcon, ShieldCheckIcon, SparklesIcon } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { errorMessage } from '@/api/http'
import { cn } from '@/lib/cn'
import { DASH, fmt } from '@/lib/format'
import { CORES } from '@/screens/research-labs/lab-task'
import { Setting } from '@/screens/research-labs/task-settings'
import {
  Badge,
  Button,
  Checkbox,
  Chips,
  Disclosure,
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
  Textarea,
} from '@/ui/kit'
import { Confirm, Select } from '@/ui/overlay'
import { ScopePicker } from '@/ui/scope-picker'
import { type Counted, type Mode, type SuperResult, superLab, type TaskRequest } from './api'

const MODE_LABELS: Record<Mode, string> = {
  arithmetic: 'Arithmetic',
  if_else: 'If / Else',
  filter: 'Filter',
  compound: 'Compound (&&)',
}

interface Draft {
  region: string
  delay: number
  universe: string
  neutralization: string
  decay: number
  truncation: number
  testPeriod: string
  selectionLimit: number
  selectionHandling: string
  maxTrade: 'ON' | 'OFF'
  nanHandling: 'ON' | 'OFF'
  cores: number
  perMode: number
  modes: Mode[]
  wrapper: string
  /** Every selection written or pasted, in order. */
  selections: string[]
  /** The ones ticked to simulate. */
  chosen: string[]
  combos: string[]
  customCombo: string
  minPicks: number
}

const DEFAULTS = {
  // The notebook's own settings.
  region: 'USA',
  delay: 1,
  universe: 'TOP2000',
  neutralization: 'STATISTICAL',
  decay: 10,
  truncation: 0.08,
  testPeriod: 'P2Y',
  selectionLimit: 10,
  selectionHandling: 'POSITIVE',
  maxTrade: 'OFF' as const,
  nanHandling: 'OFF' as const,
  cores: 3,
  perMode: 6,
  modes: ['arithmetic', 'if_else', 'filter', 'compound'] as Mode[],
  wrapper: 'oWn * ({expr})#GoodStuff',
  selections: [] as string[],
  chosen: [] as string[],
  combos: ['combo_a(alpha,nlength=64,mode="algo2")'],
  customCombo: '',
  minPicks: 10,
}

const useDraft = create<Draft & { set: (change: Partial<Draft>) => void }>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      set: (change) => set(change),
    }),
    { name: 'alpha-harness-super-lab' },
  ),
)

const PRE =
  'num overflow-x-auto rounded-sm border border-hairline bg-canvas px-2 py-1 text-body-compact whitespace-pre-wrap break-all text-ink-muted'

export function SuperLabScreen() {
  const draft = useDraft()
  const set = draft.set
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const market = { region: draft.region, delay: draft.delay, universe: draft.universe }

  const options = useQuery({
    queryKey: ['super-lab', 'options', market],
    queryFn: () => superLab.options(market),
    staleTime: 5 * 60 * 1000,
  })
  const opts = options.data
  const neutralization =
    opts && !opts.neutralizations.includes(draft.neutralization)
      ? (opts.neutralizations[0] ?? draft.neutralization)
      : draft.neutralization

  const [counts, setCounts] = useState<Map<string, Counted>>(new Map())
  const [paste, setPaste] = useState('')

  const onScope = useCallback(
    (change: Partial<{ region: string; delay: number; universe: string }>) => set(change),
    [set],
  )

  const generate = useMutation({
    mutationFn: () =>
      superLab.generate({
        ...market,
        per_mode: draft.perMode,
        modes: draft.modes,
        wrapper: draft.wrapper,
      }),
    onSuccess: (out) => {
      out.problems.forEach((p) => {
        toast.error(p)
      })
      const fresh = out.selections.map((s) => s.expression)
      const all = [...new Set([...draft.selections, ...fresh])]
      set({ selections: all, chosen: [...new Set([...draft.chosen, ...fresh])] })
      toast.success(`Wrote ${fmt.int(fresh.length)} selections`)
    },
    onError: (e) => toast.error('Could not write selections', { description: errorMessage(e) }),
  })

  const count = useMutation({
    mutationFn: (selections: string[]) =>
      superLab.count({
        region: draft.region,
        delay: draft.delay,
        selections,
        selection_limit: draft.selectionLimit,
        selection_handling: draft.selectionHandling,
      }),
    onSuccess: (rows) => {
      const next = new Map(counts)
      for (const row of rows) next.set(row.selection, row)
      setCounts(next)
      // The notebook keeps only selections that pick enough Alphas; untick the rest.
      const low = new Set(
        rows.filter((r) => r.count === null || r.count < draft.minPicks).map((r) => r.selection),
      )
      set({ chosen: draft.chosen.filter((s) => !low.has(s)) })
      toast.success(`Counted ${fmt.int(rows.length)} selections; ${fmt.int(low.size)} unticked`)
    },
    onError: (e) => toast.error('Could not count picks', { description: errorMessage(e) }),
  })

  const chosen = useMemo(() => new Set(draft.chosen), [draft.chosen])
  const toggle = (s: string) =>
    set({ chosen: chosen.has(s) ? draft.chosen.filter((x) => x !== s) : [...draft.chosen, s] })

  const addPasted = () => {
    const lines = paste
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (!lines.length) return
    set({
      selections: [...new Set([...draft.selections, ...lines])],
      chosen: [...new Set([...draft.chosen, ...lines])],
    })
    setPaste('')
  }

  const combos = draft.combos
  const toggleCombo = (c: string) =>
    set({ combos: combos.includes(c) ? combos.filter((x) => x !== c) : [...combos, c] })
  const extraCombos = combos.filter((c) => !(opts?.combos ?? []).includes(c))

  const simulations = draft.chosen.length * combos.length
  const body: TaskRequest = {
    ...market,
    selections: draft.chosen,
    combos,
    neutralization,
    decay: draft.decay,
    truncation: draft.truncation,
    test_period: draft.testPeriod,
    selection_limit: draft.selectionLimit,
    selection_handling: draft.selectionHandling,
    max_trade: draft.maxTrade,
    nan_handling: draft.nanHandling,
    cores: draft.cores,
  }
  const add = useMutation({
    mutationFn: () => superLab.addTask(body),
    onSuccess: (task) => {
      void queryClient.invalidateQueries({ queryKey: ['lab-tasks'] })
      toast.success(`Added ${task.name}`, {
        description: 'Start it from Tasks. Results appear under SuperAlphas below.',
        action: { label: 'Open Tasks', onClick: () => void navigate({ to: '/tasks' }) },
      })
    },
    onError: (e) => toast.error('Could not add the task', { description: errorMessage(e) }),
  })

  return (
    <Page>
      <PageHeader
        title="Super Lab"
        description="SuperAlphas from random selection expressions and your chosen combos, the SUPER notebook's workflow."
        actions={
          <Button
            variant="primary"
            disabled={simulations === 0 || !opts || opts.operators.length === 0}
            loading={add.isPending}
            onClick={() => add.mutate()}
          >
            <PlusIcon />
            Add Task · {fmt.int(simulations)} SuperAlphas
          </Button>
        }
      />

      <Panel title="Market and Settings">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
            <ScopePicker scope={{ instrumentType: 'EQUITY', ...market }} onChange={onScope} />
            <Setting label="Neutralization">
              <Select
                label="Neutralization"
                mono
                items={(opts?.neutralizations ?? [neutralization]).map((n) => ({
                  value: n,
                  label: n,
                }))}
                value={neutralization}
                onChange={(v) => set({ neutralization: v })}
              />
            </Setting>
            <Setting label="Decay">
              <Input
                type="number"
                min={0}
                max={512}
                className="w-24"
                aria-label="Decay"
                value={draft.decay}
                onChange={(e) => set({ decay: Math.max(0, Math.floor(Number(e.target.value))) })}
              />
            </Setting>
            <Setting label="Selection Limit">
              <Input
                type="number"
                min={1}
                max={1000}
                className="w-24"
                aria-label="Selection Limit"
                value={draft.selectionLimit}
                onChange={(e) =>
                  set({ selectionLimit: Math.max(1, Math.floor(Number(e.target.value))) })
                }
              />
            </Setting>
            <Setting label="Selection Handling">
              <Segmented
                label="Selection Handling"
                items={(opts?.handlings ?? ['POSITIVE', 'NON_ZERO', 'NON_NAN']).map((h) => ({
                  value: h,
                  label: h,
                }))}
                value={draft.selectionHandling}
                onChange={(v) => set({ selectionHandling: v })}
              />
            </Setting>
            <Setting label="Cores">
              <Segmented
                label="Cores"
                items={CORES.map((v) => ({ value: v, label: v }))}
                value={draft.cores}
                onChange={(cores) => set({ cores })}
              />
            </Setting>
          </div>
          <Disclosure summary="More settings">
            <div className="flex flex-wrap items-start gap-x-8 gap-y-4 p-3">
              <Setting label="Truncation">
                <Input
                  type="number"
                  step={0.01}
                  min={0}
                  max={1}
                  className="w-24"
                  aria-label="Truncation"
                  value={draft.truncation}
                  onChange={(e) => set({ truncation: Number(e.target.value) })}
                />
              </Setting>
              <Setting label="Test Period">
                <Input
                  className="num w-24"
                  aria-label="Test Period"
                  value={draft.testPeriod}
                  onChange={(e) => set({ testPeriod: e.target.value })}
                />
              </Setting>
              <Setting label="Max Trade">
                <Segmented
                  label="Max Trade"
                  items={[
                    { value: 'OFF' as const, label: 'OFF' },
                    { value: 'ON' as const, label: 'ON' },
                  ]}
                  value={draft.maxTrade}
                  onChange={(v) => set({ maxTrade: v })}
                />
              </Setting>
              <Setting label="NaN Handling">
                <Segmented
                  label="NaN Handling"
                  items={[
                    { value: 'OFF' as const, label: 'OFF' },
                    { value: 'ON' as const, label: 'ON' },
                  ]}
                  value={draft.nanHandling}
                  onChange={(v) => set({ nanHandling: v })}
                />
              </Setting>
            </div>
          </Disclosure>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric boxed label="Selection Operators" value={fmt.int(opts?.operators.length)} />
            <Metric boxed label="Datasets" value={fmt.int(opts?.datasets)} />
            <Metric boxed label="Categories" value={fmt.int(opts?.categories)} />
            <Metric boxed label="Universes" value={fmt.int(opts?.universes.length)} />
          </div>
          {options.isError && <ErrorNotice error={options.error} title="Could not read BRAIN" />}
          {opts?.problems.map((p) => (
            <Notice key={p} tone="error" title={p} />
          ))}
        </div>
      </Panel>

      <Panel
        title="Selections"
        description="Which of your own Alphas each SuperAlpha holds. Writing and counting them is free."
        actions={
          <>
            <Button
              disabled={draft.selections.length === 0}
              loading={count.isPending}
              onClick={() => count.mutate(draft.selections)}
            >
              <RefreshCwIcon />
              Count Picks
            </Button>
            <Button
              variant="primary"
              disabled={!opts || draft.modes.length === 0}
              loading={generate.isPending}
              onClick={() => generate.mutate()}
            >
              <SparklesIcon />
              Write Selections
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
            <Setting label="Kinds">
              <Chips
                label="Kinds"
                items={(Object.keys(MODE_LABELS) as Mode[]).map((m) => ({
                  value: m,
                  label: MODE_LABELS[m],
                }))}
                value={draft.modes}
                onChange={(modes) => set({ modes })}
              />
            </Setting>
            <Setting label="Per Kind">
              <Input
                type="number"
                min={1}
                max={100}
                className="w-24"
                aria-label="Per Kind"
                value={draft.perMode}
                onChange={(e) =>
                  set({ perMode: Math.min(100, Math.max(1, Math.floor(Number(e.target.value)))) })
                }
              />
            </Setting>
            <Setting label="Minimum Picks">
              <Input
                type="number"
                min={0}
                className="w-24"
                aria-label="Minimum Picks"
                value={draft.minPicks}
                onChange={(e) => set({ minPicks: Math.max(0, Math.floor(Number(e.target.value))) })}
              />
            </Setting>
            <Setting label="Wrapper">
              <Input
                className="num w-72"
                aria-label="Wrapper"
                value={draft.wrapper}
                onChange={(e) => set({ wrapper: e.target.value })}
              />
            </Setting>
          </div>
          <p className="text-body-compact text-pretty text-ink-subtle">
            <code className="num">{'{expr}'}</code> in the wrapper is replaced by each written
            expression. Count Picks unticks every selection that picks fewer than the minimum.
          </p>

          {draft.selections.length === 0 ? (
            <Empty title="No selections yet">Write some, or paste your own below.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-body">
                <thead>
                  <tr className="border-b border-hairline text-body-compact text-ink-subtle">
                    <th className="w-8 px-2 py-2" />
                    <th className="px-2 py-2 text-left font-medium">Selection</th>
                    <th className="px-2 py-2 text-right font-medium">Picks</th>
                    <th className="w-8 px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {draft.selections.map((s) => {
                    const c = counts.get(s)
                    return (
                      <tr key={s} className="border-b border-hairline-subtle last:border-b-0">
                        <td className="px-2 py-1.5 align-top">
                          <Checkbox
                            label=""
                            aria-label="Simulate this selection"
                            checked={chosen.has(s)}
                            onChange={() => toggle(s)}
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <code className="num text-body-compact break-all text-ink">{s}</code>
                          {c?.message && (
                            <p className="text-body-compact text-status-warning">{c.message}</p>
                          )}
                        </td>
                        <td
                          className={cn(
                            'num px-2 py-1.5 text-right align-top',
                            c && (c.count ?? 0) < draft.minPicks
                              ? 'text-status-warning'
                              : 'text-ink',
                          )}
                        >
                          {c ? fmt.int(c.count) : DASH}
                        </td>
                        <td className="px-2 py-1.5 text-right align-top">
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label="Remove"
                            onClick={() =>
                              set({
                                selections: draft.selections.filter((x) => x !== s),
                                chosen: draft.chosen.filter((x) => x !== s),
                              })
                            }
                          >
                            ×
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body-compact text-ink-subtle">
              {fmt.int(draft.chosen.length)} of {fmt.int(draft.selections.length)} ticked
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => set({ chosen: [...draft.selections] })}
            >
              Tick All
            </Button>
            <Button size="sm" variant="ghost" onClick={() => set({ chosen: [] })}>
              Untick All
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={draft.selections.length === 0}
              onClick={() => {
                set({ selections: [], chosen: [] })
                setCounts(new Map())
              }}
            >
              Clear
            </Button>
          </div>
          <Disclosure summary="Paste your own selections">
            <div className="flex flex-col gap-2 p-3">
              <Textarea
                rows={4}
                className="num"
                placeholder="One selection expression per line"
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
              />
              <div>
                <Button size="sm" disabled={!paste.trim()} onClick={addPasted}>
                  Add
                </Button>
              </div>
            </div>
          </Disclosure>
        </div>
      </Panel>

      <Panel
        title="Combos"
        description="How each SuperAlpha weights the Alphas it selects. Every ticked combo runs with every ticked selection."
      >
        <div className="flex flex-col gap-2">
          {[...(opts?.combos ?? []), ...extraCombos].map((c) => (
            <Checkbox
              key={c}
              checked={combos.includes(c)}
              onChange={() => toggleCombo(c)}
              label={<code className="num text-body-compact break-all">{c}</code>}
            />
          ))}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input
              className="num min-w-64 flex-1"
              placeholder="Your own combo expression"
              aria-label="Your own combo expression"
              value={draft.customCombo}
              onChange={(e) => set({ customCombo: e.target.value })}
            />
            <Button
              size="sm"
              disabled={!draft.customCombo.trim()}
              onClick={() =>
                set({
                  combos: [...new Set([...combos, draft.customCombo.trim()])],
                  customCombo: '',
                })
              }
            >
              Add Combo
            </Button>
          </div>
        </div>
      </Panel>

      <ResultsPanel />
    </Page>
  )
}

/** Every SuperAlpha the lab has simulated: check them, then submit the ones that pass. */
function ResultsPanel() {
  const queryClient = useQueryClient()
  const results = useQuery({
    queryKey: ['super-lab', 'results'],
    queryFn: superLab.results,
    refetchInterval: 15_000,
  })
  const rows = results.data ?? []
  const simulated = rows.filter((r) => r.alphaId)
  const [confirming, setConfirming] = useState<SuperResult | null>(null)

  const check = useMutation({
    mutationFn: (ids: string[]) => superLab.check(ids),
    onSuccess: (out) => {
      const passed = out.filter((c) => c.passed).length
      toast.success(`Checked ${fmt.int(out.length)}: ${fmt.int(passed)} pass every check`)
      void queryClient.invalidateQueries({ queryKey: ['super-lab', 'results'] })
    },
    onError: (e) => toast.error('Could not check', { description: errorMessage(e) }),
  })

  const submit = useMutation({
    mutationFn: (id: string) => superLab.submit(id),
    onSuccess: (out) => {
      if (out.submitted) toast.success(`${out.alphaId} submitted`)
      else toast.error(`${out.alphaId} was not submitted`, { description: out.message })
      setConfirming(null)
      void queryClient.invalidateQueries({ queryKey: ['super-lab', 'results'] })
    },
    onError: (e) => {
      setConfirming(null)
      toast.error('Could not submit', { description: errorMessage(e) })
    },
  })

  // The notebook checks only the Alphas whose in-sample tests all passed.
  const clean = simulated.filter((r) => r.failed.length === 0 && !r.submitted)

  return (
    <Panel
      title="SuperAlphas"
      description="What the Super Lab's tasks have simulated. Check re-runs BRAIN's submission checks and tags the ones that pass GREEN / super."
      actions={
        <Button
          disabled={clean.length === 0}
          loading={check.isPending}
          onClick={() => check.mutate(clean.map((r) => r.alphaId as string))}
        >
          <ShieldCheckIcon />
          Check {fmt.int(clean.length)} Without Failures
        </Button>
      }
    >
      {results.isError && <ErrorNotice error={results.error} title="Could not read results" />}
      {rows.length === 0 ? (
        <Empty title="Nothing simulated yet">
          Add a task above, then start it from{' '}
          <Link to="/tasks" className={LINK}>
            Tasks
          </Link>
          .
        </Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-body">
            <thead>
              <tr className="border-b border-hairline text-body-compact text-ink-subtle">
                <th className="px-2 py-2 text-left font-medium">Alpha</th>
                <th className="px-2 py-2 text-left font-medium">Selection · Combo</th>
                <th className="px-2 py-2 text-right font-medium">Sharpe</th>
                <th className="px-2 py-2 text-right font-medium">Fitness</th>
                <th className="px-2 py-2 text-right font-medium">Turnover</th>
                <th className="px-2 py-2 text-left font-medium">Checks</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={`${r.taskId}-${r.alphaId ?? i}`}
                  className="border-b border-hairline-subtle align-top last:border-b-0"
                >
                  <td className="num px-2 py-1.5">
                    {r.alphaId ? (
                      <Link to="/alpha/$alphaId" params={{ alphaId: r.alphaId }} className={LINK}>
                        {r.alphaId}
                      </Link>
                    ) : (
                      <span className="text-ink-subtle" title={r.message ?? undefined}>
                        {r.state.toLowerCase()}
                      </span>
                    )}
                  </td>
                  <td className="max-w-md px-2 py-1.5">
                    <pre className={PRE}>{r.selection ?? DASH}</pre>
                    <pre className={cn(PRE, 'mt-1')}>{r.combo ?? DASH}</pre>
                  </td>
                  <td className="num px-2 py-1.5 text-right">{fmt.ratio(r.sharpe)}</td>
                  <td className="num px-2 py-1.5 text-right">{fmt.ratio(r.fitness)}</td>
                  <td className="num px-2 py-1.5 text-right">{fmt.pct(r.turnover)}</td>
                  <td className="px-2 py-1.5">
                    {r.submitted ? (
                      <Badge tone="profit">Submitted</Badge>
                    ) : r.failed.length > 0 ? (
                      <Badge tone="loss" title={r.failed.join(', ')}>
                        {fmt.int(r.failed.length)} failed
                      </Badge>
                    ) : r.verdict === 'submittable' ? (
                      <Badge tone="profit">Passes</Badge>
                    ) : r.alphaId ? (
                      <Badge tone="muted">{r.verdict ?? 'unchecked'}</Badge>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap">
                    {r.alphaId && !r.submitted && (
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={check.isPending && check.variables?.includes(r.alphaId)}
                          onClick={() => check.mutate([r.alphaId as string])}
                        >
                          Check
                        </Button>
                        <Button
                          size="sm"
                          variant={r.verdict === 'submittable' ? 'primary' : 'secondary'}
                          disabled={r.verdict !== 'submittable'}
                          onClick={() => setConfirming(r)}
                        >
                          <SendIcon />
                          Submit
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Confirm
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={`Submit ${confirming?.alphaId ?? ''}?`}
        confirmLabel="Submit"
        pending={submit.isPending}
        onConfirm={() => confirming?.alphaId && submit.mutate(confirming.alphaId)}
      >
        This submits the SuperAlpha on BRAIN and cannot be undone. Its selection and combo
        descriptions are filled in first, then BRAIN re-runs its checks, which can take a few
        minutes.
      </Confirm>
    </Panel>
  )
}
