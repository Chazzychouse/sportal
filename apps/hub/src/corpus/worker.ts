import { NodeRuntime, NodeServices, NodeWorkerRunner } from "@effect/platform-node"
import { DateTime, Effect, Layer, Schema } from "effect"
import { WorkerRunner } from "effect/workers"
import { HubConfig } from "../HubConfig.ts"
import { CorpusDays } from "./CorpusDay.ts"
import { DayRun, RunDay } from "./CorpusRun.ts"

// A corpus worker thread: answers each `RunDay` its parent sends, until the parent closes it. Every outcome is replied,
// a defect too, so the parent never waits on a day that ended.
const serve = Effect.gen(function* () {
  const platform = yield* WorkerRunner.WorkerRunnerPlatform
  const runner = yield* platform.start<unknown, unknown>()
  yield* runner.run((port, message) =>
    Schema.decodeUnknownEffect(RunDay)(message).pipe(
      Effect.orDie,
      Effect.flatMap((request) => request.run()),
      Effect.exit,
      Effect.flatMap(DayRun.reply),
      Effect.flatMap((reply) => runner.send(port, reply))
    )
  )
})

serve.pipe(
  Effect.provide(
    Layer.mergeAll(NodeWorkerRunner.layer, CorpusDays.layer, DateTime.layerCurrentZoneLocal).pipe(
      Layer.provide(HubConfig.layer),
      Layer.provide(NodeServices.layer)
    )
  ),
  NodeRuntime.runMain
)
