/**
 * Submit Queue (Tools): Alphas you approved, submitted for you within today's caps.
 *
 * Putting an Alpha here is the approval for the automatic path, which never passes the caps.
 * Past them, an Alpha goes only by its own Submit Now, which asks every time.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SendIcon,
  Trash2Icon,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/api/http'
import { cn } from '@/lib/cn'
import { fmt } from '@/lib/format'
import { RunningFlask } from '@/screens/dashboard/heatmap'
import {
  Badge,
  Button,
  Empty,
  ErrorNotice,
  LINK,
  Metric,
  Notice,
  Page,
  PageHeader,
  Panel,
  Skeleton,
  Textarea,
  type Tone,
} from '@/ui/kit'
import { Confirm } from '@/ui/overlay'
import { type QueueEntry, submitQueue } from './api'
import { CapsEditor } from './caps'

const STATUS_TONE: Record<string, Tone | 'outline'> = {
  QUEUED: 'outline',
  SUBMITTING: 'neutral',
  SUBMITTED: 'profit',
  REFUSED: 'loss',
}

const KIND_LABEL: Record<string, string> = { REGULAR: 'Regular', SUPER: 'Super' }

export function SubmitQueueScreen() {
  const client = useQueryClient()
  const queue = useQuery({
    queryKey: ['submit-queue'],
    queryFn: submitQueue.view,
    refetchInterval: 10_000,
  })
  const refresh = () => client.invalidateQueries({ queryKey: ['submit-queue'] })
  const [ids, setIds] = useState('')
  const [approving, setApproving] = useState<QueueEntry | null>(null)

  const add = useMutation({
    mutationFn: (list: string[]) => submitQueue.add(list),
    onSuccess: (out) => {
      const added = out.filter((a) => a.added).length
      toast.success(`Queued ${fmt.int(added)} of ${fmt.int(out.length)}`)
      for (const a of out.filter((x) => !x.added))
        toast.error(`${a.alphaId} was not queued`, { description: a.message })
      setIds('')
      void refresh()
    },
    onError: (e) => toast.error('Could not queue', { description: errorMessage(e) }),
  })
  const pause = useMutation({
    mutationFn: (paused: boolean) => submitQueue.pause(paused),
    onSuccess: () => void refresh(),
    onError: (e) => toast.error(errorMessage(e)),
  })
  const reorder = useMutation({
    mutationFn: (order: string[]) => submitQueue.reorder(order),
    onSuccess: () => void refresh(),
    onError: (e) => toast.error(errorMessage(e)),
  })
  const remove = useMutation({
    mutationFn: (alphaId: string) => submitQueue.remove(alphaId),
    onSuccess: () => void refresh(),
    onError: (e) => toast.error(errorMessage(e)),
  })
  const submitNow = useMutation({
    mutationFn: (alphaId: string) => submitQueue.submitNow(alphaId),
    onSuccess: (out) => {
      if (out.submitted) toast.success(`${out.alphaId} submitted`)
      else toast.error(`${out.alphaId} was not submitted`, { description: out.message })
      setApproving(null)
      void refresh()
      void client.invalidateQueries({ queryKey: ['quarter'] })
    },
    onError: (e) => {
      setApproving(null)
      toast.error('Could not submit', { description: errorMessage(e) })
    },
  })

  const data = queue.data
  const waiting = (data?.entries ?? []).filter((e) => e.status !== 'SUBMITTED')
  const done = (data?.entries ?? [])
    .filter((e) => e.status === 'SUBMITTED')
    .sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)))
  const day = (kind: string) => data?.days.find((d) => d.kind === kind)
  const capped = (kind: string) => {
    const d = day(kind)
    return d ? d.full || d.submitted >= d.cap : false
  }

  const move = (index: number, by: -1 | 1) => {
    const order = waiting.map((e) => e.alphaId)
    const to = index + by
    if (to < 0 || to >= order.length) return
    ;[order[index], order[to]] = [order[to] as string, order[index] as string]
    reorder.mutate(order)
  }

  return (
    <Page>
      <PageHeader
        title="Submit Queue"
        description="Alphas you approved, submitted for you in this order within today's caps. Past a cap, each one needs its own approval."
        actions={
          data && (
            <Button
              variant={data.paused ? 'primary' : 'secondary'}
              loading={pause.isPending}
              onClick={() => pause.mutate(!data.paused)}
            >
              {data.paused ? <PlayIcon /> : <PauseIcon />}
              {data.paused ? 'Resume' : 'Pause'}
            </Button>
          )
        }
      />
      {queue.isError && <ErrorNotice error={queue.error} title="Could not read the queue" />}
      {queue.isPending && <Skeleton className="h-32" label="Reading the queue" />}

      {data && (
        <>
          {data.paused && (
            <Notice tone="warn" title="Paused: nothing is submitted automatically.">
              Submit Now still works, one Alpha at a time.
            </Notice>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {data.days.map((d) => (
              <Metric
                key={d.kind}
                boxed
                label={`${KIND_LABEL[d.kind] ?? d.kind} Today`}
                tone={d.submitted >= d.cap ? 'profit' : 'neutral'}
                value={
                  <>
                    {fmt.int(d.submitted)}
                    <span className="text-body text-ink-subtle"> / {fmt.int(d.cap)} automatic</span>
                  </>
                }
                hint={
                  d.full
                    ? "BRAIN's own limit is reached for today"
                    : d.submitted >= d.cap
                      ? 'Cap reached; the rest wait for tomorrow'
                      : `${fmt.int(d.cap - d.submitted)} more can go today`
                }
              />
            ))}
            <Metric
              boxed
              label="Waiting"
              value={fmt.int(waiting.filter((e) => e.status === 'QUEUED').length)}
              hint={`${fmt.int(waiting.filter((e) => e.status === 'REFUSED').length)} set aside`}
            />
            <Metric
              boxed
              label="Caps Reset In"
              value={fmt.countdown(data.resetsInSeconds)}
              hint={
                data.lastTick
                  ? `Midnight US Eastern · looked ${fmt.ago(data.lastTick)}`
                  : 'Midnight US Eastern'
              }
            />
          </div>

          <Panel
            title="Daily Caps"
            description="Change how many the queue may send on its own each day."
          >
            <CapsEditor />
          </Panel>

          <Panel
            title="Queue"
            description="Each Alpha is checked again just before it is sent. One that fails a check is set aside, never sent."
          >
            {waiting.length === 0 ? (
              <Empty title="Nothing waiting">
                Add Alpha IDs below, or queue them from the Super Lab or the Submission Planner.
              </Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[48rem] text-body">
                  <thead>
                    <tr className="border-b border-hairline text-body-compact text-ink-subtle">
                      <th className="w-10 px-2 py-2 text-left font-medium">#</th>
                      <th className="px-2 py-2 text-left font-medium">Alpha</th>
                      <th className="px-2 py-2 text-left font-medium">Kind</th>
                      <th className="px-2 py-2 text-right font-medium">Sharpe</th>
                      <th className="px-2 py-2 text-right font-medium">Fitness</th>
                      <th className="px-2 py-2 text-left font-medium">Status</th>
                      <th className="px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {waiting.map((e, i) => (
                      <tr
                        key={e.alphaId}
                        className="border-b border-hairline-subtle align-top last:border-b-0"
                      >
                        <td className="num px-2 py-1.5 text-ink-subtle">{i + 1}</td>
                        <td className="num px-2 py-1.5">
                          <Link
                            to="/alpha/$alphaId"
                            params={{ alphaId: e.alphaId }}
                            className={LINK}
                          >
                            {e.alphaId}
                          </Link>
                        </td>
                        <td className="px-2 py-1.5">
                          <Badge tone="outline">{KIND_LABEL[e.kind] ?? e.kind}</Badge>
                        </td>
                        <td className="num px-2 py-1.5 text-right">{fmt.ratio(e.sharpe)}</td>
                        <td className="num px-2 py-1.5 text-right">{fmt.ratio(e.fitness)}</td>
                        <td className="px-2 py-1.5">
                          <span className="flex items-center gap-1.5">
                            {e.status === 'SUBMITTING' && <RunningFlask />}
                            <Badge tone={STATUS_TONE[e.status] ?? 'outline'}>
                              {e.status.toLowerCase()}
                            </Badge>
                          </span>
                          {e.message && (
                            <p
                              className={cn(
                                'mt-1 text-body-compact',
                                e.status === 'REFUSED' ? 'text-pnl-negative' : 'text-ink-subtle',
                              )}
                            >
                              {e.message}
                            </p>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right whitespace-nowrap">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label="Move up"
                              disabled={i === 0 || reorder.isPending}
                              onClick={() => move(i, -1)}
                            >
                              <ArrowUpIcon />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label="Move down"
                              disabled={i === waiting.length - 1 || reorder.isPending}
                              onClick={() => move(i, 1)}
                            >
                              <ArrowDownIcon />
                            </Button>
                            {e.status === 'REFUSED' && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => add.mutate([e.alphaId])}
                              >
                                Retry
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant={capped(e.kind) ? 'primary' : 'secondary'}
                              disabled={e.status === 'SUBMITTING' || submitNow.isPending}
                              onClick={() => setApproving(e)}
                            >
                              <SendIcon />
                              Submit Now
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label="Remove from the queue"
                              disabled={e.status === 'SUBMITTING'}
                              onClick={() => remove.mutate(e.alphaId)}
                            >
                              <Trash2Icon />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel
            title="Add Alphas"
            description="One Alpha ID per line, or separated by spaces or commas. They join the back of the queue."
          >
            <div className="flex flex-col gap-2">
              <Textarea
                rows={3}
                className="num"
                value={ids}
                placeholder="1Y5vvGOQ"
                onChange={(e) => setIds(e.target.value)}
              />
              <div>
                <Button
                  variant="primary"
                  disabled={!ids.trim()}
                  loading={add.isPending}
                  onClick={() => add.mutate(ids.split(/[\s,]+/).filter(Boolean))}
                >
                  <PlusIcon />
                  Queue
                </Button>
              </div>
            </div>
          </Panel>

          <Panel title="Submitted" description="Everything this harness submitted, newest first.">
            {done.length === 0 ? (
              <Empty title="Nothing submitted from here yet" />
            ) : (
              <ul className="flex flex-col divide-y divide-hairline-subtle">
                {done.map((e) => (
                  <li key={e.alphaId} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                    <Link
                      to="/alpha/$alphaId"
                      params={{ alphaId: e.alphaId }}
                      className={cn(LINK, 'num')}
                    >
                      {e.alphaId}
                    </Link>
                    <Badge tone="outline">{KIND_LABEL[e.kind] ?? e.kind}</Badge>
                    <Badge tone={e.mode === 'approved' ? 'warn' : 'profit'}>
                      {e.mode === 'approved'
                        ? 'approved by you'
                        : e.mode === 'found'
                          ? 'found submitted'
                          : 'automatic'}
                    </Badge>
                    <span className="num text-body-compact text-ink-subtle">
                      Sharpe {fmt.ratio(e.sharpe)}
                    </span>
                    <span className="ml-auto text-body-compact text-ink-subtle">
                      {fmt.dateTime(e.submittedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}

      <Confirm
        open={approving !== null}
        onOpenChange={(open) => !open && !submitNow.isPending && setApproving(null)}
        title={`Submit ${approving?.alphaId ?? ''} now?`}
        confirmLabel="Submit"
        pending={submitNow.isPending}
        onConfirm={() => approving && submitNow.mutate(approving.alphaId)}
      >
        {approving && capped(approving.kind) ? (
          <>
            Today's automatic cap for {KIND_LABEL[approving.kind]?.toLowerCase()} Alphas is reached,
            so this goes only because you approve it. It is checked first and cannot be undone.
          </>
        ) : (
          <>
            This submits it now instead of waiting its turn. It is checked first, counts toward
            today's cap, and cannot be undone.
          </>
        )}
      </Confirm>
    </Page>
  )
}
