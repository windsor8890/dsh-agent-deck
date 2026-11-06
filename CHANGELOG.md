# Changelog

## 0.6.0 — 2026-11-06

### Added

- Battle bar above the stage: `ACTIVE / WAITING / ERRORS / SYNC / TPS / DESKS` with live counts.
- Clickable `FILTER` legend for RUN / WAIT / SYNC / ERR; matching units stay lit, others dim.
- Hover lineage highlight: hovering a card, strip chip or desk highlights the same session and topology parent/child.
- Horizontal agent strip for 9+ live units; the card wall stays readable and overflow is not hidden.
- `CINEMA` briefing layout with larger battle bar/legend and optional `CINEMA SKIN: COZY / COLD` in `PREFS`.
- Prioritized `LIVE FEED` ticker: errors, waiting units and completed units before ordinary log lines.
- Character micro-actions: error smoke puffs and a short sparkle burst when a unit leaves RUN.
- Fixed a first-entry flash: sprites now start decoding when the plugin applies, and the
  old procedural character is never drawn as a placeholder. Until the WebP data URLs
  settle, the unit is skipped; a failed pose reuses the front sprite only after probing.

## 0.5.0 — 2026-11-06

### Added

- DIY whale-girl state sprites: default, idle, working, walking, slacking, gaming, error.
- Seven-state gallery and bilingual README (Chinese / English) with light and dark screenshots.
- Concurrent social visits with delegation preference, distance-based timing, curved paths and depth layering.
- State-driven desk actions: waiting for a human shows the phone, idle WAIT alternates phone/game, retained sessions sleep.
- Empty-office resident: idle whale-girl at desk `#00` plus a standby terminal card.
- `PREFS` panel: visits on/off, visit pace, max visitors, desk actions; stored in `localStorage`.
- Explicit `↗` open-session action; focus mode has a visible `× RELEASE` button.
- WebP q95 sprites (roughly half the bundle size of the previous PNG base64 assets).
- `npm test` hermetic checks and GitHub Actions workflow.
- Manual runtime/soak checklist under `docs/quality/`.
- Bilingual README with explicit Chinese/English switching, MIT license, asset notice and social-preview metadata.

### Fixed

- Focus release no longer depends on clicking a hidden card.
- Visit return leg facing direction; deleted/re-seated visitors are pruned immediately.
- Light theme no longer inverts the resident whale-girl image.
- Reduced-motion handling covers desk actions and sprite animation.
- Visit and action scheduling no longer overlap.
