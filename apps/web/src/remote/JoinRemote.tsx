import { useAtomValue } from "@effect/atom-react"
import { Effect } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useState } from "react"
import { encode } from "uqr"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/design/dialog"
import { HubClient } from "../hub/HubClient.ts"
import { runtime } from "../WebRuntime.ts"
import * as RemoteLink from "./RemoteLink.ts"

/**
 * How a phone joins as this Display's Remote: a QR code for this page's port on one of the machine's home-network
 * addresses, at this Display's id, and the address as text. With several addresses (a VPN, a second network), each
 * is listed to switch to.
 */
export function JoinRemote(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const answer = useAtomValue(addresses)
  const id = useAtomValue(RemoteLink.displayId)
  const [chosen, setChosen] = useState(0)

  const port = window.location.port === "" ? "" : `:${window.location.port}`
  const url = (address: string) => `${window.location.protocol}//${address}${port}/remote/${id}`
  const listed = AsyncResult.isSuccess(answer) ? answer.value : []
  const shown = listed[chosen] ?? listed[0]

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="top-20 translate-y-0 gap-4 border-border bg-popover sm:max-w-sm">
        <div>
          <DialogTitle className="label-caps text-xs">Remote</DialogTitle>
          <DialogDescription className="text-xs">
            Scan with a phone on the same network to control this Display.
          </DialogDescription>
        </div>
        {AsyncResult.isInitial(answer) ? (
          <p className="text-muted-foreground text-sm">Asking the Hub…</p>
        ) : AsyncResult.isFailure(answer) ? (
          <p className="text-muted-foreground text-sm">Could not reach the Hub.</p>
        ) : shown === undefined ? (
          <p className="text-muted-foreground text-sm">
            The Hub found no home-network address. Is this machine on Wi-Fi or Ethernet?
          </p>
        ) : (
          <>
            <QrCode text={url(shown)} />
            <p className="text-muted-foreground text-xs">
              Phone stuck loading? This machine's firewall must let the home network reach port{" "}
              <span className="font-mono">{window.location.port || "80"}</span>.
            </p>
            <ul className="flex flex-col gap-1">
              {listed.map((address, index) => (
                <li key={address}>
                  <button
                    type="button"
                    onClick={() => setChosen(index)}
                    aria-pressed={address === shown}
                    className={`w-full rounded-sm px-2 py-1 text-left font-mono text-xs ${
                      address === shown
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    {url(address)}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** The addresses the Hub says a phone can reach it at; asked while the dialog is mounted open. */
const addresses = runtime.atom(
  Effect.gen(function* () {
    const hub = yield* HubClient
    return yield* hub.addresses
  })
)

/** A QR code, dark on light whatever the theme, since that is what phone cameras read best. */
function QrCode(props: { text: string }) {
  const { data, size } = encode(props.text, { border: 2 })
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={`QR code for ${props.text}`}
      className="mx-auto size-56 rounded-sm bg-white"
    >
      <path
        fill="black"
        d={data.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : []))).join("")}
      />
    </svg>
  )
}
