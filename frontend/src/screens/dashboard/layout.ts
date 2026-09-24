/**
 * Which Dashboard sections show, and in what order, remembered in this browser.
 *
 * Tiles and panels are ordered separately: tiles sit in the figure grid and panels below it,
 * so moving a tile past a panel would mean nothing on screen.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const TILES = ['submitted', 'today', 'left', 'sent', 'pyramids'] as const
export const PANELS = ['results', 'work'] as const
export type TileId = (typeof TILES)[number]
export type PanelId = (typeof PANELS)[number]
export type SectionId = TileId | PanelId

export const LABELS: Record<SectionId, string> = {
  submitted: 'Submitted Alphas',
  today: 'Submitted Today',
  left: 'Simulations Left Today',
  sent: 'Sent Today',
  pyramids: 'Pyramids Completed',
  results: "Today's Results",
  work: 'Work in Flight',
}

interface Layout {
  order: SectionId[]
  hidden: SectionId[]
  toggle: (id: SectionId) => void
  move: (id: SectionId, by: -1 | 1) => void
  reset: () => void
}

const DEFAULT: SectionId[] = [...TILES, ...PANELS]

export const useLayout = create<Layout>()(
  persist(
    (set) => ({
      order: DEFAULT,
      hidden: [],
      toggle: (id) =>
        set((s) => ({
          hidden: s.hidden.includes(id) ? s.hidden.filter((h) => h !== id) : [...s.hidden, id],
        })),
      move: (id, by) =>
        set((s) => {
          const group: readonly SectionId[] = (TILES as readonly SectionId[]).includes(id)
            ? TILES
            : PANELS
          const within = ordered(s.order, group)
          const from = within.indexOf(id)
          const to = from + by
          if (to < 0 || to >= within.length) return s
          ;[within[from], within[to]] = [within[to] as SectionId, id]
          const other = s.order.filter((o) => !group.includes(o))
          return { order: group === TILES ? [...within, ...other] : [...other, ...within] }
        }),
      reset: () => set({ order: DEFAULT, hidden: [] }),
    }),
    { name: 'alpha-harness-dashboard', version: 1 },
  ),
)

/**
 * ``group`` in the saved order. A section the saved order predates goes where it sits by
 * default: straight after its default predecessor, or first when it has none.
 */
export function ordered<T extends SectionId>(order: SectionId[], group: readonly T[]): T[] {
  const result = [
    ...new Set(order.filter((id): id is T => (group as readonly SectionId[]).includes(id))),
  ]
  group.forEach((id, index) => {
    if (result.includes(id)) return
    const before = index > 0 ? result.indexOf(group[index - 1] as T) : -1
    result.splice(before + 1, 0, id)
  })
  return result
}
