import { Option } from "effect"
import { useEffect, useState } from "react"
import { encode } from "uqr"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/design/dialog"
import { hostAddresses } from "../hub/HubClient.ts"

/**
 * How a phone joins as a Remote: a QR code for this page's port on one of the machine's home-network addresses,
 * and the address as text. With several addresses (a VPN, a second network), each is listed to switch to.
 */
export function JoinRemote(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  // Undefined while asking; none when the Hub could not be asked.
  const [addresses, setAddresses] = useState<Option.Option<ReadonlyArray<string>> | undefined>(undefined)
  const [chosen, setChosen] = useState(0)

  useEffect(() => {
    if (!props.open) return
    setChosen(0)
    setAddresses(undefined)
    void hostAddresses().then(setAddresses)
  }, [props.open])

  const port = window.location.port === "" ? "" : `:${window.location.port}`
  const url = (address: string) => `${window.location.protocol}//${address}${port}/remote`
  const listed = addresses === undefined ? [] : Option.getOrElse(addresses, (): ReadonlyArray<string> => [])
  const shown = listed[chosen]

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="top-20 translate-y-0 gap-4 border-border bg-popover sm:max-w-sm">
        <div>
          <DialogTitle className="label-caps text-xs">Remote</DialogTitle>
          <DialogDescription className="text-xs">
            Scan with a phone on the same network to control this Stage.
          </DialogDescription>
        </div>
        {addresses === undefined ? (
          <p className="text-muted-foreground text-sm">Asking the Hub…</p>
        ) : Option.isNone(addresses) ? (
          <p className="text-muted-foreground text-sm">
            The Hub did not answer. Restart it (<code className="font-mono">pnpm dev</code>) so it runs this
            version.
          </p>
        ) : shown === undefined ? (
          <p className="text-muted-foreground text-sm">
            The Hub found no home-network address. Is this machine on Wi-Fi or Ethernet?
          </p>
        ) : (
          <>
            <QrCode text={url(shown)} />
            <ul className="flex flex-col gap-1">
              {listed.map((address, index) => (
                <li key={address}>
                  <button
                    type="button"
                    onClick={() => setChosen(index)}
                    aria-pressed={index === chosen}
                    className={`w-full rounded-sm px-2 py-1 text-left font-mono text-xs ${
                      index === chosen ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent"
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
