/**
 * Local storage utilities for MapCanvas state persistence.
 */

const VIEW_STATE_STORAGE_KEY = "polished-atlas:view-state";
export const VIEW_STATE_VERSION = 1;
const PERF_SETTINGS_STORAGE_KEY = "polished-atlas:perf-settings";

export interface StoredViewState {
  version: number;
  scale: number;
  center: {
    x: number;
    y: number;
  };
}

export interface PerfSettingsState {
  disableMapAnimations: boolean;
  disableObjectAnimations: boolean;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function readStoredViewState(): StoredViewState | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(VIEW_STATE_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as StoredViewState | undefined;
    if (!parsed || parsed.version !== VIEW_STATE_VERSION) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeStoredViewState(state: StoredViewState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(VIEW_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn("Failed to persist atlas view state", err);
  }
}

export function readPerfSettings(): PerfSettingsState {
  if (typeof window === "undefined") {
    return { disableMapAnimations: false, disableObjectAnimations: false };
  }
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

export function writePerfSettings(next: PerfSettingsState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PERF_SETTINGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

/**
 * Clamp a value to the unit range [0, 1].
 */
export function clampUnit(value: unknown, fallback = 0.5): number {
  if (!isFiniteNumber(value)) {
    return fallback;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}
