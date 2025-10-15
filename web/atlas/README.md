# Polished Atlas Web Client

This package hosts the React + PixiJS client used to render stitched map atlases.

## Development Workflow

1. Generate a connection graph (only once per source change):
   ```bash
   python scripts/generate_map_connections.py NewBarkTown
   ```
   The file will be written to `maps/day/animated/NewBarkTown_connections.json` by default.

2. Install dependencies:
   ```bash
   cd web/atlas
   npm install
   ```

3. Start the dev server:
   ```bash
   npm run dev
   ```
   Vite serves from `http://localhost:5173`. The dev server is allowed to read the repository root so animation metadata and sprite sheets under `maps/day/animated/` are accessible.
   When running in development the app automatically references the real `maps/day/animated/NewBarkTown_connections.json`
   via Vite's `@fs` path, so no manual copying of assets is required. In production builds the assets are
   expected to be hosted relative to `/maps/day/animated/`.

## Configuration

Environment variables (prefixed with `VITE_`) can be provided via `.env` files or the shell:

- `VITE_CONNECTION_GRAPH_URL`: Path or URL to the JSON produced by `generate_map_connections.py`. Defaults to `/maps/day/animated/NewBarkTown_connections.json`.
- `VITE_ROOT_MAP`: Override the root label used when building the atlas layout. Defaults to `NewBarkTown`.

## Notes

- The current layout focuses on the New Bark Town graph. Additional root graphs can be produced and loaded without code changes.
- PixiJS renders sprite-sheet animations using the shared ticker for consistent timing. Pan with drag, zoom with mouse wheel, and pinch on touch devices. Double-click resets the view.
- The layout engine works in metatile (block) units derived from connection offsets. If new metadata fields are required (e.g., warp links) extend `generate_map_connections.py` accordingly.
