import { Cause, Effect, Stream } from "effect"

/**
 * Gzip for the bodies the feed log stores and the recordings Scenarios reads, and the zlib-deflated patches
 * FastCast sends: the web `CompressionStream` and `DecompressionStream`, as Effect streams. Each fails with an
 * `UnknownError` when the bytes cannot be compressed or read.
 */

/** `text` as gzip'd UTF-8 bytes. */
export const compress = Effect.fnUntraced(function* (text: string) {
  return yield* Stream.mkUint8Array(
    through(Stream.make(new TextEncoder().encode(text)), () => new CompressionStream("gzip"))
  )
})

/** The text a gzip'd or zlib-deflated body holds. */
export const decompress = Effect.fnUntraced(function* (bytes: Uint8Array, format: "gzip" | "deflate") {
  return yield* Stream.mkString(decompressStream(Stream.make(bytes), format))
})

/** The text gzip'd or zlib-deflated `bytes` hold, as they are read; a failure of `bytes` is the error's cause. */
export function decompressStream<E>(
  bytes: Stream.Stream<Uint8Array, E>,
  format: "gzip" | "deflate"
): Stream.Stream<string, Cause.UnknownError> {
  return through(bytes, () => new DecompressionStream(format)).pipe(Stream.decodeText)
}

function through<E>(
  bytes: Stream.Stream<Uint8Array, E>,
  transform: () => CompressionStream | DecompressionStream
) {
  return Stream.fromReadableStream({
    evaluate: () => Stream.toReadableStream(bytes).pipeThrough(transform()),
    onError: (cause) => new Cause.UnknownError(cause, "A body could not be compressed or read back")
  })
}
