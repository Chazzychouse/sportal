import { Data, Schema } from "effect"
import { KeyValueStore } from "effect/persistence"
import { Atom } from "effect/reactivity"
import { CustomStream, type CustomStreamId } from "./CustomStream.ts"

/**
 * The custom streams saved in this browser, in the order they were added. A change written to it is kept at once; a
 * kept list that does not read is an empty one.
 */
export const customStreams: Atom.Writable<ReadonlyArray<CustomStream>, CustomStreamsChange> = Atom.writable(
  (get) => get(kept),
  (ctx, change: CustomStreamsChange) => ctx.set(kept, edited(ctx.get(kept), change))
).pipe(Atom.keepAlive)

/**
 * A change to the saved custom streams: one added (last; one saved already moves there, under its new name), renamed,
 * or removed.
 */
export type CustomStreamsChange = Data.TaggedEnum<{
  Added: { readonly stream: CustomStream }
  Renamed: { readonly id: CustomStreamId; readonly name: string }
  Removed: { readonly id: CustomStreamId }
}>
export const CustomStreamsChange = Data.taggedEnum<CustomStreamsChange>()

const kept = Atom.kvs({
  runtime: Atom.runtime(KeyValueStore.layerStorage(() => localStorage)),
  key: "sportal.custom",
  schema: Schema.Array(CustomStream),
  defaultValue: (): ReadonlyArray<CustomStream> => []
}).pipe(Atom.keepAlive)

function edited(
  streams: ReadonlyArray<CustomStream>,
  change: CustomStreamsChange
): ReadonlyArray<CustomStream> {
  return CustomStreamsChange.$match(change, {
    Added: ({ stream }) => [...streams.filter((each) => each.id !== stream.id), stream],
    Renamed: ({ id, name }) =>
      streams.map((each) => (each.id === id ? new CustomStream({ ...each, name }) : each)),
    Removed: ({ id }) => streams.filter((each) => each.id !== id)
  })
}
