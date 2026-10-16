import { Schema } from "effect"

/** No day the Hub holds lists a game with that id. */
export class GameNotFound extends Schema.TaggedError<GameNotFound>()("GameNotFound", {}) {}
