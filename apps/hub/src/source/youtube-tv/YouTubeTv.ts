import type { GuideUnreadable } from "@sportal/api/GuideUnreadable"
import { Context, Effect, Layer, Option, type Stream, SubscriptionRef } from "effect"
import type { Guide } from "../Guide.ts"
import * as YouTubeTvGuide from "./YouTubeTvGuide.ts"

/** YouTube TV: reads the guide responses the shell fetches from its guide page, and keeps the latest guide. */
export class YouTubeTv extends Context.Service<
  YouTubeTv,
  {
    /** The latest guide, then again after every guide read; none before the first read. */
    readonly guide: Stream.Stream<Option.Option<Guide>>
    /** Reads a guide response as the guide page received it; it is the latest guide next. */
    readGuide(guide: string): Effect.Effect<void, GuideUnreadable>
  }
>()("sportal/hub/source/youtube-tv/YouTubeTv") {
  /** YouTube TV, as its guide names it. */
  static readonly source = YouTubeTvGuide.source

  static readonly layer: Layer.Layer<YouTubeTv> = Layer.effect(
    YouTubeTv,
    Effect.gen(function* () {
      const latest = yield* SubscriptionRef.make(Option.none<Guide>())

      const readGuide = Effect.fn("YouTubeTv.readGuide")(function* (response: string) {
        const read = yield* YouTubeTvGuide.decode(response)
        yield* SubscriptionRef.set(latest, Option.some(read))
      })

      return YouTubeTv.of({ guide: SubscriptionRef.changes(latest), readGuide })
    })
  )
}
