import { Slate } from "@sportal/domain/Slate"
import { Array as Arr, DateTime, Option, Schema } from "effect"

/** A game day, as YYYY-MM-DD: a date that exists. */
export const GameDay = Schema.String.check(
  Schema.makeFilter(
    (date) =>
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      Option.exists(DateTime.make(`${date}T12:00:00Z`), (noon) => DateTime.formatIsoDateUtc(noon) === date),
    { expected: "a date, YYYY-MM-DD" }
  )
).pipe(Schema.brand("GameDay"))
export type GameDay = typeof GameDay.Type

/** Game day `day` in `zone`: from 04:00 local on it until 04:00 the next day. */
export function bounds(
  day: GameDay,
  zone: DateTime.TimeZone
): { readonly from: DateTime.Utc; readonly until: DateTime.Utc } {
  const noon = DateTime.makeZonedUnsafe(`${day}T12:00:00Z`, { timeZone: zone, adjustForTimeZone: true })
  return { from: Slate.dayStart(noon), until: Slate.dayStart(DateTime.add(noon, { days: 1 })) }
}

/** Every game day from `from` to `to`, both included; none when `to` is before `from`. */
export function dates(from: GameDay, to: GameDay): ReadonlyArray<GameDay> {
  const last = DateTime.makeUnsafe(`${to}T00:00:00Z`)
  return Arr.unfold(DateTime.makeUnsafe(`${from}T00:00:00Z`), (day) =>
    DateTime.isGreaterThan(day, last)
      ? Option.none()
      : Option.some([GameDay.make(DateTime.formatIsoDateUtc(day)), DateTime.add(day, { days: 1 })] as const)
  )
}
