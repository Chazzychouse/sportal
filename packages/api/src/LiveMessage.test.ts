import { assert, describe, it } from "@effect/vitest"
import { Screen } from "@sportal/domain/Screen"
import { Schema } from "effect"
import { LiveMessage, LiveMessageJson } from "./LiveMessage.ts"

describe("LiveMessage", () => {
  it("should encode SlateChanged as {_tag, games}", () => {
    const message = LiveMessage.cases.SlateChanged.make({ games: [] })

    const json = Schema.encodeSync(LiveMessageJson)(message)

    assert.strictEqual(json, '{"_tag":"SlateChanged","games":[]}')
  })

  it("should encode ScreenChanged as {_tag, screen}", () => {
    const message = LiveMessage.cases.ScreenChanged.make({ screen: Screen.initial })

    const json = Schema.encodeSync(LiveMessageJson)(message)

    assert.strictEqual(
      json,
      `{"_tag":"ScreenChanged","screen":${JSON.stringify(Schema.encodeSync(Screen)(Screen.initial))}}`
    )
  })
})
