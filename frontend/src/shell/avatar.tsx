/**
 * The account's BRAIN profile picture, served by the backend (which holds the session it
 * needs), laid over the initials. The initials stay whenever there is no picture: the request
 * 404s and the image never shows.
 */

import { useState } from 'react'
import { cn } from '@/lib/cn'

const SIZE = {
  /** The sidebar's Profile entry, sized to the other nav icons' row. */
  xs: 'size-5 rounded-full text-[9px]',
  /** The top bar's profile button. */
  round: 'size-7 rounded-full text-caption',
  /** The sidebar's account button. */
  sm: 'size-7 rounded-xs text-caption',
  /** The Dashboard greeting, spanning its two `text-display` lines. */
  lg: 'size-14 rounded-lg text-title sm:size-18 sm:text-headline',
  /** The Profile page's hero. */
  xl: 'size-24 rounded-2xl text-headline sm:size-28 sm:text-display',
} as const

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

export function Avatar({
  name,
  userId,
  size = 'sm',
}: {
  name: string
  userId: string | null | undefined
  size?: keyof typeof SIZE
}) {
  const [loaded, setLoaded] = useState(false)
  return (
    <span
      className={cn(
        'num relative flex shrink-0 items-center justify-center overflow-hidden border border-hairline-strong bg-surface-3 font-medium text-ink-muted',
        SIZE[size],
      )}
    >
      {initialsOf(name)}
      {userId && (
        <img
          // Keyed by account, so signing in as someone else never shows the last picture.
          key={userId}
          src={`/api/auth/avatar?user=${encodeURIComponent(userId)}`}
          alt=""
          aria-hidden
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(false)}
          className={cn('absolute inset-0 size-full object-cover', !loaded && 'invisible')}
        />
      )}
    </span>
  )
}
