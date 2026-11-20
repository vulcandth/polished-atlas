import { describe, expect, it } from "vitest";
import { buildAtlasLayout } from "./buildAtlasLayout";
import type { ConnectionDTO, ConnectionGraphDTO, MapDTO } from "@/types";

function map(label: string, width: number, height: number, connections: ConnectionDTO[] = []): MapDTO {
  return { label, map_constant: label, border_block: "0", connection_flags: [],
    width, height, asset: `${label}.animation.json`, connections };
}
function edge(label: string, direction: string, offset: number): ConnectionDTO {
  return { label, map_constant: label, direction, offset, target_present: true };
}

describe("connection layout coverage", () => {
  it("resolves a time-invariant map under the current atlas channel", () => {
    const den = { ...map("Den", 20, 18), asset: "maps/common/animated/Den.animation.json" };
    const layout = buildAtlasLayout({ root: "Den", map_count: 1, maps: { Den: den } }, {
      assetBaseUrl: "https://example.org/polished-atlas/dev/maps/day/animated/",
    });
    expect(new URL(layout.placements[0].asset).pathname).toBe("/polished-atlas/dev/maps/common/animated/Den.animation.json");
  });
  it("places both dual destinations and the route beyond them", () => {
    const graph: ConnectionGraphDTO = { root: "Route13", map_count: 4, maps: {
      Route13: map("Route13", 35, 10, [
        { ...edge("Route14", "south", 0), split_range: [null, 18] },
        { ...edge("LuckyIsland", "south", 9), split_range: [18, null] },
      ]),
      Route14: map("Route14", 9, 19, [edge("Route15", "west", 10)]),
      LuckyIsland: map("LuckyIsland", 26, 19),
      Route15: map("Route15", 20, 9),
    } };
    const layout = buildAtlasLayout(graph);
    const positions = Object.fromEntries(layout.placements.map((p) => [p.label, [p.xBlocks, p.yBlocks]]));
    expect(positions).toEqual({ Route13: [20, 0], Route14: [20, 10], LuckyIsland: [29, 10], Route15: [0, 20] });
    expect(layout.bounds).toEqual({ width: 55 * 32, height: 29 * 32 });
  });

  it("fails when a listed map cannot be placed instead of silently dropping it", () => {
    expect(() => buildAtlasLayout({ root: "Town", map_count: 2, maps: {
      Town: map("Town", 10, 8), Route: map("Route", 4, 12),
    } })).toThrow("unplaced maps: Route");
  });

  it("retains the one-block gatehouse overlap from either side of Route 36", () => {
    const graph: ConnectionGraphDTO = { root: "Route36", map_count: 2, maps: {
      Route36: map("Route36", 23, 9, [{ ...edge("Ruins", "south", 9), overlap_blocks: 1, layout_only: true }]),
      Ruins: map("Ruins", 14, 21, [{ ...edge("Route36", "north", -9), overlap_blocks: 1 }]),
    } };
    for (const rootOverride of ["Route36", "Ruins"]) {
      const layout = buildAtlasLayout(graph, { rootOverride });
      expect(Object.fromEntries(layout.placements.map(p => [p.label, [p.xBlocks, p.yBlocks]])))
        .toEqual({ Route36: [0, 0], Ruins: [9, 8] });
    }
  });
});
