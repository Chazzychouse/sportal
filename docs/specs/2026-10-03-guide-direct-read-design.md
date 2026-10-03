# Guide Direct Read — Design

Date: 2026-10-03
Status: Approved 2026-10-03; spike done 2026-10-03 (section 0)
Replaces: how the guide is obtained in `docs/specs/2026-10-03-guide-matched-channels-design.md` (section 2,
the guide reader, and the re-read triggers in sections 3 and 4). The domain, the matcher, the Hub's guide
decoding, and the fallbacks there stand.

## Goal

Get a source's guide the way any client gets data: one read-only request, with no hidden page, no debugger,
and no preview playing. Keep how a guide is obtained behind the source's adapter, so the domain never knows
which source or method produced a `Guide`.

## Why the guide reader goes

| Flaw | Evidence |
| --- | --- |
| It depends on the page making one particular private call, observed from outside | The read waits for a `browse` request naming `FEunplugged_epg` to pass the debugger. Detection has failed in development, and nothing in the page promises that call keeps its shape or timing |
| Every read plays a preview | The spike counted 202 video requests in two minutes of an open guide. A read may count against the stream budget while three tiles play |
| It sees only the page's first fetch | About four hours from the current half hour, because the page asks for that much. Late FBS and night NFL games show as **Upcoming** with no channel until a later read |
| Reads are costly, so triggers are elaborate | Reads wait for the web UI's first ask, re-read a minute after a waiting airing's begin, and on reconnect, with a two-minute floor and a 30-second timeout |

## Decisions

| Question | Decision |
| --- | --- |
| How YouTube TV's guide is read | The shell sends the guide request itself (`POST /youtubei/v1/browse`, `browseId: "FEunplugged_epg"`) on the provider session, which holds the sign-in. One response covers the next 24 hours, so no continuation is requested |
| Where the request runs | In the shell. The provider session's sign-in never leaves it. The guide still reaches the Hub through the web UI, so the shell never calls the Hub |
| How fresh | When the web UI first asks (as soon as it is connected, so it is listening before a guide arrives), every 5 minutes after, and when the web UI's connection to the Hub comes back (the Hub keeps the guide in memory). The 45-minute staleness rule stands |
| What is neutral | `Guide`, `Airing`, `Channel`, and `Guide#availabilityOf` in `packages/domain`. Each source has a guide adapter: a reader in the shell, which fetches bytes, and a decoder in the Hub, which turns them into a `Guide` |
| A listings service | Not now. Schedules Direct (Gracenote listings by zip code) becomes a second guide adapter, in its own spec, when a fallback for YouTube TV's endpoint or a second channel-based source (Fubo, Hulu Live) is wanted. It does not list Sunday Ticket feeds, so it cannot replace this read |
| Streaming-only sources (Peacock, ESPN+, Prime) | Out of scope. They have no channels; each needs its own adapter that finds a game's event page |
| ADR 0002 | Amended again: see section 4 |

## 0. Spike (done 2026-10-03)

Two throwaway Electron scripts (not committed), run by hand against the signed-in provider session with the
shell closed, sent the guide request directly.

| Question | Found |
| --- | --- |
| Same payload as the guide page's? | Yes: 55 stations, 175 airings, the shape of `guide-2026-10-03T2024Z.json`, decoded by the existing `GuideResponse` |
| What the request needs | The body `{ context: INNERTUBE_CONTEXT, browseId: "FEunplugged_epg" }`, and the header `Authorization: SAPISIDHASH <ts>_<sha1("<ts> <SAPISID> https://tv.youtube.com")>` with `Origin` and `X-Origin`. Without the header: 401 `UNAUTHENTICATED`. The API key and the client name and version headers are not needed |
| Where the parts come from | `INNERTUBE_CONTEXT` (client `WEB_UNPLUGGED`, version `1.20260930.04.00`) from the `ytcfg.set({...})` config in the HTML of `GET https://tv.youtube.com/live`; `SAPISID` from the session's cookies. The session sends its own cookies |
| How far ahead one response reaches | The response's window is 24 hours from the request; 90% of its airings end within the next day. Without the page's shorter first-fetch duration, the first response already covers the slate's day |
| Continuations | Not needed. Requested with the page-1 next token, they return stations with no airings and a 0–0 window; the page adds something not reproduced, and it is not pursued |
| Sort | The guide has a per-account sort (Default, Custom, Most watched, A-Z, Z-A), kept by YouTube TV. **Custom lists only the stations the account chose**, and the response follows it. Requesting a sort's reload token changes the account's sort: the spike did this once by accident and switched the account to Custom (39 stations) |

The reader therefore sends no continuation or sort request. A guide read under the Custom sort can miss
stations; the Hub logs the station count of each guide, so a sudden drop is visible.

## 1. Desktop shell (`apps/desktop`)

**`GuideReader`**, rewritten. It keeps its name and glossary row, reworded: "The shell component that reads a
source's guide with the source's own guide request, on the provider session".

- `guides: Stream<string>`: each response body, as received.
- A read is two requests on the provider session: `GET https://tv.youtube.com/live` for the config, then the
  guide `browse` with the context from that config and the authorization header from `SAPISID`.
- Reads when first asked, then every 5 minutes, and whenever asked again (a reconnect).
- A request uses `ProviderSession`'s session (`session.fetch`). No view is created and no debugger is
  attached.
- Failures are a tagged `GuideNotRead` with the HTTP status or network cause. A 401 or 403 is logged as a
  likely sign-out. The loop survives every failure except interruption.

**Removed:** the hidden view, `listen`, the `Network.*` decoders, the 30-second timeout, and the two-minute
floor.

**`ProviderSession`** exposes its `session` for the reader, which needs its `fetch` and its cookies. Nothing
else changes.

## 2. Bridge, web UI, and Hub

- `ShellBridge.onGuideRead` is unchanged. `readGuide()` stays, documented as "the Hub came back".
- **Web UI:** forwards readings to the Hub, and calls `readGuide` on reconnect. The timer that re-reads a
  minute after a waiting airing's begin is removed: the 5-minute cadence covers it.
- **Hub:** unchanged, except that `YouTubeTv.readGuide` logs each guide's station and airing counts.

## 3. Failure handling

| Failure | Result |
| --- | --- |
| Network error, or HTTP 5xx | `GuideNotRead` logged in the shell; the next read in 5 minutes |
| HTTP 401 or 403 | As above, logged as "signed out of YouTube TV?" |
| A page that does not decode | `GuideUnreadable` (422) in the Hub with the schema issue, as today |
| Reads keep failing | The guide goes stale after 45 minutes; tiles fall back to the lineup and the picking tile, as today |

## 4. ADR 0002 amendment

Replaces "Amendment: the guide reader". Provider pages are still loaded unmodified, and nothing is injected
into any view. Added: the shell may send one kind of request on the provider session, YouTube TV's guide
`browse` for `FEunplugged_epg`, read-only, and the `GET` of the guide page that gives its config, at most every 5 minutes plus once per Hub
reconnect. It sends no other request a provider page did not send itself.

## Testing

- **`GuideReader`:** with a stubbed `fetch`, test-first: the config is read from the page's `ytcfg.set`; the
  request has the shape the spike recorded, with a correct `SAPISIDHASH`; a page without `INNERTUBE_CONTEXT`,
  a missing `SAPISID`, and each HTTP failure are tagged and the loop continues; a 401 is logged as a sign-out.
- **Hub decoding:** unchanged; the existing fixture is the payload this request returns.
- **By hand (game-day checklist):** replace the "watch the stream count while the reader runs" row with "a
  read plays nothing and opens no view". Add: a night game shows **On <channel> at <time>** from the first
  read of the day.

## Open questions

- Whether YouTube TV limits how often the guide may be requested. Five minutes is well below what an open
  guide page does, but this is unmeasured.
