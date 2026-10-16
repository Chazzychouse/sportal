import { useAtomValue } from "@effect/atom-react"
import { useEffect } from "react"
import { toast } from "sonner"
import * as Games from "../hub/Games.ts"
import { Connection } from "../hub/HubSocket.ts"
import * as CoveringToast from "./CoveringToast.tsx"

/**
 * Shows one toast for as long as the Hub socket is lost: from the moment it is lost until it is back, then dismisses
 * it. Before the socket has ever connected there is none. While it shows, the videos under it hide.
 */
export function useConnectionToast() {
  const { connection } = useAtomValue(Games.today)
  const lost = Connection.$is("Lost")(connection)
  useEffect(() => {
    if (!lost) return undefined
    CoveringToast.warning("Lost the Hub. Reconnecting…", {
      id: lostToast,
      duration: Number.POSITIVE_INFINITY
    })
    return () => {
      toast.dismiss(lostToast)
    }
  }, [lost])
}

/** The one toast's id, so a second loss replaces it instead of stacking. */
const lostToast = "sportal-hub-lost"
