import { BaseTexture, Texture, type Sprite } from "pixi.js";

export interface FacingPriority {
  rgba: Uint8Array;
  always: number[];
  inGrass: number[];
}

export function facingPriority(rgba: Uint8Array, attributes: Uint8Array): FacingPriority | undefined {
  const always: number[] = [], inGrass: number[] = [];
  for (let i = 0; i < attributes.length; i++) {
    if (attributes[i] & 0x80) always.push(i);
    else if (attributes[i] & 2) inGrass.push(i);
  }
  return always.length || inGrass.length ? { rgba, always, inGrass } : undefined;
}

// A marker owns at most one mutable texture. Shared cache frames retain their
// original pixels when two NPCs with the same sprite stand on different tiles.
export function createObjectOcclusion(sprite: Sprite, colorAt: (x: number, y: number) => number | null) {
  let output: Texture | undefined;
  let pixels: Uint8Array;
  let previous: Texture | undefined;
  sprite.once("destroyed", () => output?.destroy(true));
  return (frame: Texture, priority: FacingPriority | undefined, x: number, y: number, grass: boolean) => {
    if (!priority || (!priority.always.length && !grass)) return frame;
    const { width, height } = frame;
    if (output?.width !== width || output.height !== height) {
      output?.destroy(true);
      pixels = new Uint8Array(width * height * 4);
      output = new Texture(BaseTexture.fromBuffer(pixels, width, height));
      previous = undefined;
    }
    let changed = frame !== previous;
    if (changed) pixels.set(priority.rgba);
    previous = frame;
    let hidden = false;
    const apply = (indices: number[], active: boolean) => {
      for (const i of indices) {
        // Hardware resolves overlapping OBJs first. Drawing the winning BG
        // color here also masks any lower-priority object at this pixel.
        const bg = active ? colorAt(x + i % width, y + Math.floor(i / width)) : null;
        const offset = i * 4;
        for (let channel = 0; channel < 3; channel++) {
          const value = bg === null ? priority.rgba[offset + channel] : (bg >> (16 - channel * 8)) & 255;
          if (pixels[offset + channel] !== value) {
            pixels[offset + channel] = value;
            changed = true;
          }
        }
        hidden ||= bg !== null;
      }
    };
    apply(priority.always, true);
    apply(priority.inGrass, grass);
    if (changed) output.baseTexture.update();
    return hidden ? output : frame;
  };
}
