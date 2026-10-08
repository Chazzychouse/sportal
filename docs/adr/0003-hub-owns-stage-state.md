# 3. The Hub owns Stage state

Date: 2026-10-03
Status: Accepted

Note, 2026-10-08: the Stage is now called the Screen (`Screen`, `ScreenCommand`, `/api/screen`), and the Hub's
`Director` holds it beside the slate. The decision stands.

## Context

A phone must be able to change what a TV shows, and automation must be able to change the Stage
while no client is focused.

## Decision

The Stage lives in the Hub. Clients send `StageCommand`s; the Hub applies them with the pure
`Stage.apply`, then broadcasts the new Stage on the live stream. Clients render what they receive and
keep no copy of their own.

## Consequences

Every client, including a second tab, sees the same Stage. A command costs a round trip, a few
milliseconds on a local network. If a remote Hub ever makes that visible, a client can apply the same
pure function optimistically.
