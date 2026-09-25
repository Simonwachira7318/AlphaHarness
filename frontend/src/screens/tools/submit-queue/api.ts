/** Submit Queue: Alphas approved for submission, sent within the daily caps or one by one. */

import type { components } from '@/api/generated'
import { http } from '@/api/http'

type Schemas = components['schemas']

export type QueueView = Schemas['QueueView']
export type QueueEntry = Schemas['QueueEntry']

const B = '/api/submit-queue'

export const submitQueue = {
  view: () => http.get<QueueView>(B),
  /** Approves these Alphas for the automatic path, which never passes the day's caps. */
  add: (alphaIds: string[]) => http.post<Schemas['Added'][]>(`${B}/add`, { alpha_ids: alphaIds }),
  reorder: (alphaIds: string[]) => http.post<void>(`${B}/reorder`, { alpha_ids: alphaIds }),
  remove: (alphaId: string) => http.del<void>(`${B}/${encodeURIComponent(alphaId)}`),
  pause: (paused: boolean) => http.post<void>(`${B}/pause`, { paused }),
  /** How many of each kind go on their own per day; zero stops that kind. */
  setCaps: (caps: { regular: number; super: number }) => http.put<void>(`${B}/caps`, caps),
  /** Irreversible, and past the caps: the per-Alpha approval. */
  submitNow: (alphaId: string) =>
    http.post<Schemas['SubmitOutcome']>(`${B}/${encodeURIComponent(alphaId)}/submit`, {
      confirm: true,
    }),
}
