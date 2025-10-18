# Web Atlas Design

## Goals
- Present polishedcrystal overworld maps as a stitched, pannable, zoomable atlas similar to Google Maps.
- Support desktop and mobile devices with responsive touch/gesture controls.
- Consume generated connection graphs and sprite sheet animation metadata (JSON + PNG).
- Provide hooks for future overlays such as points of interest, routes, and search.

## Data Flow
1. **Neighborhood Manifest**: `scripts/generate_map_neighborhoods.py` emits one connection JSON per overworld neighborhood plus `map_neighborhoods.json`, which lists each neighborhood, its root map, bounds, default offsets (supporting fractional blocks like `0.5`), and `z_offset` stacking order for resolving overlap.
2. **Connection Graph**: Individual JSON files (e.g. `NewBarkTown_connections.json`) referenced by the manifest. Each file contains map adjacency, offsets, and metadata for a single neighborhood.
3. **Map Assets**: `scripts/render_maps.py` renders animation metadata JSON files plus sprite sheet PNGs located in `maps/<time>/animated/`. Filenames align with map labels and the build pipeline produces assets for every palette (`day`, `morn`, `nite`, `eve`).
4. **Warp Metadata**: `scripts/generate_warp_metadata.py` extracts warp coordinates, destinations, and overworld flags from polishedcrystal map scripts into `maps/warp_metadata.json`.
5. **Web Bundle**: Vite consumes the generated JSON + sprite sheets inside `web/atlas/src/` to produce the production-ready `dist/` directory served by GitHub Pages.

## Front-End Stack
- **Framework**: React 18 with TypeScript for UI structure and state.
- **Renderer**: PixiJS v7 for performant WebGL canvas rendering of map textures and animations.
- **Bundler**: Vite for fast development and build pipeline.
- **State Management**: Zustand or Redux Toolkit (preference for Zustand due to lightweight needs).
- **Routing**: React Router for future multi-page support (e.g., settings, info panels).
- **Styling**: CSS Modules or Tailwind CSS; ensure dark/light themes.

## Application Architecture
- `App`: Initializes providers, loads the neighborhood manifest (or a legacy single graph), merges layouts, and restores/persists the current view.
- `MapCanvas`: PixiJS integration, manages stage, viewport, zoom/pan, sprite layers.
- `MapLayerManager`: Translates connection graph into positioned map sprites. Handles stitching by applying connection offsets.
- `AnimationController`: Keeps GIF frames or spritesheets in sync; uses Pixi ticker for frame advancement.
- `ControlsOverlay`: UI chrome for zoom buttons, search bar, map selector, legend toggle.
- `InfoPanel`: Displays metadata for selected map tile (name, type, connections).
- `ResponsiveLayout`: Media queries + flexbox to adapt to mobile; bottom sheet panel pattern on small screens.

## Responsive Interaction
- Desktop: Mouse wheel zoom (with clamp), click-drag pan, double-click zoom in/out.
- Mobile: Pinch zoom, two-finger pan, double-tap zoom in, single tap selection.
- Use `pixi-viewport` plugin to simplify cross-device gestures and inertia.

## Asset Stitching Logic
1. Load root map specified in connection JSON.
2. Perform BFS/DFS to layout maps in world coordinates applying `direction` and `offset` from each connection.
3. Track visited maps to avoid infinite loops, align coordinates ensuring shared borders match.
4. Compute bounding box for all maps, set Pixi viewport to encompass.
5. For animated assets: use Pixi AnimatedSprite with textures extracted per frame from sprite sheets, advancing frames via shared ticker.

## Build Tooling
- `scripts/build_atlas.sh` orchestrates the full asset pipeline: renders maps,
  regenerates neighborhood manifests, extracts warp metadata, installs web
  dependencies, and runs `vite build`.
- The Python generators can be invoked individually for partial rebuilds when
  iterating on game data or metadata extraction.
- Vite handles bundling, code splitting, and static asset packaging for
  deployment.

## Deployment Considerations
- GitHub Actions publishes the `web/atlas/dist` directory to GitHub Pages on
  every push to `main`.
- Optional service worker caching can be layered on top of the generated static
  bundle if offline support becomes a goal.
- Map regions load lazily via Pixi texture streaming to keep the initial payload
  manageable.

## Future Enhancements
- Searchable index for map names and locations.
- Overlay toggles (e.g., day/night palettes, trainer locations).
- URL deep-linking to specific map coordinates.
- Screenshot export for selected view.

## Testing Strategy
- Unit tests for layout + connection parsing (Jest + React Testing Library).
- Integration tests for viewport gestures (Playwright with mobile emulation).
- Visual regression using Percy or Chromatic for sprite alignment.
