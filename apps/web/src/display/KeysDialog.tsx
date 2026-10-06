import { Hotkey } from "@sportal/api/Hotkey"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/design/dialog"

/** Every hotkey, grouped, read from the one table the bindings are tested against. */
export function KeysDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="top-20 translate-y-0 gap-3 border-border bg-popover sm:max-w-md">
        <div>
          <DialogTitle className="label-caps text-xs">Keys</DialogTitle>
          <DialogDescription className="text-xs">
            They work while a video has focus too, except Enter.
          </DialogDescription>
        </div>
        {(["Strip", "Tiles", "Stage"] as const).map((group) => (
          <section key={group}>
            <h3 className="label-caps pb-1 text-[11px] text-muted-foreground">{group}</h3>
            <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
              {Hotkey.keys
                .filter((binding) => binding.group === group)
                .map((binding) => (
                  <div key={binding.does} className="contents">
                    <dt className="flex items-center gap-1">
                      {binding.keys.map((key) => (
                        <kbd
                          key={key}
                          className="rounded-sm border border-b-2 bg-secondary px-1.5 font-mono text-[11px] leading-5"
                        >
                          {key}
                        </kbd>
                      ))}
                    </dt>
                    <dd className="text-muted-foreground">{binding.does}</dd>
                  </div>
                ))}
            </dl>
          </section>
        ))}
      </DialogContent>
    </Dialog>
  )
}
