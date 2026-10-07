import { Cause, Effect, Stream } from "effect"

/**
 * Gzip for the bodies the feed log stores and the recordings the importer writes, and the zlib-deflated patches
 * FastCast sends: the web `CompressionStream` and `DecompressionStream`, as Effect streams. Both fail with an
 * `UnknownError` when the bytes cannot be compressed or read.
 */

/** `text` as gzip'd UTF-8 bytes. */
export const compress = Effect.fnUntraced(function* (text: string) {
  return yield* Stream.mkUint8Array(
    through(new TextEncoder().encode(text), () => new CompressionStream("gzip"))
  )
})

/** The text a gzip'd or zlib-deflated body holds. */
export const decompress = Effect.fnUntraced(function* (bytes: Uint8Array, format: "gzip" | "deflate") {
  return yield* through(bytes, () => new DecompressionStream(format)).pipe(Stream.decodeText, Stream.mkString)
})

function through(bytes: Uint8Array, transform: () => CompressionStream | DecompressionStream) {
  return Stream.fromReadableStream({
    evaluate: () => Stream.toReadableStream(Stream.make(bytes)).pipeThrough(transform()),
    onError: (cause) => new Cause.UnknownError(cause, "A body could not be compressed or read back")
  })
}
