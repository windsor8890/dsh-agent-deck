# Runtime soak / manual QA checklist

Latest run: [`run-2026-11-06.md`](run-2026-11-06.md) · Visual baselines:
[`visual-baselines.md`](visual-baselines.md)

`npm test` (`scripts/check.mjs`) is hermetic: it validates the bundle, embedded
sprites, module contract, preference/action helpers and docs references. It cannot
exercise the live canvas, DSH host, real sessions or wall-clock behaviour. Run this
checklist before calling a visual/behaviour release done.

Record the DSH version, OS, browser, DPR, theme and reduced-motion setting for each run.

## 1. Resident empty state

- [ ] Close/stop every session (or use a fresh DSH profile) and open Watchtower.
- [ ] Left wall shows the `#00 WHALE-GIRL / IDLE` resident card and `RESIDENT · STANDBY`.
- [ ] Office shows one idle whale-girl at desk #00 with `#00 IDLE`; no VACANT-only room.
- [ ] The resident is not clickable/focusable and does not appear in telemetry counts.
- [ ] Start one session: resident card/desk disappears, real unit appears.
- [ ] End that session: after the 3-minute idle hold expires, the resident returns.

## 2. Seat model / overflow

- [ ] With 8 live units, every seat is occupied exactly once; names/hotkeys 1–8 match.
- [ ] With 9+ units, extra units appear in the `STANDBY +N` tray and wall `LIVE FEED +N`.
- [ ] Close a seated session; after the idle hold, one standby unit takes the free seat.
- [ ] Re-open the panel after a resize: desk positions, hit areas and nameplates stay aligned.

## 3. PREFS

- [ ] `PREFS` opens from the stage toolbar; `Esc` and `×` close it.
- [ ] Toggle `VISITS` off: no new visits; existing visits finish normally.
- [ ] Cycle `CHILL / NORMAL / LIVELY`; visit gap changes accordingly.
- [ ] Toggle `MAX VISITORS` 1/2; never more than the selected number overlap.
- [ ] Toggle `DESK ACTIONS` off: a WAIT unit shows IDLE, not phone/game.
- [ ] Reload the page; every preference survives via localStorage.

## 4. State-driven desk actions

- [ ] RUN/long tool: WORKING; no random slack/game.
- [ ] WAIT due pending interaction: SLACKING phone.
- [ ] WAIT due >6s inactivity: SLACKING/GAMING alternates over time.
- [ ] Held/locked session (3-minute retention): IDLE/sleep, not game.
- [ ] `prefers-reduced-motion: reduce` (reload required): visits/actions muted.

## 5. Focus / ANALYZE / CINEMA

- [ ] Card `↗` opens the session; card body focuses.
- [ ] `× RELEASE` and `Esc` return to OFFICE; no stuck dimmed canvas.
- [ ] `C` / CINEMA hides wall+rail; `Esc` exits.
- [ ] Resize while focused (sidebar collapse, window resize): release returns to a correctly measured canvas.
- [ ] Hotkeys 1–8 focus the correct physical seats.

## 6. Themes / views / display

- [ ] Light, dark, system theme; switch while panel is open.
- [ ] Light theme: sprites keep original palette, no white fringe, HUD readable.
- [ ] OFFICE, RADAR, NET switch with `M`; no stale office visits/actions in other views.
- [ ] Narrow window <1180px hides rail; <820px hides wall; no canvas 1×1 lock.
- [ ] DPR 100%, 150%, 200%: pixels stay crisp; no blurry or oversized sprites.

## 7. Soak / performance

- [ ] 9+ sessions for at least 10 minutes; no runaway visits, duplicate seats, ghost sprites or memory growth.
- [ ] Delete a session mid-visit; visit ends cleanly without a ghost/overlap.
- [ ] Keep the panel open for 30+ minutes; CPU/GPU stable, console clean (ignore unrelated 404s).
- [ ] Record: average FPS, CPU% of the DSH renderer, resident/visits/actions observed, client.js load size.
- [ ] Compare against the static budget: client.js ≤ ~700 KiB; current WebP build ≈ 444 KiB (≈212 KiB gzip).

Known-unverified items should be kept in README "已知限制" rather than silently dropped.
