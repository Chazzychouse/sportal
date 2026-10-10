import { readFileSync } from "node:fs"
import { GameId } from "@sportal/domain/Game"
import { Deferred, Effect, HashMap, Layer, Option, Schema, Stream, SubscriptionRef } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { FastCast, type Wanted } from "./FastCast.ts"
import * as FastCastMessage from "./FastCastMessage.ts"
import { Frame } from "./Frame.ts"
import { Topic } from "./Topic.ts"

/**
 * One open socket that answers the handshake and each subscription as FastCast does, recording each frame the client
 * sends; the test sends the rest and closes it. Each socket the client opens is this one again.
 */
export function fakeServer() {
  const listeners = new Set<{
    readonly type: string
    readonly listener: (event: Socket.WebSocketEvent) => void
  }>()
  const sent = watched<Sent>()
  const emit = (type: string, event: Socket.WebSocketEvent) =>
    [...listeners]
      .filter((entry) => entry.type === type)
      .forEach((entry) => {
        entry.listener(event)
      })
  const send = (data: object) => emit("message", { data: JSON.stringify(data) })
  const socket: Socket.WebSocketLike = {
    readyState: 1,
    addEventListener: (type, listener) => {
      listeners.add({ type, listener })
    },
    removeEventListener: (type, listener) =>
      [...listeners]
        .filter((entry) => entry.type === type && entry.listener === listener)
        .forEach((entry) => {
          listeners.delete(entry)
        }),
    close: () => {},
    send: (data) => {
      const frame = decodeSent(String(data))
      if (frame.op === "C") send({ hbi: 30, rc: 200, sid: "sid-1", op: "C" })
      if (frame.op === "S") send({ rc: 200, sid: frame.sid, tc: frame.tc, op: "S" })
      // Recorded after the answer, so a test waiting on this frame sends what follows after it.
      sent.add(frame)
    }
  }
  return {
    socket,
    sent,
    send,
    sendText: (data: string) => emit("message", { data }),
    close: (code: number) => emit("close", { code, reason: "" })
  }
}

/**
 * Values as they arrive, and `until`, which waits for the first moment they satisfy a condition and gives them as
 * they are then.
 */
export function watched<A>() {
  const values: Array<A> = []
  const waiting = new Set<{
    readonly satisfied: (all: ReadonlyArray<A>) => boolean
    readonly done: Deferred.Deferred<void>
  }>()
  return {
    add: (value: A) => {
      values.push(value)
      ;[...waiting]
        .filter((waiter) => waiter.satisfied(values))
        .forEach((waiter) => {
          waiting.delete(waiter)
          Deferred.doneUnsafe(waiter.done, Effect.void)
        })
    },
    all: (): ReadonlyArray<A> => [...values],
    until: (satisfied: (all: ReadonlyArray<A>) => boolean): Effect.Effect<ReadonlyArray<A>> =>
      Effect.suspend(() => {
        if (satisfied(values)) return Effect.succeed([...values])
        const done = Deferred.makeUnsafe<void>()
        waiting.add({ satisfied, done })
        return Deferred.await(done).pipe(Effect.map(() => [...values]))
      })
  }
}

/** Whether `tc` has been subscribed to at least `times` times among what a client `sent`. */
export function subscribed(tc: string, times: number) {
  return (sent: ReadonlyArray<Sent>) =>
    sent.filter((frame) => frame.op === "S" && frame.tc === tc).length >= times
}

/**
 * Runs FastCast's frames over `server` in a fiber of its own, told to follow the NFL game `main` until `want` says
 * otherwise, collecting them into `frames` and completing `ended` if they ever end.
 */
export function nflFrames(server: ReturnType<typeof fakeServer>) {
  return framesOver(fastCastHost(server))
}

/**
 * Runs FastCast's frames over `host` in a fiber of its own, told to follow the NFL game `main` until `want` says
 * otherwise, collecting them into `frames` and completing `ended` if they ever end.
 */
export function framesOver(host: Layer.Layer<HttpClient.HttpClient | Socket.WebSocketConstructor>) {
  return Effect.gen(function* () {
    const ended = yield* Deferred.make<void>()
    const frames = watched<Frame>()
    const wanted = yield* SubscriptionRef.make(wantedOf([main, "AwaitingCheckpoint"]))
    const running = yield* FastCast

    yield* running.follow(SubscriptionRef.changes(wanted)).pipe(
      Stream.runForEach((frame) => Effect.sync(() => frames.add(frame))),
      Deferred.into(ended),
      Effect.forkChild({ startImmediately: true })
    )
    const want = (...entries: ReadonlyArray<readonly [Topic, HashMap.HashMap.Value<Wanted>]>) =>
      SubscriptionRef.set(wanted, wantedOf(...entries))
    return { ended, frames, want }
  }).pipe(Effect.provide(FastCast.layer.pipe(Layer.provide(host))))
}

/** ESPN's host, whose every socket is already closed when it opens, and each address a socket was opened at. */
export function closedSockets() {
  const opened = watched<string>()
  const closed: Socket.WebSocketLike = {
    readyState: 3,
    addEventListener: () => {},
    removeEventListener: () => {},
    close: () => {},
    send: () => {}
  }
  const host = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, espn),
    Layer.succeed(Socket.WebSocketConstructor, (url) => {
      opened.add(url)
      return closed
    })
  )
  return { opened, host }
}

/** The first game of the recorded checkpoint, live: FastCast follows its topic from the start. */
export const firstGame = "401872971"

/** The NFL game topic followed from the start, and any NFL game's. */
export const gameOf = (game: string) => new Topic({ league: "nfl", game: GameId.make(game) })
export const main = gameOf(firstGame)
export const mainTc = gameTopic(firstGame)

export function gameTopic(game: string) {
  return `gp-football-nfl-${game}`
}

/** The recorded game package's checkpoint, at `mid`. */
export function checkpointMessage(mid: number) {
  return { op: "H", tc: mainTc, mid, pl: `https://checkpoint.test/${mid}` }
}

/** A `P` at `mid` whose patches are base64, but not zlib-deflated. */
export function undecodablePatchMessage(mid: number) {
  const pl = Buffer.from("not deflated").toString("base64")
  return { op: "P", tc: mainTc, mid, pl: JSON.stringify({ ts: 1791136341731, pl }) }
}

export const ariAtNygPlays = "gp-football-nfl-401872966"
export const neAtBufPlays = "gp-football-nfl-401872971"

// Recorded from ESPN on 2026-10-04 on BUF at NE's game topic: the two plays its messages 819–822 patch, as they stood
// after message 818, and those messages as the recorder kept them. Message 819 opens with a `move` outside the plays.
export const moveRecording = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      checkpoint: Schema.Struct({ mid: Schema.Int, body: Schema.Json }),
      messages: Schema.Array(
        Schema.Struct({
          op: Schema.String,
          tc: Schema.String,
          mid: Schema.Int,
          ts: Schema.Finite,
          pl: Schema.String
        })
      )
    })
  )
)(readFileSync(new URL("./fixtures/nfl-gp-move-2026-10-04.json", import.meta.url), "utf8"))

const checkpointBody = JSON.stringify(moveRecording.checkpoint.body)

/** The recorded checkpoint's document, as a checkpoint frame holds it. */
export const checkpointDocument = Schema.decodeSync(FastCastMessage.Checkpoint)(checkpointBody)

/** A checkpoint frame of `document` on `tc`, at `mid`. */
export function checkpoint(tc: string, mid: number, document: unknown): Frame {
  const decoded = Schema.decodeSync(FastCastMessage.Checkpoint)(JSON.stringify(document))
  return Frame.Checkpoint({ topic: topicNamed(tc), mid, document: decoded })
}

/** A `P` on `tc`, its patches sent as an array, one of the three ways FastCast spells them. */
export function message(tc: string, mid: number, patches: ReadonlyArray<object>): Frame {
  const pl = JSON.stringify({ ts: 1791136341731, pl: patches })
  return Frame.Pushed({
    topic: Topic.fromTc(tc),
    mid: Option.some(mid),
    envelope: decodeEnvelope(JSON.stringify({ op: "P", tc, mid, pl }))
  })
}

/** The topic `tc` names; a test names only real ones. */
export function topicNamed(tc: string): Topic {
  return Option.getOrThrow(Topic.fromTc(tc))
}

/** NE at BUF's game topic synced at the recorded checkpoint, message 818. */
export function neAtBufCheckpoint(): Frame {
  return checkpoint(neAtBufPlays, moveRecording.checkpoint.mid, moveRecording.checkpoint.body)
}

/** A patch and an idle message on NE at BUF's game topic, before any checkpoint. */
export function beforeAnyCheckpoint(): ReadonlyArray<Frame> {
  const idle = Frame.Pushed({
    topic: Topic.fromTc(neAtBufPlays),
    mid: Option.some(820),
    envelope: decodeEnvelope(JSON.stringify({ op: "I", tc: neAtBufPlays, mid: 820 }))
  })
  return [textReplaced(819), idle]
}

/** A patch on NE at BUF's game topic that sets its penalty play's text. */
export function textReplaced(mid: number) {
  return message(neAtBufPlays, mid, [
    { op: "replace", path: "/entities/plays/401872971792/text", value: "Corrected" }
  ])
}

/** A patch on NE at BUF's game topic that will not apply: it has no such play. */
export function unapplicablePatch(mid: number) {
  return message(neAtBufPlays, mid, [
    { op: "replace", path: "/entities/plays/no-such-play/text", value: "Corrected" }
  ])
}

/** A message on NE at BUF's game topic that does not decode: FastCast sends no `test` op. */
export function undecodablePatch(mid: number) {
  return message(neAtBufPlays, mid, [{ op: "test", path: "/entities/plays", value: {} }])
}

/** BUF at NE's recorded checkpoint and the messages after it, as FastCast frames. */
export function moveRecordingFrames(): ReadonlyArray<Frame> {
  const messages = moveRecording.messages.map(
    ({ op, tc, mid, ts, pl }): Frame =>
      Frame.Pushed({
        topic: Topic.fromTc(tc),
        mid: Option.some(mid),
        envelope: decodeEnvelope(JSON.stringify({ op, tc, mid, pl: JSON.stringify({ ts, pl }) }))
      })
  )
  return [neAtBufCheckpoint(), ...messages]
}

/** A frame a FastCast client sends: its op, and the session and topic it names, if any. */
export const Sent = Schema.Struct({
  op: Schema.String,
  sid: Schema.optionalKey(Schema.String),
  tc: Schema.optionalKey(Schema.String)
})
export type Sent = typeof Sent.Type

/** A wanted set of `entries`. */
function wantedOf(...entries: ReadonlyArray<readonly [Topic, HashMap.HashMap.Value<Wanted>]>): Wanted {
  return HashMap.fromIterable(entries)
}

function fastCastHost(server: ReturnType<typeof fakeServer>) {
  return Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, espn),
    Layer.succeed(Socket.WebSocketConstructor, () => server.socket)
  )
}

// FastCast's host lookup, and any checkpoint, which is the recorded one, except a missing one, one that is not a game
// package, one that never comes, and a recorded or missing one that comes after 5 s.
const espn = HttpClient.make((request) => {
  const url = new URL(request.url)
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      url.pathname.endsWith("websockethost")
        ? new Response(JSON.stringify({ ip: "fastcast.test", securePort: 443, token: "token" }))
        : url.pathname === "/missing" || url.pathname === "/slow-missing"
          ? new Response("Not Found", { status: 404 })
          : url.pathname === "/garbled"
            ? new Response(JSON.stringify({ entities: "not a game package" }))
            : new Response(checkpointBody)
    )
  ).pipe(
    Effect.andThen((response) =>
      url.pathname === "/hang"
        ? Effect.never
        : url.pathname === "/slow" || url.pathname === "/slow-missing"
          ? Effect.sleep("5 seconds").pipe(Effect.as(response))
          : Effect.succeed(response)
    )
  )
})

const decodeSent = Schema.decodeUnknownSync(Schema.fromJsonString(Sent))

const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(FastCastMessage.Envelope))
