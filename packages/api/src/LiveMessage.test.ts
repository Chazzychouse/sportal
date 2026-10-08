import { assert, describe, it } from "@effect/vitest"
import { Stage } from "@sportal/domain/Stage"
import { Schema } from "effect"
import { LiveMessage, LiveMessageJson } from "./LiveMessage.ts"

describe("LiveMessage", () => {
  it("should encode SlateChanged as {_tag, games}", () => {
    const message = LiveMessage.cases.SlateChanged.make({ games: [] })

    const json = Schema.encodeSync(LiveMessageJson)(message)

    assert.strictEqual(json, '{"_tag":"SlateChanged","games":[]}')
  })

  it("should encode StageChanged as {_tag, stage}", () => {
    const message = LiveMessage.cases.StageChanged.make({ stage: Stage.initial })

    const json = Schema.encodeSync(LiveMessageJson)(message)

    assert.strictEqual(
      json,
      `{"_tag":"StageChanged","stage":${JSON.stringify(Schema.encodeSync(Stage)(Stage.initial))}}`
    )
  })
})
