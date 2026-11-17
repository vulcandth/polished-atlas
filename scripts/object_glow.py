"""Export collision-driven NPC glow rules from the pinned source tables."""
from pathlib import Path
import re

from generate_warp_metadata import _parse_collision_constants


def _lines(path: Path) -> list[str]:
    return [line.split(";", 1)[0].strip() for line in path.read_text(encoding="utf-8").splitlines()]


def load_object_glow(root: Path) -> dict | None:
    collision_path = root / "data/collision/glow_collisions.asm"
    if not collision_path.exists():
        if "RefreshObjectGlowTypes:" in (root / "engine/gfx/dynamic_pals.asm").read_text(encoding="utf-8"):
            raise ValueError("NPC glow engine exists but its collision table is missing")
        return None  # v3.2.2 predates NPC glow.
    types = []
    for line in _lines(root / "constants/gfx_constants.asm"):
        match = re.fullmatch(r"const (OBJ_GLOW_\w+)", line)
        if match:
            types.append(match[1])
        if line.startswith("DEF NUM_OBJ_GLOW_TYPES "):
            break
    if not types or types.pop(0) != "OBJ_GLOW_NONE":
        raise ValueError("Unsupported NPC glow constants")
    rows = []
    for line in _lines(root / "data/collision/glow_adjustments.asm"):
        if line.startswith("db "):
            values = [int(value.strip()) for value in line[3:].split(",")]
            if len(values) != 3 or any(not 0 <= value <= 31 for value in values):
                raise ValueError(f"Invalid NPC glow RGB adjustment: {line}")
            rows.append(values)
    if len(rows) != len(types):
        raise ValueError("NPC glow adjustment count does not match constants")
    adjustments = dict(zip(types, rows))
    constants = _parse_collision_constants(root)
    collisions = {}
    terminated = False
    for line in _lines(collision_path):
        if not line or line == "GlowCollisions:":
            continue
        if line == "db 0":
            terminated = True
            break
        match = re.fullmatch(r"db (COLL_\w+),\s*(OBJ_GLOW_\w+)", line)
        if not match or match[1] not in constants:
            raise ValueError(f"Unsupported NPC glow collision: {line}")
        if match[2] not in adjustments and match[2] not in {"OBJ_GLOW_DAY", "OBJ_GLOW_NITE"}:
            raise ValueError(f"Unknown NPC glow type: {match[2]}")
        value = constants[match[1]]
        if not 1 <= value <= 255 or str(value) in collisions:
            raise ValueError(f"Duplicate or invalid NPC glow collision: {line}")
        collisions[str(value)] = match[2]
    if not terminated:
        raise ValueError("Unterminated NPC glow collision table")
    fade = (root / "engine/gfx/fade.asm").read_text(encoding="utf-8")
    init = fade.split("\nOWFadePalettesInit::", 1)[1].split("\n\n", 1)[0]
    match = re.search(r"ld a, (\d+)\s+ld \[wPalFadeDelayFrames\], a", init)
    if not match:
        raise ValueError("Unsupported NPC glow fade initialization")
    return {"collision_types": collisions, "adjustments": adjustments,
            "fade_steps": int(match[1]), "fade_step_frames": 2}
