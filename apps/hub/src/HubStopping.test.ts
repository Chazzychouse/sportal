import { assert, describe, it } from "@effect/vitest"
import { Cause, Exit } from "effect"
import { isStopping } from "./HubStopping.ts"

describe("isStopping", () => {
  it.each([
    ["an interrupt", Exit.failCause(Cause.interrupt())],
    ["a stream's end", Exit.failCause(Cause.fail(Cause.Done()))],
    [
      "an interrupt beside a stream's end",
      Exit.failCause(Cause.combine(Cause.interrupt(), Cause.fail(Cause.Done())))
    ]
  ])("should read %s as stopping", (_name, exit) => {
    const stopping = isStopping(exit)

    assert.isTrue(stopping)
  })

  it.each([
    ["a defect", Exit.failCause(Cause.combine(Cause.fail(Cause.Done()), Cause.die("boom")))],
    ["a failure", Exit.failCause(Cause.combine(Cause.fail(Cause.Done()), Cause.fail("refused")))]
  ])("should not read a stream's end beside %s as stopping", (_name, exit) => {
    const stopping = isStopping(exit)

    assert.isFalse(stopping)
  })

  it.each([
    ["a success", Exit.void],
    ["a defect alone", Exit.die("boom")]
  ])("should not read %s as stopping", (_name, exit) => {
    const stopping = isStopping(exit)

    assert.isFalse(stopping)
  })
})
