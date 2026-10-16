import type { StreamLocator } from "@sportal/domain/Channel"
import { Result, Schema } from "effect"

/**
 * A custom stream's id, read from what it plays (`video.<id>`, `list.<id>`, or `list.<id>.<video id>`), so one video or
 * playlist is saved once however its address was written.
 */
export const CustomStreamId = Schema.String.pipe(Schema.brand("CustomStreamId"))
export type CustomStreamId = typeof CustomStreamId.Type

/** What a custom stream plays on YouTube: one video, or a playlist, from its start or from one of its videos. */
export const CustomTarget = Schema.TaggedUnion({
  Video: { videoId: Schema.String },
  Playlist: { listId: Schema.String, videoId: Schema.optionalKey(Schema.String) }
})
export type CustomTarget = typeof CustomTarget.Type

/** A YouTube video or playlist saved on this Display to watch in a tile, under the name its cards and tile show. */
export class CustomStream extends Schema.Class<CustomStream>("sportal/CustomStream")({
  id: CustomStreamId,
  name: Schema.String,
  target: CustomTarget
}) {
  /**
   * Reads a YouTube address: `youtube.com/watch?v=`, `youtu.be/<id>`, `youtube.com/live/<id>`, `youtube.com/shorts/<id>`,
   * `youtube.com/embed/<id>`, `youtube.com/playlist?list=`, or `watch?v=…&list=…` (the playlist, from that video), on
   * `www.`, `m.` or neither, with or without its scheme. With no name, or a blank one, it is "YouTube video" or "YouTube
   * playlist".
   */
  static parse(url: string, name?: string): Result.Result<CustomStream, NotYouTube> {
    const target = targetOf(url)
    if (target === undefined) return Result.fail(new NotYouTube({ url }))

    const id = CustomStreamId.make(idOf(target))
    const given = name?.trim() ?? ""
    const named = given === "" ? defaultName(target) : given
    return Result.succeed(new CustomStream({ id, name: named, target }))
  }

  /** The address the shell loads: YouTube's own watch page. */
  watchUrl(): string {
    return CustomTarget.match(this.target, {
      Video: ({ videoId }) => `https://www.youtube.com/watch?v=${videoId}`,
      Playlist: ({ listId, videoId }) =>
        `https://www.youtube.com/watch?list=${listId}${videoId === undefined ? "" : `&v=${videoId}`}`
    })
  }

  /** The address a plain browser plays in a frame: YouTube's embedded player. */
  embedUrl(): string {
    return CustomTarget.match(this.target, {
      Video: ({ videoId }) => `https://www.youtube.com/embed/${videoId}`,
      Playlist: ({ listId }) => `https://www.youtube.com/embed/videoseries?list=${listId}`
    })
  }

  /** What a custom tile carries for the shell to load: the watch page. */
  locator(): StreamLocator {
    return { _tag: "WebView", url: this.watchUrl() }
  }
}

/** An address that names no YouTube video or playlist: another site's, or a YouTube page with no id. */
export class NotYouTube extends Schema.TaggedError<NotYouTube>()("NotYouTube", { url: Schema.String }) {}

/** The video or playlist an address names; none for an address off YouTube, or naming neither. */
function targetOf(url: string): CustomTarget | undefined {
  const trimmed = url.trim()
  const address = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  if (!URL.canParse(address)) return undefined
  const { protocol, hostname, pathname, searchParams } = new URL(address)
  if (!["https:", "http:"].includes(protocol) || !youTubeHosts.includes(hostname)) return undefined

  const videoId = valid(videoIn(hostname, pathname, searchParams), videoIdForm)
  const listId = valid(searchParams.get("list") ?? undefined, listIdForm)
  if (listId !== undefined)
    return videoId === undefined ? { _tag: "Playlist", listId } : { _tag: "Playlist", listId, videoId }
  return videoId === undefined ? undefined : { _tag: "Video", videoId }
}

const youTubeHosts = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]

/** The video id where the address keeps it: youtu.be's path, `watch`'s `v`, or the segment after `live`, `shorts` or `embed`. */
function videoIn(hostname: string, pathname: string, searchParams: URLSearchParams): string | undefined {
  const [, first, second] = pathname.split("/")
  if (hostname === "youtu.be") return first
  if (first === "watch") return searchParams.get("v") ?? undefined
  // `embed/videoseries` is the embedded player's playlist page, not a video, though it is eleven letters long.
  return first !== undefined && ["live", "shorts", "embed"].includes(first) && second !== "videoseries"
    ? second
    : undefined
}

function valid(id: string | undefined, form: RegExp): string | undefined {
  return id !== undefined && form.test(id) ? id : undefined
}

const videoIdForm = /^[\w-]{11}$/
const listIdForm = /^[\w-]+$/

function idOf(target: CustomTarget): string {
  return CustomTarget.match(target, {
    Video: ({ videoId }) => `video.${videoId}`,
    Playlist: ({ listId, videoId }) =>
      videoId === undefined ? `list.${listId}` : `list.${listId}.${videoId}`
  })
}

function defaultName(target: CustomTarget): string {
  return CustomTarget.match(target, { Video: () => "YouTube video", Playlist: () => "YouTube playlist" })
}
