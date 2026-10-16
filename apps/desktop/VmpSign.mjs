import { execFileSync } from "node:child_process"

/**
 * electron-builder's afterSign hook: gives the Windows app castlabs' VMP signature, without which Widevine services
 * refuse playback. Needs the castlabs-evs Python package and a logged-in EVS account (`SPORTAL_VMP_SIGN=1`); without
 * it the app keeps castlabs' development signature, fine for trying a build but not for a release.
 */
export default function vmpSign(context) {
  if (context.electronPlatformName !== "win32") return
  if (process.env.SPORTAL_VMP_SIGN !== "1") {
    console.warn("VmpSign: SPORTAL_VMP_SIGN is not 1, so this Windows build is not VMP-signed")
    return
  }
  const python = process.env.PYTHON ?? "python"
  execFileSync(python, ["-m", "castlabs_evs.vmp", "--no-ask", "sign-pkg", context.appOutDir], {
    stdio: "inherit"
  })
  execFileSync(python, ["-m", "castlabs_evs.vmp", "verify-pkg", context.appOutDir], { stdio: "inherit" })
}
