# Changelog

## Unreleased

### Changed

- Removed the floating CHIEF DESK marker but kept the SUPERVISOR nameplate.
- Replaced the decorative night-shift window with a live SECTOR 07 status screen and aligned it with the THROUGHPUT / TOOL LOAD displays.
- Removed the shared OPS FEED backboard; the three wall displays are individually mounted, and the clock is larger and clear of them.

## 0.6.2 — 2026-11-07

### Fixed

- Discard failed assistant attempts without mixing their streamed text or tool calls into a retry.
- Match tool results by call ID, including long MCP names and concurrent calls with the same name.
- Keep tool identities and in-flight results independent of the 18-row display limit.
- Release idle retained sessions after three minutes even when no monitor page is open.
- Normalize the phase mix across all tracked agents, including idle time.
- Balance Canvas state saves in the office renderer for sustained viewing.
- Restore escaped, readable THINK / ACT / OUT details in ANALYZE alongside the six charts.
- Show alert text in the feed and select the newest call for the room summary.

### Tests

- Add dependency-free behavioral regressions for telemetry, monitor lifecycle, and UI rendering to `npm test`.

## 0.6.1 — 2026-11-07

### Changed

- Removed dead SVG chart helpers and CSS after the all-Canvas migration.
- Renamed the sidebar/panel entry: Chinese `作战室`, English `Agent Deck` (previously `监控室 / Control Room`).

## 0.6.0 — 2026-11-07

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
- Four-frame whale-girl action loop GIF (idle / working / slacking / gaming) in the README.
- Two transparent working keyframes embedded as WebP: the `busy` pose now shows a subtle
  typing loop in Canvas while the rest of the states keep the static generated sprites.
- Transparent two-frame loops for `slacking` (phone) and `gaming` (controller); reduced
  motion freezes them on the first frame.
- Light-theme office contrast raised with darker pre-filter furniture/wall tones, keeping
  the paper-white theme without losing desk outlines.
- Layout refresh: `AGENT UNITS` sits across the bottom (20% height) as a horizontal
  filmstrip, `TELEMETRY` sits at the top-right, and the office stage fills the remaining
  top-left space with a wider desk layout.
- Office backdrop now stretches the back wall and floor grid across the full stage width;
  the fake isometric side wall is removed, so no paper-white strips remain at the sides.
- The two wall monitors are anchored to the visible top-right wall (below the HUD/legend)
  instead of floating over the stage controls.
- Added a decorative `CHIEF DESK / SUPERVISOR` teacher-style podium on the right side,
  between the two desk rows. When topology has a root/parent agent it takes the podium;
  otherwise a fixed gold-tinted resident supervisor fills it. It is not one of the 8 agent
  seats and does not consume a session slot.
- Shifted the 8 agent desks slightly left and moved the podium further right, leaving a
  clear walkway and visual gap between the last desk column and the supervisor.
- Removed the two procedural foreground potted plants.
- Performance pass: the office canvas renders at 20fps while agents work and 12fps when
  idle, caps its backing DPR at 1.25, and pauses entirely when the panel is not visible.
- Raised office motion to 30fps while agents are active and 20fps when idle; the DOM
  throttling and hidden-panel pause remain.
- Throughput curves are now canvas-rendered at 30fps, interpolating between the monitor's
  10Hz samples; the old SVG charts visibly stepped at the repaint cadence.
- Agent-unit card sparklines use the same 30fps Canvas/interpolation path, so the small
  per-unit curves no longer jump on the slow card repaint.
- Every remaining rendered chart is now Canvas: tool-mix/file/context/latency bars,
  per-unit mini charts, phase stacked bar/timeline, tool-matrix heatmap, context/task
  rings and the focused THRUPUT trace. No SVG charts remain in the live UI.
- Fixed ANALYZE hiding its new chart canvases: the old focus rule now hides only the
  office canvas, not every canvas in the stage.
- Wall clock is screen-anchored to the visible top-right wall; the throughput/tool-load
  monitors now sit below it instead of covering it.
- Removed the unexplained decorative hexagonal wall emblem.
- Telemetry DOM repaints are throttled (300ms light / 900ms heavy), collapsed rail groups
  are not inserted into the DOM, and hidden panels stop all plugin work.
- Compact stage HUD: only throughput trend, tool mix and recent calls; no repeated
  ACTIVE/TOOLS/ERRORS counters.
- KPI de-duplication: the global top bar keeps only LIVE/AGENTS/CLOCK; the stage battle bar
  owns the state counters.
- Telemetry rail now has a persistent clickable ATTENTION queue plus collapsible
  RUNTIME and SYSTEM groups; low-priority file/model/config/log sections are folded away.
- Bottom filmstrip cards are compact (state, TPS, current tool, short think line); full
  THINK/ACT/OUT detail moves to focus/ANALYZE.
- When fewer than three agents are live, a ROOM SUMMARY card fills the remaining filmstrip
  width instead of stretching one giant agent card.
- The state filter now also dims non-matching filmstrip cards and unit rows in telemetry.

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
