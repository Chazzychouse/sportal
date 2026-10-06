import { Context } from "effect"
import type { Provider } from "./Provider.ts"

/**
 * A provider's decode on its own, for frames it delivered before: what each frame said. Its adapter provides it, so a
 * recorded scenario decodes its frames as the provider that recorded them would, without naming that provider.
 */
export class Decoder extends Context.Service<Decoder, { readonly decode: Provider["Service"]["decode"] }>()(
  "sportal/hub/Decoder"
) {}
