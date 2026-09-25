/** Osmosis: the allocation BRAIN holds, the one the harness would set, and applying it. */

import type { components } from '@/api/generated'
import { http } from '@/api/http'

type Schemas = components['schemas']

export type OsmosisView = Schemas['OsmosisView']
export type ScopeView = Schemas['ScopeView']

export interface OsmosisSettings {
  auto: boolean
  per_scope: number
  weighting: 'fitness' | 'sharpe' | 'equal'
  include_super: boolean
}

const B = '/api/osmosis'

export const osmosisApi = {
  /** Reads BRAIN; changes nothing. */
  view: () => http.get<OsmosisView>(B),
  save: (s: OsmosisSettings) => http.put<void>(`${B}/settings`, s),
  /** Edits Osmosis points on BRAIN. */
  apply: () => http.post<Schemas['Applied']>(`${B}/apply`, { confirm: true }),
}
