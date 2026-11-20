"""List detached overworld groups and possible seams indicated by game warps."""
from itertools import combinations


def stitch_report(manifest: dict, warp_maps: dict) -> dict:
    groups = {label: group["id"] for group in manifest["neighborhoods"]
              for label in group["map_labels"]}
    mainland = groups["NewBarkTown"]
    direct = set()
    interiors = {}
    for source, data in warp_maps.items():
        for warp in data["warps"]:
            target = warp["target"]["map_label"]
            if not target:
                continue
            if source in groups and target in groups:
                if groups[source] != groups[target]:
                    direct.add(tuple(sorted((source, target))))
            # Concrete exits on the interior distinguish a through-gate from
            # a shared grotto template that returns to whichever map opened it.
            elif source not in groups and target in groups:
                interiors.setdefault(source, set()).add(target)
    shared = [
        {"via": room, "maps": [first, second]}
        for room, outside in sorted(interiors.items())
        for first, second in combinations(sorted(outside), 2)
        if groups[first] != groups[second]
    ]
    return {
        "mainland": mainland,
        "detached_groups": {group["id"]: group["map_labels"] for group in manifest["neighborhoods"]
                            if group["id"] != mainland},
        "direct_warps_between_groups": sorted(direct),
        "shared_interiors_between_groups": shared,
    }
