import type { SourceName } from "@sportal/domain/Channel"
import { Array as Arr, DateTime, Option, Schema, SchemaGetter, SchemaTransformation } from "effect"
import { ChannelId, Guide } from "../Guide.ts"
import * as YouTubeTvPayload from "./YouTubeTvPayload.ts"

/** YouTube TV, as its guide names it. Its guide's responses are read here as the channels and airings they list. */
export const source: SourceName = "YouTube TV"

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
        Option.fromNullishOr(airing).pipe(
          Option.flatMap((listed) =>
            Option.all({
              title: Option.fromNullishOr(listed.title?.runs[0].text),
              begin: decodeBegin(listed.beginTimeMs),
              end: decodeEnd(listed.endTimeMs)
            })
          ),
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

/** A guide response as the channels and airings it lists. */
export const decode = Schema.decodeEffect(GuideListing)

const decodeLiveChannelUrlOption = Schema.decodeOption(LiveChannelUrl)

const decodeBegin = Schema.decodeOption(Schema.FiniteFromString.check(Schema.isGreaterThanOrEqualTo(0)))
const decodeEnd = Schema.decodeOption(Schema.FiniteFromString)
