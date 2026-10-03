import type { GameSnapshot } from "@sportal/domain/Game"
import { LeagueId } from "@sportal/domain/League"
import { Context, type Effect, Schema } from "effect"

export class Provider extends Context.Service<
  Provider,
  {
    slate(league: LeagueId): Effect.Effect<ReadonlyArray<GameSnapshot>, ProviderError>
  }
>()("sportal/hub/Provider") {}

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  league: LeagueId,
  cause: Schema.Defect()
}) {}
