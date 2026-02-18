import { useCallback, useEffect, useRef } from "react";

export interface UrlViewState {
  x?: number;
  y?: number;
  zoom?: number;
  map?: string;
}

interface UseUrlStateOptions {
  /**
   * Debounce delay in ms before updating URL
   */
  updateDelay?: number;
  /**
   * Called when URL state changes (e.g., user navigates with back/forward)
   */
  onStateChange?: (state: UrlViewState) => void;
}

/**
 * Parse URL search params into view state
 */
function parseUrlState(): UrlViewState {
  const params = new URLSearchParams(window.location.search);
  const state: UrlViewState = {};

  const x = params.get("x");
  const y = params.get("y");
  const zoom = params.get("zoom");
  const map = params.get("map");

  if (x !== null && !isNaN(parseFloat(x))) {
    state.x = parseFloat(x);
  }
  if (y !== null && !isNaN(parseFloat(y))) {
    state.y = parseFloat(y);
  }
  if (zoom !== null && !isNaN(parseFloat(zoom))) {
    state.zoom = parseFloat(zoom);
  }
  if (map !== null && map.trim()) {
    state.map = map.trim();
  }

  return state;
}

/**
 * Build URL search params from view state
 */
function buildUrlParams(state: UrlViewState): URLSearchParams {
  const params = new URLSearchParams();

  if (state.x !== undefined) {
    params.set("x", state.x.toFixed(0));
  }
  if (state.y !== undefined) {
    params.set("y", state.y.toFixed(0));
  }
  if (state.zoom !== undefined) {
    // Round to 2 decimal places
    params.set("zoom", state.zoom.toFixed(2));
  }
  if (state.map) {
    params.set("map", state.map);
  }

  return params;
}

/**
 * Hook to sync view state with URL for deep linking
 */
export function useUrlState(options: UseUrlStateOptions = {}) {
  const { updateDelay = 500, onStateChange } = options;
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitialLoad = useRef(true);

  // Get initial state from URL
  const getInitialState = useCallback((): UrlViewState => {
    return parseUrlState();
  }, []);

  // Update URL with current state (debounced)
  const updateUrl = useCallback(
    (state: UrlViewState, replace = false) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = setTimeout(() => {
        const params = buildUrlParams(state);
        const search = params.toString();
        const newUrl = search ? `${window.location.pathname}?${search}` : window.location.pathname;

        if (replace || isInitialLoad.current) {
          window.history.replaceState(null, "", newUrl);
          isInitialLoad.current = false;
        } else {
          window.history.pushState(null, "", newUrl);
        }
      }, updateDelay);
    },
    [updateDelay],
  );

  // Clear URL params
  const clearUrl = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  // Generate shareable link
  const getShareableLink = useCallback((state: UrlViewState): string => {
    const params = buildUrlParams(state);
    const search = params.toString();
    return search
      ? `${window.location.origin}${window.location.pathname}?${search}`
      : `${window.location.origin}${window.location.pathname}`;
  }, []);

  // Handle browser back/forward navigation
  useEffect(() => {
    const handlePopState = () => {
      const state = parseUrlState();
      onStateChange?.(state);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [onStateChange]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return {
    getInitialState,
    updateUrl,
    clearUrl,
    getShareableLink,
  };
}
