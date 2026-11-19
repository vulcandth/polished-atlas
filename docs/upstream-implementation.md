# Stable/dev implementation and audit

## Objective

Keep main on polishedcrystal v3.2.2 at `/polished-atlas/`, with a long-lived
dev branch at `/polished-atlas/dev/`. Both retain the existing atlas features.
Publish both together manually. Future upstream updates require reviewed SHA
changes, not an automatically moving master reference.

The dev target is `f8e67fbd53ad7a99870d8ab87fd73612e6c6a679`, verified against
upstream master on November 18, 2026. The first audit pass targeted `704ea9db1`.
The baseline is `e410d7405e7d5d016b16a0a59bfb6da0b2a9eabf` (v3.2.2).
There are 1,057 commits and 3,520 changed endpoint paths in the current range.

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
- One hundred forty commits have received detailed review: 112 are resolved as no
  atlas impact, five with adaptations, one already supported, and twenty-two retain
  open validation work.
  Accelerated batches additionally skipped 325 unrelated commits after subject,
  complete file-scope and consumer screening. These are explicitly marked
  `scope-screen`, not full reviews. There are 443 resolved commits in total and
  586 still pending. Inventory generation does not constitute review.
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
- The next accelerated batch processed 39 commits: twenty detailed no-impact
  resolutions, seventeen explicit scope skips, and two relevant changes retained
  for validation. Title/splash screens, item illustrations, audio scores and unused
  ROM tools were screened by their complete file lists and atlas consumers;
  shared-file diffs were inspected where needed. The changelog still supplies no
  comprehensive master feature summary. The ledger now has 608 unresolved commits
  (586 pending and 22 reviewed with open work); this is not a completed audit.
- Two additional checks emerged from that batch: `half2` NPC steps now last
  sixteen frames instead of eight, and block `$00` is a normal metatile rather
  than an alias for the map border. The raster renderer already indexes zero
  directly; movement timing, connected borders and collision behavior still need
  validation. These findings expand the requirements rather than replace the
  explicit palette-swap and NPC-glow work.

- Latest NPC adaptation: modern six-field `db` movement records now export all
  59 entries; missing/truncated records fail instead of silently producing an
  empty movement table. Pokémon palette constants, repeated icon palette entries
  and extended form indices now resolve consistently. Packed light/dark palettes
  compose before glow/fading; ordinary aquarium palettes remain distinct.
- Dual object palettes now select colors per facing tile for Ho-Oh, Lugia and
  Alolan Exeggutor. World and indoor contexts preserve the map pair during spatial
  refresh. Aquarium Pokémon (including volcano Moltres) use the icon renderer,
  and modern background alignment flags supply their vertical placement.
- Verification for this adaptation: 54 Python tests, 37 frontend tests, TypeScript
  and the complete 612-map/four-time dev build pass. The frontend was rebuilt and
  the bundle validated after final source cleanup. Required frontend lint has no
  errors and retains the existing hook-dependency warning. Stable-source object
  metadata generation also succeeds; this is not a full stable regression pass.
  Source-based browser samples cover both large-bird frames, Exeggutor, Marill,
  aquarium fish and volcano Moltres at day/night without console errors. Packed
  glow combinations have focused pixel tests; full-world glow validation remains.
- **World-layout defect found during NPC verification:** Fuchsia City and nearby southwestern Kanto routes
  have generated assets but are absent from the connected neighborhood. The
  generator marks an undirected component as consumed after traversing only its
  outgoing connections; the Route14/LuckyIsland synthetic dual connection left
  real maps unreachable in that traversal. Passing map counts and bundle checks
  did not detect the omission. The following adaptation restores these maps.
- The ledger still has 608 unresolved commits: 585 pending and 23 reviewed with
  open work. Five partially inspected feature commits retain pending status with
  adaptation notes; the three-file object-flag change received a full diff review
  and stays open for integration validation. Implementation tests do not substitute
  for the remaining commit audit.
- Dual connection tables now expand into both actual destinations at upstream's
  offsets, with the source-edge split recorded in cell coordinates. Replaced
  Route14/LuckyIsland and Olivine/coast border strips are omitted from world
  placement; the playable Cherrygrove track remains. Derived reverse constraints
  place maps with one-way connections without changing the parsed game exits.
  Generation checks every eligible outdoor map and component, and the frontend
  rejects connection graphs containing unplaced maps. Current source constraints
  have no coordinate conflicts. The world now contains 125 maps in 29 neighborhoods,
  compared with 102 before the fix; all 612 individual map assets remain available.
- Verification: 56 Python tests, 39 frontend tests, TypeScript and the full
  four-time dev build/bundle validation pass. Lint has no errors and the existing
  hook-dependency warning. Browser verification confirms restored Fuchsia and
  nearby routes, aquarium 1F entry at day/night, and the exit back to Fuchsia.
  Screenshots: `.build/fuchsia-aquarium-day.jpg`,
  `.build/fuchsia-aquarium-night.jpg`, `.build/fuchsia-restored-night.jpg`.
  No console errors occurred; opening an overlay emits an existing Pixi
  `interactive` deprecation warning. This verifies access and displayed sprites,
  not every aquarium floor, animation phase, dual seam or glow transition.

- Latest audit batch: 46 commits processed, with 41 resolved and five retained
  as reviewed/open. Thirty-one resolutions are dialogue, excluded random weather,
  field-move interaction or equivalent ROM bookkeeping changes with no atlas
  impact. Ten validate supported data regeneration or existing adaptations,
  including Lugia symmetry, Copycat teal, dark NPC overcast colors, rock animation
  names, palette-swap ordering and three connection edits.
  Two large mechanical conversions used exact normalization: all 51 movement
  records match after accounting for the old macro's palette-nibble packing, and
  both complete tileset files match after the 22-prefix rename mapping. These are
  recorded as `normalized-diff`, distinct from line-by-line full patch review.
- The audit now has **484 resolved, 539 pending and 28 reviewed/open commits**
  (567 unresolved total). New open checks cover Cerulean/Route24 bridge state,
  Dragon Shrine scripted paths, Trainer House's daily variable sprite and arch-tree
  priority/obstruction. This batch does not complete the audit or broaden the
  previous visual verification claims.

- Accelerated asset batch: **76 more commits processed, 72 resolved and four
  reviewed/open**. Seventy-three commits were grouped by their complete changed-file
  scope, then checked using raw binary comparisons, decoded PNG differences and
  current source consumers. These records use `binary-data-diff`; they are neither
  relevance-only skips nor claims of visual inspection of every changed pixel.
  One PNG re-encoding uses `normalized-diff`: both complete decoded images are
  identical. Farigiraf menu-mini art is excluded because the atlas selects the
  separate overworld icon. Other resolutions cover regenerated terrain and sprite
  assets. Exact raw metatile/attribute ingestion was checked for all 25 affected
  current tilesets, and affected sprite sources decode successfully.
- This batch found an additional rendering gap: the barn-entrance change toggles
  BG priority on four tiles. The raster renderer currently discards that bit, so
  regeneration alone cannot make objects pass behind the entrance. This stays
  open alongside the existing object-priority work. Full text diffs for the three
  entrance-dependent hidden-grotto palette commits were also reviewed; they stay
  open for origin-aware terrain/NPC palette selection and navigation validation.
- Current ledger: **556 resolved, 463 pending and 32 reviewed/open commits**
  (**495 unresolved**). The full audit is still incomplete. The changelog remains
  a triage aid, not a complete account of master changes. No new full-site visual
  verification or publication is claimed by this asset batch.

- Hidden-grotto entrance palettes now carry the entering map constant through
  overlay selection, NPC background-color context and return backlinks. The
  renderer and background metadata apply the same GREEN/ROOF copies for Bellchime
  Trail, Cherrygrove Bay and Yellow Forest, preserving ROOF color 0. Generic
  entrances retain the original palette. Overlay reuse distinguishes origins.
  The build emits all 24 origin/time/map assets, and publication validation rejects
  missing variants, mismatched dimensions or missing palette rows. Cave-grotto
  terrain uses only slots 4/5, so its three origin images correctly remain identical;
  the changed slots 2/6 remain available to background-derived object colors.
- Verification: 58 Python tests, 40 frontend tests, TypeScript and the complete
  612-map/four-time build pass. Lint has no errors and retains the existing hook
  dependency warning. Exact source RGB5 expectations, terrain/NPC metadata equality
  and origin isolation are checked at all four times for both grotto maps. The
  stable v3.2.2 grotto policy remains identical and emits no entrance variants.
  Browser verification shows orange, yellow and pink grottos entered from the
  respective maps, with correct return warps; Bellchime also passes at night.
  No console errors occurred. Screenshots are `.build/grotto-bellchime-day.jpg`,
  `.build/grotto-bellchime-night.jpg`, `.build/grotto-yellow-day.jpg` and
  `.build/grotto-cherrygrove-day.jpg`. This does not validate randomized grotto
  contents or complete the broader NPC glow checks.
- The three entrance-palette commits are resolved. Current ledger: **559 resolved,
  463 pending and 29 reviewed/open commits** (**492 unresolved**). The audit and
  publication work remain incomplete; nothing has been pushed or published.

- Further accelerated triage resolved **31 commits**: 24 scope screens, six full
  text-diff reviews and one whitespace-normalized comparison. The scope screens
  exclude ROM UI, encounter simulation, assembler updates and other unrelated
  consumers; they do not claim full patch or binary-pixel review. Focused text
  inspection was used where party/status UI shared graphics source files.
  The palette-table relocation is already handled by `PaletteSwapIndex`; all
  seven palette-swap tests pass, including the pinned upstream corpus. The first
  test attempt hit the environment's broken MSYS Git; rerunning with Windows Git
  passed. No product code changed in this batch.
- Rechecking the complete changelog diff confirms that its only new release
  entry is the v3.2.3 battle-crash hotfix. Commit/file triage remains necessary.
  Hardware constants and other ambiguous shared changes remain pending rather
  than being skipped on their titles. Current ledger: **590 resolved, 432 pending
  and 29 reviewed/open commits** (**461 unresolved**). These findings remain
  non-exhaustive; `paletteswap`, NPC glow and the other open validation work below
  are still required. Nothing has been pushed or published.

- BG tile priority now survives compact export as RGBA foreground tracks above
  NPCs and below weather. Coverage uses source color indices, so index 0 remains
  transparent even if its RGB matches another color. Static priority tiles remain
  visible when map animation is disabled; animated coverage and colors share the
  terrain clock. Texture cleanup includes the new layer. The priority rule is
  documented in [Pan Docs](https://raw.githubusercontent.com/gbdev/pandocs/master/src/Tile_Maps.md).
- Verification: 59 Python tests, 41 frontend tests, TypeScript and the full
  612-map/four-time build pass. Lint has no errors and retains the existing hook
  dependency warning. All 1,056 base map images are byte-identical to the previous
  grotto build. There are 184 priority atlases, five with animated tracks. Bundle
  validation checks foreground assets even without background animation and
  rejects missing, invalid or opaque replacements. The frame-by-frame fixture
  covers banks, flips, palette swaps, static tiles and index-zero transparency.
- Browser validation used the real Route39 terrain and generated cowgirl sprite
  in a controlled overlap fixture; no NPC map positions were changed. The lintel
  hides overlapping pixels in day/night and with animation disabled, while moving
  the fixture sprite clear of it restores the full sprite. The built atlas loads
  day/night and supports the animation toggle without console errors. Evidence:
  `.build/priority-barn-day.jpg`, `.build/priority-barn-night.jpg`,
  `.build/priority-atlas-night.jpg`, and `.build/priority-regression.json`.
  Exact source-attribute reconciliation checks all 1,056 map/time assets with no
  missing or extra priority positions (`.build/priority-source-coverage.json`).
  This is not a claim of visual inspection of every priority tile or completion
  of NPC glow/grass/object-ordering work. The barn commit is resolved: **591
  resolved, 432 pending and 28 reviewed/open** (**460 unresolved**).

- World and overlay object containers now sort by upstream LOW/NORMAL/HIGH
  priority. LOW wins if both priority bits are set. Stable insertion order keeps
  later source objects in front within each group, matching reverse OAM writes
  for initial source-order allocation; screen Y does not change the order. This
  does not emulate runtime object-slot allocation, player-follow priority changes
  or skyfall transitions. The existing terrain-priority/weather layers stay above
  the object container.
- All 18 arch-tree movement consumers across EcruteakCity, EcruteakShrineOutside,
  SilverCaveRoom3 and VermilionCity carry LOW_PRIORITY/EMOTE_OBJECT and no longer
  MOVE_ANYWHERE/HIGH_PRIORITY. Upstream skips EMOTE_OBJECT in occupancy checks;
  atlas movement summaries already use terrain-only collisions and add no
  decoration occupancy. General NPC-to-NPC collision simulation is not claimed.
  The arch-tree commit is resolved after a real-asset overlap check.
- Verification: 60 Python tests, 42 frontend tests, TypeScript and frontend
  production build pass; lint retains only the existing hook warning. Browser
  fixtures verify low-priority arch fragments behind NPCs, high-priority Rattata
  in front of Pidgey, and stable ties in day/night, with no console errors.
  Screenshots: `.build/object-order-day.jpg`, `.build/object-order-night.jpg`.
  No generated source assets changed or needed rebuilding in this step.
- Full review of the Rattata priority commit found its new movement type also
  needs idle bounce animation: upstream alternates DOWN/UP facing every 16
  VBlanks. Priority is fixed, but that commit remains open until the animation
  path is implemented and verified, including the same sprite's static decorative
  reuse. Current ledger: **592 resolved, 431 pending and 28 reviewed/open**
  (**459 unresolved**). The audit remains incomplete; nothing is published.

- The Route30 Rattata now bounces using its two source facings, with 16 VBlanks
  per pose. The built atlas showed both poses. Corpus tests cover all three
  SilverCaveRoom3 decorations that reuse its graphics. The full dev build,
  61 Python tests, 44 frontend tests and the CI TypeScript check passed.
- Ten additional animation-related commits received full diff reviews. The ledger
  records three bookkeeping changes with no atlas impact, one superseded pillar
  timing, and six changes already handled by final animation tables and palette
  metadata. With Rattata resolved, 603 commits are resolved, 421 pending and
  27 reviewed/open. The audit is incomplete.

- A batch of 65 commits changed only existing terrain assets. The audit resolved
  57 after matching every changed path to consumers in the pinned source index
  and each consuming map to a built asset. Changed collision source lines were
  checked for ordinary tilecoll records. Eight candidates remain pending for
  further review. The binary assets received file-scope review.
- Full review of dd1056be found a remaining variable-sprite palette gap for
  dolls, daycare and grotto Pokémon. Including that open finding, the ledger
  now has 660 resolved, 363 pending and 28 reviewed/open.
- Both GIF commands now use the modern compact tile tracks. The Sprout Tower
  1F export matched all 33 rendered frames and their rounded GIF delays across
  its 320-VBlank loop. A regression test covers two independent track periods.

- The Goldenrod Harbor border review exposed obsolete macro graphics and
  incorrect event flags on 13-argument objects. Dev now reads fixed sprite
  and palette arguments from the checked-out wrapper macros, reads the flag
  from the last argument, and chooses fruit artwork using FIRST_BERRY_TREE.
  Regenerated metadata covers 318 regular item balls, 29 key/TM balls, 61 cut
  trees and 54 fruit trees. The Harbor seam still needs a visual check.
- Verified time slots and movement data for the Celadon gardener and Rugged
  Road hikers, firebreather and Black Belt. The ledger now has 663 resolved,
  359 pending and 29 reviewed/open. Findings remain preliminary.

- Local main commit a44f8e0 validates dev compact animation layers and
  entrance variants in both publication and rollback. The clean combined build
  used main a44f8e0 and dev 187cd96 at the configured project URLs. Assembly
  and retained-site verification passed at 97,727,559 bytes. The two entries
  reference their respective JavaScript and CSS assets. All 1,010 generated
  stable map PNGs matched the previous v3.2.2 output byte for byte.
- Dev now applies the upstream side-wall direction masks on entry and exit for
  axis movement, reachable-cell exploration and animated wandering. Left/right
  glow wall IDs retain the directional behavior of their ordinary counterparts.
  TypeScript and all 48 frontend tests passed. This change follows the combined
  build above. Final combined browser and publication checks remain open.

### Batched review on November 18

The changelog adds only the v3.2.3 battle hotfix. The two Flare Blitz commits
already have dispositions. A pass over the 359 then-pending commits at the
first pin scanned added and removed assembly lines in 15 batches. It found
palette-swap signals in 15 commits, glow in 3, object definitions in 126,
connections or warps in 76, and tile animation in 47. Groups overlap. These
counts describe this batch only. The ledger preserves specific file leads for
204 still-pending commits. Commits without matching lines still require a
disposition, especially binary art, renames, and changes to shared engine code.

- Screened out 15 commits affecting dialogue, audio, encounter rates, game UI,
  RAM transfers, formatting, or assets the atlas does not display. Checked
  mixed commits separately. For example, the Fly/Teleport change also gates
  overcast roofs by environment, and the nine files in the reverted roof
  refactor returned byte-for-byte to their previous versions.
- Checked all 25 palette-swap rectangles in 17 maps and the eight RGB variants
  of each of 26 palette labels against source. Across four times of day,
  19,312 base tile placements used the expected palette. Checked every frame
  used by 7,568 animated placements against its allowed colors. Route 7
  declares a water-slot swap but has no tiles using that slot in its interior.
  Its connected border and moving NPC visuals still need verification.
- Found all nine glow collision types across 377 cells in the generated maps.
  The aquarium schoolboy at (4,4) and Morty at (5,1) stand on lit cells.
  The cave-mouth, ladder and Dragon Shrine side-wall fixtures need movement
  through the cells to exercise their effects.
- The Judge Machine also changes six screen blocks when powered on. The
  renderer and collision generators now use the same conditional block changes
  for single-flag tile callbacks. Four callbacks in this revision match this
  form. Separate renders with the machine off and on verified all 18 distinct
  cycle colors appear only when powered on. Cave flicker writes directly to
  the display hardware. The Judge cycle writes to BG palette 6 in the active
  buffer, and none of the 21 declared objects in the two PokéCom maps copies
  that slot.
- Reviewed all six additional commits through `f8e67fbd5`. National Park, its
  contest variant and both gatehouses now belong to map group 41. Checked the
  regular and overcast group colors. Comparing both park renders across all
  four times localized the pixel changes to the flower strip. The compressed
  offset encoding changed upstream. Atlas consumes the checked-in source
  assets, and the target Git tree contains zero tracked `.lzp` files.

**698 resolved, 331 pending, 28 reviewed with open work.** Commit-level
coverage and runtime validation remain in progress.

## Immediate remaining implementation work

- Verify palette-swap NPC colors in the full generated site. The frontend now
  consumes swap metadata and rebuilds background-derived NPC frames when movement
  crosses a color boundary; focused tests cover selection and boundary changes.
- Check remaining event-dependent tile callbacks, object visibility and weather
  against the shared snapshot. Forced map time is shared across terrain and
  objects. Run the final combined-site checks before deployment.
- Complete NPC glow effects, weather integration verification, dual-palette integration validation,
  and all map/object/movement findings from the audit.
- Finish grass occlusion and per-facing RELATIVE_ATTRIBUTES/OAM_PRIO behavior.
  Static object priority groups and BG attribute priority are implemented as
  recorded above; broader glow and runtime object-priority interaction validation
  remains open.
- Finish glow validation on Dragon Shrine, cave mouths, underground lamps and lava
  ladders, including directional walls/warps and secondary palettes. Verify
  `SPRITE_AQUARIUM_MON` handling (also used for volcano Moltres), and reconcile
  all remaining dynamic-palette rules; explicit map time now replaces the indoor/day
  heuristic for current metadata. Hidden-grotto entrance-dependent terrain and
  background palettes are implemented and verified as recorded above.
- Finish dual-connection commit review and visual seam checks, including the
  Cherrygrove track/city overlap. Resolve the shortened FakeRoute36 border alias
  used by RuinsOfAlphOutside; the ruins now place via their Route32 connection,
  but their north connection still needs explicit alias handling/validation.
- Validate Route23North/South's seam, officer placement and Victory Road/League
  Gate warp round trips. The split commit's text and binary changes are reviewed;
  its two block arrays exactly concatenate to the old map, but visual checks remain.
- Dev builds now require upstream corpus tests after source checkout, checking
  the exact pinned SHA. Extend that corpus coverage alongside further adaptations.
- Finish the commit ledger, then run full combined-site/browser tests and publish.
