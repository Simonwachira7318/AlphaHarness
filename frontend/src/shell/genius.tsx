/**
 * The account's BRAIN Genius level as a badge, each level in its own colour from the tier-1
 * palette. A level BRAIN adds later still shows, in neutral, until it is given one here.
 */

import { AwardIcon } from 'lucide-react'
import { cn } from '@/lib/cn'

const LEVELS: Record<string, { label: string; color: string }> = {
  GOLD: { label: 'Gold', color: 'var(--amber-300)' },
  EXPERT: { label: 'Expert', color: 'var(--teal-300)' },
  MASTER: { label: 'Master', color: 'var(--orchid-300)' },
  GRANDMASTER: { label: 'Grandmaster', color: 'var(--rose-300)' },
}

const readable = (level: string) =>
  level.charAt(0) + level.slice(1).toLowerCase().replaceAll('_', ' ')

export function GeniusBadge({
  level,
  size = 'sm',
  className,
}: {
  level: string | null | undefined
  size?: 'sm' | 'md'
  className?: string
}) {
  if (!level) return null
  const known = LEVELS[level] ?? { label: readable(level), color: 'var(--neutral-300)' }
  return (
    <span
      title={`BRAIN Genius level: ${known.label}`}
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1 rounded-pill border font-medium whitespace-nowrap',
        size === 'md'
          ? 'px-2.5 py-1 text-body-compact [&_svg]:size-3.5'
          : 'px-1.5 py-px text-caption [&_svg]:size-3',
        className,
      )}
      style={{
        color: known.color,
        borderColor: `color-mix(in oklab, ${known.color} 45%, transparent)`,
        backgroundColor: `color-mix(in oklab, ${known.color} 12%, transparent)`,
      }}
    >
      <AwardIcon aria-hidden />
      {known.label}
    </span>
  )
}
