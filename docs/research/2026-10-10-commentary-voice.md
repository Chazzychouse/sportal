# Commentary: voice, ducking, writer, pacing

2026-10-10. Research for roadmap piece 5 (Commentary) in `docs/specs/2026-10-10-classification-design.md`. Nothing
here is decided. Prices and versions were checked on 2026-10-10 unless the text says otherwise. Anything marked
**unverified** I could not confirm from a primary source or from a measurement.

## Summary

- **Voice, start local:** Kokoro-82M through `kokoro-js` (Apache-2.0, ONNX, runs on CPU in Node). Use a B-grade male voice
  (`am_michael`, `am_fenrir`, `bm_george`) with `speed` around 0.85, and shape pauses with punctuation. It costs nothing,
  works offline, has a Node path, and fits the port. Its weakness: it has no emotion or pause control.
- **Voice, hosted, best match for the persona:** OpenAI `gpt-4o-mini-tts`. Its `instructions` field takes a
  plain-English delivery brief ("low, calm, deliberate, investigative; long pause before the reveal"), so the voice is
  designed in words and nothing is cloned. A game day costs about $0.30. A distinct timbre would take ElevenLabs Voice
  Design (v4/v3), at about $1.50 per game day at API rates.
- **Persona safety:** never put the real host's name in a voice prompt, a writer prompt, or an example line.
  ElevenLabs' policy forbids synthesizing "the voice, identity, or likeness of any living individual" without consent.
  OpenAI requires custom voices to come with the speaker's consent. Describe the archetype instead: "a calm, deliberate
  TV investigator".
- **Ducking:** Electron has no per-view volume, only `setAudioMuted`. On this machine every tile's audio reaches
  PipeWire as **one stream from Chromium's audio-service process** (`application.name = "@sportal/desktop"`,
  `media.name = "Playback"`), and nothing on it says which tile it came from. Only the focused tile is unmuted, so that
  stream is in practice the focused game. Recommended: **lower that stream with `wpctl`/`pactl` and play the line from a
  separate process** (`pw-play`). The fallback is mute-during-line with `setAudioMuted`. Both leave the provider page
  untouched.
- **Writer:** templates first: no latency, and their audio can be rendered and cached ahead of time. Then Claude Haiku 4.5
  (`claude-haiku-4-5`) for latency. Cheap enough to try alongside it: Claude Sonnet 5.5 with thinking off
  (`between_tools`) and the persona cached. Expect about 1–3 s from a moment change to audio with Haiku plus a hosted
  TTS (**unverified**, measure it).
- **Staleness:** every line carries the `Classification.since` it was written for and a short TTL. It is dropped unless
  that game's moment is still the same (`since` unchanged) when the line is about to play.
- **Pacing:** speak into dead ball (`Break` moments, between plays), never over a live snap in the focused game. At
  most one line per about 20–30 s. Priority: ScoringThreat on an unseen game, then a BigPlay result, then CrunchTime,
  then Break filler. RedZone's own rule is "only occasional and usually brief voice-over".
- **Biggest open risk:** the ESPN data and the YouTube TV video are out of sync, often by tens of seconds (data likely
  ahead, **unverified**). A line can spoil a play the viewer has not seen yet. Measure the offset before tuning anything
  else.

## Machine

Measured on this machine (`lspci`, `nproc`, `free -h`, `nvidia-smi`, `pactl`). If the Display ends up running on
another "home box", measure that one too.

| | |
|---|---|
| CPU | AMD Ryzen 5 8645HS, 6 cores / 12 threads |
| GPU | NVIDIA RTX 4050 Laptop, **6 GB VRAM**, plus a Radeon 760M iGPU |
| RAM | 30 GiB, **24 GiB used, 28 GiB of 30 GiB swap used** at the time of measuring |
| Audio | PipeWire 1.6.8 (pulse server 15.0.0), WirePlumber 0.5.17; `pw-play`, `paplay`, `wpctl` present |

What this means for local TTS: small models (Kokoro 82M, Piper, Chatterbox 350–500M) fit easily on the GPU or run on
the CPU. 3–4B models (Orpheus 3B, Fish S2 Pro 4B) would need quantizing to fit 6 GB beside Electron's video decode
(**unverified**). Memory is already tight, so a Python GPU server running all day costs something real here.

## TTS comparison

A line is about 15 words, roughly 90 characters and 6–7 s of speech at a slow 130–150 wpm. A game day is about 200 lines:
roughly 18k characters, about 22 minutes of audio.

| Engine | Fit for a deep, slow, deliberate male | Latency to first audio | Streaming | Pause / emotion control | Rate / pitch | Cost per line / per game day | License | Node | Hardware |
|---|---|---|---|---|---|---|---|---|---|
| **Kokoro-82M** v1.0 (2025-01-27) | Fair. Male voices top out at C+ (`am_michael`, `am_fenrir`, `am_puck`; `bm_george` and `bm_fable` are C). Clean, a little flat; voices can be blended | Short line on CPU: about 0.5–2 s (**unverified**, measure). The model card claims about 100× real time on GPU | Yes: `TextSplitterStream` in kokoro-js | None (no SSML); punctuation only | `speed` | $0 | Apache-2.0 | **Yes**: `kokoro-js` (Transformers.js / onnxruntime; fp32/fp16/q8/q4) | CPU fine; GPU optional |
| **Piper** (now `OHF-Voice/piper1-gpl`) | Weakest: clear but robotic, more an announcer than an actor | Very low on CPU (**unverified** for this machine) | Per sentence | None (no SSML documented) | `length_scale` (slower = larger) | $0 | **GPL-3.0** (the new repo; the old `rhasspy/piper` was MIT) | CLI or HTTP server; Python package | CPU |
| **Chatterbox** (Resemble AI): Turbo 350M, Nano 110M, original 500M | Good expressiveness. `exaggeration` 0–1 and `cfg_weight` (a lower value gives slower, more deliberate pacing). A specific timbre needs a reference clip, which must not be a real person's voice | About 0.3–1 s on the GPU (**unverified**). Nano runs about 3× real time on 8 CPU cores (README) | Community servers (**unverified**) | Tags such as `[chuckle]` and `[cough]` on Turbo/Nano; exaggeration | Through cfg/exaggeration only | $0 | MIT; output carries a Perth watermark | Python only, so it needs a local HTTP sidecar | 6 GB GPU fits; Nano on CPU |
| **Orpheus TTS** 3B | Strong expressiveness: male voices `leo`, `dan`, `zac`; tags `<sigh>`, `<gasp>`, and others | About 200 ms streaming (README, data-centre GPU) | Yes | Emotion tags | Prompt only | $0 | Apache-2.0 code. The weights are a Llama-3.2 fine-tune, so check the model card for Llama terms (**unverified**). Last update May 2025 | Python or llama.cpp-style server | 3B needs a quantized build to fit 6 GB (**unverified**) |
| **Fish Audio S2 Pro** 4B | Top tier among open weights; free-form tags (`[pause]`, `[whisper]`, natural-language direction) | About 100 ms (README, H200) | Yes | Rich tags | Tags | $0 | **Fish Audio Research License** (non-commercial; personal use probably fine, read it) | Python server | Too big for 6 GB without heavy quantization (**unverified**) |
| (F5-TTS, VibeVoice, Higgs Audio v2, Dia) | Cloning- or long-form-oriented; not better than the above for short lines | – | – | – | – | – | F5 weights are CC-BY-NC (**unverified**) | Python | GPU |
| **OpenAI `gpt-4o-mini-tts`** (snapshot 2025-12-15) | **Best fit by design.** Voices include `onyx`, `ash`, `cedar` (the docs recommend `marin` and `cedar`). `instructions` controls tone, intonation, speed, emotional range | Low with `wav`/`pcm` output (docs); exact time to first audio **unverified** | Yes (chunked; `pcm`/`wav` for lowest latency) | Natural-language `instructions`; no SSML | `instructions`, and a `speed` parameter (**unverified** on this model) | $0.60/M text tokens + $12/M audio tokens, about $0.015/min, so about **$0.0015/line, $0.30/game day** | Proprietary. Policy: disclose that the voice is AI (trivially true for a personal tool) | Official `openai` npm SDK, or plain HTTP | Hosted |
| **ElevenLabs** v4 / v3 (Voice Design), Flash v2.5 | **Best timbre.** Voice Design turns a text description into three candidate voices; v4 audio tags (`[sighs]`, `[whispers]`) | v4 Turbo about 100 ms, v3 Conversational about 280 ms, Flash about 75 ms (vendor claims) | Yes (HTTP and WebSocket) | v4/v3: audio tags; **no SSML `<break>`** (use ellipses and dashes) | Speed setting (range **unverified**) | API: v3 $0.08 per 1k chars, Flash/Turbo $0.04, so v3 is **about $0.007/line, $1.44/game day**; plans from $6/month (Starter, 273k chars) | Proprietary. Use policy forbids impersonating a living person without consent | Official JS SDK | Hosted |
| **Cartesia Sonic-3.6** | Good. Voices are cloned from a clip or picked from a library; no text-only voice design found (**unverified**) | Vendor positions it as very low latency; the docs page gave no number (**unverified**) | Yes (WebSocket) | `<emotion value="calm"/>` (beta, 60+ values), `[laughter]`; no documented pause tag | `<speed ratio>` 0.6–1.5, `<volume ratio>` 0.5–2.0 | 1 credit = 1 char, so about 18k credits/game day. Pro $5/month = 100k credits (about 5 game days); Startup $49 = 1.25M | Proprietary | JS SDK | Hosted |

**Reading:** for the persona, what matters most is **controllable delivery**: slow, low, and pausing before the payoff.
OpenAI's `instructions` and ElevenLabs' tags give that; Kokoro and Piper do not. A sensible order, all behind one
`Voice` port:

1. Kokoro adapter: offline, free, the default.
2. OpenAI adapter: a persona brief in `instructions`.
3. Optionally ElevenLabs, if the timbre matters enough to pay for.

Rendering template lines ahead of time and caching them hides latency from any engine.

## Ducking options

The facts on this machine, with the shell running:

- Electron `webContents` has `setAudioMuted`, `isAudioMuted`, `isCurrentlyAudible` and an `audio-state-changed` event.
  It has **no volume setter** (Electron docs).
- `pactl list sink-inputs` shows **one** sink input. It belongs to the Electron process
  `--type=utility --utility-sub-type=audio.mojom.AudioService`, with `application.name = "@sportal/desktop"`,
  `media.name = "Playback"`, and WirePlumber restores its volume by application name.
- With 9 renderer processes running there was still one stream, so Chromium's audio service is the single PipeWire
  client. **Unverified:** whether two *audible* tiles at once ever show up as two sink inputs. If they do, the streams
  still carry nothing that says which tile they belong to, so PipeWire **cannot address a single tile**. Check it with
  `pactl list sink-inputs short` while two tiles are unmuted.
- Sportal unmutes only the focused tile (`TileViews.sync` → `setAudioMuted(placement.muted)`), so the Electron stream
  *is* the focused game's audio.

Options, best first. Every one respects the no-injection rule: none touches the provider page, its requests, or its
media. They act on Electron's mute flag or on the OS mixer.

1. **Lower the Electron stream in PipeWire, and play the line from a separate process.** Look up the sink input whose
   `application.process.binary = electron` and `application.name = @sportal/desktop`. Ramp it to about 30% with
   `wpctl set-volume <id> 0.3` (or `pactl set-sink-input-volume`). Play the line with `pw-play` (its own client, so it
   is not ducked), then ramp back. This is a real duck and keeps the crowd under the voice.
   - **The line must not play inside Electron** (for example an `<audio>` element in the web UI). It would join the
     same audio-service stream and be ducked with the game.
   - WirePlumber's stream-restore keys on the app name, so a crash mid-duck brings the next launch up at 30%. Set the
     volume to 100% at startup and in a finalizer.
   - **Unverified:** that Chromium never rewrites the stream volume itself.
2. **Mute during the line** (`setAudioMuted(true)` on the focused tile, then back). The Electron API is enough; it is
   simplest and most certain. It is abrupt and loses the stadium bed. The voice may then play inside Electron.
3. **WirePlumber role-based ducking.** The example in `/usr/share/doc/wireplumber/examples/wireplumber.conf.d/media-role-nodes.conf`
   sets up role loopback sinks with `policy.role-based.priority`: Multimedia 10, with a role at priority 30 whose
   `action.lower-priority = "duck"`, and `linking.role-based.duck-level` defaulting to 0.3.
   - Play the line with a higher-priority `media.role` and WirePlumber ducks Multimedia automatically, with no
     volume code at all.
   - The cost: a system-wide config change that reroutes **all** desktop audio through role loopbacks
     (`node.stream.default-media-role`). That is heavy for one app, and not portable.
4. **Play the line louder over the game.** Nothing to build, but the line is hard to follow over a crowd. Only as a
   last resort.
5. Ruled out: lowering volume in the provider page (`video.volume`, an injected Web Audio gain). That is script
   injection and breaks the hard rule.

Where it lives: ducking is the Display's job (ADR 0015), so the desktop shell does option 1 or 2. The Hub never sees
audio.

## Writer

**Templates first.** One table per Moment case and BigPlayKind, with slots for team, yards, clock and margin, and a few
variants each picked at random. The audio of a template can be rendered once per slot value: team names and numbers
are a finite set. Speech then starts with **zero** latency, whatever the engine.

**Then an LLM, via the Claude API.** Prices are from the `claude-api` skill's model table (cached 2026-09-25); confirm
on the pricing page.

| Model | $/M in / out | Minimum cacheable prefix | Notes |
|---|---|---|---|
| `claude-haiku-4-5` | $1 / $5 | **4096 tokens** | Fastest. Takes no adaptive thinking (thinking is off unless requested). A persona sheet under 4096 tokens **will not cache**; either pad it with about 40 example lines (worth doing anyway for voice consistency) or accept no caching |
| `claude-sonnet-5-5` | $2 / $10, cache reads $0.20 | **512 tokens** | Better voice. Thinking is on by default. For a short line send `thinking: {type: "between_tools"}` (thinking off) or keep it on at `low` effort, then measure latency |

- **Cost:** a persona of about 2k tokens plus about 300 tokens of game context, giving about 40 tokens out.
  - Haiku uncached: about $0.003 per line, $0.60 per game day.
  - Sonnet 5.5 cached: about $0.0013 per line, about $0.26 per game day.

  Either is trivial. Choose on latency and voice quality.
- **Prompt shape:**
  - The cached `system` block holds the persona sheet: who the host is, the delivery rules, banned phrases, 30–40 example
    lines, and a hard rule never to name or quote a real broadcaster.
  - The user message carries the volatile part: game, moment, score, clock, last play, and what the viewer can see.
  - Ask for a single line of 15 words or fewer through structured output, and send no timestamps in the cached part.
- **Latency budget, from moment change to first audio (estimates, unverified):**
  - Hub classification plus the SSE hop to the Display: under 0.5 s.
  - Haiku answer: about 0.6–1.5 s.
  - Hosted TTS first audio: about 0.2–0.5 s, or local Kokoro on CPU: about 0.5–2 s.

  That totals **about 1.5–3.5 s**. This matters less than the video delay (see Open questions). A line can even wait for the video.
- **Avoiding stale lines:**
  - Every request carries `(gameId, moment._tag, since)`. Every finished line is checked against the Display's latest
    classifications just before it plays, and dropped if `since` changed or the game left the screen.
  - Give each line a TTL by kind: about 8 s for a BigPlay, about 15 s for a ScoringThreat; a result line (TD, turnover)
    replaces a queued threat line.
  - Cancel the in-flight LLM call (an interruptible fiber) when the moment it was for ends.
  - Lines about things that are certain (a final score, a halftime recap) can be generated without hurry.

## Pacing

What RedZone does, from its own people:

- Mostly the network's own call, with "only occasional and usually brief voice-over comments" by the host (Wikipedia).
- The host: "I'm not trying to talk over any live football more than I have to". He talks more when there is a double
  or triple box with simultaneous snaps, because then there is no single game audio to fall back on (Awful
  Announcing, 2023-11-09).
- Red-zone possessions get the full screen, then strong drives, then important games.
- Phrases like "while we were watching that…" admit the switch delay instead of hiding it.

Rules worth stealing for Sportal:

1. **Speak into dead ball.** The best windows:
   - a `Break` (timeout, period end, `afterScore`);
   - the gap right after a play result arrives (25–40 s play clock);
   - focus changes.
   Never start a line while the focused game's snap is likely coming: the play clock is running under about 10 s with
   no Break. This is inferred from data, never from the video.
2. **Talk about what the viewer cannot see.** The most valuable line is about an *unfocused* game ("Meanwhile, in
   Columbus, a red-zone trip"), timed into the focused game's dead ball. It pairs with piece 4 (Prompts).
3. **Rate limit.** At most one line per about 20–30 s, and no more than about 2 per minute even on a busy afternoon.
   Stay silent through `Live`-to-`Live`. Each game gets one line per moment, never a repeat for the same `since`.
4. **Priority, highest first:**
   1. A TD or turnover result on any game.
   2. A ScoringThreat on an unseen game.
   3. CrunchTime starting.
   4. A BigPlay on the focused game. Usually skip this: the network's own announcers are already calling it.
   5. Break filler and recaps.

   A higher-priority line may cut a lower one mid-line, with a short fade. Nothing cuts a result line.
5. **Never narrate what the network announcer is narrating.** On the focused game, the host frames ("Fourth and goal.
   Watch this.") and then gets out of the way. The duck ends when the line ends, not when the play ends.
6. **Short.** 15 words or fewer, about 5–7 s. The persona's slowness is spent on one pause before the payoff, not on
   length.

## Open questions for the user

1. **Data vs video offset.** How far behind the ESPN data is the YouTube TV picture on game day? Lines may have to wait
   until the video catches up, or they spoil plays. Measure this during a game-day check.
2. **Where it runs.** Does the Display (and so the TTS engine) run on this laptop, or on the planned home box? That
   decides whether local GPU models are an option and whether memory is.
3. **Budget and offline.** Is about $0.30–1.50 per game day for hosted TTS acceptable, or must commentary work offline?
4. **Duck vs mute.** Is a true duck (PipeWire stream volume plus a separate player process) worth a little OS plumbing
   over a plain mute during lines?
5. **Timbre.** Is a stock voice steered by instructions (OpenAI, Kokoro) enough, or do you want a designed timbre
   (ElevenLabs Voice Design, written as an archetype with no real names)?
6. **Unfocused games.** Should the host talk about unfocused games, which overlaps with Prompts, or only frame the
   focused one?
7. **Persona sheet.** Who writes it, and should a few hand-written example lines in the target voice come first, before
   any LLM?

## Sources

All accessed 2026-10-10.

- Electron `webContents` API (audio methods; no volume setter): https://www.electronjs.org/docs/latest/api/web-contents
- Kokoro-82M model card (v1.0, 2025-01-27, Apache-2.0): https://huggingface.co/hexgrad/Kokoro-82M
- Kokoro voice grades: https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md
- kokoro-js (Node/ONNX, dtypes, `TextSplitterStream`): https://github.com/hexgrad/kokoro/tree/main/kokoro.js
- Piper (GPL-3.0, OHF): https://github.com/OHF-Voice/piper1-gpl
- Chatterbox (MIT, variants, exaggeration/cfg, Perth watermark): https://github.com/resemble-ai/chatterbox
- Orpheus TTS (Apache-2.0, voices, tags, latency): https://github.com/canopyai/Orpheus-TTS
- Fish Audio S2 Pro (research license, tags, latency): https://github.com/fishaudio/fish-speech
- Open-source TTS landscape 2026 (secondary): https://www.bentoml.com/blog/exploring-the-world-of-open-source-text-to-speech-models
- OpenAI TTS guide (models, voices, instructions, formats, disclosure): https://developers.openai.com/api/docs/guides/text-to-speech
- OpenAI `gpt-4o-mini-tts` model page (pricing, snapshots): https://developers.openai.com/api/docs/models/gpt-4o-mini-tts
- ElevenLabs API pricing: https://elevenlabs.io/pricing/api
- ElevenLabs models and latency: https://elevenlabs.io/docs/overview/capabilities/text-to-speech
- ElevenLabs Voice Design: https://elevenlabs.io/docs/product-guides/voices/voice-design
- ElevenLabs v4/v3 prompting (audio tags, no SSML break): https://elevenlabs.io/docs/best-practices/prompting/eleven-v3
- ElevenLabs Prohibited Use Policy (impersonation): https://elevenlabs.io/use-policy
- Cartesia pricing (Sonic-3.6, credits): https://cartesia.ai/pricing
- Cartesia Sonic-3 speed/volume/emotion: https://docs.cartesia.ai/build-with-cartesia/sonic-3/volume-speed-emotion
- Claude pricing and models (via the `claude-api` skill, table cached 2026-09-25): https://platform.claude.com/docs/en/about-claude/pricing
- Claude prompt caching (minimum prefix per model): https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- WirePlumber role-based ducking example (local, 0.5.17): `/usr/share/doc/wireplumber/examples/wireplumber.conf.d/media-role-nodes.conf`
- NFL RedZone format: https://en.wikipedia.org/wiki/NFL_RedZone
- Scott Hanson on talking over football (2023-11-09): https://awfulannouncing.com/nfl/scott-hanson-redzone-talking-defense.html
- Behind the scenes at RedZone (NPR, 2014; fetch timed out, not read): https://www.npr.org/2014/12/14/370379435/seven-chaotic-hours-behind-the-scenes-at-nfl-redzone
- Local measurements: `lspci`, `nproc`, `free -h`, `nvidia-smi`, `pactl list sink-inputs`, `ps` (2026-10-10, shell running)
