/**
 * AI help on one Alpha, with a model the consultant picks from those their keys reach:
 * drafting its properties, and remodelling it to pass the checks it failed.
 *
 * Nothing here saves or submits. A draft lands in the Properties form for review; a remodel
 * queues simulations, and each variant is checked on BRAIN by its own button.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { RefreshCwIcon, SparklesIcon, WandSparklesIcon } from 'lucide-react'
import { useMemo } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { components } from '@/api/generated'
import { errorMessage, http } from '@/api/http'
import { fmt } from '@/lib/format'
import { useRefetchOn } from '@/lib/ws'
import { llm } from '@/screens/ai/api'
import { pool } from '@/screens/pool/api'
import {
  Badge,
  Button,
  Empty,
  ErrorNotice,
  LINK,
  Panel,
  Skeleton,
  signTone,
  TEXT_TONE,
} from '@/ui/kit'
import { Select } from '@/ui/overlay'
import type { AlphaInfo } from './api'

type Schemas = components['schemas']
export type Described = Schemas['Described']
type Remodelled = Schemas['Remodelled']
type RemodelRow = Schemas['RemodelRow']

const id = (alphaId: string) => encodeURIComponent(alphaId)

const assist = {
  describe: (alphaId: string, model: string | null) =>
    http.post<Described>(`/api/alphas/${id(alphaId)}/ai/describe`, { model }),
  remodel: (alphaId: string, model: string | null, count: number) =>
    http.post<Remodelled>(`/api/alphas/${id(alphaId)}/ai/remodel`, { model, count }),
  remodels: (alphaId: string) => http.get<RemodelRow[]>(`/api/alphas/${id(alphaId)}/ai/remodels`),
}

/** The last model picked, shared by both features and remembered in this browser. */
const useChosenModel = create<{ model: string | null; set: (model: string) => void }>()(
  persist((set) => ({ model: null, set: (model) => set({ model }) }), {
    name: 'alpha-harness-alpha-ai-model',
  }),
)

/** Text models whose provider has an enabled key, and the one in use. */
function useModelChoice() {
  const models = useQuery({ queryKey: ['ai', 'models'], queryFn: llm.models })
  const keys = useQuery({ queryKey: ['ai', 'keys'], queryFn: llm.keys })
  const chosen = useChosenModel((s) => s.model)
  const choose = useChosenModel((s) => s.set)
  const usable = useMemo(() => {
    const providers = new Set(
      (keys.data?.keys ?? []).filter((k) => k.enabled).map((k) => k.provider),
    )
    return (models.data?.models ?? []).filter(
      (m) => m.kind !== 'embedding' && providers.has(m.provider),
    )
  }, [models.data, keys.data])
  const model =
    usable.find((m) => m.id === chosen) ?? usable.find((m) => m.recommended) ?? usable[0] ?? null
  return {
    usable,
    model,
    choose,
    loading: models.isPending || keys.isPending,
  }
}

export function ModelPicker({ disabled }: { disabled?: boolean }) {
  const { usable, model, choose, loading } = useModelChoice()
  if (loading) return <Skeleton className="h-8 w-48" label="Loading AI models" />
  if (!usable.length)
    return (
      <span className="text-body-compact text-ink-subtle">
        No AI key is enabled.{' '}
        <Link to="/ai" className={LINK}>
          Add one
        </Link>
      </span>
    )
  return (
    <Select
      label="AI model"
      className="min-w-48"
      disabled={disabled}
      value={model?.id ?? null}
      onChange={choose}
      items={usable.map((m) => ({ value: m.id, label: `${m.label} · ${m.provider}` }))}
    />
  )
}

/** Drafts name, category, tags and description into the Properties form; saves nothing. */
export function FillWithAi({
  alphaId,
  onFilled,
}: {
  alphaId: string
  onFilled: (draft: Described) => void
}) {
  const { model } = useModelChoice()
  const fill = useMutation({
    mutationFn: () => assist.describe(alphaId, model?.id ?? null),
    onSuccess: (draft) => {
      onFilled(draft)
      toast.success(`Drafted by ${draft.model}. Review it, then Save to BRAIN.`)
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-hairline bg-surface-2 p-2">
      <ModelPicker disabled={fill.isPending} />
      <Button
        size="sm"
        variant="secondary"
        loading={fill.isPending}
        disabled={!model}
        onClick={() => fill.mutate()}
      >
        {!fill.isPending && <SparklesIcon />}
        Fill with AI
      </Button>
    </div>
  )
}

const COUNTS = [
  { value: '2', label: '2 variants' },
  { value: '4', label: '4 variants' },
  { value: '6', label: '6 variants' },
] as const

const useVariantCount = create<{ count: '2' | '4' | '6'; set: (c: '2' | '4' | '6') => void }>()(
  persist((set) => ({ count: '4', set: (count) => set({ count }) }), {
    name: 'alpha-harness-remodel-count',
  }),
)

/**
 * Failed checks → variants from the chosen model → vetted and simulated → checked on BRAIN.
 * Shown when a check failed, or when this Alpha already has variants to follow.
 */
export function RemodelPanel({ alpha }: { alpha: AlphaInfo }) {
  const queryClient = useQueryClient()
  const { model } = useModelChoice()
  const count = useVariantCount((s) => s.count)
  const setCount = useVariantCount((s) => s.set)
  const failing = alpha.checks.filter((c) => c.result === 'FAIL' || c.result === 'ERROR')

  const variants = useQuery({
    queryKey: ['alpha', alpha.alphaId, 'remodels'],
    queryFn: () => assist.remodels(alpha.alphaId),
  })
  useRefetchOn('simulations', ['alpha', alpha.alphaId, 'remodels'], 3000)

  const remodel = useMutation({
    mutationFn: () => assist.remodel(alpha.alphaId, model?.id ?? null, Number(count)),
    onSuccess: (r) => {
      const skipped = r.rejected.length ? `, ${r.rejected.length} refused before simulating` : ''
      toast.success(`${r.model}: ${r.queued.length} variants queued${skipped}.`)
      void queryClient.invalidateQueries({ queryKey: ['alpha', alpha.alphaId, 'remodels'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const rows = variants.data ?? []
  if (!failing.length && !rows.length) return null

  return (
    <Panel
      title="Fix Failed Checks"
      description="An AI model rewrites the Alpha to target what failed. Variants are simulated, then checked on BRAIN. Nothing is submitted."
      bodyClassName="flex flex-col gap-4"
    >
      {failing.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-caption text-ink-subtle">Failed:</span>
          {failing.map((c) => (
            <Badge key={c.name} tone="loss">
              {c.name}
            </Badge>
          ))}
        </div>
      )}

      {failing.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-hairline bg-surface-2 p-2">
          <ModelPicker disabled={remodel.isPending} />
          <Select
            label="Variants"
            value={count}
            onChange={setCount}
            items={COUNTS.map((c) => ({ ...c }))}
            disabled={remodel.isPending}
          />
          <Button
            size="sm"
            variant="primary"
            loading={remodel.isPending}
            disabled={!model}
            onClick={() => remodel.mutate()}
          >
            {!remodel.isPending && <WandSparklesIcon />}
            Remodel with AI
          </Button>
        </div>
      )}

      {remodel.data && remodel.data.rejected.length > 0 && (
        <details className="text-body-compact text-ink-subtle">
          <summary className="cursor-pointer">
            {remodel.data.rejected.length} variants refused before simulating
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {remodel.data.rejected.map((r) => (
              <li key={r.expression}>
                <code className="font-mono text-caption text-ink-muted">{r.expression}</code>
                <span className="block text-status-warning">{r.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {variants.isPending ? (
        <Skeleton className="h-24" label="Loading variants" />
      ) : variants.isError ? (
        <ErrorNotice error={variants.error} title="Variants could not load" />
      ) : rows.length === 0 ? (
        <Empty title="No variants yet" />
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <VariantItem key={row.recordId} row={row} parentId={alpha.alphaId} />
          ))}
        </ul>
      )}
    </Panel>
  )
}

const DONE = new Set(['COMPLETE', 'WARNING'])
const WAITING = new Set(['QUEUED', 'PENDING', 'RUNNING', 'ORPHANED'])

function VariantItem({ row, parentId }: { row: RemodelRow; parentId: string }) {
  const queryClient = useQueryClient()
  const check = useMutation({
    mutationFn: () => pool.check(row.alphaId as string),
    onSuccess: (body) => {
      const checks = body.is?.checks ?? []
      const n = (r: string) => checks.filter((c) => (c.result ?? 'PENDING') === r).length
      const verdict =
        n('FAIL') === 0 && n('PENDING') === 0 ? 'passes every check' : `${n('FAIL')} fail`
      toast.success(`${row.alphaId}: ${n('PASS')} pass, ${verdict}.`)
      void queryClient.invalidateQueries({ queryKey: ['alpha', parentId, 'remodels'] })
      void queryClient.invalidateQueries({ queryKey: ['pool', 'submittable-count'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const status = row.status
  const tone = DONE.has(status) ? 'profit' : WAITING.has(status) ? 'neutral' : 'loss'
  const checked = row.passed.length + row.failed.length + row.pending.length > 0

  return (
    <li className="flex flex-col gap-2 rounded-md border border-hairline p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{status.toLowerCase()}</Badge>
        {row.decay != null && (
          <span className="num text-caption text-ink-subtle">decay {row.decay}</span>
        )}
        {row.neutralization && (
          <span className="text-caption text-ink-subtle">{row.neutralization.toLowerCase()}</span>
        )}
        {row.sharpe != null && (
          <span className={`num text-body-compact ${TEXT_TONE[signTone(row.sharpe)]}`}>
            Sharpe {fmt.ratio(row.sharpe)}
          </span>
        )}
        {row.fitness != null && (
          <span className="num text-body-compact text-ink-muted">
            Fitness {fmt.ratio(row.fitness)}
          </span>
        )}
      </div>
      <code className="block rounded-md bg-canvas px-2 py-1.5 font-mono text-caption break-all text-ink-muted">
        {row.expression}
      </code>
      {row.why && <p className="text-body-compact text-ink-subtle">{row.why}</p>}
      {!DONE.has(status) && !WAITING.has(status) && row.message && (
        <p className="text-body-compact text-pnl-negative">{row.message}</p>
      )}
      {checked && (
        <p className="text-body-compact text-ink-subtle">
          <span className="num text-pnl-positive">{row.passed.length}</span> passed
          {row.failed.length > 0 && (
            <>
              {' · '}
              <span className="text-pnl-negative">failed {row.failed.join(', ')}</span>
            </>
          )}
          {row.pending.length > 0 && (
            <>
              {' · '}
              <span className="num">{row.pending.length}</span> pending
            </>
          )}
        </p>
      )}
      {row.alphaId && DONE.has(status) && (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" loading={check.isPending} onClick={() => check.mutate()}>
            {!check.isPending && <RefreshCwIcon />}
            Run checks on BRAIN
          </Button>
          <Link to="/alpha/$alphaId" params={{ alphaId: row.alphaId }} className={LINK}>
            Open {row.alphaId}
          </Link>
        </div>
      )}
    </li>
  )
}
