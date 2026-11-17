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
- Review every commit's changes, including merges and reverts, and reconcile the
  complete endpoint diff. Record reason, disposition, fix, and validation evidence
  for every SHA in `docs/upstream-audit.json` on dev.
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
classify code automatically. Re-running preserves recorded reviews. The check
requires exact commit/file coverage and a resolved disposition, explanation,
and evidence for each commit. Review quality still requires reading the changes;
passing this structural check alone does not prove compatibility.

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
- Thirty-seven commits have been individually reviewed: twenty are resolved as no atlas
  impact and seventeen retain open adaptation/validation work. Another 1,014 commits
  have not been reviewed. Inventory generation does not constitute review.
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
- Exhaustive review, remaining dev compatibility, complete visual verification,
  pushing branches, CI execution, and publication remain incomplete.

## Immediate remaining implementation work

- Verify palette-swap NPC colors in the full generated site. The frontend now
  consumes swap metadata and rebuilds background-derived NPC frames when movement
  crosses a color boundary; focused tests cover selection and boundary changes.
- Implement modern banked `tileframe` animation tables/routines; the old animation
  decoder remains and must not be treated as master-compatible.
- Complete NPC glow effects, shared event state, fixed-weather rules/cherry blossoms, dual object
  palettes, all map/object/movement findings from the audit, and full dev generation.
- Finish glow validation on Dragon Shrine, cave mouths, underground lamps and lava
  ladders, including directional walls/warps and secondary palettes. Verify
  `SPRITE_AQUARIUM_MON` handling (also used for volcano Moltres), and reconcile
  forced map time palettes with the existing indoor/day heuristic.
- Dev builds now require upstream corpus tests after source checkout, checking
  the exact pinned SHA. Extend that corpus coverage alongside further adaptations.
- Finish the commit ledger, then run full combined-site/browser tests and publish.
