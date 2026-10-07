import { assert, describe, it } from "@effect/vitest"
import { Cause, Exit } from "effect"
import { isStopping } from "./HubStopping.ts"

describe("isStopping", () => {
  it("is an interrupt, a stream's end, or both", () => {
    assert.isTrue(isStopping(Exit.failCause(Cause.interrupt())))
    assert.isTrue(isStopping(Exit.failCause(Cause.fail(Cause.Done()))))
    assert.isTrue(isStopping(Exit.failCause(Cause.combine(Cause.interrupt(), Cause.fail(Cause.Done())))))
  })

  it("is not a stream's end beside a real failure", () => {
    assert.isFalse(isStopping(Exit.failCause(Cause.combine(Cause.fail(Cause.Done()), Cause.die("boom")))))
    assert.isFalse(isStopping(Exit.failCause(Cause.combine(Cause.fail(Cause.Done()), Cause.fail("refused")))))
  })

  it("is not a success or a failure alone", () => {
    assert.isFalse(isStopping(Exit.void))
    assert.isFalse(isStopping(Exit.die("boom")))
  })
})
