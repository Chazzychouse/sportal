import { Cause, type Effect, Stream } from "effect"

/**
 * Gzip for the bodies the feed log stores and the recordings the importer writes: the web `CompressionStream` and
 * `DecompressionStream`, as Effect streams. Both fail with an `UnknownError` when the bytes cannot be gzip'd or read.
 */

/** `text` as gzip'd UTF-8 bytes. */
export function compress(text: string): Effect.Effect<Uint8Array, Cause.UnknownError> {
  return Stream.mkUint8Array(through(new TextEncoder().encode(text), () => new CompressionStream("gzip")))
}

/** The text a gzip'd body holds. */
export function decompress(bytes: Uint8Array): Effect.Effect<string, Cause.UnknownError> {
  return through(bytes, () => new DecompressionStream("gzip")).pipe(Stream.decodeText, Stream.mkString)
}

function through(bytes: Uint8Array, transform: () => CompressionStream | DecompressionStream) {
  return Stream.fromReadableStream({
    evaluate: () => Stream.toReadableStream(Stream.make(bytes)).pipeThrough(transform()),
    onError: (cause) => new Cause.UnknownError(cause, "A body could not be gzip'd or read back")
  })
}
