import { fileURLToPath } from "node:url"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import type { LeagueId } from "@sportal/domain/League"
import {
  Array as Arr,
  DateTime,
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
  SchemaGetter,
  SchemaIssue,
  Stream,
  Struct
} from "effect"
import { Command, Flag } from "effect/cli"
import { Frame } from "../feed-log/Frame.ts"
import * as Gzip from "../feed-log/Gzip.ts"
import * as FastCastMessage from "../provider/espn/FastCastMessage.ts"
import * as Recording from "./Recording.ts"

/**
 * A recorded day as frames: each `gp-` topic seeded with an empty checkpoint, its patch batches as messages, and the
 * scoreboard polls as responses, in order of receipt. `games`, when not empty, keeps only those games' topics and
 * trims each scoreboard to their events. Leaves out the scoreboard topic (deviation 5).
 *
 * Each frame is shaped as the live feeds log it: an `H` is a message and then its checkpoint, both numbered by the
 * checkpoint's mid (the recorder kept it only in the URL); a patch batch is the socket's `{ op, tc, mid, pl }` text,
 * sent at its `ts`. The recorder kept no mid for an idle message either, so it takes the one after its topic's last.
 */
export const importRecording = (options: {
  recording: string
  games: ReadonlyArray<string>
}): Stream.Stream<
  Omit<Frame, "seq">,
  ImportFailed | Recording.RecordingUnreadable,
  FileSystem.FileSystem | Path.Path
> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { join } = yield* Path.Path
      const polls = yield* Recording.polls(options.recording)
      const kept = (tc: string) =>
        Option.exists(
          FastCastMessage.owner(tc),
          (owner) =>
            owner._tag === "Game" && (options.games.length === 0 || options.games.includes(owner.game))
        )
      const response = (poll: (typeof polls)[number]) =>
        fs.readFile(poll.path).pipe(
          Effect.mapError(failed(poll.path)),
          Effect.flatMap((bytes) => Gzip.decompress(bytes, "gzip")),
          Effect.flatMap((body) =>
            options.games.length === 0 ? Effect.succeed(body) : trimmed(body, options.games)
          ),
          Effect.mapError(failed(poll.path)),
          Effect.map((body) => polled(poll.league, poll.at, body))
        )

      const socket = join(options.recording, "fastcast.jsonl")
      return fs.stream(socket).pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filter((line) => line.length > 0),
        Stream.mapEffect((line) => decodeLine(line)),
        Stream.mapError(failed(socket)),
        Stream.filter((line): line is Line => line.op !== "start" && line.op !== "C" && line.op !== "S"),
        Stream.filter((line) => kept(line.tc)),
        Stream.mapAccumEffect((): ReadonlyMap<string, number> => new Map(), framed),
        // Each poll goes in before the first socket frame received after it, and the rest after the last.
        Stream.mapAccum(
          () => polls,
          (waiting, frame) => {
            const [due, later] = Arr.span(waiting, (poll) =>
              DateTime.isLessThanOrEqualTo(poll.at, frame.receivedAt)
            )
            return [later, [...due.map(response), Effect.succeed(frame)]] as const
          },
          { onHalt: (waiting) => waiting.map(response) }
        ),
        Stream.mapEffect((next) => next)
      )
    })
  )

/** The frames an import wrote to `path`, in order. */
export function readFrames(
  path: string
): Stream.Stream<Omit<Frame, "seq">, ImportFailed, FileSystem.FileSystem> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const text = yield* (yield* FileSystem.FileSystem)
        .readFile(path)
        .pipe(Effect.flatMap((bytes) => Gzip.decompress(bytes, "gzip")))
      return Stream.fromIterable(text.split("\n").filter((line) => line.length > 0))
    }).pipe(Effect.mapError(failed(path)))
  ).pipe(Stream.mapEffect((line) => decodeReceived(line).pipe(Effect.mapError(failed(path)))))
}

/** Writes `frames` to `path` as gzip'd JSON lines, one encoded frame each, for `readFrames`. */
export function writeFrames<R>(
  frames: Stream.Stream<Omit<Frame, "seq">, ImportFailed | Recording.RecordingUnreadable, R>,
  path: string
): Effect.Effect<number, ImportFailed | Recording.RecordingUnreadable, R | FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const lines = yield* frames.pipe(
      Stream.mapEffect((frame) => encodeReceived(frame).pipe(Effect.mapError(failed(path)))),
      Stream.runCollect
    )
    const bytes = yield* Gzip.compress(lines.map((line) => `${line}\n`).join("")).pipe(
      Effect.mapError(failed(path))
    )
    yield* (yield* FileSystem.FileSystem).writeFile(path, bytes).pipe(Effect.mapError(failed(path)))
    return lines.length
  })
}

/** A recording could not be imported, and why. */
class ImportFailed extends Schema.TaggedError<ImportFailed>()("ImportFailed", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

function failed(path: string) {
  return (cause: unknown) =>
    cause instanceof ImportFailed
      ? cause
      : new ImportFailed({ reason: `${path} could not be imported`, cause })
}

// An `H`'s `pl` is its checkpoint's URL, `…/message/<mid>/checkpoint`: the recorder kept the mid only there.
const CheckpointUrl = Schema.String.pipe(
  Schema.decodeTo(Schema.Struct({ url: Schema.String, mid: Schema.Int }), {
    decode: SchemaGetter.transformEffect((url) => {
      const match = /\/message\/(\d+)\/checkpoint$/.exec(url)
      return match === null
        ? Effect.fail(new SchemaIssue.InvalidValue({ message: "Not a FastCast checkpoint URL" }, url))
        : Effect.succeed({ url, mid: Number(match[1]) })
    }),
    encode: SchemaGetter.transform(({ url }) => url)
  })
)

/** One line of the recorder's `fastcast.jsonl`: an `H`, a patch batch, an idle message, or the socket's own. */
const decodeLine = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ at: Schema.Number, op: Schema.Literal("H"), tc: Schema.String, pl: CheckpointUrl }),
      Schema.Struct({
        at: Schema.Number,
        op: Schema.Literals(["R", "P"]),
        tc: Schema.String,
        mid: Schema.Int,
        ts: Schema.optional(Schema.Number),
        pl: Schema.String
      }),
      Schema.Struct({ at: Schema.Number, op: Schema.Literal("I"), tc: Schema.String, pl: Schema.String }),
      Schema.Struct({ at: Schema.Number, op: Schema.Literals(["start", "C", "S"]) })
    ])
  )
)

type Line = Exclude<Effect.Success<ReturnType<typeof decodeLine>>, { readonly op: "start" | "C" | "S" }>

/** A line as its frames, given each topic's last mid; an idle message takes the mid after it. */
function framed(
  mids: ReadonlyMap<string, number>,
  line: Line
): Effect.Effect<readonly [ReadonlyMap<string, number>, ReadonlyArray<Omit<Frame, "seq">>], ImportFailed> {
  const receivedAt = DateTime.makeUnsafe(line.at)
  const message = (mid: number, body: object, sentAt?: DateTime.Utc) =>
    ({
      receivedAt,
      sentAt,
      sourceId: mid,
      feed: "fastcast",
      channel: line.tc,
      kind: "message",
      body: JSON.stringify(body)
    }) as const
  const following = (mid: number) => new Map([...mids, [line.tc, mid]])
  switch (line.op) {
    case "H": {
      const { url, mid } = line.pl
      const frame = message(mid, { op: line.op, tc: line.tc, mid, pl: url })
      return Effect.succeed([
        following(mid),
        [frame, { ...frame, kind: "checkpoint", body: emptyCheckpoint }]
      ])
    }
    case "R":
    case "P":
      return Effect.succeed([
        following(line.mid),
        [
          message(
            line.mid,
            { op: line.op, tc: line.tc, mid: line.mid, pl: JSON.stringify({ ts: line.ts, pl: line.pl }) },
            line.ts === undefined ? undefined : DateTime.makeUnsafe(line.ts)
          )
        ]
      ])
    case "I":
      return Option.match(Option.fromUndefinedOr(mids.get(line.tc)), {
        onNone: () =>
          Effect.fail(
            new ImportFailed({ reason: `an idle message on ${line.tc} at ${line.at} came before its H` })
          ),
        onSome: (last) =>
          Effect.succeed([
            following(last + 1),
            [message(last + 1, { op: line.op, tc: line.tc, mid: last + 1, pl: line.pl })]
          ] as const)
      })
  }
}

// The recording has no checkpoint bodies, and every game in it kicked off after the recorder subscribed (deviation 5).
const emptyCheckpoint = '{"entities":{}}'

function polled(league: LeagueId, receivedAt: DateTime.Utc, body: string): Omit<Frame, "seq"> {
  return { receivedAt, feed: "poll", channel: league, kind: "response", body }
}

/** A scoreboard with only `games`' events, the rest of it as it was. */
const Scoreboard = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({
      events: Schema.Array(
        Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [
          Schema.Record(Schema.String, Schema.Json)
        ])
      )
    }),
    [Schema.Record(Schema.String, Schema.Json)]
  )
)

function trimmed(body: string, games: ReadonlyArray<string>) {
  return Schema.decodeEffect(Scoreboard)(body).pipe(
    Effect.flatMap((scoreboard) =>
      Schema.encodeEffect(Scoreboard)({
        ...scoreboard,
        events: scoreboard.events.filter((event) => games.includes(event.id))
      })
    )
  )
}

/** A frame before the log numbers it, as one line of an import. */
const Received = Schema.fromJsonString(Schema.Struct(Struct.omit(Frame.fields, ["seq"])))
const decodeReceived = Schema.decodeEffect(Received)
const encodeReceived = Schema.encodeEffect(Received)

// As a script: pnpm --filter @sportal/hub feed:import --recording <dir> [--games id,…] --out <file.jsonl.gz>
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = Command.make(
    "feed:import",
    {
      recording: Flag.String("recording").pipe(Flag.withDescription("The recorded day's league folder")),
      games: Flag.String("games").pipe(
        Flag.withDescription("Comma-separated game ids to keep; every game when left out"),
        Flag.withDefault("")
      ),
      out: Flag.String("out").pipe(Flag.withDescription("The .jsonl.gz file to write"))
    },
    (values) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        // pnpm runs scripts in the package; relative paths are the caller's.
        const cwd = process.env.INIT_CWD ?? process.cwd()
        const out = path.resolve(cwd, values.out)
        const frames = importRecording({
          recording: path.resolve(cwd, values.recording),
          games: values.games.split(",").filter((game) => game.length > 0)
        })
        const count = yield* writeFrames(frames, out)
        const { size } = yield* (yield* FileSystem.FileSystem).stat(out)
        yield* Effect.logInfo(
          `ImportRecording: wrote ${out}: ${count} frames, ${Math.round(Number(size) / 1024)} KB`
        )
      })
  )
  Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
}
