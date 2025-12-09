# polished-atlas

Interactive web atlas for the [polishedcrystal](https://github.com/Rangi42/polishedcrystal)
ROM hack. The project stitches overworld maps into a zoomable canvas and exposes
warp metadata so players can jump between interior and exterior locations. The
tooling targets polishedcrystal release **v3.2.2** and displays the upstream
version in the UI so visitors know which ROM build is represented.

## Project layout

- `scripts/` — Python and shell utilities that generate map assets, layout
	manifests, and metadata consumed by the web client.
- `maps/` — Generated sprite sheets, manifests, and metadata. The contents are
	produced by the build pipeline and are not committed.
- `web/atlas/` — React + Pixi web client distributed through Vite.
- `external/polishedcrystal/` — Local checkout of the upstream polishedcrystal
	repository (cloned automatically by the build script or GitHub CI).

## Prerequisites

- Python 3.11+
- Node.js 20+
- git and bash available on your PATH

## Local build pipeline

Run the orchestration script to fetch assets, generate metadata, and build the
web bundle. The script clones polishedcrystal v3.2.2 if it is missing and reuses
any existing checkout by default.

```bash
./scripts/build_atlas.sh
```

Environment overrides:

- `POLISHED_REPO_URL` – source repository (default:
	`https://github.com/Rangi42/polishedcrystal.git`).
- `POLISHED_REF` – branch or tag to checkout (default: `v3.2.2`).
- `POLISHED_DIR` – destination for the checkout (default:
	`external/polishedcrystal`).
- `POLISHED_UPDATE` – set to `true` to force-fetch the requested ref.
- `TIME_OF_DAY_SET` – comma-delimited list of time-of-day palettes to render.
	Defaults to `day,morn,nite,eve` (all palettes). The legacy `TIME_OF_DAY`
	variable remains supported as a shorthand for single entries.
- `WEEKDAY` – game weekday (0–6) used for weather-dependent renders.
- `VITE_POLISHED_CRYSTAL_VERSION` – upstream polishedcrystal version string shown in the UI (defaults to `v1`).
- `VITE_POLISHED_ATLAS_VERSION` – atlas build/version identifier used for cache-busting asset URLs (optional).

The script performs the following steps:

1. Render polishedcrystal maps into animated sprite sheets for every requested
	time of day (defaults to `day`, `morn`, `nite`, `eve`).
2. Generate neighborhood connection manifests for each rendered palette.
3. Extract warp metadata for every map.
4. Run `npm ci` and `npm run build` inside `web/atlas/` to produce `dist/` with
	the upstream polishedcrystal version injected into the UI and an atlas version used for cache-busting.

See `docs/development.md` for deeper operational guidance and troubleshooting
tips.

## Available scripts

- `scripts/build_atlas.sh` – orchestrates the entire asset + web build pipeline.
- `scripts/render_maps.py` – renders animated sprite sheets for every map.
- `scripts/generate_map_neighborhoods.py` – creates neighborhood connection
	graphs and layout manifests.
- `scripts/generate_warp_metadata.py` – emits warp metadata consumed by the web
	application.
- `scripts/generate_object_metadata.py` – exports NPC and object placement
	metadata for overlay rendering.

## Continuous integration & deployment

GitHub Actions (`.github/workflows/ci.yml`) runs on pushes, and supports manual
dispatches when you want to publish to GitHub Pages. The workflow:

- Clones the repository and sets up Python 3.11 and Node 20.
- Executes `scripts/build_atlas.sh` (which clones polishedcrystal, renders
	assets, generates metadata, and builds the web client).
- Publishes the compiled site as a workflow artifact for every run.
- Deploys `web/atlas/dist` to GitHub Pages only when the workflow is triggered
	via the manual dispatch action.

Repository variables `POLISHED_REPO_URL`, `POLISHED_REF`, `TIME_OF_DAY`, and
`WEEKDAY` can be configured to point CI at a different upstream fork or palette.

## Deployment targets

The GitHub Pages deployment produced by CI publishes `web/atlas/dist`. For
manual publishing, run `scripts/build_atlas.sh` locally and push the resulting
`dist/` directory to your preferred static hosting provider.
