import { Data, Effect, Option, Stream } from "effect"
import { KeyValueStore } from "effect/persistence"
import { Atom } from "effect/reactivity"
import * as AutopilotState from "../autopilot/AutopilotState.ts"
import { nameIn } from "../autopilot/AutopilotState.ts"
import * as LiveStream from "../hub/LiveStream.ts"
import * as DisplayScreen from "../screen/DisplayScreen.ts"
import { logDefect, runtime } from "../WebRuntime.ts"
import type { Prompt } from "./Prompt.ts"
import { Prompts } from "./Prompts.ts"

/** What moves this Display's prompts: turned on or off, or the prompt accepted or dismissed. */
export type PromptInput = Data.TaggedEnum<{
  Toggled: object
  Accepted: object
  Dismissed: object
}>
export const PromptInput = Data.taggedEnum<PromptInput>()

/**
 * This Display's prompts, kept in this browser. Accepting sends the prompt's commands as yours; dismissing keeps its
 * game quiet for its moment. With no prompt, both do nothing.
 */
export const prompts: Atom.Writable<Prompts, PromptInput> = Atom.writable(
  (get) => get(kept),
  (ctx, input: PromptInput) => {
    const current = ctx.get(kept)
    if (PromptInput.$is("Toggled")(input)) {
      ctx.set(kept, current.toggle())
      return
    }
    const shown = ctx.get(prompt)
    if (Option.isNone(shown)) return
    const accepted = PromptInput.$is("Accepted")(input)
    Atom.batch(() => {
      ctx.set(answered, Option.some({ prompt: shown.value, accepted }))
      if (accepted) for (const command of shown.value.commands()) ctx.set(AutopilotState.yours, command)
      else ctx.set(kept, current.dismiss(shown.value, ctx.get(LiveStream.live).classifications))
    })
  }
).pipe(Atom.keepAlive)

/** The prompt to show now on this Display's Screen, if any. */
export const prompt: Atom.Atom<Option.Option<Prompt>> = Atom.make((get) =>
  get(kept).prompt(get(DisplayScreen.screen), get(LiveStream.live))
)

/** The last prompt you answered, and whether you accepted it; none before any. */
const answered = Atom.make<Option.Option<{ readonly prompt: Prompt; readonly accepted: boolean }>>(
  Option.none()
).pipe(Atom.keepAlive)

/** Logs each prompt shown, taken over or gone, and each you accepted or dismissed. Mounted once, by the Display. */
export const log = runtime.atom((get) =>
  Effect.gen(function* () {
    const shown = get.stream(prompt).pipe(
      Stream.changesWith((a, b) => keyOf(a) === keyOf(b)),
      Stream.zipWithPrevious,
      Stream.runForEach(([previous, next]) => {
        const nameOf = nameIn(get.once(LiveStream.live).slate)
        const before = Option.flatten(previous)
        return Option.match(next, {
          onSome: (each) =>
            Effect.logInfo(`Prompt: ${Option.isSome(before) ? "now " : ""}${each.words(nameOf)}`).pipe(
              Effect.annotateLogs(details(each))
            ),
          onNone: () => (Option.isSome(before) ? Effect.logInfo("Prompt: gone") : Effect.void)
        })
      })
    )
    const answers = get.stream(answered).pipe(
      Stream.map(Option.toArray),
      Stream.flattenIterable,
      Stream.runForEach(({ prompt: answer, accepted }) =>
        Effect.logInfo(
          `Prompt: ${accepted ? "accepted" : "dismissed"} ${answer.words(nameIn(get.once(LiveStream.live).slate))}`
        ).pipe(Effect.annotateLogs(details(answer)))
      )
    )
    yield* Effect.all([shown, answers], { concurrency: "unbounded", discard: true })
  }).pipe(logDefect("The prompts"))
)

/** What tells one prompt from another for the log: its game, rank and target. */
function keyOf(prompt: Option.Option<Prompt>): string {
  return Option.match(prompt, {
    onNone: () => "",
    onSome: ({ game, rank, target }) => `${game} ${rank} ${target}`
  })
}

/** A prompt's log annotations. */
function details(prompt: Prompt) {
  return { "prompt.game": prompt.game, "prompt.rank": prompt.rank, "prompt.target": prompt.target }
}

const kept = Atom.kvs({
  runtime: Atom.runtime(KeyValueStore.layerStorage(() => localStorage)),
  key: "sportal/prompts",
  schema: Prompts,
  defaultValue: () => Prompts.initial
}).pipe(Atom.keepAlive)
