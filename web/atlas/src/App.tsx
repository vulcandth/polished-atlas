import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MapCanvas, { type MapCanvasHandle, type MapViewState, type WarpBacklink } from "@/components/MapCanvas";
import type { SearchResult } from "@/components/MapSearch";
import ZoomControls from "@/components/ZoomControls";
import HelpPanel from "@/components/HelpPanel";
import OverlayBreadcrumb from "@/components/OverlayBreadcrumb";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useAtlasData } from "@/hooks/useAtlasData";
import { useObjectMetadata } from "@/hooks/useObjectMetadata";
import { useWarpMetadata } from "@/hooks/useWarpMetadata";
import { useBgPalettes } from "@/hooks/useBgPalettes";
import { useUrlState, type UrlViewState } from "@/hooks/useUrlState";
import { joinBasePath, withBasePath, withVersion } from "@/lib/basePath";
import { takeScreenshot } from "@/lib/screenshot";
import type { NeighborhoodSummary } from "@/types";
import { MIN_SCALE, MAX_SCALE } from "@/components/MapCanvas/constants";
import HeaderNav, { TIME_OF_DAY_OPTIONS, TimeOfDaySlug } from "./components/HeaderNav";

const DEFAULT_ROOT = import.meta.env.VITE_ROOT_MAP ?? "NewBarkTown";
const MANIFEST_OVERRIDE = import.meta.env.VITE_NEIGHBORHOOD_MANIFEST_URL?.trim() || "";
const TIME_STORAGE_KEY = "polished-atlas/time-of-day";

// Persisted performance settings (shared with MapCanvas)
const PERF_SETTINGS_STORAGE_KEY = "polished-atlas:perf-settings";
type PerfSettingsState = { disableMapAnimations: boolean; disableObjectAnimations: boolean };
function readPerfSettings(): PerfSettingsState {
  if (typeof window === "undefined")
    return { disableMapAnimations: false, disableObjectAnimations: false };
  try {
    const raw = window.localStorage.getItem(PERF_SETTINGS_STORAGE_KEY);
    if (!raw) return { disableMapAnimations: false, disableObjectAnimations: false };
    const parsed = JSON.parse(raw) as Partial<PerfSettingsState> | undefined;
    return {
      disableMapAnimations: Boolean(parsed?.disableMapAnimations),
      disableObjectAnimations: Boolean(parsed?.disableObjectAnimations),
    };
  } catch {
    return { disableMapAnimations: false, disableObjectAnimations: false };
  }
}
function writePerfSettings(next: PerfSettingsState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PERF_SETTINGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

const POLISHED_VERSION = (() => {
  const raw = import.meta.env.VITE_POLISHED_CRYSTAL_VERSION;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return "v3.2.3";
})();

function sanitizeTimeOfDay(value: unknown): TimeOfDaySlug {
  const text = typeof value === "string" ? value : value != null ? String(value) : "";
  const normalized = text.trim().toLowerCase();
  const match = TIME_OF_DAY_OPTIONS.find((option) => option.value === normalized);
  return match ? match.value : "day";
}

const DEFAULT_TIME_OF_DAY: TimeOfDaySlug = sanitizeTimeOfDay(
  import.meta.env.VITE_ATLAS_TIME ?? "day",
);

type OffsetTuple = [number, number];

function snapToHalf(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 2) / 2;
}

function cloneOffsetMap(source: Record<string, OffsetTuple>): Record<string, OffsetTuple> {
  const entries = Object.entries(source).map(([key, value]) => [
    key,
    [value[0], value[1]] as OffsetTuple,
  ]);
  return Object.fromEntries(entries);
}

function offsetMapsEqual(a: Record<string, OffsetTuple>, b: Record<string, OffsetTuple>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const left = a[key];
    const right = b[key];
    if (!left || !right) {
      if (left === undefined && right === undefined) {
        continue;
      }
      return false;
    }
    if (left[0] !== right[0] || left[1] !== right[1]) {
      return false;
    }
  }
  return true;
}

function numberMapsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const left = a[key] ?? 0;
    const right = b[key] ?? 0;
    if (left !== right) {
      return false;
    }
  }
  return true;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  if (target.isContentEditable) {
    return true;
  }
  return false;
}

function manifestUrlForSlug(timeSlug: TimeOfDaySlug): string {
  if (MANIFEST_OVERRIDE) {
    return withVersion(withBasePath(MANIFEST_OVERRIDE));
  }
  if (import.meta.env.DEV) {
    const repoRoot = typeof __REPO_ROOT__ === "string" ? __REPO_ROOT__ : "";
    if (repoRoot && typeof window !== "undefined" && window.location?.origin) {
      const rawPath = `${repoRoot}/maps/${timeSlug}/animated/map_neighborhoods.json`.replace(
        /\\/g,
        "/",
      );
      const withLeadingSlash = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
      return withVersion(`${window.location.origin}/@fs${encodeURI(withLeadingSlash)}`);
    }
  }
  return withVersion(joinBasePath("maps", timeSlug, "animated", "map_neighborhoods.json"));
}

function deriveDataSources(timeSlug: TimeOfDaySlug): {
  graphUrl?: string;
  manifestUrl?: string;
  rootLabel?: string;
  supportsTimeSelection: boolean;
} {
  const graphEnv = import.meta.env.VITE_CONNECTION_GRAPH_URL?.trim();
  if (graphEnv) {
    return {
      graphUrl: withBasePath(graphEnv),
      manifestUrl: undefined,
      rootLabel: DEFAULT_ROOT,
      supportsTimeSelection: false,
    };
  }
  const manifestUrl = manifestUrlForSlug(timeSlug);
  return {
    graphUrl: undefined,
    manifestUrl,
    rootLabel: undefined,
    supportsTimeSelection: MANIFEST_OVERRIDE.length === 0,
  };
}

export default function App() {
  const [timeOfDay, setTimeOfDay] = useState<TimeOfDaySlug>(() => {
    if (typeof window === "undefined") {
      return DEFAULT_TIME_OF_DAY;
    }
    const stored = window.localStorage.getItem(TIME_STORAGE_KEY);
    return sanitizeTimeOfDay(stored ?? DEFAULT_TIME_OF_DAY);
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(TIME_STORAGE_KEY, timeOfDay);
    }
  }, [timeOfDay]);

  const { graphUrl, manifestUrl, rootLabel, supportsTimeSelection } = deriveDataSources(timeOfDay);
  const { layout, loading, error, reload } = useAtlasData({
    graphUrl,
    manifestUrl,
    rootLabel,
  });
  const {
    metadata: warpMetadata,
    loading: warpLoading,
    error: warpError,
    reload: warpReload,
  } = useWarpMetadata();
  const {
    metadata: bgPalettes,
    loading: bgLoading,
    error: bgError,
    reload: bgReload,
  } = useBgPalettes();
  const {
    metadata: objectMetadata,
    loading: objectLoading,
    error: objectError,
    reload: objectReload,
  } = useObjectMetadata();
  const isLoading = loading || warpLoading || objectLoading || bgLoading;

  // New UI state
  const mapCanvasRef = useRef<MapCanvasHandle>(null);
  const [currentScale, setCurrentScale] = useState(1);
  const [helpPanelOpen, setHelpPanelOpen] = useState(false);

  // URL deep-linking
  const handleUrlStateChange = useCallback((state: UrlViewState) => {
    if (mapCanvasRef.current) {
      if (state.x !== undefined && state.y !== undefined) {
        mapCanvasRef.current.focusWorldOn(state.x, state.y);
      }
      if (state.zoom !== undefined) {
        mapCanvasRef.current.setScale(state.zoom);
      }
    }
  }, []);

  const { getInitialState, updateUrl } = useUrlState({
    onStateChange: handleUrlStateChange,
  });

  // Apply initial URL state on mount
  useEffect(() => {
    const initialState = getInitialState();
    if (initialState.zoom !== undefined || initialState.x !== undefined) {
      handleUrlStateChange(initialState);
    }
  }, [getInitialState, handleUrlStateChange]);

  // Handle view state changes from MapCanvas
  const handleViewStateChange = useCallback(
    (viewState: MapViewState) => {
      setCurrentScale(viewState.scale);
      updateUrl(
        {
          x: Math.round(viewState.centerWorldX),
          y: Math.round(viewState.centerWorldY),
          zoom: viewState.scale,
        },
        true, // replace instead of push to avoid polluting history
      );
    },
    [updateUrl],
  );

  // Search navigation
  const handleSearchSelect = useCallback((result: SearchResult) => {
    if (result.x !== undefined && result.y !== undefined && mapCanvasRef.current) {
      mapCanvasRef.current.focusWorldOn(result.x, result.y);
    }
  }, []);

  // Zoom controls
  const handleZoom = useCallback((newScale: number) => {
    if (mapCanvasRef.current) {
      mapCanvasRef.current.setScale(newScale);
    }
  }, []);

  // Reset view to fit entire atlas
  const handleResetView = useCallback(() => {
    mapCanvasRef.current?.resetView();
  }, []);

  // Screenshot
  const handleScreenshot = useCallback(async () => {
    const app = mapCanvasRef.current?.getApp();
    if (app) {
      try {
        await takeScreenshot(app, { filename: `polished-atlas-${Date.now()}` });
      } catch (err) {
        console.error("Screenshot failed:", err);
      }
    }
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

      switch (e.key) {
        case "?":
          e.preventDefault();
          setHelpPanelOpen(true);
          break;
        case "/":
          e.preventDefault();
          document.querySelector<HTMLInputElement>(".map-search input")?.focus();
          break;
        case "Escape":
          setHelpPanelOpen(false);
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const neighborhoods: NeighborhoodSummary[] = useMemo(
    () => layout?.metadata?.neighborhoods ?? [],
    [layout],
  );
  const assetResolver = useMemo(() => {
    const fallback = (rawLabel: string): string => {
      const trimmed = rawLabel.trim();
      return withVersion(joinBasePath("maps", timeOfDay, "animated", `${trimmed}.animation.json`));
    };
    if (!layout?.placements?.length) {
      return fallback;
    }
    const assetsByLabel = new Map<string, string>();
    let templateAsset: string | null = null;
    for (const placement of layout.placements) {
      if (!placement.asset) {
        continue;
      }
      const normalisedLabel = placement.label.trim();
      if (normalisedLabel.length > 0) {
        assetsByLabel.set(normalisedLabel, placement.asset);
      }
      const normalisedAsset = placement.asset.replace(/\\/g, "/");
      if (!templateAsset && /\/maps\/[^/]+\/animated\//.test(normalisedAsset)) {
        templateAsset = placement.asset;
      }
    }

    const rewriteWithSlug = (rawAsset: string, slug: string): string | null => {
      const normalised = rawAsset.replace(/\\/g, "/");
      const pattern = /^(.*\/maps\/)([^/]+)(\/animated\/)([^/]+\.animation\.json)(\?.*)?$/;
      const match = pattern.exec(normalised);
      if (!match) {
        return null;
      }
      const [, prefix, , animatedSegment, filename, query = ""] = match;
      return `${prefix}${slug}${animatedSegment}${filename}${query}`;
    };

    const rewriteWithLabel = (rawAsset: string, slug: string, label: string): string | null => {
      const normalised = rawAsset.replace(/\\/g, "/");
      const pattern = /^(.*\/maps\/)([^/]+)(\/animated\/)([^/]+?)(\.animation\.json)(\?.*)?$/;
      const match = pattern.exec(normalised);
      if (!match) {
        return null;
      }
      const [, prefix, , animatedSegment, , extension, query = ""] = match;
      const trimmed = label.trim();
      const target = trimmed.length > 0 ? trimmed : label;
      return `${prefix}${slug}${animatedSegment}${target}${extension}${query}`;
    };

    const resolveAsset = (rawAsset: string): string => {
      const normalised = rawAsset.replace(/\\/g, "/");
      if (/\/maps\/common\/animated\//.test(normalised)) {
        return withVersion(withBasePath(normalised));
      }
      const rewritten = rewriteWithSlug(normalised, timeOfDay);
      if (rewritten) {
        return withVersion(withBasePath(rewritten));
      }
      return withVersion(withBasePath(normalised));
    };

    return (mapLabel: string): string => {
      const trimmedLabel = mapLabel.trim();
      if (trimmedLabel.length > 0 && assetsByLabel.has(trimmedLabel)) {
        return resolveAsset(assetsByLabel.get(trimmedLabel)!);
      }
      if (templateAsset && trimmedLabel.length > 0) {
        const rewritten = rewriteWithLabel(templateAsset, timeOfDay, trimmedLabel);
        if (rewritten) {
          return withVersion(withBasePath(rewritten));
        }
      }
      return fallback(trimmedLabel);
    };
  }, [layout, timeOfDay]);

  const [editing, setEditing] = useState(false);
  const [offsetOverrides, setOffsetOverrides] = useState<Record<string, OffsetTuple>>({});
  const [zOverrides, setZOverrides] = useState<Record<string, number>>({});
  const [selectedNeighborhoodId, setSelectedNeighborhoodId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  const baseOffsetsRef = useRef<Record<string, OffsetTuple>>({});
  const baseZRef = useRef<Record<string, number>>({});

  useEffect(() => {
    if (!neighborhoods.length) {
      baseOffsetsRef.current = {};
      baseZRef.current = {};
      if (!editing) {
        setOffsetOverrides({});
        setZOverrides({});
        setSelectedNeighborhoodId(null);
      }
      return;
    }

    const nextBaseOffsets: Record<string, OffsetTuple> = {};
    const nextBaseZ: Record<string, number> = {};
    for (const neighborhood of neighborhoods) {
      const offset: OffsetTuple = [
        snapToHalf(neighborhood.offsetBlocks[0]),
        snapToHalf(neighborhood.offsetBlocks[1]),
      ];
      const z = Number.isFinite(neighborhood.zOffset) ? Math.trunc(neighborhood.zOffset ?? 0) : 0;
      nextBaseOffsets[neighborhood.id] = offset;
      nextBaseZ[neighborhood.id] = z;
    }

    baseOffsetsRef.current = cloneOffsetMap(nextBaseOffsets);
    baseZRef.current = { ...nextBaseZ };

    if (!editing) {
      if (!offsetMapsEqual(offsetOverrides, nextBaseOffsets)) {
        setOffsetOverrides(cloneOffsetMap(nextBaseOffsets));
      }
      if (!numberMapsEqual(zOverrides, nextBaseZ)) {
        setZOverrides({ ...nextBaseZ });
      }
      const preferredId = neighborhoods[0]?.id ?? null;
      if (
        (!selectedNeighborhoodId || !nextBaseOffsets[selectedNeighborhoodId]) &&
        selectedNeighborhoodId !== preferredId
      ) {
        setSelectedNeighborhoodId(preferredId ?? null);
      }
    } else if (selectedNeighborhoodId && !nextBaseOffsets[selectedNeighborhoodId]) {
      const fallbackId = neighborhoods[0]?.id ?? null;
      if (selectedNeighborhoodId !== fallbackId) {
        setSelectedNeighborhoodId(fallbackId ?? null);
      }
    }
  }, [neighborhoods, editing, selectedNeighborhoodId, offsetOverrides, zOverrides]);

  const handleSelectNeighborhood = useCallback((id: string) => {
    setSelectedNeighborhoodId(id);
  }, []);

  const handleReloadClick = useCallback(() => {
    reload();
    warpReload();
    bgReload();
    objectReload();
  }, [reload, warpReload, bgReload, objectReload]);

  const handleOffsetChange = useCallback((id: string, next: OffsetTuple) => {
    setOffsetOverrides((current) => {
      const snapped: OffsetTuple = [snapToHalf(next[0]), snapToHalf(next[1])];
      const existing = current[id];
      if (existing && existing[0] === snapped[0] && existing[1] === snapped[1]) {
        return current;
      }
      return { ...current, [id]: snapped };
    });
  }, []);

  const nudgeOffset = useCallback((id: string, deltaX: number, deltaY: number) => {
    setOffsetOverrides((current) => {
      const base = current[id] ?? baseOffsetsRef.current[id] ?? [0, 0];
      const next: OffsetTuple = [snapToHalf(base[0] + deltaX), snapToHalf(base[1] + deltaY)];
      if (base[0] === next[0] && base[1] === next[1]) {
        return current;
      }
      return { ...current, [id]: next };
    });
  }, []);

  const handleZChange = useCallback((id: string, value: number) => {
    setZOverrides((current) => {
      const nextValue = Number.isFinite(value) ? Math.trunc(value) : 0;
      if (current[id] === nextValue) {
        return current;
      }
      return { ...current, [id]: nextValue };
    });
  }, []);

  const handleTimeOfDayChange = useCallback(
    (nextValue: string) => {
      const next = sanitizeTimeOfDay(nextValue);
      if (next === timeOfDay) {
        return;
      }
      setTimeOfDay(next);
      setSaveStatus("idle");
      setSaveError(null);
    },
    [timeOfDay],
  );

  const hasPendingChanges = useMemo(() => {
    if (!editing) {
      return false;
    }
    if (!neighborhoods.length) {
      return false;
    }
    for (const neighborhood of neighborhoods) {
      const id = neighborhood.id;
      const baseOffset = baseOffsetsRef.current[id] ?? [0, 0];
      const overrideOffset = offsetOverrides[id] ?? baseOffset;
      if (overrideOffset[0] !== baseOffset[0] || overrideOffset[1] !== baseOffset[1]) {
        return true;
      }
      const baseZ = baseZRef.current[id] ?? 0;
      const overrideZ = zOverrides[id] ?? baseZ;
      if (overrideZ !== baseZ) {
        return true;
      }
    }
    return false;
  }, [editing, neighborhoods, offsetOverrides, zOverrides]);

  const persistOverrides = useCallback(async () => {
    if (!layout?.metadata?.neighborhoods?.length) {
      return;
    }
    const normalizedOffsets: Record<string, OffsetTuple> = {};
    const normalizedZ: Record<string, number> = {};
    const payload = layout.metadata.neighborhoods.map((summary) => {
      const baseOffset = baseOffsetsRef.current[summary.id] ?? [0, 0];
      const overrideOffset = offsetOverrides[summary.id] ?? baseOffset;
      const snapped: OffsetTuple = [snapToHalf(overrideOffset[0]), snapToHalf(overrideOffset[1])];
      const baseZ = baseZRef.current[summary.id] ?? 0;
      const overrideZ = zOverrides[summary.id] ?? baseZ;
      const normalizedZValue = Number.isFinite(overrideZ) ? Math.trunc(overrideZ) : 0;
      normalizedOffsets[summary.id] = snapped;
      normalizedZ[summary.id] = normalizedZValue;
      return {
        id: summary.id,
        offset_blocks: snapped,
        z_offset: normalizedZValue,
      };
    });

    const response = await fetch("/__atlas/update-neighborhoods", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ neighborhoods: payload }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Failed to update neighborhoods (status ${response.status})`);
    }

    baseOffsetsRef.current = cloneOffsetMap(normalizedOffsets);
    baseZRef.current = { ...normalizedZ };
    setOffsetOverrides(cloneOffsetMap(normalizedOffsets));
    setZOverrides({ ...normalizedZ });
  }, [layout, offsetOverrides, zOverrides]);

  const canEdit =
    import.meta.env.DEV &&
    Boolean(manifestUrl) &&
    neighborhoods.length > 0 &&
    !graphUrl &&
    timeOfDay === "day";

  useEffect(() => {
    if (editing && !canEdit) {
      setEditing(false);
      setSaveStatus("idle");
      setSaveError(null);
    }
  }, [canEdit, editing]);

  useEffect(() => {
    if (!supportsTimeSelection) {
      return;
    }
    setSelectedNeighborhoodId(null);
  }, [supportsTimeSelection, timeOfDay]);

  const handleToggleEditing = useCallback(async () => {
    if (!canEdit) {
      return;
    }
    if (!editing) {
      setEditing(true);
      setSaveStatus("idle");
      setSaveError(null);
      setOffsetOverrides(cloneOffsetMap(baseOffsetsRef.current));
      setZOverrides({ ...baseZRef.current });
      if (!selectedNeighborhoodId || !baseOffsetsRef.current[selectedNeighborhoodId]) {
        setSelectedNeighborhoodId(neighborhoods[0]?.id ?? null);
      }
      return;
    }

    if (!hasPendingChanges) {
      setEditing(false);
      setSaveStatus("idle");
      setSaveError(null);
      return;
    }

    setSaveStatus("saving");
    setSaveError(null);
    try {
      await persistOverrides();
      setSaveStatus("success");
      setEditing(false);
      reload();
    } catch (err) {
      console.error("Failed to persist neighborhood updates", err);
      setSaveStatus("error");
      setSaveError(err instanceof Error ? err.message : "Failed to update neighborhoods");
    }
  }, [
    canEdit,
    editing,
    hasPendingChanges,
    neighborhoods,
    persistOverrides,
    reload,
    selectedNeighborhoodId,
  ]);

  useEffect(() => {
    if (!editing || !selectedNeighborhoodId) {
      return;
    }
    const listenerOptions: AddEventListenerOptions = { capture: true };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!editing || !selectedNeighborhoodId) {
        return;
      }
      if (isInteractiveTarget(event.target)) {
        return;
      }
      const step = event.shiftKey ? 1 : 0.5;
      let consumed = false;
      switch (event.key) {
        case "ArrowUp":
          nudgeOffset(selectedNeighborhoodId, 0, -step);
          consumed = true;
          break;
        case "ArrowDown":
          nudgeOffset(selectedNeighborhoodId, 0, step);
          consumed = true;
          break;
        case "ArrowLeft":
          nudgeOffset(selectedNeighborhoodId, -step, 0);
          consumed = true;
          break;
        case "ArrowRight":
          nudgeOffset(selectedNeighborhoodId, step, 0);
          consumed = true;
          break;
        default:
          break;
      }
      if (consumed) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", handleKeyDown, listenerOptions);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, listenerOptions);
    };
  }, [editing, selectedNeighborhoodId, nudgeOffset]);

  const selectedOffset = selectedNeighborhoodId
    ? (offsetOverrides[selectedNeighborhoodId] ?? baseOffsetsRef.current[selectedNeighborhoodId])
    : undefined;
  const selectedZ = selectedNeighborhoodId
    ? (zOverrides[selectedNeighborhoodId] ?? baseZRef.current[selectedNeighborhoodId] ?? 0)
    : 0;

  const timeSelectDisabled =
    !supportsTimeSelection || Boolean(graphUrl) || editing || isLoading || saveStatus === "saving";
  let timeSelectTitle: string | undefined;
  if (graphUrl) {
    timeSelectTitle = "Time selection is unavailable when a connection graph override is active.";
  } else if (!supportsTimeSelection) {
    timeSelectTitle = "Time selection is disabled when a manifest override is configured.";
  } else if (editing) {
    timeSelectTitle = "Finish editing before switching time of day.";
  } else if (isLoading) {
    timeSelectTitle = "Please wait for the current manifest to finish loading.";
  } else if (saveStatus === "saving") {
    timeSelectTitle = "Saving layout changes…";
  }
  if (!timeSelectTitle) {
    timeSelectTitle = "Select atlas time of day.";
  }

  const timeLabel = useMemo(() => {
    const option = TIME_OF_DAY_OPTIONS.find((item) => item.value === timeOfDay);
    return option?.label ?? "Day";
  }, [timeOfDay]);

  const neighborhoodCount = layout?.metadata?.neighborhoods?.length ?? 0;
  const mapCount = layout?.placements.length ?? 0;
  const subtitleParts: string[] = [];
  subtitleParts.push(`Time: ${timeLabel}`);
  if (neighborhoodCount > 0) {
    subtitleParts.push(`${neighborhoodCount} neighborhood${neighborhoodCount === 1 ? "" : "s"}`);
  }
  if (mapCount > 0) {
    subtitleParts.push(`${mapCount} map${mapCount === 1 ? "" : "s"}`);
  }
  const subtitle = subtitleParts.length > 0 ? subtitleParts.join(" • ") : "Loading atlas…";

  // Performance toggles (lifted to header)
  const initialPerf = readPerfSettings();
  const [disableMapAnimations, setDisableMapAnimations] = useState<boolean>(
    initialPerf.disableMapAnimations,
  );
  const [disableObjectAnimations, setDisableObjectAnimations] = useState<boolean>(
    initialPerf.disableObjectAnimations,
  );
  useEffect(() => {
    writePerfSettings({ disableMapAnimations, disableObjectAnimations });
  }, [disableMapAnimations, disableObjectAnimations]);

  // Weather and sprite limit toggles (controlled from header)
  const [weatherEnabled, setWeatherEnabled] = useState<boolean>(true);
  const [spriteLimitEnabled, setSpriteLimitEnabled] = useState<boolean>(false);
  const [mapBordersEnabled, setMapBordersEnabled] = useState<boolean>(false);

  // Overlay navigation state
  const [overlayState, setOverlayState] = useState<{
    mapLabel: string | null;
    backlink: WarpBacklink | null;
  }>({ mapLabel: null, backlink: null });

  const handleOverlayChange = useCallback(
    (state: { mapLabel: string | null; backlink: WarpBacklink | null }) => {
      setOverlayState(state);
    },
    []
  );

  const handleCloseOverlay = useCallback(() => {
    mapCanvasRef.current?.closeOverlay();
  }, []);

  return (
    <TooltipProvider>
      <main className="app-shell dark">
      <HeaderNav
        subtitle={subtitle}
        version={POLISHED_VERSION}
        placements={layout?.placements ?? []}
        neighborhoods={neighborhoods}
        onSearchSelect={handleSearchSelect}
        isLoading={isLoading}
        timeOfDay={timeOfDay}
        onTimeOfDayChange={handleTimeOfDayChange}
        timeSelectDisabled={timeSelectDisabled}
        timeSelectTitle={timeSelectTitle}
        disableMapAnimations={disableMapAnimations}
        onDisableMapAnimationsChange={setDisableMapAnimations}
        disableObjectAnimations={disableObjectAnimations}
        onDisableObjectAnimationsChange={setDisableObjectAnimations}
        weatherEnabled={weatherEnabled}
        onWeatherEnabledChange={setWeatherEnabled}
        spriteLimitEnabled={spriteLimitEnabled}
        onSpriteLimitEnabledChange={setSpriteLimitEnabled}
        mapBordersEnabled={mapBordersEnabled}
        onMapBordersEnabledChange={setMapBordersEnabled}
        onReload={handleReloadClick}
        onResetView={handleResetView}
        onScreenshot={handleScreenshot}
        onOpenHelp={() => setHelpPanelOpen(true)}
        canEdit={canEdit}
        editing={editing}
        onToggleEditing={handleToggleEditing}
        saveStatus={saveStatus}
      />
      <OverlayBreadcrumb
        mapLabel={overlayState.mapLabel}
        backlink={overlayState.backlink}
        onClose={handleCloseOverlay}
      />
      {editing && canEdit && (
        <section className="dev-toolbar">
          <div className="dev-row">
            <label htmlFor="neighborhood-select">Neighborhood</label>
            <select
              id="neighborhood-select"
              value={selectedNeighborhoodId ?? ""}
              onChange={(event) => handleSelectNeighborhood(event.target.value)}
            >
              {neighborhoods.map((neighborhood) => (
                <option key={neighborhood.id} value={neighborhood.id}>
                  {neighborhood.id}
                </option>
              ))}
            </select>
          </div>
          <div className="dev-row">
            <span>
              Offset (blocks):{" "}
              {selectedOffset ? `${selectedOffset[0]} , ${selectedOffset[1]}` : "--"}
            </span>
          </div>
          <div className="dev-row">
            <label htmlFor="neighborhood-z">Z Offset</label>
            <input
              id="neighborhood-z"
              type="number"
              value={selectedNeighborhoodId ? selectedZ : ""}
              onChange={(event) => {
                if (!selectedNeighborhoodId) {
                  return;
                }
                const nextValue = Number.parseInt(event.target.value, 10);
                handleZChange(selectedNeighborhoodId, nextValue);
              }}
            />
          </div>
          <div className="dev-row">
            <span>{hasPendingChanges ? "Unsaved changes" : "Offsets synced"}</span>
          </div>
          <div className="dev-row">
            <span>Use arrow keys (hold Shift for 1 block) to adjust offsets.</span>
          </div>
          {saveStatus === "error" && saveError && <span className="dev-error">{saveError}</span>}
        </section>
      )}
      <section className="canvas-container">
        <MapCanvas
          ref={mapCanvasRef}
          atlas={layout}
          loading={isLoading}
          editing={editing}
          bgPalettes={bgPalettes}
          baseOffsets={baseOffsetsRef.current}
          offsetOverrides={editing ? offsetOverrides : null}
          zOverrides={editing ? zOverrides : null}
          selectedNeighborhoodId={editing ? selectedNeighborhoodId : null}
          onSelectNeighborhood={editing ? handleSelectNeighborhood : undefined}
          onOffsetChange={editing ? handleOffsetChange : undefined}
          warpMetadata={warpMetadata}
          resolveAssetHref={assetResolver}
          objectMetadata={objectMetadata}
          timeOfDay={timeOfDay}
          disableMapAnimations={disableMapAnimations}
          disableObjectAnimations={disableObjectAnimations}
          weatherEnabled={weatherEnabled}
          onWeatherEnabledChange={setWeatherEnabled}
          spriteLimitEnabled={spriteLimitEnabled}
          onSpriteLimitEnabledChange={setSpriteLimitEnabled}
          mapBordersEnabled={mapBordersEnabled}
          onViewStateChange={handleViewStateChange}
          onOverlayChange={handleOverlayChange}
        />
        <ZoomControls
          scale={currentScale}
          minScale={MIN_SCALE}
          maxScale={MAX_SCALE}
          onZoom={handleZoom}
          onResetView={handleResetView}
          disabled={isLoading}
        />
        <div className="controls-overlay">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="control-btn"
                onClick={handleScreenshot}
                disabled={isLoading}
                aria-label="Take screenshot"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              </button>
            </TooltipTrigger>
            <TooltipContent>Take screenshot</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="control-btn"
                onClick={() => setHelpPanelOpen(true)}
                aria-label="Help"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </button>
            </TooltipTrigger>
            <TooltipContent>Help &amp; keyboard shortcuts</TooltipContent>
          </Tooltip>
        </div>
        {error && <div className="status-banner error">{error}</div>}
        {!error && warpError && <div className="status-banner error">{warpError}</div>}
        {!error && bgError && <div className="status-banner error">{bgError}</div>}
        {!error && objectError && <div className="status-banner error">{objectError}</div>}
        {saveStatus === "error" && saveError && !editing && (
          <div className="status-banner error">{saveError}</div>
        )}
        {saveStatus === "success" && !editing && (
          <div className="status-banner info">Neighborhood layout saved.</div>
        )}
      </section>
      <HelpPanel isOpen={helpPanelOpen} onClose={() => setHelpPanelOpen(false)} />
      </main>
    </TooltipProvider>
  );
}
