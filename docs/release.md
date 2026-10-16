# Releasing Sportal

How Sportal goes from a commit to an installer someone can download. The app is one Electron program that runs its own
Hub ([ADR 0020](./adr/0020-one-installable-app.md)).

## Pipeline

```
push / pull request ──► ci.yml ──► pnpm check ──► pnpm package (Linux) ──► AppImage artifact, kept 7 days
tag v1.2.3 ──────────► release.yml ──► pnpm check ──► installers on ubuntu + windows ──► draft GitHub release v1.2.3
                                                                                       └─► you publish it by hand
```

- **`ci.yml`** runs on every push to `main` and every pull request. It runs the same gate as the push hook and then a
  real Linux package, so a change that breaks bundling fails in CI and not on release day. Download the AppImage from
  the run's artifacts to try a branch.
- **`release.yml`** runs on a `v*` tag. Each OS builds its own installers natively (the castlabs Electron build is
  per-OS, and electron-builder takes it from `node_modules/electron/dist`). Both jobs upload to the same draft
  release. The version comes from the tag (`v1.2.3` becomes `1.2.3`), so nothing has to be bumped in a commit.

| OS | Installers | Notes |
| --- | --- | --- |
| Linux | `Sportal-<v>-linux-x86_64.AppImage`, `Sportal-<v>-linux-amd64.deb` | No VMP on Linux. Prefer the `.deb`: Ubuntu 24.04's AppArmor blocks Electron's sandbox in an AppImage unless it runs with `--no-sandbox` |
| Windows | `Sportal-<v>-win-x64.exe` (NSIS, per user, choose a folder) | VMP-signed in CI. Unsigned for Authenticode until a certificate is added, so SmartScreen warns on first run |

## One-time setup

1. **castlabs EVS account** (needed for Windows playback). Sign up once on your own machine:
   `python -m pip install castlabs-evs` then `python -m castlabs_evs.account signup`. Signup needs an emailed code.
2. In the GitHub repository's **Settings → Secrets and variables → Actions**, add:
   - `EVS_ACCOUNT_NAME`, `EVS_PASSWD`: the EVS account. `release.yml` runs `castlabs_evs.account --no-ask reauth`
     with them on every release, so the token never goes stale.
   - Optional: `WIN_CSC_LINK` (a base64 `.pfx` or its URL) and `WIN_CSC_KEY_PASSWORD`, to Authenticode-sign the Windows
     installer. Without them the build is unsigned and still works.
3. Settings → Actions → General → Workflow permissions: allow read and write, so the release job can create the draft.

## Cutting a release

1. Make sure `main` is green in CI.
2. `git tag v0.1.0 && git push origin v0.1.0`
3. Wait for both `installers` jobs. Open the draft release, check that it has the `.AppImage`, the `.deb`, the `.exe`,
   and the `latest*.yml` files, write the notes, and publish it.
4. On a game day, run the installed-app rows of `docs/game-day-checklist.md` (YouTube TV plays in the installed app on
   each OS, and the Remote reaches the embedded Hub).

A failed job leaves the draft half filled. Delete the draft and the tag (`git push --delete origin v0.1.0`), fix, and
tag again.

## Building locally

- `pnpm package` builds the web UI, the Hub's bundle and the shell, then the installer for this OS in
  `apps/desktop/release/`. `release/<os>-unpacked/` is the app before installation and can be run in place.
- A local Windows build is not VMP-signed unless `SPORTAL_VMP_SIGN=1` and you are logged in to EVS
  (`apps/desktop/VmpSign.mjs`). Widevine services may refuse to play in an unsigned build. That is fine for trying
  the app, but not for a release.
- `pnpm start` runs the same thing from the repository without packaging.

## Not done yet

- **Auto-update.** electron-builder already writes `app-update.yml` and the `latest*.yml` feeds to each release, so
  adding `electron-updater` to the shell is the remaining step. It should wait for Authenticode signing on Windows, and
  a release must stay a draft until both jobs finish, or clients would see half a release.
- **Icons.** The app uses Electron's default icon. Add `apps/desktop/build/icon.png` (512×512) and electron-builder
  takes it for every target.
- **macOS.** Not a target. It would need an Apple Developer ID, notarization, and VMP signing *before* code signing.
- **A standalone Hub.** For a Hub that outlives a window (a box serving several Displays), `apps/hub/dist/hub.mjs` runs
  with plain Node 24: `SPORTAL_WEB_ROOT=<web build> node hub.mjs`. A container image of it is not built yet.
