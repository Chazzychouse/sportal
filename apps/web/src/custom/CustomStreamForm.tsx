import { useAtomSet } from "@effect/atom-react"
import { Result } from "effect"
import { type FormEvent, useId, useState } from "react"
import { Button } from "@/design/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/design/dialog"
import { DisplayInput } from "../display/Display.ts"
import * as DisplayState from "../display/DisplayState.ts"
import { CustomStream } from "./CustomStream.ts"
import { CustomStreamsChange } from "./CustomStreams.ts"

/**
 * The YouTube form. Without `editing`, a video or playlist address and a name: saved, then watched in the selected
 * tile; an address that is not YouTube's says so under its field. With `editing`, only the name, to rename it. Mounted
 * while open, so each opening starts blank.
 */
export function CustomStreamForm(props: {
  editing: CustomStream | undefined
  onOpenChange: (open: boolean) => void
}) {
  const input = useAtomSet(DisplayState.display)
  const edit = useAtomSet(DisplayState.editCustom)
  const [url, setUrl] = useState("")
  const [name, setName] = useState(props.editing?.name ?? "")
  const [refused, setRefused] = useState(false)
  const refusal = useId()
  const adding = props.editing === undefined

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (props.editing !== undefined) {
      edit(CustomStreamsChange.Renamed({ id: props.editing.id, name: name.trim() }))
      return props.onOpenChange(false)
    }
    Result.match(CustomStream.parse(url, name), {
      onFailure: () => setRefused(true),
      onSuccess: (stream) => {
        edit(CustomStreamsChange.Added({ stream }))
        input(DisplayInput.ChosenCustom({ stream }))
      }
    })
  }

  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogContent className="top-20 translate-y-0 gap-3 border-border bg-popover sm:max-w-md">
        <div>
          <DialogTitle className="label-caps text-xs">{adding ? "Add YouTube" : "Rename"}</DialogTitle>
          <DialogDescription className="text-xs">
            {props.editing === undefined
              ? "A video or playlist address. It plays in the selected tile."
              : props.editing.name}
          </DialogDescription>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3">
          {adding && (
            <label className="flex flex-col gap-1 text-sm">
              Address
              <input
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value)
                  setRefused(false)
                }}
                placeholder="https://www.youtube.com/watch?v=…"
                aria-invalid={refused}
                aria-describedby={refused ? refusal : undefined}
                className={field}
              />
              {refused && (
                <span id={refusal} className="text-destructive text-xs">
                  That is not a YouTube video or playlist address.
                </span>
              )}
            </label>
          )}
          <label className="flex flex-col gap-1 text-sm">
            Name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={adding ? "YouTube video" : ""}
              className={field}
            />
          </label>
          <Button type="submit" disabled={adding ? url.trim() === "" : name.trim() === ""}>
            {adding ? "Watch" : "Rename"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const field =
  "h-9 rounded-sm border bg-background px-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
