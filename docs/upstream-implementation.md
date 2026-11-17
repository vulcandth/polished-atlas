# Stable/dev implementation and audit

## Objective

Keep main on polishedcrystal v3.2.2 at `/polished-atlas/`, with a long-lived
dev branch at `/polished-atlas/dev/`. Both retain the existing atlas features.
Publish both together manually. Future upstream updates require reviewed SHA
changes, not an automatically moving master reference.

The initial dev target is `704ea9db192ca8b902ef4aa7a441eb905eb29b89`.
The baseline is `e410d7405e7d5d016b16a0a59bfb6da0b2a9eabf` (v3.2.2).
There are 1,051 commits and 3,520 changed endpoint paths in this range.

**Planning inspection was preliminary and NOT exhaustive. Auditing every commit
is implementation work. The known requirements below are not a closed list.**

## Required work

- Capture stable regression evidence; create dev; share deployment infrastructure
  from main while keeping master-specific adaptations on dev.
- Account for every commit, including merges and reverts, and reconcile the
  complete endpoint diff. Per the requested accelerated approach, screen subjects
  and complete changed-file lists in batches; skip clearly unrelated commits with
  an explicit scope reason. Read relevant or ambiguous diffs and validate required
  adaptations. Record the method, disposition and evidence for every SHA in
  `docs/upstream-audit.json` on dev; scope screening is not a full diff review.
- Implement `usepaletteswap` and ordered `paletteswap` tables. Display a spatial
  composite, evaluating each local coordinate with inclusive minimum/exclusive
  maximum boundaries and NULL preserving the previous effective slot selection.
  Include animations, time/weather variants, and background-derived NPC colors.
- Update asset resolution, `.lzp` source fallbacks, banked `tileframe` animations,
  assembly syntax, maps/layouts, objects, dual palettes, collisions, movement
  analysis, and every additional compatibility requirement discovered by review.
- Support the new NPC glow effects explicitly: review upstream glow sources,
  spatial influence, palette selection and RGB adjustments, and implement their
  interactions with time/weather, background-derived colors, palette swaps, and
  secondary object palettes. Verify representative glowing and nearby NPCs;
  locating the engine routines does not count as completing this support.
- Share event state across terrain/palettes/objects/weather. Use fixed scripted
  and scheduled weather only; omit random weather and document this limitation.
- Preserve all four time palettes; default weekday remains Monday. Alternate
  monochrome builds and unrelated gameplay tools are outside scope.
- Validate every supported map and every palette-swap map. Run parser, frontend,
  rendering, stable regression, combined URL, failure, and rollback checks.
- Publish only after complete audit and compatibility validation, then verify
  both live URLs and revision labels.

## Audit tooling

Use a complete upstream clone (the build's shallow source clone is insufficient):

```sh
python scripts/audit_upstream.py --repo external/polishedcrystal --output docs/upstream-audit.json
python scripts/audit_upstream.py --repo external/polishedcrystal --output docs/upstream-audit.json --check
```

Inventory generation starts every commit as `pending`. It does not review or
classify code automatically. Re-running preserves recorded reviews and triage. The check
requires exact commit/file coverage and a resolved disposition, explanation,
and evidence for each commit. A `review_method: scope-screen` resolution records
an explicit relevance-based skip, not a line-by-line review. Relevant/ambiguous
changes still require diff inspection and validation. Passing this structural
check alone does not prove compatibility.

The pinned changelog only adds the v3.2.3 battle-crash hotfix after v3.2.2; it does
not summarize the major master changes. It informs triage but cannot replace the
commit/file inventory. Never skip a change solely because it is undocumented.

## Progress

- Complete upstream history obtained; exact range independently counted.
- Original stable build completed: 605 maps, four time palettes, 29 neighborhoods.
- Local baseline saved under `.build/baseline`; its build log is `.build/baseline.log`.
- Shared pinned-build and combined-publication infrastructure implemented locally.
- Stable clean rebuild matches all 2,145 baseline map assets/metadata files after
  excluding only generation timestamps; all 605 maps pass bundle validation.
- Initial verification: 11 Python tests, 10 frontend tests, TypeScript checking,
  production build, and workflow YAML parsing pass. ESLint reports one existing
  dependency warning in MapCanvas and no errors.
- Dev pins the target revision (whose audit is incomplete) and can index 612 maps and 53 tilesets
  after fixing constants parsing, LZP source fallback, and new roof references.
- Palette-swap parsing covers all 17 affected maps at the pinned target. Terrain
  rendering composites 16px cells and applies the result to every rendered frame.
  Scoped table labels, ordered overrides, NULL chaining, and eight palette variants
  are covered by tests. Goldenrod City and Route 7 static previews are available
  locally in `.build/palette-preview/`; Goldenrod's composite was visually inspected.
- 17 Python tests pass, including the locally available upstream palette-swap corpus.
- One hundred eighteen commits have received detailed review: ninety-two are resolved as no
  atlas impact, five with adaptations, one already supported, and twenty retain
  open validation work.
  Accelerated batches additionally skipped 308 unrelated commits after subject,
  complete file-scope and consumer screening. These are explicitly marked
  `scope-screen`, not full reviews. There are 406 resolved commits in total and
  625 still pending. Inventory generation does not constitute review.
- The latest screening batches cover menu/battle/audio/RAM changes, standalone ROM
  analysis/build tools and LZP compressor maintenance. Atlas consumes checked-in
  raw/PNG sources for LZP references; it does not invoke the compressor. New asset
  declarations and shared rendering changes remain relevant. Small map-script
  diffs were reviewed together: pure dialogue changes can be resolved, while
  changes to branches, event flags, timing or facing remain open for consumer checks.
- The frontend consumes palette-swap regions for background-derived NPC colors,
  including movement, and supports special WHITE/GRASS background color mapping.
  Full generated-site visual verification remains outstanding.
- Current focused checks: 18 Python tests (including the required pinned upstream
  corpus), 15 frontend tests, and TypeScript checking pass. ESLint has one existing
  hook dependency warning and no errors.
- NPC glow requirements are confirmed in target engine sources: collision cells
  select glow types; DAY/NITE select non-overcast palette endpoints; aquarium,
  lantern, Dragon Shrine and lava types add saturated 5-bit RGB adjustments to
  colors 0-2 while preserving color 3. Movement into/out of glow cells fades palettes.
  Relevant sources are `data/collision/glow_collisions.asm`,
  `data/collision/glow_adjustments.asm`, `engine/gfx/dynamic_pals.asm` and
  `engine/gfx/sprite_palettes.asm`. This source inspection is not yet a completed
  review of every glow-related commit.
- Initial NPC glow implementation exports collision and RGB rules from the pinned
  source, applies DAY/NITE overrides and saturated 5-bit adjustments, and tracks
  moving objects' previous/current glow with a shared fade clock. Texture caches
  distinguish glow states and local background colors. Disabling object animations
  settles the palette at the object's displayed location.
- Real upstream sprite previews were inspected in the browser at day and night:
  Fuchsia Aquarium schoolboy, Ecruteak Gym Morty, Route 11 Youngster, Rugged Road
  Hiker and a Cinnabar Volcano boulder, including entering/leaving fade samples.
  These focused previews do not verify full MapCanvas movement or all interactions.
- This verification exposed missing `.lzp` sprite source fallbacks and the renamed
  boulder/rock sprite. Both are adapted; the corpus now checks every ordinary sprite
  header with a source path produces nonempty, tile-aligned graphics. PNG decoding
  closes source files instead of leaving reader-owned handles open.
- Thirteen additional glow-related commits have been reviewed, including byte-level
  inspection of changed metatile, attribute and map block data. Their compatibility
  dispositions remain open for full-site validation. Some additional glow changes
  (volcano introduction, Fire Island and Indigo Plateau windows) are only partially
  reviewed and still count as pending.
- Current glow checks: 20 Python tests and 23 frontend tests pass, including all
  ordinary sprite source decoding, both RGB metadata encodings, cache separation,
  palette endpoints and exact 5-bit fade convergence. TypeScript checking passes;
  ESLint reports one existing hook-dependency warning and no errors. The audit
  publication gate correctly fails with 1,031 unresolved commits (1,014 pending
  review plus 17 reviewed with outstanding adaptation/validation).
- Banked animation command engine implemented in `scripts/tile_animation.py`.
  It parses all 53 target tables, runs one command per VBlank, preserves command
  aliases and both VRAM banks, supports multi-tile and unaligned byte copies,
  scrolling, palette effects, and explicit time/event/hardware-counter inputs.
  Engine routines and `maskbits` macro were read at the target revision; this
  does not constitute reviewing their entire commit history.
- All 53 tilesets were simulated using their actual decoded graphics. Thirty-five
  produce changes; every command stream reaches a repeating state. The longest
  captured loop is 1,536 frames for PokeCom Center. Evidence is retained locally
  in `.build/tile-animation-corpus.json`. Hardware-divider samples use a fixed
  CGB double-speed phase for reproducibility; actual CPU execution can shift the
  Judge machine's samples. This is not a cycle-accurate ROM emulator.
- Modern sheet export now writes a base map plus a compact 8px tile atlas and
  independently timed tracks. This preserves blank VBlanks, both tile banks,
  flips, spatial palette swaps and palette-animation commands without duplicating
  the entire map for every frame. The frontend composites the tracks below objects
  and markers. Disabling map animation displays the baked initial frame.
- Synthetic export reconstruction matches the full raster renderer at every
  captured VBlank, including both banks, all flips and a spatial palette swap.
  Metadata validation rejects missing images, bad dimensions/indices/durations,
  out-of-bounds positions and overlapping tracks. Focused browser previews show
  Goldenrod, National Park and a static Ecruteak Gym through the actual loader.
- The first full-site preview exposed empty neighborhoods and unresolved warps:
  upstream removed map_attributes' fourth argument. The parser now accepts both
  forms, derives modern connection flags and fails malformed/empty input. Complete
  map inventory and nonempty neighborhood checks prevent a silent empty world.
  Parent/commit graph comparison for a79dd2a36 proves all 607 records unchanged;
  the target corpus checks all 612 headers and every connection declaration.
- Canonical map identities now follow header-table group/index order. Upstream's
  LavRadioTower4F attribute declaration reuses the 3F constant for dimensions;
  treating that as its identity broke tower warps. All declared warp targets now
  resolve while dimensions still follow the attribute declaration.
- The generated production preview renders 29 neighborhoods and switches day/night
  (the initial check produced no console errors). Full static mode exposed stale visibility after ticker
  shutdown; on-demand rendering now refreshes culling and animation state first.
  The rebuilt preview remains visible with both animation toggles disabled.
  Indoor navigation is not yet visually verified. A later initial-load check
  reported failures for several map assets that subsequently loaded after toggling;
  investigate loader/cancellation behavior before calling browser verification complete.
- Current checks: 35 Python tests, 26 frontend tests, TypeScript checking and the
  production build pass. ESLint reports the existing hook-dependency warning and
  no errors. Complete generated-bundle validation passes locally with dirty-build
  provenance preserved. These checks are not complete upstream compatibility proof.
- A complete dev build now validates its generated bundle before reporting success.
  It includes all 612 maps, four time variants and 29 neighborhoods. Dirty build
  asset versions include the generation time to prevent stale force-cached previews.
  The publication audit gate still rejects 645 unresolved commits: 625 pending
  and twenty reviewed with open validation. Nothing has been pushed or published.
- Shared map palette time now follows upstream's brightness table, including forced
  MORN/DAY/NITE/EVE and the pre-Flash darkness mapping. Terrain, roof colors, animation
  gates, palette-swap regions and NPC context use the same policy; object schedules
  still use actual clock time. Explicit darkness metadata covers Rock Tunnel and
  Scary Cave Shipwreck rather than relying on map-name guesses.
- Found and adapted a major parser gap: modern `special_bg_pal` specifies a starting
  slot and palette count. All 93 declarations now parse instead of being silently
  skipped. The renderer overlays the selected subset on environment colors, handles
  TIMEWEATHER's eight variants, palette aliases, copied BG slots, PokeCenter/Mart/
  Magnet Train/generic grotto routines, and excludes `if 0` reference palettes.
  Overcast roofs now use map-group indexing; forest/Faraway roof exceptions apply.
- Current verification: 40 Python tests and 28 frontend tests pass; TypeScript and
  the complete 612-map dev build pass, including bundle validation. Tests compare
  every map's palette time to the upstream table, exercise every declared special
  palette variant, and assert known upstream RGB values and subset positions.
  ESLint retains one existing hook-dependency warning and no errors.
- The rebuilt production preview was inspected at day/night in Ecruteak City.
  Dance Theater entrance/exit warps work, and the forced-day interior and NPCs
  retain their colors when entered at night. This limited browser pass recorded
  no console errors; it does not complete full-site glow or loader verification.
- Another accelerated pass processed 58 commits in batches: 50 detailed no-impact
  resolutions, four explicit scope skips, and four relevant changes left open.
  The cleared changes cover menu/text rendering, ROM layout and CPU bookkeeping,
  unused tools, and equivalent weather-loop optimizations. Shared graphics files
  were inspected at diff level rather than excluded by directory or commit title.
  The open findings cover VBlank timing validation, immediate weather clearing,
  fixed rain/thunder intensity, and Zapdos-dependent Route 9/10 overcast.
- Target-source weather inspection also confirms the global Azalea Slowpoke gate
  on rain/overcast, snow in Silver Cave Room 3, and guaranteed Cherrygrove City
  blossoms before delivering the Mystery Egg. These findings drove the shared event
  state and particle/palette integration below; broader verification remains open.
  Random regional weather and random later blossoms remain intentionally omitted.
- Fixed weather now shares one event/engine-flag loader and override policy across
  terrain, animation, objects, background palettes and weather generation. This
  fixes terrain ignoring overrides and stopping before the initial engine flags.
  Invalid overrides fail, and invariant-render caching includes effective flags.
  The shared weather policy implements the global Slowpoke gate, weekly schedules,
  fixed rain/thunder intensity, Zapdos/Team Rocket conditions, all three snow maps,
  sandstorms and guaranteed early Cherrygrove blossoms. Two reviewed weather
  commits are now resolved with these adaptations and corpus checks.
- Weather graphics now follow upstream INCBIN declarations and load the declared
  tile prefix. Snow uses white for all visible colors; blossoms use PAL_OW_PINK.
  The frontend spawns blossoms from cherry-leaf collision cells or map edges,
  refreshes when weather metadata arrives, and uses effective map palette time.
  It no longer invents rain from a map-name hash while metadata loads. Weather
  fields are also attached to indoor overlays and disposed on close. Parent map
  transforms handle panning rather than applying the camera delta twice.
- Current checks: 48 Python tests, 32 frontend tests and TypeScript checking pass.
  The complete 612-map/four-time dev build and bundle validation pass. ESLint has
  the existing hook-dependency warning and no errors. Tests cover all maps over
  seven weekdays/four clock times with several event states, terrain/metadata
  agreement under overrides, weather source tiles, and blossom spawning rules.
- Browser preview confirms Cherrygrove day/night rendering and weather off/on
  without console errors; a screenshot is retained at `.build/cherrygrove-weather.jpg`.
  Indoor snow overlays, rapid teardown during asynchronous weather loading, and
  non-default rainy event-state browser scenarios still need focused verification.
- Exhaustive review, remaining dev compatibility, complete visual verification,
  pushing branches, CI execution, and publication remain incomplete.

## Immediate remaining implementation work

- Verify palette-swap NPC colors in the full generated site. The frontend now
  consumes swap metadata and rebuilds background-derived NPC frames when movement
  crosses a color boundary; focused tests cover selection and boundary changes.
- Finish animation integration with animated background-derived object colors,
  shared event state. Forced map time is now shared across terrain and objects. Modern GIF output still fails explicitly
  on modern tables and needs adaptation. Backport compact-asset validation into
  main's shared publication tooling, then verify combined deployment.
- Complete NPC glow effects, weather integration verification, dual object palettes,
  and all map/object/movement findings from the audit.
- Finish glow validation on Dragon Shrine, cave mouths, underground lamps and lava
  ladders, including directional walls/warps and secondary palettes. Verify
  `SPRITE_AQUARIUM_MON` handling (also used for volcano Moltres), and reconcile
  all remaining dynamic-palette rules; explicit map time now replaces the indoor/day
  heuristic for current metadata. Implement hidden-grotto entrance-dependent colors
  for Bellchime Trail, Cherrygrove Bay and Yellow Forest.
- Audit dual connections and the shortened FakeRoute36 border alias used by
  RuinsOfAlphOutside; a complete parsed inventory alone does not validate layout.
- Validate Route23North/South's seam, officer placement and Victory Road/League
  Gate warp round trips. The split commit's text and binary changes are reviewed;
  its two block arrays exactly concatenate to the old map, but visual checks remain.
- Dev builds now require upstream corpus tests after source checkout, checking
  the exact pinned SHA. Extend that corpus coverage alongside further adaptations.
- Finish the commit ledger, then run full combined-site/browser tests and publish.
