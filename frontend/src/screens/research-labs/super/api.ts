/** Super Lab: write selections, count their picks, simulate SuperAlphas, check and submit them. */

import type { components } from '@/api/generated'
import { http, qs } from '@/api/http'

type Schemas = components['schemas']

export type SuperOptions = Schemas['SuperOptions']
export type Selection = Schemas['Selection']
export type Counted = Schemas['Counted']
export type SuperResult = Schemas['SuperResult']
export type Checked = Schemas['Checked']
export type Submitted = Schemas['Submitted']

export type Mode = 'arithmetic' | 'if_else' | 'filter' | 'compound'

export interface Market {
  region: string
  delay: number
  universe: string
}

export interface GenerateRequest extends Market {
  per_mode: number
  modes: Mode[]
  wrapper: string
}

export interface CountRequest {
  region: string
  delay: number
  selections: string[]
  selection_limit: number
  selection_handling: string
}

export interface TaskRequest extends Market {
  selections: string[]
  combos: string[]
  neutralization: string
  decay: number
  truncation: number
  test_period: string
  selection_limit: number
  selection_handling: string
  max_trade: 'ON' | 'OFF'
  nan_handling: 'ON' | 'OFF'
  cores: number
}

const B = '/api/super-lab'

export const superLab = {
  options: (m: Market) => http.get<SuperOptions>(`${B}/options${qs({ ...m })}`),
  /** Free: reads only. */
  generate: (body: GenerateRequest) => http.post<Schemas['Generated']>(`${B}/generate`, body),
  /** Free: asks BRAIN how many Alphas each selection picks, simulates nothing. */
  count: (body: CountRequest) => http.post<Counted[]>(`${B}/count`, body),
  addTask: (body: TaskRequest) => http.post<Schemas['AddedTask']>(`${B}/tasks`, body),
  results: () => http.get<SuperResult[]>(`${B}/results`),
  check: (alphaIds: string[]) =>
    http.post<Checked[]>(`${B}/check`, { alpha_ids: alphaIds, mark_passed: true }),
  /** Irreversible. */
  submit: (alphaId: string) =>
    http.post<Submitted>(`${B}/submit`, { alpha_id: alphaId, confirm: true }),
}
