import { useCallback, useEffect, useMemo, useState } from "react";
import { buildAtlasLayout } from "@/lib/buildAtlasLayout";
import {
  AtlasLayout,
  ConnectionGraphDTO,
  NeighborhoodManifest,
  NeighborhoodManifestEntry,
  NeighborhoodSummary,
} from "@/types";

const DEFAULT_BLOCK_PIXEL_SIZE = 32;
const DEFAULT_MARGIN_BLOCKS = 8;

type OffsetTuple = [number, number];

type NeighborhoodLayoutRecord = {
  entry: NeighborhoodManifestEntry;
  layout: AtlasLayout;
};

interface UseAtlasDataOptions {
  graphUrl?: string;
  manifestUrl?: string;
  rootLabel?: string;
}

interface UseAtlasDataResult {
  layout: AtlasLayout | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeBlocks(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

function parseOffsetBlocks(raw: NeighborhoodManifestEntry["offset_blocks"]): OffsetTuple | null {
  if (!Array.isArray(raw) || raw.length !== 2) {
    return null;
  }
  const [x, y] = raw;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
    return null;
  }
  return [Math.trunc(x), Math.trunc(y)];
}

function resolveBoundsBlocks(
  entry: NeighborhoodManifestEntry,
  layout: AtlasLayout,
  blockPixelSize: number
): { width: number; height: number } {
  const source = entry.bounds_blocks;
  const fallbackWidth = normalizeBlocks(layout.bounds.width / blockPixelSize);
  const fallbackHeight = normalizeBlocks(layout.bounds.height / blockPixelSize);
  if (!source || !isFiniteNumber(source.width) || !isFiniteNumber(source.height)) {
    return { width: fallbackWidth, height: fallbackHeight };
  }
  return {
    width: normalizeBlocks(source.width),
    height: normalizeBlocks(source.height),
  };
}

function combineNeighborhoodLayouts(
  records: NeighborhoodLayoutRecord[],
  marginBlocks: number = DEFAULT_MARGIN_BLOCKS,
  manifestVersion?: number
): AtlasLayout {
  if (records.length === 0) {
    return {
      root: "ALL_NEIGHBORHOODS",
      blockPixelSize: DEFAULT_BLOCK_PIXEL_SIZE,
      placements: [],
      bounds: { width: 0, height: 0 },
      metadata: {
        neighborhoods: [],
        source: "manifest",
      },
    };
  }

  const blockSizes = new Set(records.map((item) => item.layout.blockPixelSize));
  const blockPixelSize = records[0]?.layout.blockPixelSize || DEFAULT_BLOCK_PIXEL_SIZE;
  if (blockSizes.size > 1) {
    console.warn("Neighborhood manifests contain inconsistent block pixel sizes; using the first value.");
  }

  const sanitizedMargin = Math.max(0, Math.trunc(marginBlocks));
  const combinedPlacements: AtlasLayout["placements"] = [];
  const summaries: NeighborhoodSummary[] = [];
  const seenLabels = new Set<string>();

  const sortedRecords = records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const aRaw = a.record.entry.z_offset;
      const bRaw = b.record.entry.z_offset;
      const aZ = isFiniteNumber(aRaw) ? Math.trunc(aRaw) : Number.MAX_SAFE_INTEGER;
      const bZ = isFiniteNumber(bRaw) ? Math.trunc(bRaw) : Number.MAX_SAFE_INTEGER;
      if (aZ !== bZ) {
        return aZ - bZ;
      }
      return a.index - b.index;
    })
    .map((item) => item.record);

  let autoCursor = 0;
  let maxWidthPx = 0;
  let maxHeightPx = 0;
  let fallbackZ = 0;

  for (const record of sortedRecords) {
    const { entry, layout } = record;
    const offsetFromManifest = parseOffsetBlocks(entry.offset_blocks);
    const boundsBlocks = resolveBoundsBlocks(entry, layout, blockPixelSize);
    let offsetBlocks: OffsetTuple;
    if (offsetFromManifest) {
      offsetBlocks = offsetFromManifest;
    } else {
      offsetBlocks = [0, autoCursor];
      autoCursor += boundsBlocks.height + sanitizedMargin;
    }
    const rawZ = entry.z_offset;
    let zOffset: number;
    if (isFiniteNumber(rawZ)) {
      zOffset = Math.trunc(rawZ);
      fallbackZ = Math.max(fallbackZ, zOffset + 1);
    } else {
      zOffset = fallbackZ;
      fallbackZ += 1;
    }
    const offsetPixels: OffsetTuple = [offsetBlocks[0] * blockPixelSize, offsetBlocks[1] * blockPixelSize];

    summaries.push({
      id: entry.id,
      root: entry.root,
      graph: entry.graph,
      mapCount: entry.map_count,
      primaryType: entry.primary_type ?? null,
      boundsBlocks,
      offsetBlocks,
      zOffset,
    });

    for (const placement of layout.placements) {
      if (seenLabels.has(placement.label)) {
        console.warn(`Duplicate map label "${placement.label}" encountered across neighborhoods.`);
      }
      seenLabels.add(placement.label);
      combinedPlacements.push({
        ...placement,
        xBlocks: placement.xBlocks + offsetBlocks[0],
        yBlocks: placement.yBlocks + offsetBlocks[1],
        x: placement.x + offsetPixels[0],
        y: placement.y + offsetPixels[1],
        metadata: {
          ...placement.metadata,
          neighborhoodId: entry.id,
          neighborhoodRoot: entry.root,
          neighborhoodZ: zOffset,
        },
      });
    }

    maxWidthPx = Math.max(maxWidthPx, offsetPixels[0] + layout.bounds.width);
    maxHeightPx = Math.max(maxHeightPx, offsetPixels[1] + layout.bounds.height);
  }

  combinedPlacements.sort((a, b) => {
    const aZ = a.metadata.neighborhoodZ ?? 0;
    const bZ = b.metadata.neighborhoodZ ?? 0;
    if (aZ !== bZ) {
      return aZ - bZ;
    }
    return a.label.localeCompare(b.label);
  });

  return {
    root: "ALL_NEIGHBORHOODS",
    blockPixelSize,
    placements: combinedPlacements,
    bounds: {
      width: Math.max(0, maxWidthPx),
      height: Math.max(0, maxHeightPx),
    },
    metadata: {
      neighborhoods: summaries,
      source: "manifest",
      ...(manifestVersion !== undefined ? { manifestVersion } : {}),
    },
  };
}

export function useAtlasData(options: UseAtlasDataOptions): UseAtlasDataResult {
  const { graphUrl, manifestUrl, rootLabel } = options;
  const [layout, setLayout] = useState<AtlasLayout | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const resolvedRoot = rootLabel?.trim() ? rootLabel.trim() : undefined;

  useEffect(() => {
    const controller = new AbortController();

    const loadSingleGraph = async (url: string): Promise<AtlasLayout> => {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Failed to fetch connection graph (${response.status}).`);
      }
      const payload = (await response.json()) as ConnectionGraphDTO;
      const baseHref = new URL("./", response.url).toString();
      const singleLayout = buildAtlasLayout(payload, {
        rootOverride: resolvedRoot,
        assetBaseUrl: baseHref,
      });
      const blockPixelSize = singleLayout.blockPixelSize || DEFAULT_BLOCK_PIXEL_SIZE;
      const summary: NeighborhoodSummary = {
        id: singleLayout.root,
        root: singleLayout.root,
        graph: url,
        mapCount: payload.map_count ?? singleLayout.placements.length,
        primaryType: null,
        boundsBlocks: {
          width: normalizeBlocks(singleLayout.bounds.width / blockPixelSize),
          height: normalizeBlocks(singleLayout.bounds.height / blockPixelSize),
        },
        offsetBlocks: [0, 0],
        zOffset: 0,
      };
      const placementsWithMeta = singleLayout.placements.map((placement) => ({
        ...placement,
        metadata: {
          ...placement.metadata,
          neighborhoodId: placement.metadata?.neighborhoodId ?? singleLayout.root,
          neighborhoodRoot: placement.metadata?.neighborhoodRoot ?? singleLayout.root,
          neighborhoodZ: 0,
        },
      }));
      return {
        ...singleLayout,
        placements: placementsWithMeta,
        metadata: {
          neighborhoods: [summary],
          source: "graph",
        },
      };
    };

    const loadManifest = async (manifestHref: string): Promise<AtlasLayout> => {
      const manifestResponse = await fetch(manifestHref, { signal: controller.signal });
      if (!manifestResponse.ok) {
        throw new Error(`Failed to fetch neighborhood manifest (${manifestResponse.status}).`);
      }
      const manifestPayload = (await manifestResponse.json()) as NeighborhoodManifest;
      const entries = Array.isArray(manifestPayload.neighborhoods) ? manifestPayload.neighborhoods : [];
      const baseHref = new URL("./", manifestResponse.url).toString();
      const sortedEntries = entries
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => {
          const aZ = isFiniteNumber(a.entry.z_offset) ? Math.trunc(a.entry.z_offset as number) : Number.MAX_SAFE_INTEGER;
          const bZ = isFiniteNumber(b.entry.z_offset) ? Math.trunc(b.entry.z_offset as number) : Number.MAX_SAFE_INTEGER;
          if (aZ !== bZ) {
            return aZ - bZ;
          }
          return a.index - b.index;
        })
        .map((item) => item.entry);
      const layouts = await Promise.all(
        sortedEntries.map(async (entry: NeighborhoodManifestEntry) => {
          const graphHref = new URL(entry.graph, baseHref).toString();
          const graphResponse = await fetch(graphHref, { signal: controller.signal });
          if (!graphResponse.ok) {
            throw new Error(`Failed to fetch neighborhood graph (${graphResponse.status}).`);
          }
          const graphPayload = (await graphResponse.json()) as ConnectionGraphDTO;
          const graphBaseHref = new URL("./", graphResponse.url).toString();
          const layoutForEntry = buildAtlasLayout(graphPayload, {
            rootOverride: entry.root,
            assetBaseUrl: graphBaseHref,
          });
          return { entry, layout: layoutForEntry };
        })
      );
      return combineNeighborhoodLayouts(layouts, DEFAULT_MARGIN_BLOCKS, manifestPayload.version);
    };

    const run = async (): Promise<void> => {
      if (!manifestUrl && !graphUrl) {
        throw new Error("Either manifestUrl or graphUrl must be provided.");
      }
      setLoading(true);
      setError(null);
      try {
        if (manifestUrl) {
          const combined = await loadManifest(manifestUrl);
          setLayout(combined);
        } else if (graphUrl) {
          const single = await loadSingleGraph(graphUrl);
          setLayout(single);
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
        setLayout(null);
      } finally {
        setLoading(false);
      }
    };

    run().catch((err) => {
      console.error(err);
    });

    return () => {
      controller.abort();
    };
  }, [graphUrl, manifestUrl, resolvedRoot, nonce]);

  const reload = useCallback(() => {
    setNonce((value: number) => value + 1);
  }, []);

  return useMemo(
    () => ({ layout, loading, error, reload }),
    [layout, loading, error, reload]
  );
}

