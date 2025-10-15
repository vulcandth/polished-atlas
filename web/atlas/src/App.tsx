import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MapCanvas from "@/components/MapCanvas";
import { useAtlasData } from "@/hooks/useAtlasData";
import type { NeighborhoodSummary } from "@/types";

const DEFAULT_ROOT = import.meta.env.VITE_ROOT_MAP ?? "NewBarkTown";
const MANIFEST_OVERRIDE = import.meta.env.VITE_NEIGHBORHOOD_MANIFEST_URL?.trim() || "";
const TIME_STORAGE_KEY = "polished-atlas/time-of-day";

const TIME_OF_DAY_OPTIONS = [
  { value: "morn", label: "Morning" },
  { value: "day", label: "Day" },
  { value: "nite", label: "Night" },
  { value: "eve", label: "Evening" },
] as const;

type TimeOfDayOption = (typeof TIME_OF_DAY_OPTIONS)[number];
type TimeOfDaySlug = TimeOfDayOption["value"];

function sanitizeTimeOfDay(value: unknown): TimeOfDaySlug {
  const text = typeof value === "string" ? value : value != null ? String(value) : "";
  const normalized = text.trim().toLowerCase();
  const match = TIME_OF_DAY_OPTIONS.find((option) => option.value === normalized);
  return match ? match.value : "day";
}

const DEFAULT_TIME_OF_DAY: TimeOfDaySlug = sanitizeTimeOfDay(import.meta.env.VITE_ATLAS_TIME ?? "day");

type OffsetTuple = [number, number];

function snapToHalf(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 2) / 2;
}

function cloneOffsetMap(source: Record<string, OffsetTuple>): Record<string, OffsetTuple> {
  const entries = Object.entries(source).map(([key, value]) => [key, [value[0], value[1]] as OffsetTuple]);
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
    return MANIFEST_OVERRIDE;
  }
  if (import.meta.env.DEV) {
    const repoRoot = typeof __REPO_ROOT__ === "string" ? __REPO_ROOT__ : "";
    if (repoRoot && typeof window !== "undefined" && window.location?.origin) {
      const rawPath = `${repoRoot}/maps/${timeSlug}/animated/map_neighborhoods.json`.replace(/\\/g, "/");
      const withLeadingSlash = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
      return `${window.location.origin}/@fs${encodeURI(withLeadingSlash)}`;
    }
  }
  return `/maps/${timeSlug}/animated/map_neighborhoods.json`;
}

function deriveDataSources(timeSlug: TimeOfDaySlug): {
  graphUrl?: string;
  manifestUrl?: string;
  rootLabel?: string;
  supportsTimeSelection: boolean;
} {
  const graphEnv = import.meta.env.VITE_CONNECTION_GRAPH_URL?.trim();
  if (graphEnv) {
    return { graphUrl: graphEnv, manifestUrl: undefined, rootLabel: DEFAULT_ROOT, supportsTimeSelection: false };
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
  const neighborhoods: NeighborhoodSummary[] = layout?.metadata?.neighborhoods ?? [];

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
      const offset: OffsetTuple = [snapToHalf(neighborhood.offsetBlocks[0]), snapToHalf(neighborhood.offsetBlocks[1])];
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
      if ((!selectedNeighborhoodId || !nextBaseOffsets[selectedNeighborhoodId]) && selectedNeighborhoodId !== preferredId) {
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

  const nudgeOffset = useCallback(
    (id: string, deltaX: number, deltaY: number) => {
      setOffsetOverrides((current) => {
        const base = current[id] ?? baseOffsetsRef.current[id] ?? [0, 0];
        const next: OffsetTuple = [snapToHalf(base[0] + deltaX), snapToHalf(base[1] + deltaY)];
        if (base[0] === next[0] && base[1] === next[1]) {
          return current;
        }
        return { ...current, [id]: next };
      });
    },
    []
  );

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
    [timeOfDay]
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
    import.meta.env.DEV && Boolean(manifestUrl) && neighborhoods.length > 0 && !graphUrl && timeOfDay === "day";

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
  }, [canEdit, editing, hasPendingChanges, neighborhoods, persistOverrides, reload, selectedNeighborhoodId]);

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
    ? offsetOverrides[selectedNeighborhoodId] ?? baseOffsetsRef.current[selectedNeighborhoodId]
    : undefined;
  const selectedZ = selectedNeighborhoodId
    ? zOverrides[selectedNeighborhoodId] ?? baseZRef.current[selectedNeighborhoodId] ?? 0
    : 0;

  const timeSelectDisabled =
    !supportsTimeSelection || Boolean(graphUrl) || editing || loading || saveStatus === "saving";
  let timeSelectTitle: string | undefined;
  if (graphUrl) {
    timeSelectTitle = "Time selection is unavailable when a connection graph override is active.";
  } else if (!supportsTimeSelection) {
    timeSelectTitle = "Time selection is disabled when a manifest override is configured.";
  } else if (editing) {
    timeSelectTitle = "Finish editing before switching time of day.";
  } else if (loading) {
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

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <h1>Polished Atlas</h1>
          <span className="subtitle">{subtitle}</span>
        </div>
        <div className="actions">
          <div className="time-picker">
            <label htmlFor="time-of-day-select">Time</label>
            <select
              id="time-of-day-select"
              value={timeOfDay}
              onChange={(event) => handleTimeOfDayChange(event.target.value)}
              disabled={timeSelectDisabled}
              title={timeSelectTitle}
            >
              {TIME_OF_DAY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <button type="button" onClick={reload} disabled={loading}>
            {loading ? "Loading…" : "Reload"}
          </button>
          {canEdit && (
            <button type="button" onClick={handleToggleEditing} disabled={loading || saveStatus === "saving"}>
              {!editing ? "Edit Layout" : saveStatus === "saving" ? "Saving…" : "Finish Editing"}
            </button>
          )}
        </div>
      </header>
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
            <span>Offset (blocks): {selectedOffset ? `${selectedOffset[0]} , ${selectedOffset[1]}` : "--"}</span>
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
          atlas={layout}
          loading={loading}
          editing={editing}
          baseOffsets={baseOffsetsRef.current}
          offsetOverrides={editing ? offsetOverrides : null}
          zOverrides={editing ? zOverrides : null}
          selectedNeighborhoodId={editing ? selectedNeighborhoodId : null}
          onSelectNeighborhood={editing ? handleSelectNeighborhood : undefined}
          onOffsetChange={editing ? handleOffsetChange : undefined}
        />
        {error && <div className="status-banner error">{error}</div>}
        {saveStatus === "error" && saveError && !editing && <div className="status-banner error">{saveError}</div>}
        {saveStatus === "success" && !editing && <div className="status-banner info">Neighborhood layout saved.</div>}
      </section>
    </main>
  );
}
