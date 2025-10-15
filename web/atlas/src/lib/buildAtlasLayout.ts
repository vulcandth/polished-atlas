import { AtlasLayout, ConnectionDTO, ConnectionDirection, ConnectionGraphDTO, MapPlacement } from "@/types";

const DEFAULT_BLOCK_PIXEL_SIZE = 32;

type PlacementSeed = {
  label: string;
  xBlocks: number;
  yBlocks: number;
  widthBlocks: number;
  heightBlocks: number;
};

type PlacementLookup = Map<string, PlacementSeed>;

interface BuildAtlasLayoutOptions {
  rootOverride?: string;
  assetBaseUrl?: string;
}

export function buildAtlasLayout(graph: ConnectionGraphDTO, options: BuildAtlasLayoutOptions = {}): AtlasLayout {
  const blockPixelSize = graph.block_pixel_size ?? DEFAULT_BLOCK_PIXEL_SIZE;
  const rootLabel = options.rootOverride ?? graph.root;
  const rootMap = graph.maps[rootLabel];
  if (!rootMap) {
    throw new Error(`Root map "${rootLabel}" not present in connection graph.`);
  }
  const width = normalizeDimension(rootMap.width);
  const height = normalizeDimension(rootMap.height);
  if (width === null || height === null) {
    throw new Error(`Map "${rootLabel}" is missing width/height metadata.`);
  }

  const placements: PlacementLookup = new Map();
  placements.set(rootLabel, {
    label: rootLabel,
    xBlocks: 0,
    yBlocks: 0,
    widthBlocks: width,
    heightBlocks: height,
  });

  const queue: string[] = [rootLabel];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const currentLabel = queue.shift()!;
    if (visited.has(currentLabel)) {
      continue;
    }
    visited.add(currentLabel);
    const currentMap = graph.maps[currentLabel];
    const currentPlacement = placements.get(currentLabel);
    if (!currentMap || !currentPlacement) {
      continue;
    }

    for (const connection of currentMap.connections) {
      if (!connection.target_present) {
        continue;
      }
      const neighbour = graph.maps[connection.label];
      if (!neighbour) {
        continue;
      }
      const neighbourWidth = normalizeDimension(neighbour.width);
      const neighbourHeight = normalizeDimension(neighbour.height);
      if (neighbourWidth === null || neighbourHeight === null) {
        continue;
      }
      const { xBlocks, yBlocks } = projectNeighbour(
        currentPlacement,
        neighbourWidth,
        neighbourHeight,
        connection
      );
      const existing = placements.get(neighbour.label);
      if (existing) {
        if (existing.xBlocks !== xBlocks || existing.yBlocks !== yBlocks) {
          console.warn(
            `Conflicting placement for map ${neighbour.label}: existing (${existing.xBlocks}, ${existing.yBlocks}) vs new (${xBlocks}, ${yBlocks}).`
          );
        }
        continue;
      }
      placements.set(neighbour.label, {
        label: neighbour.label,
        xBlocks,
        yBlocks,
        widthBlocks: neighbourWidth,
        heightBlocks: neighbourHeight,
      });
      queue.push(neighbour.label);
    }
  }

  const placementList = [...placements.values()];
  const minX = Math.min(...placementList.map((p) => p.xBlocks));
  const minY = Math.min(...placementList.map((p) => p.yBlocks));
  const maxX = Math.max(...placementList.map((p) => p.xBlocks + p.widthBlocks));
  const maxY = Math.max(...placementList.map((p) => p.yBlocks + p.heightBlocks));

  const placementsWithPixels: MapPlacement[] = placementList.map((seed) => {
    const dto = graph.maps[seed.label];
    const x = (seed.xBlocks - minX) * blockPixelSize;
    const y = (seed.yBlocks - minY) * blockPixelSize;
    const widthPx = seed.widthBlocks * blockPixelSize;
    const heightPx = seed.heightBlocks * blockPixelSize;
    const assetUrl = dto?.asset ? resolveAssetHref(dto.asset, options.assetBaseUrl) : "";
    return {
      label: seed.label,
      xBlocks: seed.xBlocks - minX,
      yBlocks: seed.yBlocks - minY,
      widthBlocks: seed.widthBlocks,
      heightBlocks: seed.heightBlocks,
      x,
      y,
      widthPx,
      heightPx,
      asset: assetUrl,
      connections: dto?.connections ?? [],
      metadata: {
        mapType: dto?.map_type ?? null,
        tileset: dto?.tileset ?? null,
      },
    };
  });

  const widthPx = Math.max(0, maxX - minX) * blockPixelSize;
  const heightPx = Math.max(0, maxY - minY) * blockPixelSize;

  return {
    root: rootLabel,
    blockPixelSize,
    placements: placementsWithPixels,
    bounds: {
      width: widthPx,
      height: heightPx,
    },
  };
}

function normalizeDimension(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

function projectNeighbour(
  sourcePlacement: PlacementSeed,
  targetWidth: number,
  targetHeight: number,
  connection: ConnectionDTO
): { xBlocks: number; yBlocks: number } {
  const offset = Math.trunc(connection.offset);
  const direction = connection.direction as ConnectionDirection;
  switch (direction) {
    case "north":
      return {
        xBlocks: sourcePlacement.xBlocks + offset,
        yBlocks: sourcePlacement.yBlocks - targetHeight,
      };
    case "south":
      return {
        xBlocks: sourcePlacement.xBlocks + offset,
        yBlocks: sourcePlacement.yBlocks + sourcePlacement.heightBlocks,
      };
    case "west":
      return {
        xBlocks: sourcePlacement.xBlocks - targetWidth,
        yBlocks: sourcePlacement.yBlocks + offset,
      };
    case "east":
      return {
        xBlocks: sourcePlacement.xBlocks + sourcePlacement.widthBlocks,
        yBlocks: sourcePlacement.yBlocks + offset,
      };
    default:
      console.warn(`Unsupported connection direction "${connection.direction}".`);
      return {
        xBlocks: sourcePlacement.xBlocks,
        yBlocks: sourcePlacement.yBlocks,
      };
  }
}

function resolveAssetHref(asset: string, baseHref?: string): string {
  const trimmed = asset.trim();
  if (!trimmed) {
    return "";
  }
  if (/^(?:[a-z]+:)?\/\//i.test(trimmed) || trimmed.startsWith("/")) {
    return trimmed;
  }
  if (!baseHref) {
    return trimmed;
  }
  try {
    const base = new URL(baseHref);
    const normalizedBase = base.href.endsWith("/") ? base.href : `${base.href}/`;
    const timeSpecificMatch = /^maps\/([^/]+)\/animated\//.exec(trimmed);
    if (timeSpecificMatch) {
      const slug = timeSpecificMatch[1];
      const prefixLength = timeSpecificMatch[0].length;
      if (normalizedBase.includes(`/maps/${slug}/animated/`)) {
        const relativePath = trimmed.slice(prefixLength);
        return new URL(relativePath, normalizedBase).toString();
      }
      if (typeof window !== "undefined" && window.location?.origin) {
        return new URL(trimmed, window.location.origin).toString();
      }
      return trimmed;
    }
    return new URL(trimmed, normalizedBase).toString();
  } catch {
    return trimmed;
  }
}
