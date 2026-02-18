import { useCallback, useEffect, useMemo, useState } from "react";
import { MapIcon, MapPinIcon, SearchIcon } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
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
  /** Controlled open state */
  open?: boolean;
  /** Callback when open state changes */
  onOpenChange?: (open: boolean) => void;
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

export default function MapSearch({
  placements,
  neighborhoods,
  onSelect,
  disabled = false,
  open: controlledOpen,
  onOpenChange,
}: MapSearchProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Support both controlled and uncontrolled modes
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = useCallback(
    (value: boolean) => {
      if (!isControlled) {
        setInternalOpen(value);
      }
      onOpenChange?.(value);
    },
    [isControlled, onOpenChange],
  );

  const searchIndex = useMemo(
    () => buildSearchIndex(placements, neighborhoods),
    [placements, neighborhoods],
  );

  // Reset query when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery("");
    }
  }, [open]);

  const handleSelect = useCallback(
    (result: SearchResult) => {
      onSelect(result);
      setOpen(false);
    },
    [onSelect, setOpen],
  );

  // Group results by type
  const neighborhoodResults = useMemo(
    () => searchIndex.filter((r) => r.type === "neighborhood"),
    [searchIndex],
  );
  const mapResults = useMemo(
    () => searchIndex.filter((r) => r.type === "map"),
    [searchIndex],
  );

  return (
    <>
      {/* Only show button trigger in uncontrolled mode */}
      {!isControlled && (
        <Button
          variant="outline"
          onClick={() => setOpen(true)}
          disabled={disabled}
          className="w-[200px] justify-start gap-2 text-muted-foreground sm:w-[280px]"
        >
          <SearchIcon className="size-4" />
          <span className="truncate">Search maps...</span>
        </Button>
      )}
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Search Atlas"
        description="Search for maps and regions"
      >
        <CommandInput
          placeholder="Search maps..."
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>No results found</CommandEmpty>
          {neighborhoodResults.length > 0 && (
            <CommandGroup heading="Regions">
              {neighborhoodResults.map((result) => (
                <CommandItem
                  key={`neighborhood:${result.label}`}
                  value={`neighborhood-${result.label}-${result.displayName}`}
                  onSelect={() => handleSelect(result)}
                  className="flex items-center gap-2"
                >
                  <MapPinIcon className="size-4 text-muted-foreground" />
                  <span>{result.displayName}</span>
                  <span className="ml-auto text-xs text-muted-foreground uppercase tracking-wide">
                    Region
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {mapResults.length > 0 && (
            <CommandGroup heading="Maps">
              {mapResults.map((result) => (
                <CommandItem
                  key={`map:${result.label}`}
                  value={`map-${result.label}-${result.displayName}`}
                  onSelect={() => handleSelect(result)}
                  className="flex items-center gap-2"
                >
                  <MapIcon className="size-4 text-muted-foreground" />
                  <span>{result.displayName}</span>
                  <span className="ml-auto text-xs text-muted-foreground uppercase tracking-wide">
                    Map
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}
