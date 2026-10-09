import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import * as LiveStream from "../hub/LiveStream.ts"
import { ConnectionPill } from "./Brand.tsx"

describe("ConnectionPill", () => {
  it("should not say reconnecting before the live stream has ever connected", () => {
    const html = pill(LiveStream.Connection.Connecting())

    assert.include(html, "Connecting")
    assert.notInclude(html, "Reconnecting")
  })

  it("should say the Hub is live while connected", () => {
    const html = pill(LiveStream.Connection.Connected())

    assert.include(html, "Hub live")
  })

  it("should say reconnecting once the live stream is lost", () => {
    const lost = LiveStream.Connection.Lost({ since: DateTime.makeUnsafe(0) })

    const html = pill(lost)

    assert.include(html, "Reconnecting")
  })
})

function pill(connection: LiveStream.Connection) {
  return renderToStaticMarkup(createElement(ConnectionPill, { connection }))
}
