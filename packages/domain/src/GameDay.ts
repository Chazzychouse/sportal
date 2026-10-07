import { Slate } from "@sportal/domain/Slate"
import { Array as Arr, DateTime, Option, Schema } from "effect"

const schema = Schema.String.check(
  Schema.makeFilter(
    (date) =>
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      Option.exists(DateTime.make(`${date}T12:00:00Z`), (noon) => DateTime.formatIsoDateUtc(noon) === date),
    { expected: "a date, YYYY-MM-DD" }
  )
).pipe(Schema.brand("GameDay"))

/** Game day `day` in `zone`: from 04:00 local on it until 04:00 the next day. */
function bounds(
  gameDay: typeof schema.Type,
  zone: DateTime.TimeZone
): { readonly from: DateTime.Utc; readonly until: DateTime.Utc } {
  const noon = DateTime.makeZonedUnsafe(`${gameDay}T12:00:00Z`, { timeZone: zone, adjustForTimeZone: true })
  return { from: Slate.dayStart(noon), until: Slate.dayStart(DateTime.add(noon, { days: 1 })) }
}

/** Every game day from `from` to `to`, both included; none when `to` is before `from`. */
function dates(from: typeof schema.Type, to: typeof schema.Type): ReadonlyArray<typeof schema.Type> {
  const last = DateTime.makeUnsafe(`${to}T00:00:00Z`)
  return Arr.unfold(DateTime.makeUnsafe(`${from}T00:00:00Z`), (day) =>
    DateTime.isGreaterThan(day, last)
      ? Option.none()
      : Option.some([schema.make(DateTime.formatIsoDateUtc(day)), DateTime.add(day, { days: 1 })] as const)
  )
}

/** A game day, as YYYY-MM-DD: a date that exists. Its operations are `.bounds` and `.dates`. */
export const GameDay = Object.assign(schema, { bounds, dates })
export type GameDay = typeof GameDay.Type
