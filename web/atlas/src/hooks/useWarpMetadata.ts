import { useCallback, useEffect, useMemo, useState } from "react";
import { joinBasePath, withBasePath } from "@/lib/basePath";
import type {
  MapMetadataDTO,
  MapMetadataEntry,
  MapWarp,
  WarpEndpoint,
  WarpEndpointDTO,
  WarpEntryDTO,
  WarpMetadata,
  WarpMetadataPayload,
} from "@/types";

const DEFAULT_CELLS_PER_BLOCK = 2;
const DEFAULT_CELL_PIXEL_SIZE = 16;

interface UseWarpMetadataOptions {
  url?: string;
}

interface UseWarpMetadataResult {
  metadata: WarpMetadata | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value === 0) {
    return 0;
  }
  const truncated = Math.trunc(value);
  return Number.isFinite(truncated) ? truncated : null;
}

function toBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  return fallback;
}

function normaliseEndpoint(dto: WarpEndpointDTO | undefined): WarpEndpoint {
  const warpIndex = toNumberOrNull(dto?.warp_index);
  return {
    mapConstant: toStringOrNull(dto?.map_constant),
    mapLabel: toStringOrNull(dto?.map_label),
    warpIndex: warpIndex,
    mapType: toStringOrNull(dto?.map_type),
    isOverworld: toBoolean(dto?.is_overworld, false),
    xCells: toNumberOrNull(dto?.x_cells),
    yCells: toNumberOrNull(dto?.y_cells),
  };
}

function normaliseWarp(dto: WarpEntryDTO, endpoint: WarpEndpoint): MapWarp {
  return {
    index: toNumberOrNull(dto.index) ?? 0,
    xCells: toNumberOrNull(dto.x_cells),
    yCells: toNumberOrNull(dto.y_cells),
    target: endpoint,
  };
}

function normaliseMapEntry(label: string, dto: MapMetadataDTO | undefined): MapMetadataEntry {
  const warpSource: WarpEntryDTO[] = Array.isArray(dto?.warps) ? (dto?.warps as WarpEntryDTO[]) : [];
  const warps: MapWarp[] = warpSource.map((entry) => normaliseWarp(entry, normaliseEndpoint(entry.target)));
  return {
    label,
    mapConstant: toStringOrNull(dto?.map_constant),
    mapType: toStringOrNull(dto?.map_type),
    widthBlocks: toNumberOrNull(dto?.width_blocks),
    heightBlocks: toNumberOrNull(dto?.height_blocks),
    isOverworld: toBoolean(dto?.is_overworld, false),
    warps,
  };
}

function convertPayload(payload: WarpMetadataPayload): WarpMetadata {
  const maps: Record<string, MapMetadataEntry> = {};
  for (const [label, dto] of Object.entries(payload.maps ?? {})) {
    maps[label] = normaliseMapEntry(label, dto);
  }
  const cellsPerBlock = toNumberOrNull(payload.cells_per_block) ?? DEFAULT_CELLS_PER_BLOCK;
  const cellPixelSize = toNumberOrNull(payload.cell_pixel_size) ?? DEFAULT_CELL_PIXEL_SIZE;
  return {
    version: toNumberOrNull(payload.version) ?? 1,
    generatedAt: toStringOrNull(payload.generated_at) ?? new Date().toISOString(),
    cellsPerBlock,
    cellPixelSize,
    maps,
    constantLookup: payload.constant_lookup ?? {},
  };
}

export function resolveWarpMetadataUrl(): string {
  const override = toStringOrNull(import.meta.env.VITE_WARP_METADATA_URL);
  if (override) {
    return withBasePath(override);
  }
  if (import.meta.env.DEV) {
    const repoRoot = typeof __REPO_ROOT__ === "string" ? __REPO_ROOT__ : "";
    if (repoRoot && typeof window !== "undefined" && window.location?.origin) {
      const normalised = `${repoRoot}/maps/warp_metadata.json`.replace(/\\/g, "/");
      const withSlash = normalised.startsWith("/") ? normalised : `/${normalised}`;
      return `${window.location.origin}/@fs${encodeURI(withSlash)}`;
    }
  }
  return joinBasePath("maps", "warp_metadata.json");
}

export function useWarpMetadata(options: UseWarpMetadataOptions = {}): UseWarpMetadataResult {
  const [metadata, setMetadata] = useState<WarpMetadata | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const resolvedUrl = useMemo(() => {
    const provided = toStringOrNull(options.url);
    return provided ?? resolveWarpMetadataUrl();
  }, [options.url]);

  useEffect(() => {
    const controller = new AbortController();
    const run = async (): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(resolvedUrl, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Failed to fetch warp metadata (${response.status}).`);
        }
        const payload = (await response.json()) as WarpMetadataPayload;
        setMetadata(convertPayload(payload));
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          return;
        }
        console.error("Failed to load warp metadata", err);
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
        setMetadata(null);
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
  }, [resolvedUrl, nonce]);

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return useMemo(
    () => ({ metadata, loading, error, reload }),
    [metadata, loading, error, reload]
  );
}
