import { useAtomValue } from "@effect/atom-react"
import { Schema } from "effect"
import { KeyValueStore } from "effect/persistence"
import { Atom } from "effect/reactivity"
import { useEffect } from "react"

/** The two looks a Display has: Glass, translucent and soft, the default; and Team, painted in the teams' colors. */
export const ThemeName = Schema.Literals(["glass", "team"])
export type ThemeName = typeof ThemeName.Type

/**
 * This Display's theme, kept in this browser under `sportal.theme`. Glass until another is chosen, and Glass when what
 * is kept is not a theme or the browser's storage cannot be read.
 */
export const theme: Atom.Writable<ThemeName> = Atom.kvs({
  runtime: Atom.runtime(KeyValueStore.layerStorage(() => localStorage)),
  key: "sportal.theme",
  schema: ThemeName,
  defaultValue: (): ThemeName => "glass"
}).pipe(Atom.keepAlive)

/** This Display's theme, set on the document as `data-theme` so the theme's tokens in `theme.css` apply. */
export function useTheme(): ThemeName {
  const name = useAtomValue(theme)
  useEffect(() => {
    document.documentElement.dataset.theme = name
  }, [name])
  return name
}
