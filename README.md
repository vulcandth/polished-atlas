# polished-atlas

Interactive React/Pixi atlas for [polishedcrystal](https://github.com/Rangi42/polishedcrystal),
with animated maps, connections, warps, NPCs, weather, and movement analysis.

| Branch | Upstream | Site |
| --- | --- | --- |
| `main` | Pinned v3.2.2 | [Stable](https://vulcandth.github.io/polished-atlas/) |
| `dev` | Reviewed master commit | [Development](https://vulcandth.github.io/polished-atlas/dev/) |

The development channel is being implemented; its URL becomes available with
the first successful combined publication. See [implementation status](docs/upstream-implementation.md).

## Build locally

Requirements: Python 3.11+, Git, and Node.js 22.12+ with npm.

```sh
python scripts/build_atlas.py
npm --prefix web/atlas run preview
```

`scripts/build_atlas.sh` remains a Bash wrapper. The source repository, display
ref, exact commit, and channel are pinned in `atlas-source.json`. The build
checks out that exact commit under `external/<commit>/`. It rejects modified
or mismatched existing checkouts instead of resetting them.

The pipeline renders all maps, generates metadata in a clean
`.build/generated/<channel>/maps/` directory, installs locked web dependencies,
and builds `web/atlas/dist/`. The bundle contains its own maps and
`build-info.json`. The tracked `maps/` JSON files are legacy development inputs;
only the curated neighborhood layouts are used as production layout templates.

Useful environment settings:

- `POLISHED_DIR`: an existing clean checkout at the exact pinned SHA, or an empty
  directory for a new checkout.
- `TIME_OF_DAY_SET`: defaults to `day,morn,nite,eve`. `TIME_OF_DAY` is a shorthand.
- `WEEKDAY`: 0–6, default 1 (Monday).
- `ATLAS_WORKERS`: optional renderer worker count.
- `VITE_PUBLIC_BASE`: default `/` locally; publication supplies the channel URL prefix.
- `GIT_BIN`, `NODE_BIN`, `PYTHON_BIN`: executable overrides (`PYTHON_BIN` is for the Bash wrapper).

The former moving `POLISHED_REF`/`POLISHED_UPDATE` settings are replaced by the
reviewed source pin. Version labels and cache identifiers are derived from the
verified checkout, atlas revision, and build settings.

## CI and publication

CI validates pushes and pull requests to `main` and `dev` and uploads build
artifacts. It does not publish. Run **Publish both atlases** from `main` to
snapshot both branch heads, build them independently, validate both, and publish
one Pages artifact containing stable at the root and development under `dev/`.
The dev audit must be complete before publication succeeds.

A failure in either channel leaves the existing published site intact. The
**Restore combined atlas deployment** workflow redeploys a retained combined
artifact from a successful publication run. See [development and publishing](docs/development.md).

## Project layout

- `scripts/`: renderers, extractors, build, audit, and validation tools.
- `web/atlas/`: React/Pixi client.
- `maps/`: legacy JSON metadata and curated neighborhood layout.
- `external/`: ignored upstream checkouts.
- `.build/`: ignored generated assets and local verification evidence.

All-commit audit requirements and known compatibility work are documented in
[the implementation tracker](docs/upstream-implementation.md). The preliminary
planning inspection is not an exhaustive audit.
