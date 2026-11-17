import type { ObjectGlowMetadata, RgbTuple } from "@/types";

export const NO_GLOW = "OBJ_GLOW_NONE";
const GAME_FRAME_MS = 1000 * 70224 / 4194304;

// Terrain uses n * 8; object metadata uses round(n * 255 / 31). Both retain
// the original CGB channel in their high five bits.
const toFiveBit = (channel: number) => Math.min(31, Math.max(0, Math.floor(channel / 8)));

export interface GlowState {
  previous: string;
  current: string;
  steps: number;
}

export const UNLIT: GlowState = { previous: NO_GLOW, current: NO_GLOW, steps: 0 };

/** All objects share the game's currently active overworld fade. */
export class GlowFadeClock {
  private startedAt = -Infinity;

  start(now: number, duration: number): number {
    if (now < this.startedAt || now >= this.startedAt + duration) this.startedAt = now;
    return this.startedAt;
  }
}

export function createGlowTransition(metadata: ObjectGlowMetadata, clock: GlowFadeClock) {
  let current: string | undefined;
  let previous = NO_GLOW;
  let startedAt = -Infinity;
  const stepMs = metadata.fade_step_frames * GAME_FRAME_MS;
  return (next: string, now: number): GlowState => {
    if (current === undefined) {
      current = previous = next; // Map entry starts at its selected palette.
    } else if (next !== current) {
      previous = current;
      current = next;
      startedAt = clock.start(now, metadata.fade_steps * stepMs);
    }
    const steps = Math.min(metadata.fade_steps, Math.max(0, Math.floor((now - startedAt) / stepMs)));
    if (steps === metadata.fade_steps) previous = current;
    return { previous, current, steps };
  };
}

export function applyGlowAdjustment(colors: RgbTuple[], adjustment?: RgbTuple): RgbTuple[] {
  if (!adjustment) return colors;
  return colors.map((color, index) => index === 3 ? color : color.map((channel, rgb) =>
    Math.round(Math.min(31, toFiveBit(channel) + adjustment[rgb]) * 255 / 31)) as RgbTuple);
}

/** Port of FadeColorStep, operating on the original 5-bit RGB channels. */
export function fadeColorStep(active: number, target: number, remaining: number): number {
  const distance = Math.abs(active - target);
  if (!distance) return target;
  if (remaining <= 0) return target;
  let change: number;
  if (distance > remaining) {
    change = Math.floor(distance / remaining);
  } else {
    const quotient = Math.floor(remaining / distance) - (remaining % distance ? 1 : 0);
    change = quotient <= distance ? 1 : 0;
  }
  return active + Math.sign(target - active) * change;
}

export function fadeGlowPalette(previous: RgbTuple[], current: RgbTuple[], steps: number, total: number): RgbTuple[] {
  if (steps >= total) return current;
  if (steps <= 0) return previous;
  return previous.map((color, index) => color.map((channel, rgb) => {
    let active = toFiveBit(channel);
    const target = toFiveBit(current[index][rgb]);
    for (let remaining = total; remaining > total - steps; remaining--) {
      active = fadeColorStep(active, target, remaining);
    }
    return Math.round(active * 255 / 31);
  }) as RgbTuple);
}
