import {
  type ChannelCarriage,
  ChannelLineup,
  ChannelUrlRefused,
  type SourceName
} from "@sportal/domain/Channel"
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
import { ChannelStore } from "../ChannelStore.ts"
import { Source } from "../Source.ts"
import * as YouTubeTvPayload from "./YouTubeTvPayload.ts"

/**
 * YouTube TV as a source. Its guide, read by the shell from the guide page, says where each game airs while
 * it is fresh; until one is read, and once the last one is stale, the channels the user has picked by hand,
 * kept in the channel store, do.
 */
export const layer = Layer.effect(
  Source,
  Effect.gen(function* () {
    const store = yield* ChannelStore
    // At most one fiber waiting to retire the latest guide; a newer read replaces it.
    const expiry = yield* FiberHandle.make<void>()
    // One ref for both, so a single subscription sees every change: the lineup, and the latest guide read.
    const state = yield* SubscriptionRef.make({
      lineup: new ChannelLineup({ source, guide, carriages: yield* store.carriages }),
      read: Option.none<Guide>()
    })

    // Store first, then memory, one write at a time: a failed write changes nothing.
    const record = (carriage: ChannelCarriage) =>
      SubscriptionRef.updateEffect(state, (current) =>
        store.record(carriage).pipe(Effect.as({ ...current, lineup: current.lineup.record(carriage) }))
      )

    return Source.of({
      availability: Effect.gen(function* () {
        const { lineup, read } = yield* SubscriptionRef.get(state)
        const now = yield* DateTime.now
        const fresh = Option.filter(read, (current) =>
          DateTime.isLessThan(now, DateTime.addDuration(current.readAt, staleAfter))
        )
        return (game: GameSnapshot) =>
          Option.match(fresh, {
            onNone: () => lineup.availabilityOf(game),
            onSome: (current) => current.availabilityOf(game)
          })
      }),
      // The ref's current value comes first on every subscription; only later values are changes.
      changes: SubscriptionRef.changes(state).pipe(Stream.drop(1), Stream.as(undefined)),
      readGuide: (response) =>
        Effect.gen(function* () {
          const decoded = yield* decodeGuide(response).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("YouTubeTv: a guide response did not decode", error.message)
            ),
            Effect.mapError(() => new GuideUnreadable())
          )
          const read = new Guide({ source, readAt: yield* DateTime.now, ...decoded })
          if (read.channels.length === 0) {
            yield* Effect.logWarning("YouTubeTv: a guide response listed no channels")
            return yield* Effect.fail(new GuideUnreadable())
          }
          yield* Effect.logInfo(
            `YouTubeTv: read a guide of ${read.channels.length} channels and ${read.airings.length} airings`
          )
          yield* SubscriptionRef.update(state, (current) => ({ ...current, read: Option.some(read) }))
          // Retire this guide once it is stale, unless a newer one has replaced it, so tiles fall back too.
          yield* FiberHandle.run(
            expiry,
            Effect.sleep(staleAfter).pipe(
              Effect.andThen(
                SubscriptionRef.updateSome(state, (current) =>
                  Option.exists(current.read, (latest) => latest === read)
                    ? Option.some({ ...current, read: Option.none<Guide>() })
                    : Option.none()
                )
              )
            )
          )
        }),
      learn: (network, url) =>
        decodeLiveChannelUrl(url).pipe(
          Effect.mapError(() => new ChannelUrlRefused()),
          Effect.flatMap((live) =>
            record({
              _tag: "Carried",
              network,
              channel: { name: network, source, locator: { _tag: "WebView", url: live } }
            })
          )
        ),
      markNotCarried: (network) => record({ _tag: "NotCarried", network, source }),
      forget: (network) =>
        SubscriptionRef.updateEffect(state, (current) =>
          store
            .forget(network, source)
            .pipe(Effect.as({ ...current, lineup: current.lineup.forget(network) }))
        )
    })
  })
)

/**
 * A YouTube TV channel address, decoded to the address that plays the channel live. A guide pick can
 * carry a start point ("from the beginning"); keeping it would replay every later game on the channel
 * from that moment, so decoding keeps only the channel's id and the live flag.
 * @testonly
 */
export const LiveChannelUrl = Schema.String.pipe(
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
 * channel that has moved on, so the lineup answers until the next read.
 */
const staleAfter = Duration.minutes(45)

const decodeLiveChannelUrl = Schema.decodeEffect(LiveChannelUrl)

const source: SourceName = "YouTube TV"

const guide = { _tag: "WebView", url: "https://tv.youtube.com/live" } as const

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
