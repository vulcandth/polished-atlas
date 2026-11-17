# Development and publication

## Reproducible builds

Use Python 3.11+, Git, and Node.js 22.12+. Run `python scripts/build_atlas.py`.
The pinned source comes from `atlas-source.json`; no branch name is resolved
implicitly during a production build. Use a fresh `POLISHED_DIR` when changing
the pin, or let the default SHA-specific directory isolate the sources.

`--assets-only` runs all generators without npm. `--skip-install` reuses already
installed npm dependencies. `--output .build/my-bundle` selects a separate bundle
directory. `TIME_OF_DAY_SET` can limit local iteration; publication requires all
four palettes. Build outputs never reuse tracked or previously generated metadata.

The default source event flags are combined with `scripts/event_overrides.json`.
The default weekday is Monday. Dev's target policy is scripted/scheduled weather
only and spatially composited palette swaps; see the implementation tracker for
completion status.

Individual generators retain their `--help` interfaces. `POLISHED_DIR` and
`ATLAS_MAPS_DIR` set their default source/output roots. Standalone scripts still
default to `external/polishedcrystal` and `maps`. The normal production pipeline
sets isolated roots automatically. For frontend development with `npm run dev`,
generate standalone assets into `maps`, or use `npm run preview` after a full build.

## Verification

```sh
python -m unittest discover -s scripts/tests
npm --prefix web/atlas test
npm --prefix web/atlas run lint
cd web/atlas && npx tsc --noEmit
```

Capture a baseline bundle before changing stable generation. Compare its complete
map directory with the new build using:

```sh
python scripts/compare_assets.py .build/baseline/maps web/atlas/dist/maps --report .build/regression.json
```

This compares every file and normalizes only JSON `generated_at` timestamps.
It does not hide missing files or unexplained rendering differences.

## Publishing both versions

1. Push validated changes to the appropriate branch. Keep `main` pinned to v3.2.2.
2. In repository Settings → Pages, select GitHub Actions as the publishing source.
   The `github-pages` environment must allow the `main` coordinator to deploy.
3. Run **Publish both atlases** on `main`. It snapshots both atlas SHAs, builds
   each with its own upstream pin and URL base, and requires the dev audit check.
4. Both builds must pass before assembly or deployment. The resulting site has
   stable at `/polished-atlas/` and dev at `/polished-atlas/dev/`.
5. Check both live entrypoints, version links, time selectors, map navigation,
   overlays, and asset requests. Inspect each channel's `build-info.json` and the
   root `deployment.json` to confirm the published revisions.

The combined site must remain below the 950 MB packaging budget, and symlinks
are rejected. Publication and rollback share a concurrency group, so they cannot
overwrite one another mid-deployment. A single-channel deployment is not supported.

## Rollback

Run **Restore combined atlas deployment** on `main`, supplying the run ID of a
successful **Publish both atlases** execution. The workflow checks the source
run, downloads its `combined-site` artifact, validates both channels and their
provenance, and deploys the combined site. Artifacts are retained for 90 days;
expired artifacts require a new publication from reviewed revisions.

## Updating upstream

Never advance the dev pin without reviewing its intervening commits. Obtain full
history, inventory/review every change, update compatibility code and tests, then
change `atlas-source.json`. Update the audit range and report for the new target.
The initial full v3.2.2-to-master audit is described in `upstream-implementation.md`.

## Scripted movement auditor

```sh
python scripts/analyze_scripted_movements.py --scope overworld --format fix
python scripts/analyze_scripted_movements.py --map NewBarkTown --label TeacherStops
python scripts/analyze_scripted_movements.py --scenario fresh-game
```

Presets in `scripts/scenarios/` contain `{ "set": [], "clear": [] }` event flag
lists; the supplied presets are placeholders. A custom file can be supplied with
`--event-overrides`. Explicit flags use `--assume-set-event` / `--assume-clear-event`.
