import { assert, describe, it } from "@effect/vitest"
import { GameId } from "@sportal/domain/Game"
import * as FastCastDocument from "./FastCastDocument.ts"

// How each document follows its frames is tested through EspnDecode, which reads what the documents say.
describe("FastCastDocument", () => {
  it("names each league's scoreboard topic", () => {
    assert.strictEqual(FastCastDocument.topic("nfl"), "event-football-nfl")
    assert.strictEqual(FastCastDocument.topic("fbs"), "event-football-college-football")
  })

  it("names each game's package topic after its league's scoreboard topic", () => {
    assert.strictEqual(FastCastDocument.topic("nfl", GameId.make("401872971")), "gp-football-nfl-401872971")
    assert.strictEqual(
      FastCastDocument.topic("fbs", GameId.make("401862787")),
      "gp-football-college-football-401862787"
    )
  })
})
