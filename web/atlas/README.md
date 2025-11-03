# Polished Atlas Web Client

This package hosts the React + PixiJS client used to render stitched map atlases.

## Development Workflow

1. Generate a connection graph (only once per source change):
   ```bash
   python scripts/generate_map_connections.py NewBarkTown
   ```
   The file will be written to `maps/<time>/animated/NewBarkTown_connections.json` by default (e.g., `maps/day/animated/…`).

2. Install dependencies:
   ```bash
   cd web/atlas
   npm install
   ```

3. Start the dev server:
   ```bash
   npm run dev
   ```
   Vite serves from `http://localhost:5173`. The dev server is allowed to read the repository root so animation metadata and sprite sheets under `maps/<time>/animated/` are accessible.
   When running in development the app automatically references the real `maps/<time>/animated/NewBarkTown_connections.json`
   via Vite's `@fs` path, so no manual copying of assets is required. In production builds the assets are
   expected to be hosted relative to `/maps/<time>/animated/` (the UI lets you switch between `morn`, `day`, `nite`, and `eve`).

## Configuration

Environment variables (prefixed with `VITE_`) can be provided via `.env` files or the shell:

- `VITE_CONNECTION_GRAPH_URL`: Path or URL to the JSON produced by `generate_map_connections.py`. Defaults to `/maps/day/animated/NewBarkTown_connections.json`.
- `VITE_ROOT_MAP`: Override the root label used when building the atlas layout. Defaults to `NewBarkTown`.
- `VITE_NEIGHBORHOOD_MANIFEST_URL`: Override the manifest URL. When provided, time-of-day selection in the UI is disabled and the supplied manifest is used as-is.
- `VITE_POLISHED_CRYSTAL_VERSION`: Upstream Polished Crystal version string displayed in the UI (e.g., `v3.2.0`).
- `VITE_POLISHED_ATLAS_VERSION`: Atlas build/version identifier appended as a cache-busting query parameter to JSON and image asset URLs. When this changes, browsers will fetch fresh assets.

## Notes

- The current layout focuses on the New Bark Town graph. Additional root graphs can be produced and loaded without code changes.
- PixiJS renders sprite-sheet animations using the shared ticker for consistent timing. Pan with drag, zoom with mouse wheel, and pinch on touch devices.
- Keyboard shortcuts (when not editing layout):
   - Pan: Arrow keys, WASD, or IJKL (hold Shift for larger steps)
   - Zoom: + / = to zoom in, - to zoom out
   - Double-click anywhere to zoom in on that point
- The layout engine works in metatile (block) units derived from connection offsets. If new metadata fields are required (e.g., warp links) extend `generate_map_connections.py` accordingly.
