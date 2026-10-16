import type { GameSnapshot } from "@sportal/domain/Game"
import type { Team } from "@sportal/domain/Team"

/** A Glass card's thin edge: the away team's color above, the home team's below. */
export function teamEdge(game: GameSnapshot): string {
  return `linear-gradient(${teamColor(game.away.team)} 50%, ${teamColor(game.home.team)} 50%)`
}

/** A Team card's half for `team`: its color running darker, the away half leaning left and the home half right. */
export function teamHalf(team: Team, side: "home" | "away"): string {
  const color = teamColor(team)
  return `linear-gradient(${side === "away" ? 160 : 200}deg, ${color}, color-mix(in oklab, ${color} 55%, black))`
}

/**
 * The color to paint `team` in on Sportal's dark surfaces, as CSS: its own color; or, when that is too dark to see
 * (relative luminance under 0.03), its alternate color when that one is not, else its own color lightened. A neutral
 * graphite for a team with no color.
 */
function teamColor(team: Team): string {
  const color = rgbOf(team.color)
  if (color === undefined) return graphite
  if (luminance(color) >= darkest) return css(color)
  const alternate = rgbOf(team.alternateColor)
  return alternate !== undefined && luminance(alternate) >= darkest ? css(alternate) : css(lightened(color))
}

function rgbOf(hex: string | undefined): readonly [number, number, number] | undefined {
  if (hex === undefined || !/^[0-9a-f]{6}$/i.test(hex)) return undefined
  const value = Number.parseInt(hex, 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance([red, green, blue]: readonly [number, number, number]): number {
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
}

function linear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** 30% of the way to white: enough to lift even black (to a luminance of 0.074) above `darkest`. */
function lightened([red, green, blue]: readonly [number, number, number]): readonly [number, number, number] {
  return [toWhite(red), toWhite(green), toWhite(blue)]
}

function toWhite(channel: number): number {
  return Math.round(channel + (255 - channel) * 0.3)
}

function css(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
}

/** The darkest a team color may be and still show on a dark surface, as relative luminance. */
const darkest = 0.03

const graphite = "#3a3d44"
