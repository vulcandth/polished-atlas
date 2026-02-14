import { Application, Assets } from "pixi.js";
import type { MapAnimationResource } from "@/lib/loadMapAnimation";
import { MIN_SCALE, MAX_SCALE } from "@/components/MapCanvas/constants";

/**
 * Allow panning beyond the edge of the content for better UX (esp. on mobile).
 * Returns 10% of the smaller viewport dimension, clamped to a sensible range.
 */
export function computeOverscrollPx(viewW: number, viewH: number): number {
  const candidate = Math.max(viewW, viewH) > 0 ? Math.min(viewW, viewH) * 0.1 : 64;
  return Math.max(48, Math.min(256, candidate));
}

/**
 * Provide a slightly larger buffer at the bottom, where browser UI can
 * overlap content and thumbs often need headroom.
 */
export function computeBottomExtraPx(viewH: number): number {
  const base = computeOverscrollPx(viewH, viewH);
  return Math.max(32, Math.floor(base * 0.5));
}

/**
 * Clamp scale value to valid range, handling non-finite inputs.
 */
export function clampScale(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

/**
 * Dispose animation resource textures and optionally unload via Assets.
 * NOTE: Only use unload for short-lived overlay assets; for world map sprites,
 * multiple instances share the same BaseTexture by URL and unloading can
 * de-texture currently visible sprites.
 */
export function disposeAnimationResource(
  resource: MapAnimationResource | null | undefined,
  options?: { unload?: boolean },
): void {
  if (!resource) {
    return;
  }
  // First, dispose of the Texture wrappers without touching the BaseTexture
  // so that the asset system can own the BaseTexture lifecycle.
  for (const texture of resource.textures) {
    try {
      // In some teardown orders, PIXI may already have nulled the baseTexture
      // on a Texture without marking it destroyed. Guard for that to avoid
      // internal refCount access on a null baseTexture.
      if (texture && !texture.destroyed) {
        const bt = (texture as any).baseTexture ?? (texture as any)._baseTexture;
        if (!bt) {
          continue;
        }
        texture.destroy(false);
      }
    } catch {
      /* ignore individual texture destroy issues */
    }
  }
  // Optionally unload via Assets which will destroy the BaseTexture it manages.
  if (options?.unload) {
    void Assets.unload(resource.imageUrl);
  }
}

/**
 * Safe event listener attach for PIXI renderer.
 */
export function rendererOn(
  app: Application | null,
  event: string,
  handler: (...args: any[]) => void,
): void {
  const r: any = app && (app as any).renderer;
  if (r && typeof r.on === "function") {
    try {
      r.on(event, handler);
    } catch {
      /* noop */
    }
  }
}

/**
 * Safe event listener detach for PIXI renderer.
 */
export function rendererOff(
  app: Application | null,
  event: string,
  handler: (...args: any[]) => void,
): void {
  const r: any = app && (app as any).renderer;
  if (r && typeof r.off === "function") {
    try {
      r.off(event, handler);
    } catch {
      /* noop */
    }
  }
}

/**
 * Compute the effective visible size of the canvas in CSS pixels, accounting for
 * mobile browser UI that reduces the visual viewport compared to the layout viewport.
 */
export function getEffectiveViewSize(app: Application | null): { width: number; height: number } {
  if (!app) return { width: 0, height: 0 };
  const renderer = app.renderer;
  const canvas = app.view as unknown as HTMLCanvasElement | null;
  const baseW = Math.max(0, renderer?.width ?? 0);
  const baseH = Math.max(0, renderer?.height ?? 0);
  let rectW = baseW;
  let rectH = baseH;
  if (canvas) {
    const rect = canvas.getBoundingClientRect();
    rectW = Math.max(0, Math.round(rect.width));
    rectH = Math.max(0, Math.round(rect.height));
  }
  let vvW = Number.POSITIVE_INFINITY;
  let vvH = Number.POSITIVE_INFINITY;
  if (typeof window !== "undefined" && (window as any).visualViewport) {
    const vv = window.visualViewport as VisualViewport;
    vvW = Math.max(0, Math.round(vv.width));
    vvH = Math.max(0, Math.round(vv.height));
  }
  const width = Math.min(baseW || Number.POSITIVE_INFINITY, rectW || Number.POSITIVE_INFINITY, vvW);
  const height = Math.min(
    baseH || Number.POSITIVE_INFINITY,
    rectH || Number.POSITIVE_INFINITY,
    vvH,
  );
  return {
    width: Number.isFinite(width) ? width : baseW,
    height: Number.isFinite(height) ? height : baseH,
  };
}

/**
 * Snap a value to the nearest half (0.5 increment).
 */
export function snapToHalf(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 2) / 2;
}
