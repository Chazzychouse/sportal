import type { Team } from "@sportal/domain/Team"
import { useState } from "react"

/**
 * A team's logo at `size` pixels square, or its abbreviation in a neutral circle when it has none or the image
 * will not load. ESPN's logos are asked for at twice the size through its resizer, not at their 500px original.
 */
export function TeamLogo(props: { team: Team; size: number }) {
  const [failed, setFailed] = useState<string | undefined>(undefined)
  const { logo, abbreviation } = props.team
  const box = { width: props.size, height: props.size }
  if (logo === undefined || failed === logo)
    return (
      <span
        aria-hidden
        style={{ ...box, fontSize: Math.max(7, props.size * 0.3) }}
        className="grid shrink-0 place-items-center rounded-full bg-secondary font-sans font-semibold text-muted-foreground leading-none"
      >
        {abbreviation.slice(0, 4)}
      </span>
    )
  return (
    <img
      src={sized(logo, props.size * 2)}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(logo)}
      style={box}
      className="shrink-0 object-contain"
    />
  )
}

function sized(logo: string, pixels: number) {
  const espn = "https://a.espncdn.com/i/"
  // The resizer wants the path as is: percent-encoded, it answers with an empty image.
  return logo.startsWith(espn)
    ? `https://a.espncdn.com/combiner/i?img=/i/${logo.slice(espn.length)}&w=${pixels}&h=${pixels}`
    : logo
}
