import type { GuideUnreadable } from "@sportal/api/GuideUnreadable"
import {
  Context,
  Duration,
  Effect,
  FiberHandle,
  Layer,
  Option,
  Semaphore,
  type Stream,
  SubscriptionRef
} from "effect"
import type { Guide } from "./Guide.ts"
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
      const writes = yield* Semaphore.make(1)

      const readGuide = Effect.fn("GuideReader.readGuide")(function* (response: string) {
        const read = yield* YouTubeTvGuide.decode(response)
        // Retire this guide once it is stale, unless a newer one has replaced it; tiles hear of it as a change.
        const retire = SubscriptionRef.updateSome(latest, (current) =>
          Option.exists(current, (guide) => guide === read)
            ? Option.some(Option.none<Guide>())
            : Option.none()
        )
        const retirement = Effect.sleep(staleAfter).pipe(Effect.andThen(retire), Effect.interruptible)

        // A published guide always has its retirement scheduled.
        yield* Effect.gen(function* () {
          yield* SubscriptionRef.set(latest, Option.some(read))
          yield* FiberHandle.run(expiry, retirement)
        }).pipe(Effect.uninterruptible)
      }, Semaphore.withPermit(writes))

      return GuideReader.of({
        guide: SubscriptionRef.changes(latest),
        readGuide
      })
    })
  )
}

/** A guide answers for 45 minutes after its reading. */
const staleAfter = Duration.minutes(45)
