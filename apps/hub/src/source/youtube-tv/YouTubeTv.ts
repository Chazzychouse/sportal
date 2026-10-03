import type { GameSnapshot } from "@sportal/domain/Game"
import {
  type Airing,
  type ChannelCarriage,
  ChannelId,
  ChannelLineup,
  ChannelUrlRefused,
  Guide,
  GuideUnreadable
} from "@sportal/domain/Source"
import {
  DateTime,
  Effect,
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
 * YouTube TV as a source. Its guide, read by the shell from the guide page, says where each game airs; until
 * one is read, the channels the user has picked by hand, kept in the channel store, do.
 */
export const layer = Layer.effect(
  Source,
  Effect.gen(function* () {
    const store = yield* ChannelStore
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
      availability: SubscriptionRef.get(state).pipe(
        Effect.map(
          ({ lineup, read }) =>
            (game: GameSnapshot) =>
              Option.match(read, {
                onNone: () => lineup.availabilityOf(game),
                onSome: (current) => current.availabilityOf(game)
              })
        )
      ),
      // The ref's current value comes first on every subscription; only later values are changes.
      changes: SubscriptionRef.changes(state).pipe(Stream.drop(1), Stream.as(undefined)),
      readGuide: (response) =>
        Effect.gen(function* () {
          const decoded = yield* decodeGuide(response).pipe(Effect.mapError(() => new GuideUnreadable()))
          const read = toGuide(decoded, yield* DateTime.now)
          if (read.channels.length === 0) return yield* Effect.fail(new GuideUnreadable())
          yield* SubscriptionRef.update(state, (current) => ({ ...current, read: Option.some(read) }))
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
 */
export const LiveChannelUrl = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^https:\/\/tv\.youtube\.com\/watch\/[A-Za-z0-9_-]+(\?.*)?$/)),
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (url) => `https://tv.youtube.com${new URL(url).pathname}?vp=${live}`,
      encode: (url) => url
    })
  )
)

const decodeLiveChannelUrl = Schema.decodeEffect(LiveChannelUrl)

const live = "0gEEEgIwAQ%3D%3D"

const guide = { _tag: "WebView", url: "https://tv.youtube.com/live" } as const

const decodeGuide = Schema.decodeEffect(YouTubeTvPayload.GuideResponseJson)

/** The channels and airings of one guide response, read at `readAt`. Rows without an id or a name are skipped. */
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
    channels.push({
      id: channel,
      name,
      ...(videoId === undefined
        ? {}
        : { live: { _tag: "WebView" as const, url: `https://tv.youtube.com/watch/${videoId}?vp=${live}` } })
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
