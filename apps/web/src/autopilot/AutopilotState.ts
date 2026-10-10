import type { SlateChanged } from "@sportal/api/LiveMessage"
import type { GameId } from "@sportal/domain/Game"
import type { Slate } from "@sportal/domain/Slate"
import { Data, DateTime, Effect, Option, Stream } from "effect"
import { KeyValueStore } from "effect/persistence"
import { Atom } from "effect/reactivity"
import * as LiveStream from "../hub/LiveStream.ts"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import type { Screen, ScreenCommand } from "../screen/Screen.ts"
import { logDefect, runtime } from "../WebRuntime.ts"
import { Autopilot } from "./Autopilot.ts"
import { type Decision, details, explain } from "./Decision.ts"

/** What moves the autopilot: turned on or off, a command you sent, or time passing. */
export type AutopilotInput = Data.TaggedEnum<{
  Toggled: object
  Commanded: { readonly command: ScreenCommand }
  Ticked: object
}>
export const AutopilotInput = Data.taggedEnum<AutopilotInput>()

/**
 * This Display's autopilot, kept in this browser. A command you sent is recorded; turning it on or off, or a tick,
 * steps it against the Screen and the live classifications, and its commands go to the Screen.
 */
export const autopilot: Atom.Writable<Autopilot, AutopilotInput> = Atom.writable(
  (get) => get(kept),
  (ctx, input: AutopilotInput) => {
    const now = DateTime.nowUnsafe()
    const current = ctx.get(kept)
    if (AutopilotInput.$is("Commanded")(input)) {
      ctx.set(kept, current.manual(input.command, now))
      return
    }
    const screen = ctx.get(DisplayScreen.screen)
    const moved = AutopilotInput.$is("Toggled")(input) ? current.toggle(screen) : current
    const {
      next,
      commands,
      decision: decided
    } = moved.step(screen, ctx.get(LiveStream.live).classifications, now)
    Atom.batch(() => {
      if (next !== current) ctx.set(kept, next)
      ctx.set(decision, Option.some(decided))
      for (const command of commands) ctx.set(DisplayScreen.screen, command)
    })
  }
).pipe(Atom.keepAlive)

/** What the autopilot's last step decided, for its log; none before its first step. */
const decision: Atom.Writable<Option.Option<Decision>> = Atom.make<Option.Option<Decision>>(
  Option.none()
).pipe(Atom.keepAlive)

/**
 * Steps the autopilot on each live update and at its next deadline, and logs each new decision in words. Mounted
 * once, by the Display.
 */
export const pilot = runtime.atom((get) =>
  Effect.gen(function* () {
    const deadlines = Stream.zipLatestAll(
      get.stream(autopilot),
      get.stream(DisplayScreen.screen),
      get.stream(LiveStream.live)
    ).pipe(
      Stream.switchMap(([current, screen, live]) =>
        Stream.fromEffect(untilDeadline(current, screen, live.classifications)).pipe(Stream.forever)
      )
    )

    const ticks = Stream.merge(get.stream(LiveStream.live), deadlines).pipe(
      Stream.runForEach(() => Effect.sync(() => get.set(autopilot, AutopilotInput.Ticked())))
    )
    const log = get.stream(decision).pipe(
      Stream.map(Option.toArray),
      Stream.flattenIterable,
      Stream.changesWith((a, b) => explain(a, String) === explain(b, String)),
      Stream.runForEach((decided) =>
        Effect.logInfo(`Autopilot: ${explain(decided, nameIn(get.once(LiveStream.live).slate))}`).pipe(
          Effect.annotateLogs(details(decided))
        )
      )
    )
    yield* Effect.all([ticks, log], { concurrency: "unbounded", discard: true })
  }).pipe(logDefect("The autopilot"))
)

/** A game's matchup on `slate`, `PHI @ DAL`; its id when the slate does not have it. */
export function nameIn(slate: Slate): (game: GameId) => string {
  return (game) =>
    Option.match(slate.gameOf(game), {
      onNone: () => game,
      onSome: ({ snapshot }) => `${snapshot.away.team.abbreviation} @ ${snapshot.home.team.abbreviation}`
    })
}

/** Waits until `current`'s next deadline on `screen`; forever, when it has none. */
function untilDeadline(
  current: Autopilot,
  screen: Screen,
  classifications: SlateChanged["classifications"]
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const now = yield* DateTime.now
    yield* Option.match(current.nextDeadline(now, screen, classifications), {
      onNone: () => Effect.never,
      onSome: (at) => Effect.sleep(DateTime.distance(now, at))
    })
  })
}

const kept = Atom.kvs({
  runtime: Atom.runtime(KeyValueStore.layerStorage(() => localStorage)),
  key: "sportal/autopilot",
  schema: Autopilot,
  defaultValue: () => Autopilot.off
}).pipe(Atom.keepAlive)
