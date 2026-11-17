"""Pinned master's scripted/scheduled weather. Random weather rolls are omitted.

Policy transcribed from engine/events/{overcast,weather}.asm. Weekdays are
Sunday=0 through Saturday=6. Event presence means a set bit, not story completion.
"""
from dataclasses import dataclass
from typing import AbstractSet


@dataclass(frozen=True)
class Weather:
    weather: str = 'none'
    overcast_index: int | None = None


def fixed_weather(constant: str, weekday: int, events: AbstractSet[str]) -> Weather:
    if not 0 <= weekday <= 6:
        raise ValueError('Weekday must be in 0..6')
    # This gate is global, including Stormy Beach and Zapdos weather.
    if 'EVENT_AZALEA_TOWN_SLOWPOKES' not in events:
        if constant in {'AZALEA_TOWN', 'ROUTE_33'} and weekday in {0, 2, 4, 6}:
            return Weather('rain', 1)
        if constant in {'LAKE_OF_RAGE', 'ROUTE_43'} and (
            'EVENT_LAKE_OF_RAGE_CIVILIANS' in events or weekday in {1, 3, 5}
        ):
            return Weather('thunderstorm', 2)
        if constant == 'STORMY_BEACH':
            return Weather('thunderstorm', 3)
        if constant in {'GOLDENROD_CITY', 'MAGNET_TUNNEL_WEST', 'ROUTE_34', 'ROUTE_34_COAST'} and (
            'EVENT_GOLDENROD_CITY_ROCKET_TAKEOVER' not in events
        ):
            return Weather('rain', 3)
        if constant in {'ROUTE_9', 'ROUTE_10_NORTH'} and 'EVENT_ROUTE_10_ZAPDOS' not in events:
            return Weather('rain' if constant == 'ROUTE_9' else 'thunderstorm', 4)
    if constant in {'SNOWTOP_MOUNTAIN_OUTSIDE', 'SNOWTOP_MOUNTAIN_INSIDE', 'SILVER_CAVE_ROOM_3'}:
        return Weather('snow')
    if constant in {'RUGGED_ROAD_NORTH', 'RUGGED_ROAD_SOUTH'}:
        return Weather('sandstorm')
    if constant == 'CHERRYGROVE_CITY' and 'EVENT_GAVE_MYSTERY_EGG_TO_ELM' not in events:
        return Weather('cherry_blossoms')
    return Weather()
