/**
 * The Submit Queue's automatic caps and its pause, editable wherever the queue is shown.
 *
 * The caps only bound the automatic path: past them each Alpha still goes by its own approval.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PauseIcon, PlayIcon, SaveIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/api/http'
import { Setting } from '@/screens/research-labs/task-settings'
import { Button, Input, Notice } from '@/ui/kit'
import { submitQueue } from './api'

const MAX = 20

const clamp = (value: string) => Math.min(MAX, Math.max(0, Math.floor(Number(value) || 0)))

export function CapsEditor() {
  const client = useQueryClient()
  const queue = useQuery({ queryKey: ['submit-queue'], queryFn: submitQueue.view })
  const cap = (kind: string) => queue.data?.days.find((d) => d.kind === kind)?.cap ?? 0
  const [regular, setRegular] = useState<number | null>(null)
  const [superCap, setSuperCap] = useState<number | null>(null)

  // Follows the saved values until edited.
  const savedRegular = queue.data ? cap('REGULAR') : null
  const savedSuper = queue.data ? cap('SUPER') : null
  useEffect(() => {
    if (savedRegular !== null) setRegular((v) => v ?? savedRegular)
    if (savedSuper !== null) setSuperCap((v) => v ?? savedSuper)
  }, [savedRegular, savedSuper])

  const refresh = () => client.invalidateQueries({ queryKey: ['submit-queue'] })
  const save = useMutation({
    mutationFn: () => submitQueue.setCaps({ regular: regular ?? 0, super: superCap ?? 0 }),
    onSuccess: () => {
      toast.success('Daily caps saved')
      void refresh()
    },
    onError: (e) => toast.error('Could not save the caps', { description: errorMessage(e) }),
  })
  const pause = useMutation({
    mutationFn: (paused: boolean) => submitQueue.pause(paused),
    onSuccess: () => void refresh(),
    onError: (e) => toast.error(errorMessage(e)),
  })

  const dirty =
    queue.data !== undefined && (regular !== cap('REGULAR') || superCap !== cap('SUPER'))
  const paused = queue.data?.paused ?? false

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Setting label="Regular Alphas per day">
          <Input
            type="number"
            min={0}
            max={MAX}
            className="w-24"
            aria-label="Regular Alphas submitted automatically per day"
            value={regular ?? ''}
            onChange={(e) => setRegular(clamp(e.target.value))}
          />
        </Setting>
        <Setting label="SuperAlphas per day">
          <Input
            type="number"
            min={0}
            max={MAX}
            className="w-24"
            aria-label="SuperAlphas submitted automatically per day"
            value={superCap ?? ''}
            onChange={(e) => setSuperCap(clamp(e.target.value))}
          />
        </Setting>
        <Button
          variant="primary"
          disabled={!dirty}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          <SaveIcon />
          Save Caps
        </Button>
        <Button
          variant={paused ? 'primary' : 'secondary'}
          loading={pause.isPending}
          disabled={!queue.data}
          onClick={() => pause.mutate(!paused)}
        >
          {paused ? <PlayIcon /> : <PauseIcon />}
          {paused ? 'Resume Auto-Submit' : 'Pause Auto-Submit'}
        </Button>
      </div>
      <p className="text-body-compact text-pretty text-ink-subtle">
        How many approved Alphas the Submit Queue sends on its own each BRAIN day (midnight US
        Eastern). Zero stops that kind. Past a cap, each Alpha needs its own approval.
      </p>
      {paused && <Notice tone="warn" title="Auto-submit is paused. Nothing goes on its own." />}
    </div>
  )
}
