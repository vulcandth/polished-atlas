import { extensions } from "pixi.js";
import { AnimatedGIF } from "@pixi/gif";

let registered = false;

export function registerPixiExtensions(): void {
  if (registered) {
    return;
  }
  extensions.add(AnimatedGIF);
  registered = true;
}
