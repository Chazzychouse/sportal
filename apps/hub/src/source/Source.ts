import type { GameSnapshot } from "@sportal/domain/Game"
import type { StreamLocator } from "@sportal/domain/Stream"
import { Context, type Option } from "effect"

export class Source extends Context.Service<
  Source,
  {
    locate(game: GameSnapshot): Option.Option<StreamLocator>
  }
>()("sportal/hub/Source") {}
