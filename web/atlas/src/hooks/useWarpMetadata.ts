import { useCallback, useEffect, useMemo, useState } from "react";
import { joinBasePath, withBasePath, withVersion } from "@/lib/basePath";
import { decodeBase64 } from "@/lib/base64";
import type {
  MapCollisionDTO,
  MapCollisionMetadata,
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

function normaliseCollision(dto: MapCollisionDTO | null | undefined): MapCollisionMetadata | null {
  if (!dto) {
    return null;
  }
  const widthCells = toNumberOrNull(dto.width_cells);
  const heightCells = toNumberOrNull(dto.height_cells);
  if (widthCells === null || heightCells === null || widthCells <= 0 || heightCells <= 0) {
    return null;
  }
  const encoding = toStringOrNull(dto.encoding) ?? "base64";
  const rawCells = typeof dto.cells === "string" ? dto.cells.replace(/\s+/g, "") : "";
  let cellBytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  if (encoding === "base64" && rawCells) {
    try {
      const decoded = decodeBase64(rawCells);
      cellBytes = decoded.length > 0 ? Uint8Array.from(decoded) : new Uint8Array();
    } catch (error) {
      console.warn("Failed to decode collision payload", error);
      cellBytes = new Uint8Array();
    }
  }
  const expectedLength = widthCells * heightCells;
  if (cellBytes.length !== 0 && cellBytes.length !== expectedLength) {
    console.warn(
      `Collision payload length mismatch (expected ${expectedLength}, got ${cellBytes.length}).`,
    );
  }
  return {
    encoding,
    widthCells,
    heightCells,
    tilesetConstant: toStringOrNull(dto.tileset_constant),
    tilesetLabel: toStringOrNull(dto.tileset_label),
    tilesetIndex: toNumberOrNull(dto.tileset_index),
    cells: rawCells,
    cellBytes,
  };
}

function normaliseMapEntry(label: string, dto: MapMetadataDTO | undefined): MapMetadataEntry {
  const warpSource: WarpEntryDTO[] = Array.isArray(dto?.warps)
    ? (dto?.warps as WarpEntryDTO[])
    : [];
  const warps: MapWarp[] = warpSource.map((entry) =>
    normaliseWarp(entry, normaliseEndpoint(entry.target)),
  );
  return {
    label,
    mapConstant: toStringOrNull(dto?.map_constant),
    mapType: toStringOrNull(dto?.map_type),
    widthBlocks: toNumberOrNull(dto?.width_blocks),
    heightBlocks: toNumberOrNull(dto?.height_blocks),
    isOverworld: toBoolean(dto?.is_overworld, false),
    warps,
    collision: normaliseCollision(dto?.collision ?? null),
  };
}

function convertPayload(payload: WarpMetadataPayload): WarpMetadata {
  const maps: Record<string, MapMetadataEntry> = {};
  for (const [label, dto] of Object.entries(payload.maps ?? {})) {
    maps[label] = normaliseMapEntry(label, dto);
  }
  const cellsPerBlock = toNumberOrNull(payload.cells_per_block) ?? DEFAULT_CELLS_PER_BLOCK;
  const cellPixelSize = toNumberOrNull(payload.cell_pixel_size) ?? DEFAULT_CELL_PIXEL_SIZE;
  const collisionPermissions: number[] = Array.isArray(payload.collision_permissions)
    ? payload.collision_permissions
        .map((value) => toNumberOrNull(value))
        .filter((value): value is number => value !== null)
    : [];
  const collisionConstantsEntries: Array<[string, number]> = Object.entries(
    payload.collision_constants ?? {},
  )
    .map(([key, value]) => [key, toNumberOrNull(value)] as const)
    .filter((entry): entry is [string, number] => entry[1] !== null);
  const collisionConstants: Record<string, number> = Object.fromEntries(collisionConstantsEntries);
  return {
    version: toNumberOrNull(payload.version) ?? 1,
    generatedAt: toStringOrNull(payload.generated_at) ?? new Date().toISOString(),
    cellsPerBlock,
    cellPixelSize,
    maps,
    constantLookup: payload.constant_lookup ?? {},
    collisionPermissions,
    collisionConstants,
  };
}

export function resolveWarpMetadataUrl(): string {
  const override = toStringOrNull(import.meta.env.VITE_WARP_METADATA_URL);
  if (override) {
    return withVersion(withBasePath(override));
  }
  if (import.meta.env.DEV) {
    const repoRoot = typeof __REPO_ROOT__ === "string" ? __REPO_ROOT__ : "";
    if (repoRoot && typeof window !== "undefined" && window.location?.origin) {
      const normalised = `${repoRoot}/maps/warp_metadata.json`.replace(/\\/g, "/");
      const withSlash = normalised.startsWith("/") ? normalised : `/${normalised}`;
      return withVersion(`${window.location.origin}/@fs${encodeURI(withSlash)}`);
    }
  }
  return withVersion(joinBasePath("maps", "warp_metadata.json"));
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

  return useMemo(() => ({ metadata, loading, error, reload }), [metadata, loading, error, reload]);
}
