import { Schema } from "effect"

const Text = Schema.Struct({ runs: Schema.NonEmptyArray(Schema.Struct({ text: Schema.String })) })

const Row = Schema.Struct({
  station: Schema.optional(
    Schema.Struct({
      epgStationRenderer: Schema.Struct({
        stationId: Schema.optional(Schema.NullOr(Schema.String)),
        icon: Schema.optional(
          Schema.Struct({
            accessibility: Schema.optional(
              Schema.NullOr(Schema.Struct({ accessibilityData: Schema.Struct({ label: Schema.String }) }))
            )
          })
        )
      })
    })
  ),
  // The station's live channel, present while the station is on the air.
  navigationEndpoint: Schema.optional(
    Schema.Struct({ watchEndpoint: Schema.optional(Schema.Struct({ videoId: Schema.String })) })
  ),
  airings: Schema.optional(
    Schema.Array(
      Schema.Struct({
        epgAiringRenderer: Schema.optional(
          Schema.Struct({
            beginTimeMs: Schema.String,
            endTimeMs: Schema.String,
            title: Schema.optional(Schema.NullOr(Text))
          })
        )
      })
    )
  )
})

/** The first page of YouTube TV's live guide, as the guide page loads it (`browse`, `FEunplugged_epg`). */
export const GuideResponse = Schema.Struct({
  contents: Schema.Struct({
    epgRenderer: Schema.Struct({
      paginationRenderer: Schema.Struct({
        epgPaginationRenderer: Schema.Struct({
          contents: Schema.Array(Schema.Struct({ epgRowRenderer: Schema.optional(Row) }))
        })
      })
    })
  })
})

export const GuideResponseJson = Schema.fromJsonString(GuideResponse)
