import { ChevronRightIcon, MapIcon, HomeIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WarpBacklink } from "@/components/MapCanvas";

interface OverlayBreadcrumbProps {
  mapLabel: string | null;
  backlink: WarpBacklink | null;
  onClose: () => void;
  onNavigate?: (mapLabel: string, newBacklink: WarpBacklink | null) => void;
  className?: string;
}

function formatMapLabel(label: string): string {
  // Convert camelCase/PascalCase to spaced words
  return label
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim();
}

interface BreadcrumbItem {
  label: string;
  backlink: WarpBacklink | null; // The backlink chain to restore when navigating to this item
}

function buildBreadcrumbPath(
  currentLabel: string | null,
  backlink: WarpBacklink | null
): BreadcrumbItem[] {
  const items: BreadcrumbItem[] = [];

  // Collect all backlinks in order (oldest first)
  const backlinks: WarpBacklink[] = [];
  let current = backlink;
  while (current) {
    backlinks.unshift(current);
    current = current.previous;
  }

  // Build breadcrumb items with the correct backlink chain for each
  for (let i = 0; i < backlinks.length; i++) {
    const bl = backlinks[i];
    // When navigating to this item, restore the backlink chain up to (but not including) this point
    items.push({
      label: bl.mapLabel,
      backlink: bl.previous,
    });
  }

  // Add current map if present (no backlink change needed since it's current)
  if (currentLabel) {
    items.push({
      label: currentLabel,
      backlink: backlink, // Current backlink stays as-is
    });
  }

  return items;
}

export default function OverlayBreadcrumb({
  mapLabel,
  backlink,
  onClose,
  onNavigate,
  className,
}: OverlayBreadcrumbProps) {
  if (!mapLabel) {
    return null;
  }

  const items = buildBreadcrumbPath(mapLabel, backlink);

  return (
    <nav
      aria-label="Map navigation"
      className={cn(
        "flex items-center gap-1 px-3 py-2",
        "text-sm bg-background/95 backdrop-blur border-b",
        "supports-[backdrop-filter]:bg-background/60",
        className
      )}
    >
      {/* Home / Atlas button */}
      <button
        onClick={onClose}
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 rounded-md",
          "text-muted-foreground hover:text-foreground hover:bg-muted",
          "transition-colors"
        )}
        title="Return to atlas"
      >
        <HomeIcon className="size-3.5" />
        <span className="hidden sm:inline">Atlas</span>
      </button>

      {/* Breadcrumb items */}
      {items.map((item, index) => {
        const isLast = index === items.length - 1;

        return (
          <div key={`${item.label}-${index}`} className="flex items-center gap-1">
            <ChevronRightIcon className="size-3.5 text-muted-foreground/60" />
            {isLast ? (
              // Current location - not clickable
              <span className="flex items-center gap-1.5 px-2 py-1 font-medium text-foreground">
                <MapIcon className="size-3.5" />
                {formatMapLabel(item.label)}
              </span>
            ) : (
              // Previous location - clickable to navigate back
              <button
                onClick={() => {
                  onNavigate?.(item.label, item.backlink);
                }}
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 rounded-md",
                  "text-muted-foreground hover:text-foreground hover:bg-muted",
                  "transition-colors"
                )}
                title={`Go back to ${formatMapLabel(item.label)}`}
              >
                {formatMapLabel(item.label)}
              </button>
            )}
          </div>
        );
      })}
    </nav>
  );
}
