import { type ChannelCarriage, ChannelLineup, ChannelUrlRefused } from "@sportal/domain/Channel"
import type { GameSnapshot } from "@sportal/domain/Game"
import { type Airing, ChannelId, Guide, GuideUnreadable } from "@sportal/domain/Guide"
import {
  DateTime,
  Duration,
  Effect,
  FiberHandle,
  Layer,
  Option,
  Schema,
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
      lineup: new ChannelLineup({ source: "YouTube TV", guide, carriages: yield* store.carriages }),
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
          const read = toGuide(decoded, yield* DateTime.now)
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
              channel: { name: network, source: "YouTube TV", locator: { _tag: "WebView", url: live } }
            })
          )
        ),
      markNotCarried: (network) => record({ _tag: "NotCarried", network, source: "YouTube TV" }),
      forget: (network) =>
        SubscriptionRef.updateEffect(state, (current) =>
          store
            .forget(network, "YouTube TV")
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

const guide = { _tag: "WebView", url: "https://tv.youtube.com/live" } as const

const decodeGuide = Schema.decodeEffect(YouTubeTvPayload.GuideResponseJson)

const decodeLiveChannelUrlOption = Schema.decodeOption(LiveChannelUrl)

/**
 * The channels and airings of one guide response, read at `readAt`. Rows without an id or a name are skipped;
 * a row whose live id is not a channel id keeps its channel without a live address.
 */
function toGuide(response: typeof YouTubeTvPayload.GuideResponse.Type, readAt: DateTime.Utc): Guide {
  const channels: Array<Guide["channels"][number]> = []
  const airings: Array<Airing> = []
  for (const { epgRowRenderer: row } of response.contents.epgRenderer.paginationRenderer.epgPaginationRenderer
    .contents) {
    const station = row?.station?.epgStationRenderer
    const id = station?.stationId
    const name = station?.icon?.accessibility?.accessibilityData.label
    if (row === undefined || id === undefined || id === null || name === undefined) continue
    const channel = ChannelId.make(id)
    const videoId = row.navigationEndpoint?.watchEndpoint?.videoId
    // Encoded, an id that is not one fails the address's pattern instead of smuggling in a query.
    const live =
      videoId === undefined
        ? Option.none()
        : decodeLiveChannelUrlOption(`https://tv.youtube.com/watch/${encodeURIComponent(videoId)}`)
    channels.push({
      id: channel,
      name,
      ...Option.match(live, {
        onNone: () => ({}),
        onSome: (url) => ({ live: { _tag: "WebView" as const, url } })
      })
    })
    for (const { epgAiringRenderer: airing } of row.airings ?? []) {
      const title = airing?.title?.runs[0].text
      const begin = Number(airing?.beginTimeMs)
      const end = Number(airing?.endTimeMs)
      // A row with nothing listed has one untitled airing spanning all of time.
      if (title === undefined || !Number.isFinite(begin) || begin < 0 || !Number.isFinite(end)) continue
      airings.push({ channel, title, begin: DateTime.makeUnsafe(begin), end: DateTime.makeUnsafe(end) })
    }
  }
  return new Guide({ source: "YouTube TV", readAt, channels, airings })
}
