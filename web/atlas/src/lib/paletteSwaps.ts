import type { BgPalettesMetadata, RgbTuple } from "@/types";

const TIME_INDEX: Record<string, number> = { morn: 0, day: 1, nite: 2, eve: 3 };

/** Terrain and object colors must select the same origin-specific variant. */
export function resolveEntranceVariant(
  metadata: BgPalettesMetadata | null | undefined, label: string, entranceMap?: string | null,
) {
  return entranceMap ? metadata?.maps[label]?.entrance_variants?.[entranceMap] : undefined;
}

/** Match the generator's composite at map-local event-cell coordinates. */
export function resolveSpatialBgPalettes(
  metadata: BgPalettesMetadata | null | undefined,
  label: string,
  time: string,
  x: number,
  y: number,
  entranceMap?: string | null,
): RgbTuple[][] | null {
  const map = metadata?.maps[label];
  if (!map) return null;
  const base = resolveEntranceVariant(metadata, label, entranceMap)?.palettes[time] ?? map?.palettes[time];
  if (!base) return null;
  const result = base.slice();
  const paletteTime = map.palette_times?.[time] ?? time;
  const index = (TIME_INDEX[paletteTime] ?? 1) + (map.overcast ? 4 : 0);
  for (const swap of map.palette_swaps ?? []) {
    const inside = x >= swap.min_x && x < swap.max_x && y >= swap.min_y && y < swap.max_y;
    const name = inside ? swap.inside : swap.outside;
    if (name === null) continue;
    const palette = metadata?.paletteSwapPalettes?.[name]?.[index];
    if (!palette || palette.length !== 4 || swap.slot < 0 || swap.slot > 7) {
      throw new Error(`Invalid palette swap ${name} in ${label}`);
    }
    result[swap.slot] = palette;
  }
  return result;
}

/** A per-object selector avoids rebuilding frames while colors remain unchanged. */
export function createSpatialPaletteSelector(
  metadata: BgPalettesMetadata,
  label: string,
  time: string,
  entranceMap?: string | null,
): (x: number, y: number) => RgbTuple[][] | undefined {
  let previous: string | undefined;
  return (x, y) => {
    const colors = resolveSpatialBgPalettes(metadata, label, time, x, y, entranceMap);
    if (!colors) return undefined;
    const signature = JSON.stringify(colors);
    if (signature === previous) return undefined;
    previous = signature;
    return colors;
  };
}
