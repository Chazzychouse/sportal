import type { StageTransition, TilePlacement } from "@sportal/api/ShellBridge"

/** The arithmetic of a Stage transition: how far along its curve a moment is, and where a view is then. */
export const Transition = {
  /** The eased progress at `t` (0–1 of the duration), as CSS computes `cubic-bezier(x1, y1, x2, y2)`. */
  progress(easing: StageTransition["easing"], t: number): number {
    if (t <= 0) return 0
    if (t >= 1) return 1
    const [x1, y1, x2, y2] = easing
    return bezier(y1, y2, solveX(x1, x2, t))
  },

  /** The bounds `eased` of the way from `from` to `to`, in whole pixels; exactly `to` at 1. */
  between(
    from: TilePlacement["bounds"],
    to: TilePlacement["bounds"],
    eased: number
  ): TilePlacement["bounds"] {
    if (eased >= 1) return to
    const at = (a: number, b: number) => Math.round(a + (b - a) * eased)
    return {
      x: at(from.x, to.x),
      y: at(from.y, to.y),
      width: at(from.width, to.width),
      height: at(from.height, to.height)
    }
  }
}

/** One coordinate of a cubic bezier from 0 to 1 with control points `p1` and `p2`, at parameter `s`. */
function bezier(p1: number, p2: number, s: number) {
  const inverse = 1 - s
  return 3 * inverse * inverse * s * p1 + 3 * inverse * s * s * p2 + s * s * s
}

/** The parameter at which the curve's x is `x`, found by bisection: x rises monotonically for CSS curves. */
function solveX(x1: number, x2: number, x: number) {
  let low = 0
  let high = 1
  while (high - low > 1e-7) {
    const middle = (low + high) / 2
    if (bezier(x1, x2, middle) < x) low = middle
    else high = middle
  }
  return (low + high) / 2
}
