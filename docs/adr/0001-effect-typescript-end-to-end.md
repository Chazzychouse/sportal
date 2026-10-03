# 1. Effect TypeScript end to end

Date: 2026-10-03
Status: Accepted

## Context

The Hub, the web UI, and the desktop shell all handle the same domain concepts. Rust and gpui were
considered. The shell must be Chromium to play Widevine video, the UI must run on a phone and a TV
browser, and a Rust Hub would put every concept in two languages.

## Decision

One language. Each domain concept is declared once as an Effect Schema in `packages/domain` and used
unchanged as the in-memory type, the decoder, and the wire format by every process.

## Consequences

No generated types and no mirror types. The Hub is not as fast as a Rust one would be; its workload
(a few polls, a handful of clients) does not need it. Revisit only on a measured problem.
