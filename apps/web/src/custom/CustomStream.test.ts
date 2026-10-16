import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import { CustomStream } from "./CustomStream.ts"

describe("CustomStream.parse", () => {
  it.each(["youtube.com", "www.youtube.com", "m.youtube.com"])(
    "should read a watch address on %s as its video",
    (host) => {
      const target = targetOf(`https://${host}/watch?v=dQw4w9WgXcQ`)

      assert.deepStrictEqual(target, { _tag: "Video", videoId: "dQw4w9WgXcQ" })
    }
  )

  it("should read a youtu.be address as its video", () => {
    const target = targetOf("https://youtu.be/dQw4w9WgXcQ")

    assert.deepStrictEqual(target, { _tag: "Video", videoId: "dQw4w9WgXcQ" })
  })

  it("should read a live address as its video", () => {
    const target = targetOf("https://www.youtube.com/live/jfKfPfyJRdk")

    assert.deepStrictEqual(target, { _tag: "Video", videoId: "jfKfPfyJRdk" })
  })

  it("should read a shorts address as its video", () => {
    const target = targetOf("https://www.youtube.com/shorts/aqz-KE-bpKQ")

    assert.deepStrictEqual(target, { _tag: "Video", videoId: "aqz-KE-bpKQ" })
  })

  it("should read an embed address as its video", () => {
    const target = targetOf("https://www.youtube.com/embed/dQw4w9WgXcQ")

    assert.deepStrictEqual(target, { _tag: "Video", videoId: "dQw4w9WgXcQ" })
  })

  it("should read a playlist address as the playlist from its start", () => {
    const target = targetOf("https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG")

    assert.deepStrictEqual(target, { _tag: "Playlist", listId: "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG" })
  })

  it("should read a watch address with a list as the playlist from that video", () => {
    const target = targetOf(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"
    )

    assert.deepStrictEqual(target, {
      _tag: "Playlist",
      listId: "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG",
      videoId: "dQw4w9WgXcQ"
    })
  })

  it("should read a playlist's own watch address, with no video, as the playlist", () => {
    const target = targetOf("https://www.youtube.com/watch?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG")

    assert.deepStrictEqual(target, { _tag: "Playlist", listId: "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG" })
  })

  it("should read the embedded player's playlist address as the playlist", () => {
    const target = targetOf(
      "https://www.youtube.com/embed/videoseries?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"
    )

    assert.deepStrictEqual(target, { _tag: "Playlist", listId: "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG" })
  })

  it("should read an address pasted without its scheme", () => {
    const target = targetOf("youtu.be/dQw4w9WgXcQ")

    assert.deepStrictEqual(target, { _tag: "Video", videoId: "dQw4w9WgXcQ" })
  })

  it("should name a video with no name given YouTube video", () => {
    const stream = parsed("https://youtu.be/dQw4w9WgXcQ")

    assert.strictEqual(stream.name, "YouTube video")
  })

  it("should name a playlist with only a blank name given YouTube playlist", () => {
    const stream = parsed("https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG", "  ")

    assert.strictEqual(stream.name, "YouTube playlist")
  })

  it("should keep the name given, trimmed", () => {
    const stream = parsed("https://youtu.be/dQw4w9WgXcQ", " Week 6 recap ")

    assert.strictEqual(stream.name, "Week 6 recap")
  })

  it("should give one video the same id whichever address names it", () => {
    const short = parsed("https://youtu.be/dQw4w9WgXcQ")

    const watch = parsed("https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42")

    assert.strictEqual(short.id, watch.id)
  })

  it("should give a playlist from a video another id than the playlist from its start", () => {
    const start = parsed("https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG")

    const fromVideo = parsed(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"
    )

    assert.notStrictEqual(start.id, fromVideo.id)
  })

  it.each(["https://vimeo.com/76979871", "https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ"])(
    "should refuse an address off YouTube: %s",
    (url) => {
      const refusal = refused(url)

      assert.deepStrictEqual(refusal?._tag, "NotYouTube")
    }
  )

  it.each(["https://www.youtube.com/watch", "https://www.youtube.com/@NFL", "https://youtu.be/short"])(
    "should refuse a YouTube address with no video or playlist id: %s",
    (url) => {
      const refusal = refused(url)

      assert.deepStrictEqual(refusal?._tag, "NotYouTube")
    }
  )

  it("should say which address it refused", () => {
    const refusal = refused("not an address")

    assert.strictEqual(refusal?.url, "not an address")
  })
})

describe("CustomStream#watchUrl", () => {
  it("should be a video's watch page", () => {
    const url = parsed("https://youtu.be/dQw4w9WgXcQ").watchUrl()

    assert.strictEqual(url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
  })

  it("should be a playlist's watch page from its start", () => {
    const url = parsed("https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG").watchUrl()

    assert.strictEqual(url, "https://www.youtube.com/watch?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG")
  })

  it("should be a playlist's watch page from its video", () => {
    const url = parsed(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"
    ).watchUrl()

    assert.strictEqual(
      url,
      "https://www.youtube.com/watch?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG&v=dQw4w9WgXcQ"
    )
  })

  it("should read back as the same stream", () => {
    const stream = parsed(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG",
      "Recap"
    )

    const again = parsed(stream.watchUrl(), stream.name)

    assert.deepStrictEqual(again, stream)
  })
})

describe("CustomStream#embedUrl", () => {
  it("should be a video's embedded player", () => {
    const url = parsed("https://youtu.be/dQw4w9WgXcQ").embedUrl()

    assert.strictEqual(url, "https://www.youtube.com/embed/dQw4w9WgXcQ")
  })

  it("should be a playlist's embedded player", () => {
    const url = parsed(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"
    ).embedUrl()

    assert.strictEqual(
      url,
      "https://www.youtube.com/embed/videoseries?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"
    )
  })
})

describe("CustomStream#locator", () => {
  it("should be a web view at the watch page", () => {
    const stream = parsed("https://youtu.be/dQw4w9WgXcQ")

    const locator = stream.locator()

    assert.deepStrictEqual(locator, { _tag: "WebView", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" })
  })
})

function parsed(url: string, name?: string) {
  return Result.getOrThrow(CustomStream.parse(url, name))
}

function targetOf(url: string) {
  return parsed(url).target
}

function refused(url: string) {
  const result = CustomStream.parse(url)
  return Result.isFailure(result) ? result.failure : undefined
}
