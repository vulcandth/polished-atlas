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
- Exhaustive review, dev compatibility, visual validation, and publication remain
  incomplete. No upstream commits have been claimed reviewed merely by inventory.
