# Phone Remote — Design

Date: 2026-10-03
Status: Approved 2026-10-03

## Goal

Control the Stage from a phone on the home network: see the layout and what each tile holds, put games in tiles,
and act on tiles, sized for one thumb. The Launchpad is a later, separate design.

## Decisions

| Question | Decision |
| --- | --- |
| Scope | Remote control only: a Stage map and the slate. Everything a stage command can do. No game detail view, no multiple Displays |
| Access | Open on the home LAN, no auth: Sportal is one person's tool on one network. The web dev server listens on the LAN (`server.host: true`); the Hub's `SPORTAL_HOST` defaults to `0.0.0.0` |
| Joining | A Remote button in the desk top bar opens a dialog with a QR code for `http://<lan address>:<this page's port>/remote` and the URL as text. `GET /api/addresses` gives the Hub machine's LAN IPv4 addresses, home-network ranges first; container and VM bridges are left out. More than one: each is listed, the first one's QR shown, a tap shows another's |
| Route | `main.tsx` renders the Remote view for `/remote`, the desk app otherwise. The Hub already serves the UI for any path (`spa: true`) |
| Header | Hub status, the layout picker, Solo / Unsolo |
| Stage map | The real layout in miniature, its slots drawn in percentages from `Layout#slots`, solo ignored so every tile shows (the soloed one marked). Each tile: slot, logos, abbreviations, scores, on-air mark. Tap selects; tap the selected tile for a bottom sheet: Hear, Promote, Solo, Clear, Swap with…. Swap with… waits for the next tile tapped, with a banner to cancel |
| Slate | Tabs Bench, Live, Next, Final (a tab with no games hidden), opening on Live. Rows at least 56px: logos, abbreviations, scores, status, networks, and the `T2` / `Bench` tag. Tapping a row drops it in the selected tile and selects the next empty tile, as on the desk |
| Selection | The phone's own, like each desk's |
| Rejections | Toasts, with the same text as the desk |
| Not in scope | Auth, multiple Displays, game detail, haptics, the Launchpad |

## Code

- **Hub.** `http/LanAddresses.ts`: a pure `lanAddresses(interfaces)` over `os.networkInterfaces()`' shape, tested.
  `SportalApi` gains a `host` group with `addresses` (`GET /api/addresses`); `HubServer` handles it.
  `main.ts` default host `0.0.0.0`.
- **Shared drop.** `StripCards.ts`' `dropCommand` becomes `drop(card, stage, selected)`, giving the command and
  the tile to select next; cards carry their `section`. Desk and phone both use them.
- **Rejection text.** Moves out of `App.tsx` into `stage/Rejections.ts` as a hook that toasts each rejection,
  used by both views.
- **Web.** `remote/RemoteView.tsx` (header, slate tabs), `remote/StageMap.tsx` (map and tile sheet).
  `frame/JoinRemote.tsx` (the QR dialog). `design/sheet.tsx` comes back for the bottom sheet. QR codes from
  `uqr`.
- **Glossary.** No new terms: the view is the Remote.

## Risks to check

| Risk | Check |
| --- | --- |
| Anyone on the Wi-Fi can drive the Stage | Accepted (decided) |
| A firewall blocks the port | The dialog shows the URL; the user opens the port |
| The Hub's address list leads with a VPN or bridge address | Home ranges first, bridges dropped, every address listed |
