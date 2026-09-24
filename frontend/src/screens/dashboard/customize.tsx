/** Show, hide and reorder the Dashboard's tiles and panels. Kept in this browser. */

import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import { Button, Checkbox } from '@/ui/kit'
import { Dialog } from '@/ui/overlay'
import { LABELS, ordered, PANELS, type SectionId, TILES, useLayout } from './layout'

export function Customize({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { order, hidden, toggle, move, reset } = useLayout()
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Customize Dashboard"
      description="Choose what shows and in what order. Saved in this browser."
      footer={
        <>
          <Button variant="ghost" onClick={reset}>
            Reset
          </Button>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {[
          { title: 'Figures', ids: ordered(order, TILES) as SectionId[] },
          { title: 'Panels', ids: ordered(order, PANELS) as SectionId[] },
        ].map((group) => (
          <section key={group.title} className="flex flex-col gap-1">
            <h3 className="text-caption font-medium uppercase tracking-wide text-ink-subtle">
              {group.title}
            </h3>
            {group.ids.map((id, index) => (
              <div
                key={id}
                className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-2"
              >
                <Checkbox
                  className="flex-1"
                  label={LABELS[id]}
                  checked={!hidden.includes(id)}
                  onChange={() => toggle(id)}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${LABELS[id]} up`}
                  title={`Move ${LABELS[id]} up`}
                  disabled={index === 0}
                  onClick={() => move(id, -1)}
                >
                  <ChevronUpIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${LABELS[id]} down`}
                  title={`Move ${LABELS[id]} down`}
                  disabled={index === group.ids.length - 1}
                  onClick={() => move(id, 1)}
                >
                  <ChevronDownIcon />
                </Button>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Dialog>
  )
}
