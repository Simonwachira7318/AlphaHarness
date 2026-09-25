/** Profile: the BRAIN account in full, read by the backend with the session it holds. */

import type { components } from '@/api/generated'
import { http, qs } from '@/api/http'

type Schemas = components['schemas']

export type ProfileView = Schemas['ProfileView']
export type Activity = Schemas['Activity']

export const profileApi = {
  get: (refresh = false) =>
    http.get<ProfileView>(`/api/profile${qs({ refresh: refresh || null })}`),
}
