/** Where a signed-out user is sent to sign in to YouTube TV. */
export const signInUrl = "https://tv.youtube.com/"

/** The hosts a provider view may visit: YouTube TV and the pages its sign-in passes through. */
export const allowedHosts = [
  "tv.youtube.com",
  "www.youtube.com",
  "accounts.youtube.com",
  "accounts.google.com"
]

/** The origin YouTube TV serves its guide and its API from. */
export const guideOrigin = "https://tv.youtube.com"

/** The browse id of YouTube TV's live guide. */
export const guideBrowseId = "FEunplugged_epg"

/** Whether an address is a live channel's watch page on YouTube TV. */
export function isChannelAddress(url: string) {
  if (!URL.canParse(url)) return false
  const { protocol, hostname, pathname } = new URL(url)
  return protocol === "https:" && hostname === "tv.youtube.com" && pathname.startsWith("/watch/")
}
