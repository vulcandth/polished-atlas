# Stable/dev implementation and audit

## Objective

Keep main on polishedcrystal v3.2.2 at `/polished-atlas/`, with a long-lived
dev branch at `/polished-atlas/dev/`. Both retain the existing atlas features.
Publish both together manually. Future upstream updates require reviewed SHA
changes, not an automatically moving master reference.

The dev target is `f8e67fbd53ad7a99870d8ab87fd73612e6c6a679`, verified against
upstream master on November 19, 2026. The first audit pass targeted `704ea9db1`.
The baseline is `e410d7405e7d5d016b16a0a59bfb6da0b2a9eabf` (v3.2.2).
There are 1,057 commits and 3,520 changed endpoint paths in the current range.

## Current audit status

All 1,057 commits from v3.2.2 through `f8e67fbd` have had a relevance
screen. The ledger resolves 1,041. All 16 open commits now have specific
follow-up work recorded against their diffs. The list of known features is
preliminary. Auditing the outstanding changes and validating them in the
Atlas remain part of implementation.

The latest batch closed 19 commits, including Celadon’s rooftops, Moomoo
Farm’s day and night occupants, Faraway Island’s ferry landing, Fuchsia’s
four timed Tauros, and the Rugged Road palette boundary. Of the 552 total commits classified
as having no Atlas impact, 364 were skipped after examining their subject,
changed paths and consumers. The changelog adds only the v3.2.3 battle
crash fix. Use the commit diffs to find unreleased master changes.

| Open commit group | Remaining work |
| --- | --- |
| Palette swaps, NPC glow and weather | Verify map transitions for background-derived and dual NPC palettes, weather particles that survive a change of weather, and sprite priority when more than ten tiles share a scanline. |
| Navel Rock and hidden grottoes | Represent the offset north/south self-connection. Choose one coherent grotto encounter state per entrance and resolve its sprite and palette. |
| Variable NPCs and Pokémon | Replace the Trainer House’s placeholder sprite with an eligible daily opponent. Check the fourth player choice, daycare deposits and dolls against the snapshot. |
| Ruins of Alph and map scripts | Check the redesigned chambers and entrances, the research scientist’s entry-scene position and the script commands that dispatch through tables or return after showing text. |

The Route 10 North storm fade matched the game's RGB5 colors on 296,960
opaque pixels at six fade steps in both day and night views. The two
Rugged Road maps met without a gap at three camera positions in each view.
Eusine’s standing locations passed all 32 combinations of the story and
respawn flags under test.

The scene-table check matched 90 script pointers and 241 named scene IDs
against RGBDS across 612 maps. The movement analyzer follows deferred
scripts at both cable car stations, the Olivine Lighthouse and the Dragon
Shrine. The shrine test starts only at the front door. At Silph Co.,
Chrome showed the guard at (13,1) before power restoration and (14,1)
afterward. That batch supported 24 complete clock- or event-driven object
callbacks and changed 15 maps in the default Monday export.

The coast tileset review found that Olivine Lighthouse windows light up only
at night after Jasmine returns. The renderer now checks both conditions.
Other tileset changes reused the existing terrain and palette comparisons.
Two findings still need dedicated checks. Navel Rock Inside connects to
itself at the north and south edges, and hidden grottoes currently mark
both the encounter and item visible at the same coordinates.

Four movement-engine refactors shared ROM routines or reordered internal step
IDs. The Atlas reads the same named movement commands before and after those
changes. For the environment-ID reorder, all 612 exported map categories and all 224 palette-slot
indices across the seven environments matched the pinned source.

- In Azalea Gym, the movement analyzer reads all 30 cart paths. All 299
  command bytes matched RGBDS output. Tests exercised 24 rides on the
  switch-controlled cart across all three terminals, both directions and
  four switch configurations. The rider and cart stayed together at half-cell
  positions and reached the correct exits. The analyzer samples the ends
  of movement commands. Chrome showed all four parked carts on map entry.
- All 2,048 combinations of the eleven Goldenrod Underground door flags
  selected the correct blocks at all 17 door positions. All 22 warps on the
  four Underground maps resolved to their declared destination cells.
- Browser textures matched the source art and colors for the two Celadon
  swim rings, both Mt. Moon fossils, Larry, the PCC office staff and both
  frames of Meowth. Additional checks covered the Wise Trio and the Burned
  Tower Firebreather with their story-controlled object flags.
- All three Cinnabar Volcano floors use both lava animation tracks. Each matched
  the source for 96 ticks at four clock settings. B1F has 105 lava-glow cells
  and two glowing ladders. B2F has 64 lava-glow cells. The 25 floor warps and
  the entrance from Cinnabar Island resolve to their source destinations.
- Five maps select bridge blocks in assembly during their entry callbacks.
  The default scene now applies all 43 writes, including the end of Nugget
  Bridge at (20,14). The alternate scene changes all 43 blocks. Route 47
  also opens the Ruins of Alph door at (8,22) when its event flag is set.
  In the clean dev build this corrected two cells on Route 24 at (20,14)
  and (21,14) from water to wall. Both blocks use the same visible artwork.
- Assembled the 6,640-byte upstream background palette section with RGBDS.
  All 93 declarations matched in order. Compared 2,168 ordinary selections
  and 616 selections from the four special routines, including regular and
  overcast colors, regional Pokémon Center floors and grotto entrance colors.
- Checked the revised Route 16/17 gates and map seams, Sinjoh Ruins entrances
  and roof, Snowtop Mountain exits and lookout, the Battle Factory entrance
  in both power states, and the new Johto roof graphics. Banked animation
  checks included the hideout spinners in both states, restless forest trees,
  fireplace, LCD and tiny water.
- The Dojo uses the map-entry script to assign each rematch trainer’s position,
  facing, palette and graphic. All seven weekdays and four time slots were
  checked with three sets of story flags. On Monday, Chrome displayed Falkner
  and Janine by day after Blue was defeated. Both slots were empty at night.
- Valerie’s house now uses a single fairy book with seven weekday palettes.
  Chrome rendered the brown Monday book at (3,3). The movement analyzer and
  the map renderer both use the scheduled object placements.
- The movement analyzer follows the success and failure branches of item
  gifts. Checked 158 inline handlers across the upstream map scripts, including
  the two pickups that disappear only when there is room in the Bag.
- Eleven Kanto Pokémon Centers share an upstairs layout that differs from
  Johto in 18 of 32 blocks. Shamouti uses Johto's geometry with an orange
  floor. All 128 collision cells agree. Chrome verified the three floor
  palettes and the return routes through the Trade Center and Colosseum.
- The original palette-swap command is resolved. Rendering checks cover all
  25 rectangles in 17 maps. The later fade-aware swap and NPC glow transition
  changes retain separate open records.
- Browser textures matched source graphics and map palettes for the Ecruteak
  gates and pagoda tips, Lavender radio dishes and Yellow Forest lilypads.
  Shallow sand occupies 761 collision cells across 21 maps. Its footprints
  appear in the game after a player step.

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

### Follow-up scan and seam checks

Screened the 359 outstanding commits in 12 batches of up to 32 against
`f8e67fbd5`. The v3.2.3 Flare Blitz hotfix is the only new release note.
Substantive overworld changes, including palette swaps and NPC glow, appear
in the commit patches. The ledger now has **735 resolved, 296 pending and
26 reviewed with open work**. Of the 37 resolved in this pass, 11 were
outside Atlas scope, 24 use regenerated data, one needed a layout correction,
and one was already supported. Coverage remains preliminary.

- For 19 map-data commits, checked all changed path types and map script
  operations. Matched current object and warp declarations against generated
  records and traced terrain inputs to their exported maps. The ledger names
  the maps, counts and scope of each check.
- Checked both ends of Nugget Bridge and four roof palette changes against
  the pinned source and exported terrain. Rechecked all 25 swap rectangles
  on 17 maps across four clock times. Using the client’s facing selector
  exposed a wrong fallback for museum-drill and arch-tree sprites. Verified
  the corrected Vermilion pearl objects against 2,048 RGBA samples.
- The Route 36 alias shortens the north connection by one block. Verified
  the overlapping gatehouse pixels, and the Cherrygrove City artwork across
  its four-by-eleven-block track overlap. Both out-of-map Cut trees match the
  flags and world coordinates of their in-map counterparts. On Route 23,
  verified the seam, nine officers and all four Victory Road/League Gate
  warp round trips.
- Azalea Town, Route 33, Lake of Rage and Route 43 can replace their block
  arrays in wet weather. Collision exports now use the same weekday and block
  source as the terrain renderer. The regression compares the full dry and wet
  cell grids against the source block and collision tables for all four maps.

### Aquarium schedules, glow and volcano callbacks

The next pass resolved 38 commits. The ledger now has **773 resolved,
269 pending and 15 reviewed with open work**. Twenty-three map-data commits
were checked in a batch against the changed assembly directives, current
asset consumers and generated map metadata. For shared Johto and volcano
graphics, the alternate PNGs are byte-identical to the files named by the
upstream tileset pointers.

- Matched all 377 glow cells across 612 maps to upstream collision quadrants.
  All ten cave mouths and five glowing ladders have warps to valid destination
  cells. The eight glowing Dragon Shrine walls block movement across the
  corresponding edge in both directions.
- Compared 104,192 sprite pixels across four clock times. The checks used a
  real NPC frame on all 20 map/glow combinations, both icon frames of all 14
  aquarium exhibits and volcano Moltres, and all eight dual-palette facings
  of Ho-Oh, Lugia and Alolan Exeggutor. Some checks place a sprite on a glow
  cell to exercise a lighting condition it can encounter during movement.
  Corrected two Exeggutor poses that were reading tile 12 where the engine
  reads tile 15.
- Both aquarium floors now apply their shared weekday callback. On weekdays
  the rotating exhibits show Goldeen, Tentacool, Squirtle and Shellder.
  On weekends they show Hisuian Qwilfish, Horsea, Seel and Krabby. Checked all
  seven days, the six permanent exhibits and visibility on a separate map.
- The terrain and collision generators now honor consecutive flag-guarded
  block writes and unconditional block writes. Checked all 16 combinations
  of four boulder flags in Cinnabar Volcano B1F, and the stairs and table in
  Snowtop Pokémon Center. Callbacks with other control flow require separate
  review.

## Batched terrain, animation and callback review

The ledger now resolves 826 of 1,057 upstream commits. The remaining 231
include pending reviews and changes with open compatibility work. This pass
resolved 53 commits using shared verification across maps with the same input
formats. Hardware transfers, player-only movement and trainer portrait changes
were screened separately from the atlas assets that their commits also touched.

- Independently reconstructed the Monday day/common first frame using the pinned
  graphics, block indices and palette data plus the animation simulator's initial
  cycle state. All 612 exported images matched across 69,174,272 pixels. The
  check also matched all 270,212 collision cells and all 1,211 foreground tile
  placements, including color-index-zero coverage. This comparison checks atlas
  export and composition. It shares the source loader and animation simulator
  with the exporter.
- Checked one position per distinct animated track on selected maps over complete
  VBlank cycles. Examples include the kiln fire, Karen's stars, Lance's torch,
  the Underground lights, sea rocks and all four Sprout Tower pillar segments.
  The selected maps exercised 33 destination operations.
- Tile callbacks now follow forward flag branches, shared destinations and
  multiple returns. Regression checks cover all 16 combinations of the Rocket
  base transmitter door and three Electrode flags. All 32 combinations of the
  Magnet Tunnel lodestone and pit flags were also checked. The map renderer and
  collision exporter consume the same selected blocks.
- Goldenrod's switch room now starts with the eight doors opened by either
  approach. Each of the eleven event flags drives the source door definition,
  including doors spanning two blocks. The Underground vendors follow the
  weekday schedule and the bargain merchant appears only on Monday morning.
  The weekday test checks all four clock settings for all seven days.
- The preceding combined build was exercised in headless Chrome. Following
  stable → dev → stable preserved the intended URL and revision, and dev
  rendered the selected night view without failed project requests or uncaught
  exceptions.

## Map connections, objects and palette review

The ledger now resolves 872 of 1,057 commits. All 173 pending entries have
a recorded lead from the batch screen. A further 12 have reviewed changes
with open work. The changelog adds only the v3.2.3 battle hotfix for this
range. The ledger records why each skipped change is outside atlas scope.

- Lucky Island now starts hidden, as in a new game with the trendy phrase
  `Prism`. Clearing `EVENT_LUCKY_ISLAND_CIVILIANS` in the dev event
  overrides selects the `Lucky` snapshot. Terrain, walkability, civilians
  and the Lucky Egg follow the same tile callback. The two layouts differ in
  136 of 494 blocks. Cianwood Gym uses the same callback evaluation to select
  the waterfall, Chuck's pose and the corresponding boulders.
- The production client layout aligned all 214 directed connections across
  29 neighborhoods in each of the four clock views. Verified eight pairs of
  objects on adjoining maps, including the Goldenrod Harbor Star Piece and
  Fisher and the City/Harbor Rocket. Checked Route 13's southern split at cell
  18. The upstream border proxy agrees with the actual Route 14 and Lucky
  Island maps in 102 of its 105 blocks. Atlas draws the actual neighbor for
  the three far-eastern blocks where upstream art and collision differ.
- Independently expanded all 2,917 source object declarations and compared
  their principal fields to the 612-map export. Checked all 2,083 warp
  declarations and the coordinates of static destinations. Lavender Radio
  Tower 1F uses an existing scripted destination encoded as warp 255. The
  atlas exports that declaration and lacks its conditional upstairs routing.
- Each clock view matched all 69,174,272 first-frame terrain pixels, 270,212
  collision cells and 1,211 foreground tile placements. The comparison shares
  the exporter's source loader and initial animation state. Separately
  decoded the raw RGB rows for Route 39, Indigo Plateau, Yellow Forest,
  Rugged Road South and the two Celadon rooftops. Checked regular and
  overcast selection where the game defines both. The build passed all 77
  Python tests, including the map-state regressions.
- Checked two large graphics commits in one pass by independently converting
  the pinned PNGs to Game Boy tile bytes. All 218 exported static sprite
  sheets and 393 Pokémon species/form records matched. Those forms use 362
  distinct icon files. The atlas does not consume party-menu miniatures.
- Assembled the clean dev build `e92333b` with the stable build and verified
  the retained 97,758,278-byte Pages bundle. Headless Chrome rendered both
  versions, loaded dev night assets and returned to stable using the channel
  links. All 54 frontend tests and the TypeScript check passed.

## NPCs in grass and campfire light

At that checkpoint the ledger resolved 915 of 1,057 commits. The remaining
142 included 133 pending reviews and nine reviewed changes with open work.

- Dev exports one bit per background pixel indicating whether its Game Boy
  color index is nonzero. Animated tiles carry that information for each
  frame. The client applies it to the facing tiles with fixed priority or
  grass-dependent priority. It paints the selected terrain color over those
  sprite pixels, which also preserves the result when two NPCs overlap.
  This matches the documented order of Game Boy Color drawing operations.
  [Pan Docs, object drawing priority](https://gbdev.io/pandocs/OAM.html#drawing-priority)
- Checked all 69,174,272 first-frame coverage bits in each of the four clock
  exports against the source tile planes and flips. The complete 612-map
  comparison also checked RGB, collision and foreground tile placement.
  A smaller animated fixture checked coverage through every frame of its cycle.
- Observed the Rugged Road North Firebreather walking across the campfire's
  daytime-light collision in headless Chrome. In the night view its red
  palette fades from the night colors to the day colors and back. In the day
  view both sides use the day colors. Independently checked the observed
  shades, including intermediate fade steps, against the pinned RGB5 rows
  and game fade arithmetic.
- Observed 37 covered pixels on the Route 1 Schoolboy in tall grass and 67 on
  the Safari Zone North Youngster in long grass. Reconstructed each displayed
  sprite frame from its facing and terrain, including all background RGB
  substitutions. These browser checks used the actual movement and rendering
  code with observation hooks in a local unminified bundle.
- Compared the source regular and overcast roof palettes for all 42 groups
  across four clock settings. Verified 6,298 zero-valued block placements
  in 126 maps and the two passable clock-tower blocks at Celadon University.
- Verified the clean dev build at `3a7c102` after assembly with stable. The
  combined artifact is 127,821,109 bytes. Chrome switched from stable to dev,
  loaded the dev night view and returned to stable. The retained-site check
  passed for both channels.
- Checked all 25 palette-swap rectangles across 17 maps, covering 19,312
  base tiles and 7,568 animated positions. Observed both Vermilion City
  pearl objects that copy the outside green palette in all four browser time
  views. All 1,536 displayed pixels matched the source PNG, facing and RGB
  table. These two objects are stationary in the pinned game data.

## Immediate remaining implementation work

- Check remaining event-dependent tile callbacks, object visibility and weather
  against the shared snapshot. Forced map time is shared across terrain and
  objects. Run the final combined-site checks before deployment.
- Verify dynamic palette and weather transitions during map changes, together
  with the remaining map, object and movement findings from the audit.
- Reconcile dynamic palette rules for variable sprites, map/overlay changes
  and weather transitions. The real campfire patrol and grass checks cover
  movement within a map. Map-entry fades and copy-background palette changes
  across connected maps still need runtime verification.
- Finish the wider Ruins of Alph redesign review.
- Dev builds now require upstream corpus tests after source checkout, checking
  the exact pinned SHA. Extend that corpus coverage alongside further adaptations.
- Finish the commit ledger, then run full combined-site/browser tests and publish.

The clean dev build at `facbdbf` passed all 87 Python tests and generated 612
maps. It assembled with stable `f4e515e` into a 128,053,312-byte local Pages
site. Chrome loaded each channel, switched dev to night, and followed the
link back to stable. Retained-site validation passed for both channels.

The next clean dev build at `743c7c3` passed 92 Python tests and generated
612 maps. It assembled with stable `f4e515e` into a 128,797,516-byte site.
Chrome loaded both versions, requested dev night assets and returned to
stable. The combined artifact also passed retained-site validation.
