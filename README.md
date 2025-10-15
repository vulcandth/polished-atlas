# polished-atlas

## Scripts

- `scripts/generate_map_metadata.py` — parses the polishedcrystal map scripts and
	emits a JSON payload containing warp metadata (source coordinates, target
	destinations, overworld flags, etc.). The output is intended for downstream
	tooling such as the atlas web app and can be extended to include additional
	per-map annotations in the future.
