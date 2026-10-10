import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import { DateTime, Option, Schema } from "effect"
import { Prompt } from "./Prompt.ts"

const phi = GameId.make("phi")
const chi = GameId.make("chi")
const since = DateTime.makeUnsafe("2026-10-10T20:00:00Z")
const names: Record<string, string> = { phi: "PHI @ DAL", chi: "CHI @ GB" }
const nameOf = (game: GameId) => names[game] ?? game

describe("Prompt", () => {
  it("should accept by assigning the game to the target, then promoting it", () => {
    const prompt = new Prompt({ game: phi, rank: "redZone", since, target: 2, replaces: Option.none() })

    const commands = prompt.commands()

    assert.deepStrictEqual(commands, [
      { _tag: "Assign", tile: 2, game: phi },
      { _tag: "Promote", tile: 2 }
    ])
  })

  it("should say what it replaces", () => {
    const prompt = new Prompt({
      game: phi,
      rank: "redZone",
      since,
      target: 3,
      replaces: Option.some({ game: chi, rank: "break" })
    })

    const words = prompt.words(nameOf)

    assert.strictEqual(words, "PHI @ DAL — red zone, replaces CHI @ GB (on a break)")
  })

  it("should say it goes into an empty tile", () => {
    const prompt = new Prompt({ game: phi, rank: "crunchTime", since, target: 2, replaces: Option.none() })

    const words = prompt.words(nameOf)

    assert.strictEqual(words, "PHI @ DAL — crunch time, into an empty tile")
  })

  it("should come back the same through its schema", () => {
    const prompt = new Prompt({
      game: phi,
      rank: "redZone",
      since,
      target: 3,
      replaces: Option.some({ game: chi, rank: "break" })
    })

    const back = Schema.decodeSync(Prompt)(Schema.encodeSync(Prompt)(prompt))

    assert.deepStrictEqual(back, prompt)
  })
})
