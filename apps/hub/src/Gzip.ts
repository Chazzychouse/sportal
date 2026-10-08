import { Cause, Effect, Stream } from "effect"

/**
 * The text a gzip'd or zlib-deflated body holds, read with the web `DecompressionStream`; FastCast's patches are
 * deflated. Fails with an `UnknownError` when the bytes cannot be read.
 */
export const decompress = Effect.fnUntraced(function* (bytes: Uint8Array, format: "gzip" | "deflate") {
  const text = Stream.fromReadableStream({
    evaluate: () => Stream.toReadableStream(Stream.make(bytes)).pipeThrough(new DecompressionStream(format)),
    onError: (cause) => new Cause.UnknownError(cause, "A body could not be read back")
  }).pipe(Stream.decodeText)
  return yield* Stream.mkString(text)
})
