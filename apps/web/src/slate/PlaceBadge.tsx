import { cn } from "@/design/ClassName"
import { Place, type StripCard } from "./StripCards.ts"

/** Where a card's game is: its tile number, tinted on air, or "Bench". `className` sizes it. */
export function PlaceBadge(props: { place: StripCard["place"]; className?: string }) {
  const { place } = props
  if (place === undefined) return null
  return (
    <span
      className={cn(
        "label-caps shrink-0 rounded-sm border px-1",
        Place.$is("Slot")(place) ? "border-on-air/50 text-on-air" : "text-muted-foreground",
        props.className
      )}
    >
      {Place.$is("Slot")(place) ? `T${place.slot + 1}` : "Bench"}
    </span>
  )
}
