import { BaseTexture, MIPMAP_MODES, SCALE_MODES } from "pixi.js";

let registered = false;

export function registerPixiExtensions(): void {
  if (registered) {
    return;
  }
  registered = true;

  // Ensure pixel-art crisp rendering across all textures by default.
  // This affects any BaseTexture created after this point (Texture.from, BaseTexture.from, fromBuffer, Assets, etc.).
  try {
    BaseTexture.defaultOptions.scaleMode = SCALE_MODES.NEAREST;
    BaseTexture.defaultOptions.mipmap = MIPMAP_MODES.OFF;
  } catch {
    // Ignore if running in a non-browser or older Pixi environment.
  }
}
