import { GameId } from "@sportal/domain/Game"
import { snapshot } from "@sportal/domain/TestGame"
import { DateTime } from "effect"

const live = snapshot({ id: GameId.make("live"), status: "live" })
const later = snapshot({
  id: GameId.make("later"),
  kickoff: DateTime.makeUnsafe("2026-10-03T20:00:00Z")
})
const soon = snapshot({ id: GameId.make("soon") })
const done = snapshot({ id: GameId.make("done"), status: "final" })

/** Four games in no order: live, soon, later, done are the ids; the strip puts them live, soon, later, done. */
export const slate = [done, later, live, soon]
