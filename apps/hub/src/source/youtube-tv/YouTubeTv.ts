import { ChannelAvailability, type SourceName } from "@sportal/domain/Channel"
import type { GameSnapshot } from "@sportal/domain/Game"
import { ChannelId, Guide, GuideUnreadable } from "@sportal/domain/Guide"
import {
  Array as Arr,
  DateTime,
  Duration,
  Effect,
  FiberHandle,
  Layer,
  Option,
  Schema,
  SchemaGetter,
  SchemaTransformation,
  Stream,
  SubscriptionRef
} from "effect"
import { Source } from "../Source.ts"
import * as YouTubeTvPayload from "./YouTubeTvPayload.ts"

/**
 * YouTube TV as a source. Its guide, read by the shell from the guide page, says where each game airs while
 * it is fresh; until one is read, and once the last one is stale, it answers no guide.
 */
export const layer: Layer.Layer<Source> = Layer.effect(
  Source,
  Effect.gen(function* () {
    // At most one fiber waiting to retire the latest guide; a newer read replaces it.
    const expiry = yield* FiberHandle.make<void>()
    const latest = yield* SubscriptionRef.make(Option.none<Guide>())

    const availability = Effect.fn("YouTubeTv.availability")(function* () {
      const now = yield* DateTime.now
      const current = yield* SubscriptionRef.get(latest)
      const fresh = Option.filter(current, (guide) =>
        DateTime.isLessThan(now, DateTime.addDuration(guide.readAt, staleAfter))
      )
      return (game: GameSnapshot) =>
        Option.match(fresh, {
          onNone: () => ChannelAvailability.NoGuide({ source }),
          onSome: (guide) => guide.availabilityOf(game)
        })
    })

    const readGuide = Effect.fn("YouTubeTv.readGuide")(function* (response: string) {
      const decoded = yield* decodeGuide(response).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("YouTubeTv: a guide response did not decode", error.message)
        ),
        Effect.mapError(() => new GuideUnreadable())
      )
      const readAt = yield* DateTime.now
      const read = new Guide({ source, readAt, ...decoded })
      if (read.channels.length === 0) {
        yield* Effect.logWarning("YouTubeTv: a guide response listed no channels")
        return yield* new GuideUnreadable()
      }

      yield* Effect.logInfo(
        `YouTubeTv: read a guide of ${read.channels.length} channels and ${read.airings.length} airings`
      )
      yield* SubscriptionRef.set(latest, Option.some(read))

      // Retire this guide once it is stale, unless a newer one has replaced it, so tiles hear of it too.
      const retire = SubscriptionRef.updateSome(latest, (current) =>
        Option.exists(current, (guide) => guide === read) ? Option.some(Option.none<Guide>()) : Option.none()
      )
      yield* FiberHandle.run(expiry, Effect.sleep(staleAfter).pipe(Effect.andThen(retire)))
    })

    return Source.of({
      availability: availability(),
      // The ref's current value comes first on every subscription; only later values are changes.
      changes: SubscriptionRef.changes(latest).pipe(Stream.drop(1), Stream.as(undefined)),
      readGuide
    })
  })
)

/**
 * A YouTube TV channel address, decoded to the address that plays the channel live. An address can
 * carry a start point ("from the beginning"); keeping it would replay every later game on the channel
 * from that moment, so decoding keeps only the channel's id and the live flag.
 */
const LiveChannelUrl = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^https:\/\/tv\.youtube\.com\/watch\/[A-Za-z0-9_-]+(\?.*)?$/)),
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (url) => `https://tv.youtube.com${new URL(url).pathname}?vp=0gEEEgIwAQ%3D%3D`,
      encode: (url) => url
    })
  )
)

/**
 * How long a guide answers after its reading: three missed 15-minute reads. After that a guide may list a
 * channel that has moved on, so the source answers no guide until the next read.
 */
const staleAfter = Duration.minutes(45)

const source: SourceName = "YouTube TV"

const decodeLiveChannelUrlOption = Schema.decodeOption(LiveChannelUrl)

const decodeBegin = Schema.decodeOption(Schema.FiniteFromString.check(Schema.isGreaterThanOrEqualTo(0)))
const decodeEnd = Schema.decodeOption(Schema.FiniteFromString)

/**
 * A guide response as the channels and airings it lists. Rows without an id or a name are skipped; a row whose
 * live id is not a channel id keeps its channel without a live address; an airing with no title or a time that is
 * not a time is skipped, such as the one untitled airing spanning all of time that a row with nothing listed has.
 */
const GuideListing = YouTubeTvPayload.GuideResponseJson.pipe(
  Schema.decodeTo(Schema.Struct({ channels: Guide.fields.channels, airings: Guide.fields.airings }), {
    decode: SchemaGetter.transform(listingOf),
    encode: SchemaGetter.forbidden(() => "A guide is never written back as a response")
  })
)

const decodeGuide = Schema.decodeEffect(GuideListing)

function listingOf(response: typeof YouTubeTvPayload.GuideResponse.Type) {
  const stations = Arr.flatMap(
    response.contents.epgRenderer.paginationRenderer.epgPaginationRenderer.contents,
    ({ epgRowRenderer: row }) => {
      const station = row?.station?.epgStationRenderer
      return Option.all({
        row: Option.fromNullishOr(row),
        id: Option.fromNullishOr(station?.stationId).pipe(Option.map(ChannelId.make)),
        name: Option.fromNullishOr(station?.icon?.accessibility?.accessibilityData.label)
      }).pipe(Option.toArray)
    }
  )
  return {
    channels: stations.map(({ row, id, name }) => ({
      id,
      name,
      ...liveOf(row.navigationEndpoint?.watchEndpoint?.videoId)
    })),
    airings: stations.flatMap(({ row, id }) =>
      Arr.flatMap(row.airings ?? [], ({ epgAiringRenderer: airing }) =>
        Option.all({
          title: Option.fromNullishOr(airing?.title?.runs[0].text),
          begin: Option.flatMap(Option.fromNullishOr(airing), (listed) => decodeBegin(listed.beginTimeMs)),
          end: Option.flatMap(Option.fromNullishOr(airing), (listed) => decodeEnd(listed.endTimeMs))
        }).pipe(
          Option.map(({ title, begin, end }) => ({
            channel: id,
            title,
            begin: DateTime.makeUnsafe(begin),
            end: DateTime.makeUnsafe(end)
          })),
          Option.toArray
        )
      )
    )
  }
}

// Encoded, an id that is not one fails the address's pattern instead of smuggling in a query.
function liveOf(videoId: string | undefined) {
  return Option.fromNullishOr(videoId).pipe(
    Option.flatMap((id) =>
      decodeLiveChannelUrlOption(`https://tv.youtube.com/watch/${encodeURIComponent(id)}`)
    ),
    Option.match({ onNone: () => ({}), onSome: (url) => ({ live: { _tag: "WebView" as const, url } }) })
  )
}
