/**
 * The card a group screen (Research Labs, Tools) links each of its members with.
 *
 * The page renders its own `Link` with {@link NAV_CARD}, because every route takes different
 * search params and a shared `Link` cannot type them; this is what goes inside. The tile holds
 * the group's sidebar icon, which shakes on hover; the member's own icon marks its number and
 * sits large and faded behind everything as a watermark.
 */

import { ArrowUpRightIcon, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'

export const NAV_CARD =
  'panel-highlight group relative isolate flex min-h-56 flex-col justify-between overflow-hidden rounded-lg border border-hairline bg-surface-1 p-6 transition-[transform,background-color,border-color] duration-200 ease-out hover:-translate-y-1 hover:border-primary hover:bg-surface-2 focus-visible:-translate-y-1 focus-visible:border-primary'

const number = (index: number) => String(index + 1).padStart(2, '0')

export function NavCardContent({
  tile: Tile,
  mark: Mark,
  index,
  label,
  description,
  pivot = 'bottom',
}: {
  /** The group's sidebar icon, the same on every card. */
  tile: LucideIcon
  /** This member's own icon. */
  mark: LucideIcon
  index: number
  label: string
  description?: string | undefined
  /** Where the tile icon rocks from: a flask from its base, a wrench from its middle. */
  pivot?: 'bottom' | 'center'
}) {
  return (
    <>
      {/* Background: grid, corner glow and the member's own mark, all behind the content. */}
      <div
        aria-hidden
        className="lab-grid pointer-events-none absolute inset-0 -z-10 opacity-60 transition-opacity duration-300 group-hover:opacity-100"
      />
      <div
        aria-hidden
        className="lab-glow pointer-events-none absolute inset-0 -z-10 opacity-40 transition-opacity duration-300 group-hover:opacity-100 group-focus-visible:opacity-100"
      />
      <Mark
        aria-hidden
        strokeWidth={1.25}
        className="pointer-events-none absolute -right-6 -bottom-6 -z-10 size-36 text-ink-tertiary opacity-15 transition-[transform,opacity,color] duration-500 ease-out group-hover:-rotate-12 group-hover:scale-110 group-hover:text-primary group-hover:opacity-25"
      />

      <div className="flex items-start justify-between">
        <span className="flex size-12 items-center justify-center rounded-md border border-hairline-strong bg-surface-2 text-ink-muted transition-colors duration-200 group-hover:border-primary group-hover:bg-surface-3 group-hover:text-primary">
          <Tile
            aria-hidden
            className={cn(
              'size-6 motion-safe:group-hover:animate-shake motion-safe:group-focus-visible:animate-shake',
              pivot === 'bottom' ? 'origin-bottom' : 'origin-center',
            )}
          />
        </span>
        <ArrowUpRightIcon
          aria-hidden
          className="size-5 text-ink-tertiary transition-[color,transform] duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-primary"
        />
      </div>
      <div className="flex flex-col gap-1">
        <span className="num flex items-center gap-1.5 text-body-compact text-ink-subtle transition-colors group-hover:text-ink-muted">
          <Mark aria-hidden className="size-3.5" />
          {number(index)}
        </span>
        <h2 className="text-headline font-semibold text-balance text-ink">{label}</h2>
        {description && (
          <p className="max-w-prose text-body text-pretty text-ink-subtle">{description}</p>
        )}
      </div>
    </>
  )
}
