/** Tools: every tool, three to a row.
 *
 * The same cards as Research Labs, so the two group screens read as one pattern, with the
 * sidebar's wrench in the tile where the labs have the flask.
 */

import { Link } from '@tanstack/react-router'
import {
  DropletsIcon,
  ListChecksIcon,
  type LucideIcon,
  SendIcon,
  SlidersHorizontalIcon,
  UnlinkIcon,
  WrenchIcon,
} from 'lucide-react'
import { TOOL_TABS } from '@/shell/nav'
import { Page, PageHeader } from '@/ui/kit'
import { NAV_CARD, NavCardContent } from '@/ui/nav-card'

const ICONS: Record<(typeof TOOL_TABS)[number]['tab'], LucideIcon> = {
  'settings-sampler': SlidersHorizontalIcon,
  'submission-planner': ListChecksIcon,
  'correlation-breaker': UnlinkIcon,
  'submit-queue': SendIcon,
  osmosis: DropletsIcon,
}

/** What each one is for, since a name alone does not say when to reach for it. */
const ABOUT: Record<(typeof TOOL_TABS)[number]['tab'], string> = {
  'settings-sampler': 'Sweep one Alpha across Simulation Settings to find where it works best.',
  'submission-planner': 'Pick which Alphas to submit, and in what order.',
  'correlation-breaker': 'Re-shape an Alpha that is already in the Production Pool.',
  'submit-queue': 'Submits your approved Alphas for you, within a daily cap.',
  osmosis: 'Allocates your Osmosis points each week, within BRAIN’s rules.',
}

/** Each tool's own search params. Both take one and default it to nothing, and a `Link`
 *  cannot infer that through the union of routes. */
const SEARCH = {
  'settings-sampler': { alpha: undefined },
  'submission-planner': { task: undefined },
  'correlation-breaker': { alpha: undefined },
  'submit-queue': {},
  osmosis: {},
} as const

export function ToolsScreen() {
  return (
    <Page>
      <PageHeader title="Tools" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {TOOL_TABS.map((tool, index) => (
          <Link key={tool.tab} to={tool.to} search={SEARCH[tool.tab]} className={NAV_CARD}>
            <NavCardContent
              tile={WrenchIcon}
              pivot="center"
              mark={ICONS[tool.tab]}
              index={index}
              label={tool.label}
              description={ABOUT[tool.tab]}
            />
          </Link>
        ))}
      </div>
    </Page>
  )
}
