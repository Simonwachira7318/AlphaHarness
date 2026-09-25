/** Research Labs: every lab, four to a row. */

import { Link } from '@tanstack/react-router'
import {
  BlocksIcon,
  DnaIcon,
  FlaskConicalIcon,
  type LucideIcon,
  SearchIcon,
  SigmaIcon,
  ZapIcon,
} from 'lucide-react'
import { LAB_TABS } from '@/shell/nav'
import { Page, PageHeader } from '@/ui/kit'
import { NAV_CARD, NavCardContent } from '@/ui/nav-card'

const ICONS: Record<(typeof LAB_TABS)[number]['tab'], LucideIcon> = {
  search: SearchIcon,
  template: BlocksIcon,
  evolution: DnaIcon,
  'power-pool': ZapIcon,
  super: SigmaIcon,
}

export function ResearchLabsScreen() {
  return (
    <Page>
      <PageHeader title="Research Labs" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {LAB_TABS.map((lab, index) => (
          <Link key={lab.tab} to={lab.to} className={NAV_CARD}>
            <NavCardContent
              tile={FlaskConicalIcon}
              mark={ICONS[lab.tab]}
              index={index}
              label={lab.label}
            />
          </Link>
        ))}
      </div>
    </Page>
  )
}
