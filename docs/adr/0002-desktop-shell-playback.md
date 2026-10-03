# 2. Desktop shell plays YouTube TV in unmodified web views

Date: 2026-10-03
Status: Accepted, with open observations

## Question

Can an Electron shell with Widevine sign in to Google and play several YouTube TV channels in
separate web views at once?

## What was observed

A throwaway spike (three web views in one window, one persistent session) was run by hand on the
development machine: Linux, Hyprland on Wayland, NVIDIA RTX 4050 with AMD integrated graphics.

- Electron build: castlabs v44.1.0+wvcus. The Widevine component registered (4.10.3050.0).
- Sign-in: Google sign-in completed inside the shell with the default user agent. No workaround needed.
- Shared session across views: yes. One sign-in covered all three views.
- Simultaneous playback of three channels: yes, with picture.
- Audio focus by muting views: works; exactly one view audible.
- Sign-in after restart: persisted.
- Display backend: with three web views, native Wayland rendering failed (`eglCreateImage failed with
  0x00003009`, an invisible window). Passing `--ozone-platform=x11` on the command line fixed it.
  Setting the same switch in code with `app.commandLine.appendSwitch` crashed the GPU process on
  launch, so the backend is chosen by start script. The real shell's main window was confirmed
  working on the default backend; whether its provider views need `start:x11` is not yet known.
- One GPU process crash and automatic restart was logged under x11 after several minutes
  (`nullptr returned from gbm_bo_import`). Its visible effect was not recorded.
- pnpm 12 does not run the install script of this git-hosted Electron build; the binary is fetched
  with `node node_modules/electron/install.js`.

Not yet observed:

- Stability over 30 minutes.
- What happens at the concurrent-stream limit, and whether views in one shell count separately.
- Whether a channel's address identifies the channel or only the programme airing on it.
- Playback inside the real shell under its permission handler and navigation allowlist. The channel
  map is empty in this slice, so no stream tile has been shown yet.

## Decision

Build the shell as specified: provider pages are loaded unmodified in web views on one persistent
session, and the shell sets only each view's address, bounds, and mute flag.

Channels will not be mapped by hand. The next plan starts with learned channels: when a game's
network is not yet known, its tile opens YouTube TV's live guide; the user picks the channel once;
the shell reports the address the view landed on and the Hub remembers it. Whether that is remembered
per network or per game depends on the address-stability observation above.

## Consequences

- The provider allowlist is four exact hosts (`tv.youtube.com`, `www.youtube.com`,
  `accounts.youtube.com`, `accounts.google.com`). Sign-in was proven in the spike without an
  allowlist; if it stalls in the shell, the terminal names the blocked host.
- The stream budget is unknown and is not enforced.
- The display backend may need to differ per machine; both start scripts are kept.

## Follow-up: learned channels (2026-10-03)

Built as designed in `docs/specs/2026-10-03-learned-channels-design.md`. What changed in the shell:

- A guide view reads only the address its page lands on (`did-navigate`, `did-navigate-in-page`);
  nothing is injected. The Hub keeps the channel's live address (`/watch/<id>?vp=0gEEEgIwAQ%3D%3D`).
- Observed in the live guide: one channel picked twice gives the same id; different channels give
  different ids; "from the beginning" adds an absolute start time to the address. Whether an old
  address still plays the channel live after its programme changes is game-day checklist row 17.
- Subframe navigations are held to the Hub's origin in the shell window only. Provider views do not
  guard subframes: their pages embed frames from hosts the four-host allowlist does not name, and
  refusing them could break sign-in or playback in ways only a game day would show.
