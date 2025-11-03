import { useCallback, useEffect, useMemo, useState } from "react";
import { joinBasePath, withBasePath, withVersion } from "@/lib/basePath";
import type {
  BgPalettesMapEntry,
  BgPalettesMetadata,
  BgPalettesPayloadDTO,
  RgbTuple,
} from "@/types";

interface UseBgPalettesOptions {
  url?: string;
}

interface UseBgPalettesResult {
  metadata: BgPalettesMetadata | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

function normalizeMapEntry(
  label: string,
  entry: BgPalettesMapEntry | undefined,
): BgPalettesMapEntry {
  const normalized: BgPalettesMapEntry = {
    label,
    map_constant: entry?.map_constant ?? null,
    map_type: entry?.map_type ?? null,
    palettes: {},
  } as BgPalettesMapEntry;
  const src = entry?.palettes ?? {};
  for (const [time, rows] of Object.entries(src)) {
    if (!Array.isArray(rows)) continue;
    const clamped: RgbTuple[][] = [];
    for (const row of rows as unknown as RgbTuple[][]) {
      const colors = Array.isArray(row) ? (row.slice(0, 4) as RgbTuple[]) : [];
      while (colors.length < 4) {
        colors.push(colors[colors.length - 1] ?? [0, 0, 0]);
      }
      clamped.push(colors.slice(0, 4));
    }
    while (clamped.length < 8) {
      clamped.push(
        clamped[clamped.length - 1] ?? [
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
        ],
      );
    }
    normalized.palettes[time] = clamped.slice(0, 8);
  }
  return normalized;
}

function convertPayload(dto: BgPalettesPayloadDTO): BgPalettesMetadata {
  const maps: Record<string, BgPalettesMapEntry> = {};
  for (const [label, entry] of Object.entries(dto.maps ?? {})) {
    maps[label] = normalizeMapEntry(label, entry);
  }
  return {
    version: toNumberOrNull(dto.version) ?? 1,
    generatedAt: toStringOrNull(dto.generated_at) ?? new Date().toISOString(),
    weekday: toNumberOrNull(dto.weekday),
    maps,
  };
}

export function resolveBgPalettesUrl(): string {
  const override = toStringOrNull(import.meta.env.VITE_BG_PALETTE_METADATA_URL);
  if (override) {
    return withVersion(withBasePath(override));
  }
  if (import.meta.env.DEV) {
    const repoRoot = typeof __REPO_ROOT__ === "string" ? __REPO_ROOT__ : "";
    if (repoRoot && typeof window !== "undefined" && window.location?.origin) {
      const raw = `${repoRoot}/maps/bg_palette_metadata.json`.replace(/\\/g, "/");
      const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
      return withVersion(`${window.location.origin}/@fs${encodeURI(withSlash)}`);
    }
  }
  return withVersion(joinBasePath("maps", "bg_palette_metadata.json"));
}

export function useBgPalettes(options: UseBgPalettesOptions = {}): UseBgPalettesResult {
  const [metadata, setMetadata] = useState<BgPalettesMetadata | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const resolvedUrl = useMemo(() => {
    const provided = toStringOrNull(options.url);
    return provided ?? resolveBgPalettesUrl();
  }, [options.url]);

  useEffect(() => {
    const controller = new AbortController();
    const run = async (): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(resolvedUrl, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Failed to fetch bg palettes (${response.status}).`);
        }
        const payload = (await response.json()) as BgPalettesPayloadDTO;
        setMetadata(convertPayload(payload));
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        console.error("Failed to load bg palettes", err);
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
        setMetadata(null);
      } finally {
        setLoading(false);
      }
    };

    run().catch((err) => console.error(err));
    return () => controller.abort();
  }, [resolvedUrl, nonce]);

  const reload = useCallback(() => setNonce((v) => v + 1), []);

  return useMemo(() => ({ metadata, loading, error, reload }), [metadata, loading, error, reload]);
}
