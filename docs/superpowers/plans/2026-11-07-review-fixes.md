# Agent Deck review fixes

> **For agentic workers:** Use the existing review reproductions and a failing-test-first cycle; each worker owns only its assigned function regions and test file.

**Goal:** Fix the seven reviewed defects and two display errors without changing installation or the read-only session boundary.

**Architecture:** Keep the single-file browser bundle. Exercise its original functions through a test-only Node VM loader; separate fixes by function region so workers can apply small patches concurrently.

**Tech Stack:** Plain JavaScript, Node's built-in test runner, existing DSH module loader and Canvas UI.

**Spec:** The code review and user's repair request in this chat.

## Constraints

- No new runtime dependencies, session writes or installation changes. Commit and push only after explicit authorization (provided after implementation).
- Preserve existing visual style and six ANALYZE widgets while restoring readable details.
- Do not overwrite concurrent edits; edit assigned regions with narrow patches.

## Tasks

- [x] Telemetry (`client.js` utils/fold; `scripts/telemetry.test.mjs`): first fail tests for failed-attempt settlement, long/same-name tool results and 19-call batches; fix attempt retirement and call identity independently of display caps. Verify successful settlement does not double-count usage or discard valid tools; verify results for calls no longer displayed.
- [x] Monitor (`client.js` createMonitor; `scripts/monitor.test.mjs`): first fail tests for idle expiry without a viewer and concurrent THINK/ACT normalization; expire idle records in flush and normalize across agent time. Cover empty input, staggered phases and multiple expirations.
- [x] UI (`client.js` styles/builders/stage; `scripts/ui.test.mjs`): reproduce Canvas stack growth and absent ANALYZE text, then restore balanced saves and escaped, scrollable THINK/ACT/OUT details. Fix alert text and newest-call selection. Cover empty details, unsafe text and repeated office frames.
- [x] Integration (root: test loader, package scripts, changelog): run all regression files plus existing checks, review the complete diff, perform a browser smoke test if available and report its actual scope.

## Review focus

- Successful stream settlement must preserve committed counts and throughput while failed attempts are removed.
- More than 18 running tools must retain identity and accept results even when not displayed.
- Idle cleanup must work without UI reads and release each retain exactly once.
- Phase percentages must remain valid for zero, one and multiple agents.
- ANALYZE details must escape telemetry text and remain accessible within the existing layout.

## Validation

- Existing checks: 13 passing; behavioral regressions: 27 passing.
- Canvas regressions exercise 100 empty and 100 active frames with state-stack assertions.
- Independent review checked the combined diff and installed Host settlement contract; no blocking findings remained.
- Final CSS review corrected detail-panel specificity and content-sized rows to avoid clipping long text.
- Browser smoke test was attempted but unavailable: the browser could not reach the loopback fixture, and the sandbox denied a loopback socket check. Live DSH GUI layout/scrolling and a long runtime soak remain unverified.
- Implementation validation required no installation or session writes. Commit and push were subsequently authorized by the user.
