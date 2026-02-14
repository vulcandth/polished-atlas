import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapPlacement, NeighborhoodSummary } from "@/types";

export interface SearchResult {
  type: "map" | "neighborhood";
  label: string;
  displayName: string;
  neighborhood?: string;
  x?: number;
  y?: number;
  widthPx?: number;
  heightPx?: number;
}

interface MapSearchProps {
  placements: MapPlacement[];
  neighborhoods: NeighborhoodSummary[];
  onSelect: (result: SearchResult) => void;
  disabled?: boolean;
}

/**
 * Format a map label for display (e.g., "NewBarkTown" -> "New Bark Town")
 */
function formatMapLabel(label: string): string {
  // Insert spaces before capital letters and numbers
  return label
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/(\d+)/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a searchable index from placements and neighborhoods
 */
function buildSearchIndex(
  placements: MapPlacement[],
  neighborhoods: NeighborhoodSummary[],
): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  // Build a map of neighborhoodId -> placements for calculating center
  const neighborhoodMaps = new Map<string, MapPlacement[]>();
  for (const placement of placements) {
    const nId = placement.metadata.neighborhoodId;
    if (nId) {
      const list = neighborhoodMaps.get(nId) ?? [];
      list.push(placement);
      neighborhoodMaps.set(nId, list);
    }
  }

  // Add neighborhoods with calculated center coordinates
  for (const neighborhood of neighborhoods) {
    const key = `neighborhood:${neighborhood.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      
      // Calculate center from all maps in this neighborhood
      const mapsInNeighborhood = neighborhoodMaps.get(neighborhood.id) ?? [];
      let x: number | undefined;
      let y: number | undefined;
      
      if (mapsInNeighborhood.length > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of mapsInNeighborhood) {
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x + p.widthPx);
          maxY = Math.max(maxY, p.y + p.heightPx);
        }
        x = (minX + maxX) / 2;
        y = (minY + maxY) / 2;
      }
      
      results.push({
        type: "neighborhood",
        label: neighborhood.id,
        displayName: formatMapLabel(neighborhood.id),
        x,
        y,
      });
    }
  }

  // Add individual maps
  for (const placement of placements) {
    const key = `map:${placement.label}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({
        type: "map",
        label: placement.label,
        displayName: formatMapLabel(placement.label),
        neighborhood: placement.metadata.neighborhoodId ?? undefined,
        x: placement.x + placement.widthPx / 2,
        y: placement.y + placement.heightPx / 2,
        widthPx: placement.widthPx,
        heightPx: placement.heightPx,
      });
    }
  }

  // Sort alphabetically by display name
  results.sort((a, b) => a.displayName.localeCompare(b.displayName));

  return results;
}

/**
 * Simple fuzzy match - checks if query words appear in target
 */
function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase();

  if (t.includes(q)) return true;

  // Check if all words in query appear in target
  const queryWords = q.split(/\s+/);
  return queryWords.every((word) => t.includes(word));
}

export default function MapSearch({
  placements,
  neighborhoods,
  onSelect,
  disabled = false,
}: MapSearchProps) {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const searchIndex = useMemo(
    () => buildSearchIndex(placements, neighborhoods),
    [placements, neighborhoods],
  );

  const filteredResults = useMemo(() => {
    if (!query.trim()) return [];
    return searchIndex.filter((result) => fuzzyMatch(query, result.displayName)).slice(0, 20);
  }, [query, searchIndex]);

  useEffect(() => {
    setHighlightIndex(0);
  }, [filteredResults]);

  const handleSelect = useCallback(
    (result: SearchResult) => {
      onSelect(result);
      setQuery("");
      setIsOpen(false);
      inputRef.current?.blur();
    },
    [onSelect],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen || filteredResults.length === 0) {
        if (e.key === "Escape") {
          setQuery("");
          setIsOpen(false);
        }
        return;
      }

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightIndex((i) => Math.min(i + 1, filteredResults.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (filteredResults[highlightIndex]) {
            handleSelect(filteredResults[highlightIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          setQuery("");
          setIsOpen(false);
          break;
      }
    },
    [isOpen, filteredResults, highlightIndex, handleSelect],
  );

  // Scroll highlighted item into view
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[highlightIndex] as HTMLElement | undefined;
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIndex]);

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".map-search")) {
        setIsOpen(false);
      }
    };
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  return (
    <div className="map-search">
      <input
        ref={inputRef}
        type="text"
        placeholder="Search maps..."
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIsOpen(true);
        }}
        onFocus={() => setIsOpen(true)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        aria-label="Search for maps and locations"
        aria-expanded={isOpen && filteredResults.length > 0}
        aria-controls="map-search-results"
        aria-autocomplete="list"
      />
      {isOpen && filteredResults.length > 0 && (
        <ul
          ref={listRef}
          id="map-search-results"
          className="map-search-results"
          role="listbox"
        >
          {filteredResults.map((result, index) => (
            <li
              key={`${result.type}:${result.label}`}
              role="option"
              aria-selected={index === highlightIndex}
              className={index === highlightIndex ? "highlighted" : ""}
              onClick={() => handleSelect(result)}
              onMouseEnter={() => setHighlightIndex(index)}
            >
              <span className="result-name">{result.displayName}</span>
              <span className="result-type">
                {result.type === "neighborhood" ? "Region" : "Map"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {isOpen && query.trim() && filteredResults.length === 0 && (
        <div className="map-search-empty">No results found</div>
      )}
    </div>
  );
}
