# Recording page redesign — design spec

**Status:** Design — pending implementation plan
**Date:** 2026-05-04

## Problem

The dataset recording page has two compounding usability problems:

1. **Click latency.** After pressing *End Episode* or *Continue*, nothing visibly changes for ~1 s while the frontend waits for the next polling tick to reflect the new phase. The current code masks this with `transitioningToReset` / `transitioningToNext` flags, but the only visible effect is a button-label swap — the timer keeps running and the status pill doesn't change.
2. **Visual noise during teleoperation.** The user is operating the leader arm and looking at the physical robot, not the screen. The current page is dense (three info cards, three buttons, an instructions panel, a URDF viewer) and assumes a focused desktop user. The user reports they only ever look at the recording-time progress bar and the recording status, and that the time bar continuing to tick after they clicked the advance button is the main thing that makes the page feel sluggish.

## Goals

- One glanceable surface: the recording-time progress, the current phase, and a single primary action are the only things that compete for attention.
- Clicking the primary action acknowledges itself **before** the backend has confirmed the phase change.
- Keyboard-first interaction so the operator doesn't have to aim a mouse while holding the leader arm.
- Audible cues for phase changes and imminent auto-advance, so the operator can keep their eyes on the robot.
- Episode duration and reset duration are configurable per session, with sensible defaults.

## Non-goals

- Camera previews on the recording page. (Possible later, out of scope here.)
- WebSocket-pushed phase status. The current 1 s polling architecture stays; the redesign masks its latency with optimistic UI rather than replacing it.
- Re-architecting the backend recording state machine.
- Touching the upload page, replay, or any non-recording feature.

## Approach (chosen direction)

Single-card glanceable layout (mockup B from brainstorm), plus audio cues from mockup C, no ambient page tint. Keyboard shortcuts are the canonical input; on-screen buttons are the visual representation of the same actions.

## Page layout

The page is a single centered card on a black background. The "← Back to Home" link stays in the top-left. Everything else collapses into one card.

**Card top row (small, secondary):**
- Left: nothing (back button is in the page header).
- Right: `Episode 3 / 10 · 04:12 🔊 ⋯` — episode counter, total session time, mute toggle, overflow menu.

**Card center stack (large, glanceable):**
1. **Status pill** — e.g. `● RECORDING EPISODE 3` (red dot + red text on a faint red background), or `● RESET — GET READY` (orange) during reset, or `→ SWITCHING…` (blue, pulsing) during the optimistic transition.
2. **Huge mono timer** — `00:23` in 48-px+ monospace, color-coded to phase (green during recording, orange during reset, dimmed during transition). Below it, smaller, `/ 01:00` showing the limit.
3. **Thin progress bar** spanning the card width — tracks the timer (`phase_elapsed_seconds / phase_time_limit_s`), colored to match the phase (green during recording, orange during reset).
4. **Full-width primary button** — green during recording (`⏭ END EPISODE · SPACE`), orange during reset (`▶ START NEXT EPISODE · SPACE`), greyed during transition.

**Removed from the page:**
- The three-card grid (Phase Timer / Episode Progress / Session Time).
- The Recording Status section as a separate panel — folded into the single card's status pill.
- The "Episode Recording Instructions" / "Environment Reset Instructions" text panels.
- The URDF Robot Visualizer card and `UrdfProcessorInitializer`.
- All arrow-key references in copy.

## Interaction model

The recording session has three actions. Each is keyboard-first; on-screen buttons are the visual representation.

| Action | Key | Visible as | Available in |
|---|---|---|---|
| Advance phase | `Space` | Primary full-width button (label changes by phase) | Both phases (when `available_controls.exit_early`) |
| Re-record current episode | `R` | Item in the `⋯` menu | Recording phase only (when `available_controls.rerecord_episode`) |
| Stop session | `Esc` | Item in the `⋯` menu | Both phases (when `available_controls.stop_recording`) |

`current_episode` from the backend is the episode currently in progress — `Episode 3 / 10` means the 3rd is being recorded right now (confirmed with the user, matches the existing semantics).

The `⋯` menu is a small dropdown anchored to the corner stat row. It opens on click and closes on outside click or after a selection. The mute toggle (`🔊` / `🔇`) is a sibling icon to the right of `⋯`, not inside it.

`Esc` and the *Stop recording* menu item open a confirmation modal: "Stop recording? Saved episodes are kept." Two buttons: *Stop* (red, destructive style) and *Keep recording*. `Esc` again or click outside cancels. This prevents a stray keypress from killing the session.

`R` and the *Re-record episode* menu item do not need confirmation — re-record is reversible inside the session and the existing backend semantics already handle it.

## Optimistic phase state (latency fix)

A single piece of frontend state — let's call it `optimisticPhase` — replaces the existing `transitioningToReset` / `transitioningToNext` boolean pair.

When the user invokes the advance action (Space or button click):

1. **Synchronously, before any network call:**
   - Set `optimisticPhase` to the next phase (`recording → resetting`, or `resetting → recording`).
   - Reset the displayed timer to `00:00` and set its limit to the next phase's `phase_time_limit_s` (already known from the recording config).
   - Swap the status pill to the next phase's appearance, with an interim "→ SWITCHING…" treatment for ~250 ms (a faint pulse) to make the action feel acknowledged.
   - Disable the primary button.
2. Fire `POST /recording-exit-early` in the background.
3. On the next polling tick (≤ 1 s later), the backend's `current_phase` matches `optimisticPhase`. Clear `optimisticPhase` — the real status now drives the UI.
4. If the backend call fails (network error or 4xx), clear `optimisticPhase`, revert to the real phase, show a toast, and re-enable the button.

The polling interval stays at 1 s. The displayed timer is driven from `phase_elapsed_seconds` from the backend status when `optimisticPhase` is null, and locally otherwise (so it keeps ticking visually during the brief optimistic window without waiting for the next tick).

## Audio cues

Implemented with `Audio` elements wrapping short embedded data-URI WAV blobs (or `OscillatorNode` from `AudioContext` — implementer's choice). No asset files.

- **Phase change to recording:** short rising two-tone "ding-ding" (~150 ms total).
- **Phase change to reset:** short falling two-tone "ding-dong" — distinguishable from the recording cue without looking.
- **Auto-advance warning:** three short beeps in the last 3 seconds of a phase, one per second.
- **Mute toggle:** speaker icon in the top-right corner of the card, between the session-time stat and the `⋯` menu. Persisted in `localStorage` under a stable key (e.g. `lelab.recording.muted`). Default unmuted.
- The mute toggle suppresses both phase-change cues and the auto-advance warning.
- Phase-change cues fire on transitions of the **real** phase (from polling), not on `optimisticPhase`. Otherwise we'd play the sound a beat early and the operator could mistake it for confirmation that didn't happen yet.
- The auto-advance warning is suppressed while `optimisticPhase` is non-null. The user has already advanced manually; warning beeps about the previous phase's expiring timer would be misleading.

## Setup modal additions

In `frontend/src/components/landing/RecordingModal.tsx`, add two number inputs after the existing "Number of Episodes" field, in a horizontal pair:

- **Episode duration (seconds)** — `min=1`, default `60`.
- **Reset duration (seconds)** — `min=1`, default `15`.

These bind to new state in `Landing.tsx` and are passed into `recordingConfig` instead of the current hardcoded values at [Landing.tsx:165-166](frontend/src/pages/Landing.tsx#L165-L166). The backend already accepts these fields ([app/recording.py:46-47](app/recording.py#L46-L47)) — no API change.

Defaults match the current hardcoded values (60 / 15) so existing flows behave identically. The backend's own defaults (30 / 10) are not used by this UI.

## State summary

- Backend state machine: unchanged.
- Backend API: unchanged.
- Polling: unchanged (1 s interval).
- New frontend state on the recording page: `optimisticPhase: "recording" | "resetting" | null`, `audioMuted: boolean` (from localStorage), `showStopConfirm: boolean`.
- Removed frontend state: `transitioningToReset`, `transitioningToNext`.

## Files affected (sketch — exact split deferred to plan)

- `frontend/src/pages/Recording.tsx` — full rewrite of the render tree and event handlers.
- `frontend/src/pages/Landing.tsx` — pass episode/reset durations into `recordingConfig`.
- `frontend/src/components/landing/RecordingModal.tsx` — two new inputs.
- New: a small audio-cue helper module (path TBD in plan) — owns the WAV/oscillator playback and the mute-state localStorage read/write.

## Open questions resolved during brainstorm

- `current_episode` is the in-progress episode, not a saved count.
- Stop has a confirmation modal, not instant stop.
- Audio default is unmuted (the robot is noisy already; a chime is fine).
- Auto-advance stays. The timer is a hard cap.
- URDF viewer is removed (the user does not look at it during teleoperation).
- Camera previews are out of scope for this redesign.
