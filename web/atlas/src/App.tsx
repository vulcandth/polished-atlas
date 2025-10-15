import MapCanvas from "@/components/MapCanvas";
import { useAtlasData } from "@/hooks/useAtlasData";

const DEFAULT_ROOT = import.meta.env.VITE_ROOT_MAP ?? "NewBarkTown";

function defaultGraphUrl(): string {
  if (import.meta.env.VITE_CONNECTION_GRAPH_URL) {
    return import.meta.env.VITE_CONNECTION_GRAPH_URL;
  }
  if (import.meta.env.DEV) {
    const repoRoot = typeof __REPO_ROOT__ === "string" ? __REPO_ROOT__ : "";
    if (repoRoot && typeof window !== "undefined" && window.location?.origin) {
      const rawPath = `${repoRoot}/maps/day/animated/NewBarkTown_connections.json`.replace(/\\/g, "/");
      const withLeadingSlash = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
      return `${window.location.origin}/@fs${encodeURI(withLeadingSlash)}`;
    }
  }
  return "/maps/day/animated/NewBarkTown_connections.json";
}

const DEFAULT_GRAPH_URL = defaultGraphUrl();

export default function App() {
  const { layout, loading, error, reload } = useAtlasData({
    graphUrl: DEFAULT_GRAPH_URL,
    rootLabel: DEFAULT_ROOT,
  });

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <h1>Polished Atlas</h1>
          <span className="subtitle">Root map: {layout?.root ?? DEFAULT_ROOT}</span>
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
