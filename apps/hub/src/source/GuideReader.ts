import { Guide, GuideUnreadable } from "@sportal/domain/Guide"
import {
  Context,
  DateTime,
  Duration,
  Effect,
  FiberHandle,
  Layer,
  Option,
  type Stream,
  SubscriptionRef
} from "effect"
import * as YouTubeTvGuide from "./youtube-tv/YouTubeTvGuide.ts"

/**
 * Reads the guide responses the shell fetches from a source's guide page, and keeps the latest guide while it is
 * fresh. Only YouTube TV has a guide to read.
 */
export class GuideReader extends Context.Service<
  GuideReader,
  {
    /**
     * The latest guide while it is fresh, then again after every guide read and when it goes stale; none before the
     * first read, and once the last is stale.
     */
    readonly guide: Stream.Stream<Option.Option<Guide>>
    /** Reads a guide response as the source's guide page received it; it is the latest guide next. */
    readGuide(guide: string): Effect.Effect<void, GuideUnreadable>
  }
>()("sportal/hub/source/GuideReader") {
  /** YouTube TV's guide, read by the shell from the guide page; a guide is fresh for 45 minutes after its reading. */
  static readonly layerYouTubeTv: Layer.Layer<GuideReader> = Layer.effect(
    GuideReader,
    Effect.gen(function* () {
      // At most one fiber waiting to retire the latest guide; a newer read replaces it.
      const expiry = yield* FiberHandle.make<void>()
      const latest = yield* SubscriptionRef.make(Option.none<Guide>())

      const readGuide = Effect.fn("GuideReader.readGuide")(function* (response: string) {
        const decoded = yield* YouTubeTvGuide.decode(response).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("YouTubeTv: a guide response did not decode", error.message)
          ),
          Effect.mapError(() => new GuideUnreadable())
        )
        const readAt = yield* DateTime.now
        const read = new Guide({ source: YouTubeTvGuide.source, readAt, ...decoded })
        if (read.channels.length === 0) {
          yield* Effect.logWarning("YouTubeTv: a guide response listed no channels")
          return yield* new GuideUnreadable()
        }

        yield* Effect.logInfo(
          `YouTubeTv: read a guide of ${read.channels.length} channels and ${read.airings.length} airings`
        )
        yield* SubscriptionRef.set(latest, Option.some(read))

        // Retire this guide once it is stale, unless a newer one has replaced it; tiles hear of it as a change.
        const retire = SubscriptionRef.updateSome(latest, (current) =>
          Option.exists(current, (guide) => guide === read)
            ? Option.some(Option.none<Guide>())
            : Option.none()
        )
        yield* FiberHandle.run(expiry, Effect.sleep(staleAfter).pipe(Effect.andThen(retire)))
      })

      return GuideReader.of({
        guide: SubscriptionRef.changes(latest),
        readGuide
      })
    })
  )
}

/**
 * How long a guide answers after its reading: three missed 15-minute reads. After that a guide may list a
 * channel that has moved on, so it is no longer the latest until the next read.
 */
const staleAfter = Duration.minutes(45)
