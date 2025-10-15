import MapCanvas from "@/components/MapCanvas";
import { useAtlasData } from "@/hooks/useAtlasData";

const DEFAULT_ROOT = import.meta.env.VITE_ROOT_MAP ?? "NewBarkTown";

function defaultManifestUrl(): string {
  const override = import.meta.env.VITE_NEIGHBORHOOD_MANIFEST_URL;
  if (override && override.trim()) {
    return override.trim();
  }
  if (import.meta.env.DEV) {
    const repoRoot = typeof __REPO_ROOT__ === "string" ? __REPO_ROOT__ : "";
    if (repoRoot && typeof window !== "undefined" && window.location?.origin) {
      const rawPath = `${repoRoot}/maps/day/animated/map_neighborhoods.json`.replace(/\\/g, "/");
      const withLeadingSlash = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
      return `${window.location.origin}/@fs${encodeURI(withLeadingSlash)}`;
    }
  }
  return "/maps/day/animated/map_neighborhoods.json";
}

function deriveDataSources(): { graphUrl?: string; manifestUrl?: string; rootLabel?: string } {
  const graphEnv = import.meta.env.VITE_CONNECTION_GRAPH_URL?.trim();
  if (graphEnv) {
    return { graphUrl: graphEnv, manifestUrl: undefined, rootLabel: DEFAULT_ROOT };
  }
  const manifestUrl = defaultManifestUrl();
  return { graphUrl: undefined, manifestUrl, rootLabel: undefined };
}

export default function App() {
  const { graphUrl, manifestUrl, rootLabel } = deriveDataSources();
  const { layout, loading, error, reload } = useAtlasData({
    graphUrl,
    manifestUrl,
    rootLabel,
  });

  const neighborhoodCount = layout?.metadata?.neighborhoods?.length ?? 0;
  const mapCount = layout?.placements.length ?? 0;
  const subtitleParts: string[] = [];
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
          <button type="button" onClick={reload} disabled={loading}>
            {loading ? "Loading…" : "Reload"}
          </button>
        </div>
      </header>
      <section className="canvas-container">
        <MapCanvas atlas={layout} loading={loading} />
        {error && <div className="status-banner error">{error}</div>}
      </section>
    </main>
  );
}
