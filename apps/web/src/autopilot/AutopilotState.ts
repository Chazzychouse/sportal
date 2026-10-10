import { Data, DateTime, Effect, Option, Stream } from "effect"
import { KeyValueStore } from "effect/persistence"
import { Atom } from "effect/reactivity"
import * as LiveStream from "../hub/LiveStream.ts"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import type { Screen, ScreenCommand } from "../screen/Screen.ts"
import { logDefect, runtime } from "../WebRuntime.ts"
import { Autopilot } from "./Autopilot.ts"

/** What moves the autopilot: turned on or off, a command you sent and the Screen after it, or time passing. */
export type AutopilotInput = Data.TaggedEnum<{
  Toggled: object
  Commanded: { readonly command: ScreenCommand; readonly screen: Screen }
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
      ctx.set(kept, current.manual(input.command, input.screen, now))
      return
    }
    const screen = ctx.get(DisplayScreen.screen)
    const moved = AutopilotInput.$is("Toggled")(input) ? current.toggle(screen) : current
    const [next, commands] = moved.step(screen, ctx.get(LiveStream.live).classifications, now)
    Atom.batch(() => {
      ctx.set(kept, next)
      for (const command of commands) ctx.set(DisplayScreen.screen, command)
    })
  }
).pipe(Atom.keepAlive)

/** Steps the autopilot on each live update and at its next deadline. Mounted once, by the Display. */
export const pilot = runtime.atom((get) =>
  Effect.gen(function* () {
    const deadlines = get
      .stream(autopilot)
      .pipe(Stream.switchMap((current) => Stream.fromEffect(untilDeadline(current))))

    yield* Stream.merge(get.stream(LiveStream.live), deadlines).pipe(
      Stream.runForEach(() => Effect.sync(() => get.set(autopilot, AutopilotInput.Ticked())))
    )
  }).pipe(logDefect("The autopilot"))
)

/** Waits until `current`'s next deadline; forever, when it has none. */
function untilDeadline(current: Autopilot): Effect.Effect<void> {
  return Effect.gen(function* () {
    const now = yield* DateTime.now
    yield* Option.match(current.nextDeadline(now), {
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
