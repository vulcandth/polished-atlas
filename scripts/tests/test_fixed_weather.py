import base64
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import atlas_common
from event_state import effective_flags, initial_flags, parse_overrides
from fixed_weather import Weather, fixed_weather
from generate_bg_palette_metadata import build_payload as bg_payload, Options
from generate_object_metadata import parse_initial_event_flags, parse_event_overrides
from generate_weather_metadata import build_payload as weather_assets
from generate_weather_state import _determine_weather_for_map
from render_map import _build_renderer


class FixedWeatherTests(unittest.TestCase):
    def test_weekly_schedules_and_civilian_override(self):
        for day in range(7):
            for name in ('AZALEA_TOWN', 'ROUTE_33'):
                self.assertEqual(fixed_weather(name, day, set()), Weather('rain', 1) if day in (0, 2, 4, 6) else Weather())
            for name in ('LAKE_OF_RAGE', 'ROUTE_43'):
                self.assertEqual(fixed_weather(name, day, set()), Weather('thunderstorm', 2) if day in (1, 3, 5) else Weather())
                self.assertEqual(fixed_weather(name, day, {'EVENT_LAKE_OF_RAGE_CIVILIANS'}), Weather('thunderstorm', 2))

    def test_global_story_gate_and_scripted_intensities(self):
        expected = {'STORMY_BEACH': Weather('thunderstorm', 3), 'ROUTE_10_NORTH': Weather('thunderstorm', 4),
                    'ROUTE_9': Weather('rain', 4), 'GOLDENROD_CITY': Weather('rain', 3),
                    'MAGNET_TUNNEL_WEST': Weather('rain', 3), 'ROUTE_34': Weather('rain', 3),
                    'ROUTE_34_COAST': Weather('rain', 3)}
        for day in range(7):
            for name, state in expected.items():
                self.assertEqual(fixed_weather(name, day, set()), state)
                self.assertEqual(fixed_weather(name, day, {'EVENT_AZALEA_TOWN_SLOWPOKES'}), Weather())
        for name in ('ROUTE_9', 'ROUTE_10_NORTH'):
            self.assertEqual(fixed_weather(name, 1, {'EVENT_ROUTE_10_ZAPDOS'}), Weather())
        for name in ('GOLDENROD_CITY', 'MAGNET_TUNNEL_WEST', 'ROUTE_34', 'ROUTE_34_COAST'):
            self.assertEqual(fixed_weather(name, 1, {'EVENT_GOLDENROD_CITY_ROCKET_TAKEOVER'}), Weather())

    def test_nonrain_weather_and_omitted_random_rolls(self):
        flags = {'EVENT_AZALEA_TOWN_SLOWPOKES'}
        for name in ('SNOWTOP_MOUNTAIN_INSIDE', 'SNOWTOP_MOUNTAIN_OUTSIDE', 'SILVER_CAVE_ROOM_3'):
            self.assertEqual(fixed_weather(name, 1, flags), Weather('snow'))
        for name in ('RUGGED_ROAD_NORTH', 'RUGGED_ROAD_SOUTH'):
            self.assertEqual(fixed_weather(name, 1, flags), Weather('sandstorm'))
        self.assertEqual(fixed_weather('CHERRYGROVE_CITY', 1, flags), Weather('cherry_blossoms'))
        self.assertEqual(fixed_weather('CHERRYGROVE_CITY', 1, flags | {'EVENT_GAVE_MYSTERY_EGG_TO_ELM'}), Weather())
        for name in ('CHERRYGROVE_BAY', 'ECRUTEAK_CITY', 'ROUTE_10_SOUTH'):
            self.assertEqual(fixed_weather(name, 1, set()), Weather())

    def test_override_validation_and_shared_precedence(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp) / 'events.json'
            p.write_text(json.dumps({'set': ['ENGINE_JUDGE_MACHINE'], 'clear': ['EVENT_TEST']}))
            with patch.dict(os.environ, ATLAS_EVENT_OVERRIDES=str(p)):
                self.assertEqual(effective_flags({'EVENT_TEST', 'EVENT_KEPT'}), {'ENGINE_JUDGE_MACHINE', 'EVENT_KEPT'})
                self.assertEqual(parse_event_overrides(None), parse_overrides(p))
                other = Path(temp) / 'other.json'
                other.write_text('[]')
                self.assertEqual(effective_flags({'EVENT_TEST'}, other), {'EVENT_TEST'})
            for payload in ({'set': 'EVENT_BAD'}, {'clear': [1]}, {'set': ['BAD']},
                            {'set': ['EVENT_X'], 'clear': ['EVENT_X']}, {'typo': []}):
                p.write_text(json.dumps(payload))
                with self.assertRaises(ValueError): parse_overrides(p)
            with self.assertRaises(FileNotFoundError): parse_overrides(Path(temp) / 'missing.json')


class WeatherCorpusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        required = os.environ.get('ATLAS_UPSTREAM_ROOT')
        cls.root = Path(required) if required else Path(__file__).resolve().parents[2] / 'external/polishedcrystal-master'
        if not cls.root.exists():
            if required: raise AssertionError('Required upstream checkout unavailable')
            raise unittest.SkipTest('Optional pinned upstream checkout unavailable')
        cls.repo = atlas_common.repository(cls.root)

    def test_shared_initial_flags_include_both_event_tables(self):
        flags = initial_flags(self.root)
        self.assertIn('EVENT_INITIALIZED_EVENTS', flags)
        self.assertIn('ENGINE_ROCKET_SIGNAL_ON_CH20', flags)
        self.assertIn('ENGINE_ROCKETS_IN_MAHOGANY', flags)
        self.assertEqual(flags, self.repo.initial_event_flags)
        self.assertEqual(flags, parse_initial_event_flags(self.root))
        self.assertTrue(all(f.startswith(('EVENT_', 'ENGINE_')) for f in flags))

    def test_overcast_and_weather_agree_for_every_map_and_day(self):
        initial = self.repo.initial_event_flags
        for events in (initial, initial - {'EVENT_AZALEA_TOWN_SLOWPOKES'}, set(),
                       {'EVENT_GOLDENROD_CITY_ROCKET_TAKEOVER', 'EVENT_ROUTE_10_ZAPDOS', 'EVENT_GAVE_MYSTERY_EGG_TO_ELM'}):
            for day in range(7):
                for info in self.repo.maps.values():
                    states = [_determine_weather_for_map(self.repo, info, weekday=day, time_of_day=t, events=events) for t in range(4)]
                    self.assertTrue(all(s == states[0] for s in states))
                    self.assertEqual(states[0]['overcast_index'], self.repo.get_overcast_index(info, weekday=day, events=events))
                    self.assertEqual(states[0]['weather'] in ('rain', 'thunderstorm'), states[0]['overcast_index'] is not None)

    def test_overrides_affect_terrain_and_npc_colors_together(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'events.json'
            path.write_text(json.dumps({'clear': ['EVENT_AZALEA_TOWN_SLOWPOKES', 'EVENT_ROUTE_10_ZAPDOS']}))
            with patch.dict(os.environ, ATLAS_EVENT_OVERRIDES=str(path)):
                payload = bg_payload(Options(self.root, Path(temp) / 'unused.json', 1, None))
                png = atlas_common.png_module(self.root)
                for label in ('Route9', 'Route10North', 'StormyBeach'):
                    self.assertTrue(payload['maps'][label]['overcast'])
                    for t, slug in enumerate(('morn', 'day', 'nite', 'eve')):
                        renderer = _build_renderer(png, self.root, self.repo, label, weekday=1, time_of_day=t,
                                                   events=effective_flags(self.repo.initial_event_flags))
                        self.assertEqual(renderer.attributes.colors[:7], payload['maps'][label]['palettes'][slug][:7])

    def test_weather_tiles_and_palettes_are_valid_source_data(self):
        payload = weather_assets(self.root)
        self.assertEqual(set(payload['graphics']), {'rain', 'splash', 'snow', 'sand', 'cherry'})
        for entry in payload['graphics'].values():
            self.assertEqual(len(base64.b64decode(entry['tiles_2bpp_base64'])), 16)
        self.assertEqual(payload['palettes']['PAL_OW_SNOW']['static'], [[255, 255, 255]] * 4)
        self.assertEqual(set(payload['palettes']['PAL_OW_PINK']['time_variants']), {'morn', 'day', 'nite', 'eve'})
