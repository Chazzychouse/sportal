import { ChannelAvailability } from "@sportal/domain/Channel"
import type { GameSnapshot } from "@sportal/domain/Game"
import { Effect, Layer, Stream } from "effect"
import { Source } from "../source/Source.ts"

/**
 * A scenario's source: every game is carried on the web UI's synthetic stream page for it, so a scenario needs
 * no sign-in and no stream budget. The address is a path, since only the web UI knows the origin it is served
 * from.
 */
export const layer: Layer.Layer<Source> = Layer.succeed(
  Source,
  Source.of({
    availability: Effect.succeed((game: GameSnapshot) =>
      ChannelAvailability.Carried({
        channel: {
          name: game.broadcasts[0]?.network ?? "Scenario",
          source: "Scenario",
          locator: { _tag: "WebView", url: `/scenario-stream/${encodeURIComponent(game.id)}` }
        }
      })
    ),
    changes: Stream.empty,
    readGuide: () => Effect.void
  })
)
