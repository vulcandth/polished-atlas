#!/usr/bin/env python3
"""Compare complete generated map directories, ignoring only JSON timestamps."""
import argparse
import hashlib
import json
from pathlib import Path


def normalize(value):
    if isinstance(value, dict):
        return {k: normalize(v) for k, v in value.items() if k != "generated_at"}
    if isinstance(value, list):
        return [normalize(v) for v in value]
    return value


def compare(before: Path, after: Path) -> dict:
    old = {p.relative_to(before).as_posix(): p for p in before.rglob("*") if p.is_file()}
    new = {p.relative_to(after).as_posix(): p for p in after.rglob("*") if p.is_file()}
    differences = []
    for name in sorted(old.keys() | new.keys()):
        if name not in old or name not in new:
            differences.append({"file": name, "change": "added" if name in new else "removed"})
            continue
        if name.endswith(".json"):
            same = normalize(json.loads(old[name].read_text(encoding="utf-8"))) == normalize(json.loads(new[name].read_text(encoding="utf-8")))
        else:
            same = hashlib.sha256(old[name].read_bytes()).digest() == hashlib.sha256(new[name].read_bytes()).digest()
        if not same:
            differences.append({"file": name, "change": "modified"})
    return {"before_count": len(old), "after_count": len(new), "differences": differences}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", type=Path)
    parser.add_argument("after", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    result = compare(args.before, args.after)
    text = json.dumps(result, indent=2) + "\n"
    if args.report:
        args.report.write_text(text, encoding="utf-8")
    print(text)
    raise SystemExit(bool(result["differences"]))
