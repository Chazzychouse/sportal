/**
 * The Remote's chime for a new prompt: a short tone through Web Audio. iOS lets a page play sound only after a tap,
 * so `unlock` runs on the first tap and `play` does nothing before it.
 */

let context: AudioContext | undefined

/** Readies sound; call from a tap. */
export function unlock(): void {
  context ??= new AudioContext()
  void context.resume()
}

/** Whether a tap has readied sound. */
export function unlocked(): boolean {
  return context !== undefined
}

/** Plays the chime: two short rising tones. Nothing before `unlock`. */
export function play(): void {
  if (context === undefined) return
  const now = context.currentTime
  for (const [offset, frequency] of [
    [0, 880],
    [0.16, 1320]
  ] as const) {
    const tone = context.createOscillator()
    const gain = context.createGain()
    tone.frequency.value = frequency
    gain.gain.setValueAtTime(0.25, now + offset)
    gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.15)
    tone.connect(gain).connect(context.destination)
    tone.start(now + offset)
    tone.stop(now + offset + 0.15)
  }
}
