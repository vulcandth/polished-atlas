import { ChevronRightIcon, MapIcon, HomeIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WarpBacklink } from "@/components/MapCanvas";

interface OverlayBreadcrumbProps {
  mapLabel: string | null;
  backlink: WarpBacklink | null;
  onClose: () => void;
  className?: string;
}

function formatMapLabel(label: string): string {
  // Convert camelCase/PascalCase to spaced words
  return label
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim();
}

function buildBreadcrumbPath(
  currentLabel: string | null,
  backlink: WarpBacklink | null
): string[] {
  const path: string[] = [];
  
  // Walk back through the backlink chain to build path
  let current = backlink;
  while (current) {
    if (current.mapLabel) {
      path.unshift(current.mapLabel);
    }
    current = current.previous;
  }
  
  // Add current map if present
  if (currentLabel) {
    path.push(currentLabel);
  }
  
  return path;
}

export default function OverlayBreadcrumb({
  mapLabel,
  backlink,
  onClose,
  className,
}: OverlayBreadcrumbProps) {
  if (!mapLabel) {
    return null;
  }

  const path = buildBreadcrumbPath(mapLabel, backlink);

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
      {path.map((label, index) => {
        const isLast = index === path.length - 1;
        
        return (
          <div key={`${label}-${index}`} className="flex items-center gap-1">
            <ChevronRightIcon className="size-3.5 text-muted-foreground/60" />
            {isLast ? (
              // Current location - not clickable
              <span className="flex items-center gap-1.5 px-2 py-1 font-medium text-foreground">
                <MapIcon className="size-3.5" />
                {formatMapLabel(label)}
              </span>
            ) : (
              // Previous location - shows but not interactive for now
              <span className="flex items-center gap-1.5 px-2 py-1 text-muted-foreground">
                {formatMapLabel(label)}
              </span>
            )}
          </div>
        );
      })}
    </nav>
  );
}
