# Development Guide

## Local workflow

1. Ensure Python 3.11+, Node.js 20+, git, and bash are available on your system.
2. Clone the repository and optionally export any overrides for polishedcrystal:
   - `POLISHED_REPO_URL` – upstream repository URL (default
     `https://github.com/Rangi42/polishedcrystal.git`).
   - `POLISHED_REF` – branch or tag to checkout (default `v3.2.0`).
   - `POLISHED_DIR` – checkout destination (default `external/polishedcrystal`).
   - `POLISHED_UPDATE` – set to `true` to force-fetch the specified ref.
   - `TIME_OF_DAY_SET` – comma-delimited palette list (default
     `day,morn,nite,eve`). The legacy `TIME_OF_DAY` variable remains supported
     for single entries.
   - `WEEKDAY` – game weekday (0–6) for weather-dependent renders.
  - `VITE_POLISHED_CRYSTAL_VERSION` – upstream version string shown in the UI (default `v3.2.0`).
  - `VITE_POLISHED_ATLAS_VERSION` – atlas build identifier used for cache-busting asset URLs.
3. Execute `./scripts/build_atlas.sh`.
   - Renders sprite sheets for every map across the requested time-of-day
     palettes.
   - Generates connection graphs, layout manifests, warp metadata, and overworld object manifests.
   - Installs web dependencies and runs `vite build` inside `web/atlas/`.
4. Serve the built site locally with `npm --prefix web/atlas run preview` or any
   static file server pointed at `web/atlas/dist`.

## Incremental asset regeneration

While prototyping, the individual Python scripts can be invoked directly:

- `python3 scripts/render_maps.py --help`
- `python3 scripts/generate_map_neighborhoods.py --help`
- `python3 scripts/generate_warp_metadata.py --help`
- `python3 scripts/generate_object_metadata.py --help`

Each script offers flags to control the polishedcrystal path, time of day, and
other parameters. Generated assets land under `maps/` by default.

### Scripted movement auditor

A Python tool flags sprite-limit risks and follower collisions in scripted sequences across all map scripts:

- Run a full overworld scan in a fix-friendly format:
  - `python3 scripts/analyze_scripted_movements.py --scope overworld --format fix`
- Target specific maps or labels (substring match, repeatable):
  - `python3 scripts/analyze_scripted_movements.py --map NewBarkTown --label TeacherStops`
- Seed event state from presets or a custom overrides file:
  - `python3 scripts/analyze_scripted_movements.py --scenario fresh-game`
  - `python3 scripts/analyze_scripted_movements.py --event-overrides scripts/event_overrides.json`

Notes:
- Presets are JSON files under `scripts/scenarios/<name>.json` with shape `{ "set": [], "clear": [] }`.
- Provided presets (`fresh-game`, `post-rocket`, `post-hof`) are placeholders; populate them with project-specific flags as desired.
- You can also add or remove individual flags via `--assume-set-event EVENT_FOO` and `--assume-clear-event EVENT_BAR`.

## Continuous integration

GitHub Actions (`.github/workflows/ci.yml`) mirrors the local pipeline on every
push, with Pages deployment available via manual dispatch:

1. Sets up Python 3.11 and Node.js 20.
2. Runs `scripts/build_atlas.sh` (which clones polishedcrystal v3.2.0,
   regenerates assets, and builds the web client).
3. Uploads `web/atlas/dist` as a workflow artifact for inspection.
4. Deploys to GitHub Pages only when triggered via the manual
   `workflow_dispatch` action.

Repository variables can tweak CI without altering the workflow:

- `POLISHED_REPO_URL`
- `POLISHED_REF`
- `TIME_OF_DAY_SET`
- `TIME_OF_DAY`
- `WEEKDAY`
- `VITE_POLISHED_CRYSTAL_VERSION`
- `VITE_POLISHED_ATLAS_VERSION`

## Troubleshooting

- Missing map assets usually indicate a stale or absent polishedcrystal
  checkout. Re-run `build_atlas.sh` with `POLISHED_UPDATE=true`.
- The map renderer relies on the polishedcrystal `utils/png.py` module; no extra
  pip dependencies are required for sheet output. For GIF generation, install
  Pillow (`pip install pillow`) and re-run `render_maps.py --format gif`.
- If Vite build failures mention missing JSON, ensure the Python scripts ran to
  completion and check the timestamps under `maps/`.

### Palette data correctness

- Object/NPC palette values are parsed directly from polishedcrystal `.pal` files
  (e.g. `gfx/overworld/npc_sprites.pal`). These files express RGB channels on
  a 0–31 scale and sometimes include leading zeros (e.g. `09`).
- As of this repo, the generator normalizes these numbers robustly, so `09` is
  interpreted as decimal 9 (not octal), ensuring accurate conversion to 8-bit
  RGB using `round(value / 31 * 255)`.
- If you update upstream palettes, re-run:
  - `python3 scripts/generate_object_metadata.py` to refresh `maps/object_metadata.json`.
  - Optionally `./scripts/build_atlas.sh` to rebuild everything end-to-end.
