import { Cause, Effect, Stream } from "effect"

/**
 * Reading the gzip'd recordings Scenarios reads, and the zlib-deflated patches FastCast sends: the web
 * `DecompressionStream`, as Effect streams. Each fails with an `UnknownError` when the bytes cannot be read.
 */

/** The text a gzip'd or zlib-deflated body holds. */
export const decompress = Effect.fnUntraced(function* (bytes: Uint8Array, format: "gzip" | "deflate") {
  return yield* Stream.mkString(decompressStream(Stream.make(bytes), format))
})

/** The text gzip'd or zlib-deflated `bytes` hold, as they are read; a failure of `bytes` is the error's cause. */
export function decompressStream<E>(
  bytes: Stream.Stream<Uint8Array, E>,
  format: "gzip" | "deflate"
): Stream.Stream<string, Cause.UnknownError> {
  return Stream.fromReadableStream({
    evaluate: () => Stream.toReadableStream(bytes).pipeThrough(new DecompressionStream(format)),
    onError: (cause) => new Cause.UnknownError(cause, "A body could not be read back")
  }).pipe(Stream.decodeText)
}
