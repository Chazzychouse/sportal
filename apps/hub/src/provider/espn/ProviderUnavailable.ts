import { Schema } from "effect"

/** FastCast could not be followed: it refused, closed, or went silent. `FastCast` logs it and opens the socket again. */
export class ProviderUnavailable extends Schema.TaggedError<ProviderUnavailable>()("ProviderUnavailable", {
  reason: Schema.Literals(["Refused", "Closed", "Silent"]),
  cause: Schema.Defect()
}) {}
