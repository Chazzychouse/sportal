import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Connection } from "../hub/LiveStream.ts"
import { ConnectionPill } from "./Masthead.tsx"

describe("ConnectionPill", () => {
  const pill = (connection: Connection) => renderToStaticMarkup(createElement(ConnectionPill, { connection }))

  it("does not say reconnecting before the live stream has ever connected", () => {
    const html = pill(Connection.Connecting())
    assert.include(html, "Connecting")
    assert.notInclude(html, "Reconnecting")
  })

  it("says the Hub is live while connected, and reconnecting once lost", () => {
    assert.include(pill(Connection.Connected()), "Hub live")
    assert.include(pill(Connection.Lost({ since: DateTime.makeUnsafe(0) })), "Reconnecting")
  })
})
