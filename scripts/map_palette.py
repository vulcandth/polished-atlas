"""Map palette time, matching ReplaceTimeOfDayPals/GetTimePalette.

This selects colors only; schedules and object visibility use the actual clock.
Flash removes IN_DARKNESS before applying the map's normal brightness policy.
"""
from collections.abc import Collection

TIME_NAMES = ("morn", "day", "nite", "eve")
FORCED_TIMES = {"PALETTE_MORN": 0, "PALETTE_DAY": 1, "PALETTE_NITE": 2, "PALETTE_EVE": 3}


def palette_time(flags: Collection[str], clock_time: int) -> int:
    clock_time &= 3
    # DARKNESS_PALSET = %00011011, indexed from its low two bits.
    if "IN_DARKNESS" in flags:
        return (3, 2, 1, 0)[clock_time]
    for flag, time in FORCED_TIMES.items():
        if flag in flags:
            return time
    return clock_time
