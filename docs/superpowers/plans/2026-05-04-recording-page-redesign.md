# Recording Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dataset recording page with a glanceable single-card UI, eliminate click latency via optimistic phase state, add keyboard shortcuts and audio cues, and surface episode/reset durations in the setup modal.

**Architecture:** Single-card React layout in [Recording.tsx](frontend/src/pages/Recording.tsx). Latency masked by an `optimisticPhase` state that flips synchronously on click (replaces today's `transitioningToReset` / `transitioningToNext` flags). Audio cues come from a new `frontend/src/lib/recordingAudio.ts` module using Web Audio `OscillatorNode` (no asset files; mute persisted in `localStorage`). Backend, polling, and recording state machine are unchanged.

**Tech Stack:** React 18, TypeScript, Vite, Tailwind, shadcn/ui (`dropdown-menu`, `alert-dialog`, `input`, `label`, `button`), `lucide-react` for icons, Web Audio API for chimes.

**Spec:** [docs/superpowers/specs/2026-05-04-recording-page-redesign-design.md](docs/superpowers/specs/2026-05-04-recording-page-redesign-design.md)

**Testing convention:** This repo has no automated test suite (per [CLAUDE.md](CLAUDE.md)). Each task ends with a manual verification step using `lelab --dev`. If you cannot drive real recording hardware, ask the user to verify the steps that require an active recording session (anything past the "Start Recording" button); confirm the parts you *can* check (rendering, modal inputs, console logs) yourself first and clearly flag what still needs human verification.

**Style:** This codebase favors minimalism (per global instructions): no comments unless WHY is non-obvious, no dead code, no defensive checks for things that can't happen.

---

## Files affected

- **Create:** `frontend/src/lib/recordingAudio.ts` — audio cue helper (oscillator playback + localStorage mute persistence).
- **Modify:** `frontend/src/components/landing/RecordingModal.tsx` — add two number inputs and props for episode/reset durations.
- **Modify:** `frontend/src/pages/Landing.tsx` — hold duration state, pass to modal, pass into `recordingConfig`.
- **Modify:** `frontend/src/pages/Recording.tsx` — full render-tree rewrite, optimistic phase state, keyboard shortcuts, stop-confirm dialog, audio integration, mute toggle.

---

### Task 1: Create the audio cue helper module

**Files:**
- Create: `frontend/src/lib/recordingAudio.ts`

A single module owns Web Audio playback for the three cue types and mute-state persistence. Using `OscillatorNode` avoids shipping audio assets and keeps the bundle tiny. The module is pure-functional (no React state); the page subscribes to mute changes via the `getMuted` / `setMuted` pair and re-renders on its own.

- [ ] **Step 1: Create the module**

```ts
// frontend/src/lib/recordingAudio.ts
const MUTE_KEY = "lelab.recording.muted";

let ctx: AudioContext | null = null;

const getCtx = (): AudioContext => {
  if (!ctx) ctx = new AudioContext();
  return ctx;
};

export const getMuted = (): boolean => {
  return localStorage.getItem(MUTE_KEY) === "1";
};

export const setMuted = (value: boolean): void => {
  localStorage.setItem(MUTE_KEY, value ? "1" : "0");
};

const playTone = (frequency: number, durationMs: number, startOffsetMs = 0) => {
  if (getMuted()) return;
  const c = getCtx();
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.frequency.value = frequency;
  osc.type = "sine";
  gain.gain.value = 0;
  osc.connect(gain);
  gain.connect(c.destination);
  const start = c.currentTime + startOffsetMs / 1000;
  const stop = start + durationMs / 1000;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(0.2, start + 0.01);
  gain.gain.setValueAtTime(0.2, stop - 0.02);
  gain.gain.linearRampToValueAtTime(0, stop);
  osc.start(start);
  osc.stop(stop);
};

export const playRecordingStartCue = (): void => {
  playTone(660, 80, 0);
  playTone(880, 80, 90);
};

export const playResetStartCue = (): void => {
  playTone(660, 80, 0);
  playTone(440, 80, 90);
};

export const playAutoAdvanceWarning = (): void => {
  playTone(880, 70, 0);
  playTone(880, 70, 1000);
  playTone(880, 70, 2000);
};
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors related to `recordingAudio.ts`.

- [ ] **Step 3: Manual smoke test**

Run: `lelab --dev` (Vite at :8080). In the browser dev console at any page, run:

```js
const m = await import("/src/lib/recordingAudio.ts");
m.playRecordingStartCue();   // hear two-tone rising "ding-ding"
m.playResetStartCue();       // hear two-tone falling "ding-dong"
m.playAutoAdvanceWarning();  // hear three short beeps over 3s
m.setMuted(true);
m.playRecordingStartCue();   // silent
m.setMuted(false);
```

Expected: cues sound as described; mute silences playback; `localStorage.lelab.recording.muted` is `"1"` then `"0"`.

If you cannot run the browser yourself, ask the user to run these console commands and confirm the audio.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/recordingAudio.ts
git commit -m "feat(recording): add audio cue helper module"
```

---

### Task 2: Add duration inputs to the recording setup modal

**Files:**
- Modify: `frontend/src/components/landing/RecordingModal.tsx`

Two number inputs are added after "Number of Episodes" in a 2-column row. Props mirror the existing `numEpisodes` / `setNumEpisodes` pattern. Defaults match today's hardcoded values (60 / 15) so existing flows behave identically.

- [ ] **Step 1: Extend the props interface**

Modify `frontend/src/components/landing/RecordingModal.tsx` — find the `RecordingModalProps` interface and add four fields:

```ts
interface RecordingModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  robot: RobotRecord | null;
  datasetName: string;
  setDatasetName: (value: string) => void;
  singleTask: string;
  setSingleTask: (value: string) => void;
  numEpisodes: number;
  setNumEpisodes: (value: number) => void;
  episodeTimeS: number;
  setEpisodeTimeS: (value: number) => void;
  resetTimeS: number;
  setResetTimeS: (value: number) => void;
  cameras: CameraConfig[];
  setCameras: (cameras: CameraConfig[]) => void;
  onStart: () => void;
  releaseStreamsRef?: React.MutableRefObject<(() => void) | null>;
}
```

Then add the same four to the destructured arguments at the top of the component:

```tsx
const RecordingModal: React.FC<RecordingModalProps> = ({
  open,
  onOpenChange,
  robot,
  datasetName,
  setDatasetName,
  singleTask,
  setSingleTask,
  numEpisodes,
  setNumEpisodes,
  episodeTimeS,
  setEpisodeTimeS,
  resetTimeS,
  setResetTimeS,
  cameras,
  setCameras,
  onStart,
  releaseStreamsRef,
}) => {
```

- [ ] **Step 2: Add the input row after "Number of Episodes"**

Find the existing `numEpisodes` `<div className="space-y-2">` block (currently around lines 152–168) and add a sibling block immediately after its closing `</div>`:

```tsx
<div className="grid grid-cols-2 gap-4">
  <div className="space-y-2">
    <Label
      htmlFor="episodeTimeS"
      className="text-sm font-medium text-gray-300"
    >
      Episode duration (seconds)
    </Label>
    <Input
      id="episodeTimeS"
      type="number"
      min="1"
      value={episodeTimeS}
      onChange={(e) => setEpisodeTimeS(parseInt(e.target.value) || 1)}
      className="bg-gray-800 border-gray-700 text-white"
    />
  </div>
  <div className="space-y-2">
    <Label
      htmlFor="resetTimeS"
      className="text-sm font-medium text-gray-300"
    >
      Reset duration (seconds)
    </Label>
    <Input
      id="resetTimeS"
      type="number"
      min="1"
      value={resetTimeS}
      onChange={(e) => setResetTimeS(parseInt(e.target.value) || 1)}
      className="bg-gray-800 border-gray-700 text-white"
    />
  </div>
</div>
```

- [ ] **Step 3: Verify the file compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: TypeScript will now error in `Landing.tsx` because the modal requires the new props but `Landing.tsx` doesn't pass them yet. That error is expected and is fixed in Task 3. No errors should be reported *inside* `RecordingModal.tsx` itself.

- [ ] **Step 4: (Defer commit until Task 3)**

The modal change is uncompilable on its own. Do not commit yet — Task 3 supplies the missing props.

---

### Task 3: Thread duration state through Landing.tsx

**Files:**
- Modify: `frontend/src/pages/Landing.tsx`

Add two pieces of `useState` for the durations, pass them to the modal, and use them in `recordingConfig` (replacing the hardcoded `60` / `15` values).

- [ ] **Step 1: Add state declarations**

Find the existing recording-related state near the top of the `Landing` component (currently around lines 33–38, including `numEpisodes`):

```tsx
const [numEpisodes, setNumEpisodes] = useState(5);
const [cameras, setCameras] = useState<CameraConfig[]>([]);
```

Add two new states immediately after:

```tsx
const [numEpisodes, setNumEpisodes] = useState(5);
const [episodeTimeS, setEpisodeTimeS] = useState(60);
const [resetTimeS, setResetTimeS] = useState(15);
const [cameras, setCameras] = useState<CameraConfig[]>([]);
```

- [ ] **Step 2: Replace hardcoded durations in `recordingConfig`**

Find the `recordingConfig` object construction (currently at lines 157–172). Replace:

```tsx
episode_time_s: 60,
reset_time_s: 15,
```

with:

```tsx
episode_time_s: episodeTimeS,
reset_time_s: resetTimeS,
```

- [ ] **Step 3: Pass the new props to `<RecordingModal>`**

Find the `<RecordingModal …/>` usage further down in the same file. Add the four new props alongside the existing ones (alphabetized or grouped however the rest of the props are passed — match local style):

```tsx
<RecordingModal
  open={showRecordingModal}
  onOpenChange={setShowRecordingModal}
  robot={selectedRecord}
  datasetName={datasetName}
  setDatasetName={setDatasetName}
  singleTask={singleTask}
  setSingleTask={setSingleTask}
  numEpisodes={numEpisodes}
  setNumEpisodes={setNumEpisodes}
  episodeTimeS={episodeTimeS}
  setEpisodeTimeS={setEpisodeTimeS}
  resetTimeS={resetTimeS}
  setResetTimeS={setResetTimeS}
  cameras={cameras}
  setCameras={setCameras}
  onStart={handleStartRecording}
  releaseStreamsRef={releaseStreamsRef}
/>
```

(Use the existing handler / prop names that are present in the file — `selectedRecord`, `handleStartRecording`, etc. The list above shows the *additions*; keep whatever is already there and add the four new lines.)

- [ ] **Step 4: Verify the project compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean — no type errors anywhere.

- [ ] **Step 5: Manual UI check**

Run: `lelab --dev`. Open the Landing page → click *Record Dataset* → verify the modal shows two new number inputs ("Episode duration (seconds)" defaulting to 60, "Reset duration (seconds)" defaulting to 15) below the existing "Number of Episodes" field. Edit them and confirm the values persist while the modal is open.

If you cannot run the browser, ask the user to verify the modal layout.

- [ ] **Step 6: Commit (covers Tasks 2 + 3)**

```bash
git add frontend/src/components/landing/RecordingModal.tsx frontend/src/pages/Landing.tsx
git commit -m "feat(recording): expose episode/reset durations in setup modal"
```

---

### Task 4: Recording page — strip noise and rebuild the layout

**Files:**
- Modify: `frontend/src/pages/Recording.tsx`

This task replaces the *render tree* of `Recording.tsx`. All the existing handlers (`handleExitEarly`, `handleRerecordEpisode`, `handleStopRecording`, `startRecordingSession`), the polling effect, and the `transitioningToReset` / `transitioningToNext` flags **stay untouched** in this task — Task 5 will replace them. The page should behave identically to today after this task; only the visual layout changes.

We are removing: URDF viewer, instructions panel, 3-card grid, Recording Status section, arrow-key copy. We are introducing: a single centered card with status pill, big timer, progress bar, single primary button, plus a corner stat row with a `⋯` dropdown for Re-record/Stop. The mute toggle and Stop confirm dialog come in later tasks; for now the dropdown items wire to `handleRerecordEpisode` and `handleStopRecording` directly.

- [ ] **Step 1: Update imports**

At the top of `frontend/src/pages/Recording.tsx`, replace the import block. Remove `UrdfViewer`, `UrdfProcessorInitializer`, and the unused lucide icons; add the dropdown-menu imports and the new icons we need.

```tsx
import React, { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  MoreHorizontal,
  RotateCcw,
  Square,
  SkipForward,
  Play,
} from "lucide-react";
import { useApi } from "@/contexts/ApiContext";
```

- [ ] **Step 2: Replace the JSX returned by the component**

Find the `return (` block at the end of `Recording.tsx` (currently around line 400, after the `getDotColor` helper). Replace **the entire return block**, from `return (` through the matching closing `);` before the final `};`, with this new render tree:

```tsx
const phaseColor =
  currentPhase === "recording"
    ? { dot: "bg-red-500", pill: "bg-red-500/15 text-red-300", timer: "text-green-400", bar: "bg-green-500", button: "bg-green-500 hover:bg-green-600" }
    : currentPhase === "resetting"
    ? { dot: "bg-orange-500", pill: "bg-orange-500/15 text-orange-300", timer: "text-orange-400", bar: "bg-orange-500", button: "bg-orange-500 hover:bg-orange-600" }
    : { dot: "bg-gray-500", pill: "bg-gray-500/15 text-gray-300", timer: "text-gray-400", bar: "bg-gray-500", button: "bg-gray-500" };

const primaryLabel =
  currentPhase === "recording"
    ? "End Episode"
    : currentPhase === "resetting"
    ? "Start Next Episode"
    : "Advance";

const PrimaryIcon = currentPhase === "recording" ? SkipForward : Play;

return (
  <div className="min-h-screen bg-black text-white p-8">
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <Button
          onClick={() => navigate("/")}
          variant="outline"
          className="border-gray-500 hover:border-gray-200 text-gray-300 hover:text-white"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Home
        </Button>
      </div>

      <div className="bg-gray-900 rounded-lg border border-gray-700 p-8">
        <div className="flex justify-end items-center gap-4 mb-6 text-sm text-gray-400">
          <span>
            Episode <span className="text-white font-semibold">{currentEpisode}</span> / {totalEpisodes}
          </span>
          <span className="font-mono">{formatTime(sessionElapsedTime)}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-gray-400 hover:text-white hover:bg-gray-800"
                aria-label="More actions"
              >
                <MoreHorizontal className="w-5 h-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="bg-gray-900 border-gray-700 text-white">
              <DropdownMenuItem
                onClick={handleRerecordEpisode}
                disabled={!backendStatus.available_controls.rerecord_episode}
                className="focus:bg-gray-800 focus:text-white"
              >
                <RotateCcw className="w-4 h-4 mr-2" />
                Re-record episode
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleStopRecording}
                disabled={!backendStatus.available_controls.stop_recording}
                className="text-red-400 focus:bg-gray-800 focus:text-red-300"
              >
                <Square className="w-4 h-4 mr-2" />
                Stop recording
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="text-center mb-6">
          <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold tracking-widest ${phaseColor.pill}`}>
            <span className={`w-2 h-2 rounded-full ${phaseColor.dot} ${currentPhase !== "completed" ? "animate-pulse" : ""}`} />
            {getStatusText()}
          </div>
        </div>

        <div className="text-center mb-4">
          <div className={`text-7xl font-mono font-bold leading-none ${phaseColor.timer}`}>
            {formatTime(phaseElapsedTime)}
          </div>
          <div className="text-sm text-gray-500 mt-2">
            / {formatTime(phaseTimeLimit)}
          </div>
        </div>

        <div className="w-full bg-gray-800 rounded-full h-1.5 mb-8">
          <div
            className={`h-1.5 rounded-full transition-all duration-500 ${phaseColor.bar}`}
            style={{
              width: `${Math.min((phaseElapsedTime / phaseTimeLimit) * 100, 100)}%`,
            }}
          />
        </div>

        <Button
          onClick={handleExitEarly}
          disabled={
            !backendStatus.available_controls.exit_early ||
            transitioningToReset ||
            transitioningToNext ||
            currentPhase === "completed"
          }
          className={`w-full text-white font-semibold py-6 text-lg disabled:opacity-50 ${phaseColor.button}`}
        >
          <PrimaryIcon className="w-5 h-5 mr-2" />
          {primaryLabel}
        </Button>

        {currentPhase === "completed" && (
          <p className="text-center text-sm text-gray-400 mt-6">
            Recording complete — redirecting to upload…
          </p>
        )}
      </div>
    </div>
  </div>
);
```

Note: this still uses `transitioningToReset` / `transitioningToNext` to keep the page identical-behavior — Task 5 replaces them.

- [ ] **Step 3: Verify the project compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Manual UI check**

Run: `lelab --dev`. Start a recording session (or have the user do so). Verify:
- Page shows a single centered card. No URDF, no instructions, no 3-card grid.
- Status pill, big timer, thin progress bar, full-width green "End Episode" button.
- Top-right of card shows `Episode N / M · MM:SS · ⋯`.
- Clicking the `⋯` opens a dropdown with "Re-record episode" and "Stop recording" (red).
- Both items still work the same as the old buttons.

If hardware isn't available, navigate to the page directly (it will redirect to home) and ask the user to verify the layout end-to-end.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Recording.tsx
git commit -m "feat(recording): single-card glanceable layout"
```

---

### Task 5: Recording page — replace transitioning flags with optimistic phase

**Files:**
- Modify: `frontend/src/pages/Recording.tsx`

Today's `transitioningToReset` / `transitioningToNext` boolean pair gets replaced by a single `optimisticPhase` state. When the user advances, we synchronously pick the next phase, immediately drive the displayed timer / status pill / button from it, and clear it once the polling tick confirms the backend has caught up.

- [ ] **Step 1: Replace state declarations**

In `Recording.tsx`, find:

```tsx
const [transitioningToReset, setTransitioningToReset] = useState(false);
const [transitioningToNext, setTransitioningToNext] = useState(false);
```

Replace with:

```tsx
type Phase = "preparing" | "recording" | "resetting" | "completed";
const [optimisticPhase, setOptimisticPhase] = useState<Phase | null>(null);
```

- [ ] **Step 2: Update the polling effect to clear `optimisticPhase` on backend match**

Find the polling effect (the `useEffect` that calls `pollStatus` every second). Replace the two `if (status.current_phase === ... && transitioning...)` blocks with a single:

```tsx
if (optimisticPhase && status.current_phase === optimisticPhase) {
  setOptimisticPhase(null);
}
```

Update the effect's dependency array: remove `transitioningToReset, transitioningToNext`, add `optimisticPhase`.

Also remove the `console.log` lines that referenced the old flag names, and the existing log line that prints both transition states. The polling effect should be quieter now.

- [ ] **Step 3: Rewrite `handleExitEarly` to set `optimisticPhase` before the network call**

Replace the entire `handleExitEarly` function with:

```tsx
const handleExitEarly = async () => {
  if (!backendStatus?.available_controls.exit_early) return;

  const realPhase = backendStatus.current_phase as Phase;
  const next: Phase | null =
    realPhase === "recording" ? "resetting" :
    realPhase === "resetting" ? "recording" : null;

  if (!next) return;

  setOptimisticPhase(next);

  try {
    const response = await fetchWithHeaders(
      `${baseUrl}/recording-exit-early`,
      { method: "POST" }
    );
    if (!response.ok) {
      const data = await response.json();
      setOptimisticPhase(null);
      toast({
        title: "Error",
        description: data.message,
        variant: "destructive",
      });
    }
  } catch (error) {
    setOptimisticPhase(null);
    toast({
      title: "Connection Error",
      description: "Could not connect to the backend server.",
      variant: "destructive",
    });
  }
};
```

(The success toast is intentionally removed — the immediate visual flip is the feedback.)

- [ ] **Step 4: Drive the rendered phase / timer / button from `optimisticPhase` when set**

Near the top of the render block (before the existing `currentPhase = backendStatus.current_phase` line), introduce an effective-phase variable and derive the displayed timer values from it. Replace:

```tsx
const currentPhase = backendStatus.current_phase;
const currentEpisode = backendStatus.current_episode || 1;
const totalEpisodes =
  backendStatus.total_episodes || recordingConfig.num_episodes;
const phaseElapsedTime = backendStatus.phase_elapsed_seconds || 0;
const phaseTimeLimit =
  backendStatus.phase_time_limit_s ||
  (currentPhase === "recording"
    ? recordingConfig.episode_time_s
    : recordingConfig.reset_time_s);
const sessionElapsedTime = backendStatus.session_elapsed_seconds || 0;
```

with:

```tsx
const realPhase = backendStatus.current_phase as Phase;
const currentPhase: Phase = optimisticPhase ?? realPhase;
const currentEpisode = backendStatus.current_episode || 1;
const totalEpisodes =
  backendStatus.total_episodes || recordingConfig.num_episodes;

const phaseElapsedTime = optimisticPhase
  ? 0
  : backendStatus.phase_elapsed_seconds || 0;
const phaseTimeLimit =
  currentPhase === "recording"
    ? recordingConfig.episode_time_s
    : currentPhase === "resetting"
    ? recordingConfig.reset_time_s
    : backendStatus.phase_time_limit_s || 0;

const sessionElapsedTime = backendStatus.session_elapsed_seconds || 0;
```

- [ ] **Step 5: Update `getStatusText` and remove the transition-specific helpers**

Find the helper trio `getPhaseTitle`, `getStatusText`, `getStatusColor`, `getDotColor`. We removed `getStatusColor` / `getDotColor` calls in the Task 4 render and folded them into `phaseColor`; delete those two helpers if still defined. Keep `getStatusText` but simplify by removing the transition branches:

```tsx
const getStatusText = () => {
  if (currentPhase === "recording") return `RECORDING EPISODE ${currentEpisode}`;
  if (currentPhase === "resetting") return "RESET — GET READY";
  if (currentPhase === "preparing") return "PREPARING SESSION";
  return "SESSION COMPLETE";
};
```

Delete `getPhaseTitle` if it has no remaining callers in the new render tree (it doesn't, after Task 4). Same for `formatTime`'s callers — leave `formatTime` since the timer block still uses it.

- [ ] **Step 6: Update the primary-button `disabled` condition**

In the JSX from Task 4, find the `disabled` prop on the primary button:

```tsx
disabled={
  !backendStatus.available_controls.exit_early ||
  transitioningToReset ||
  transitioningToNext ||
  currentPhase === "completed"
}
```

Replace with:

```tsx
disabled={
  !backendStatus.available_controls.exit_early ||
  optimisticPhase !== null ||
  currentPhase === "completed"
}
```

- [ ] **Step 7: Verify the project compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean. References to `transitioningToReset` / `transitioningToNext` should now produce no usages anywhere in the file.

- [ ] **Step 8: Manual UI check**

Run: `lelab --dev`, start a recording session (or have the user). When you click "End Episode":
- The status pill should flip to "RESET — GET READY" *immediately*, without the previous ~1 s lag.
- The timer should reset to `00:00 / 00:15` immediately and start ticking from there once the backend confirms.
- The progress bar should jump to 0%.
- Same in reverse for "Start Next Episode".

If hardware isn't available, ask the user to confirm the perceived latency is gone after a click.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/pages/Recording.tsx
git commit -m "fix(recording): mask click latency with optimistic phase"
```

---

### Task 6: Recording page — keyboard shortcuts (Space / R / Esc)

**Files:**
- Modify: `frontend/src/pages/Recording.tsx`

The keyboard shortcuts are the canonical input. Space invokes `handleExitEarly`, R invokes `handleRerecordEpisode`, Escape invokes `handleStopRecording`. We attach a window-level `keydown` listener inside an effect, gated on `recordingSessionStarted` so it isn't active during the connecting state.

- [ ] **Step 1: Add the keyboard effect**

In `Recording.tsx`, immediately after the polling `useEffect`, add a new effect:

```tsx
useEffect(() => {
  if (!recordingSessionStarted || !backendStatus) return;

  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      handleExitEarly();
    } else if (e.key === "r" || e.key === "R") {
      handleRerecordEpisode();
    } else if (e.key === "Escape") {
      handleStopRecording();
    }
  };

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}, [recordingSessionStarted, backendStatus, handleExitEarly, handleRerecordEpisode, handleStopRecording]);
```

If your linter complains about including the handler functions in the dependency array, that's expected — we want the listener to capture the latest closures. If you prefer, hoist the handlers above with `useCallback` and depend on those callbacks; either approach is fine. Do *not* depend on a constantly-changing variable like `backendStatus` if it causes the listener to thrash — wrap the handlers in `useCallback` first.

(Implementer's note: the cleanest pattern here is to wrap each handler in `useCallback` with explicit deps, then list the callbacks in the keyboard effect's deps. Do that if the simpler form re-attaches the listener too often.)

- [ ] **Step 2: Update the on-screen primary button label to advertise the shortcut**

In the primary button's JSX (from Task 4), the label currently reads `{primaryLabel}`. Update the surrounding span to add a small keyboard hint:

```tsx
<Button … >
  <PrimaryIcon className="w-5 h-5 mr-2" />
  {primaryLabel}
  <span className="ml-3 px-2 py-0.5 rounded text-xs font-mono bg-black/30 text-white/70">SPACE</span>
</Button>
```

- [ ] **Step 3: Verify the project compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Manual UI check**

Run: `lelab --dev`, start a recording session. Verify:
- Pressing **Space** advances the phase (same as clicking the primary button).
- Pressing **R** during a recording phase triggers re-record (toast appears).
- Pressing **Esc** triggers stop (today this navigates to upload — Task 7 wraps it in a confirmation).
- Typing into a focused text input does *not* trigger any of these.

Ask the user to verify if hardware is unavailable.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Recording.tsx
git commit -m "feat(recording): keyboard shortcuts for advance/re-record/stop"
```

---

### Task 7: Recording page — Stop confirmation dialog

**Files:**
- Modify: `frontend/src/pages/Recording.tsx`

Today, Esc and the Stop dropdown item end the session immediately. Spec requires a confirmation modal (`AlertDialog`) so a stray keypress doesn't kill the run.

- [ ] **Step 1: Update imports**

Add to the existing imports at the top of `Recording.tsx`:

```tsx
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
```

- [ ] **Step 2: Add `showStopConfirm` state**

Inside the component, alongside the other `useState` calls, add:

```tsx
const [showStopConfirm, setShowStopConfirm] = useState(false);
```

- [ ] **Step 3: Split the stop flow into "request" and "confirm"**

Add a small wrapper that opens the dialog instead of stopping immediately. Keep `handleStopRecording` (the function that actually POSTs `/stop-recording` and navigates) — only its callers change.

```tsx
const requestStopRecording = () => {
  if (!backendStatus?.available_controls.stop_recording) return;
  setShowStopConfirm(true);
};

const confirmStopRecording = async () => {
  setShowStopConfirm(false);
  await handleStopRecording();
};
```

- [ ] **Step 4: Update callers to use `requestStopRecording`**

- In the keyboard effect (Task 6), change the `Escape` branch to call `requestStopRecording()` instead of `handleStopRecording()`.
- In the dropdown menu's Stop item (Task 4), change `onClick={handleStopRecording}` to `onClick={requestStopRecording}`.

- [ ] **Step 5: Add the confirmation dialog to the JSX**

At the end of the outer `<div className="min-h-screen ...">` block, *just before* its closing `</div>`, add:

```tsx
<AlertDialog open={showStopConfirm} onOpenChange={setShowStopConfirm}>
  <AlertDialogContent className="bg-gray-900 border-gray-700 text-white">
    <AlertDialogHeader>
      <AlertDialogTitle>Stop recording?</AlertDialogTitle>
      <AlertDialogDescription className="text-gray-400">
        Saved episodes are kept. The session will end and you'll be taken to the upload page.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel className="bg-gray-800 border-gray-700 text-white hover:bg-gray-700">
        Keep recording
      </AlertDialogCancel>
      <AlertDialogAction
        onClick={confirmStopRecording}
        className="bg-red-500 hover:bg-red-600 text-white"
      >
        Stop
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

- [ ] **Step 6: Verify the project compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Manual UI check**

Run: `lelab --dev`, start a recording session. Verify:
- Pressing **Esc** opens the confirmation dialog (does *not* stop immediately).
- Clicking *Keep recording* (or pressing Esc again, or clicking outside) closes the dialog without stopping.
- Clicking *Stop* posts to `/stop-recording` and navigates to upload.
- Selecting "Stop recording" from the `⋯` dropdown also opens the dialog.

Ask the user to verify if hardware is unavailable.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/Recording.tsx
git commit -m "feat(recording): confirm before stopping the session"
```

---

### Task 8: Recording page — audio cues + mute toggle

**Files:**
- Modify: `frontend/src/pages/Recording.tsx`

Wire the audio module from Task 1. Cues fire on transitions of the **real** backend phase (not optimistic). Auto-advance warning fires once when `phase_elapsed_seconds` reaches `phase_time_limit_s − 3`, suppressed during optimistic windows. The mute toggle is a speaker icon between the session-time stat and the `⋯` menu, persisted via the audio module.

- [ ] **Step 1: Update imports**

Add to the imports:

```tsx
import { Volume2, VolumeX } from "lucide-react";
import {
  getMuted,
  setMuted as persistMuted,
  playRecordingStartCue,
  playResetStartCue,
  playAutoAdvanceWarning,
} from "@/lib/recordingAudio";
```

- [ ] **Step 2: Track mute state and a previous-phase ref**

Inside the component, add:

```tsx
const [muted, setMutedState] = useState<boolean>(() => getMuted());
const prevRealPhaseRef = React.useRef<Phase | null>(null);
const warningFiredForPhaseRef = React.useRef<{ phase: Phase | null; episode: number | null }>({ phase: null, episode: null });

const toggleMute = () => {
  const next = !muted;
  setMutedState(next);
  persistMuted(next);
};
```

(`React.useRef` is fine without an import alias since `React` is already imported.)

- [ ] **Step 3: Fire phase-change cues from the polling effect**

Inside the polling `pollStatus` function, *after* `setBackendStatus(status)` and the optimistic-phase clear logic, add:

```tsx
const real = status.current_phase as Phase;
const prev = prevRealPhaseRef.current;
if (prev !== real) {
  if (real === "recording" && prev !== null) {
    playRecordingStartCue();
  } else if (real === "resetting") {
    playResetStartCue();
  }
  prevRealPhaseRef.current = real;
  warningFiredForPhaseRef.current = { phase: null, episode: null };
}
```

The `prev !== null` guard prevents the recording-start cue from firing on the very first transition into recording when the page loads (we haven't established a baseline yet).

- [ ] **Step 4: Fire the auto-advance warning when the timer crosses the threshold**

Still inside `pollStatus`, after the phase-change block:

```tsx
const elapsed = status.phase_elapsed_seconds || 0;
const limit = status.phase_time_limit_s || 0;
const inFinalThreeSeconds =
  limit > 3 && elapsed >= limit - 3 && elapsed < limit;
const ep = status.current_episode || null;
const warned = warningFiredForPhaseRef.current;
if (
  inFinalThreeSeconds &&
  optimisticPhase === null &&
  (warned.phase !== real || warned.episode !== ep)
) {
  playAutoAdvanceWarning();
  warningFiredForPhaseRef.current = { phase: real, episode: ep };
}
```

- [ ] **Step 5: Add the mute toggle button to the corner stat row**

In the JSX from Task 4, find the row with `Episode N / M`, `formatTime(sessionElapsedTime)`, and the dropdown trigger. Insert a new icon button immediately *before* the dropdown:

```tsx
<Button
  variant="ghost"
  size="icon"
  onClick={toggleMute}
  aria-label={muted ? "Unmute" : "Mute"}
  className="h-8 w-8 text-gray-400 hover:text-white hover:bg-gray-800"
>
  {muted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
</Button>
```

- [ ] **Step 6: Verify the project compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Manual UI check**

Run: `lelab --dev`, start a recording session. Verify:
- A short rising "ding-ding" plays when the page transitions into recording for the 2nd-and-onward episode (i.e. on the reset → recording transition).
- A falling "ding-dong" plays when the page transitions into reset.
- Three short beeps play in the last 3 seconds of a phase, when the timer is about to expire (let it run to the end without clicking).
- Manually advancing during the warning window does not produce a stale extra beep.
- Clicking the speaker icon toggles between 🔊 / 🔇 and silences the cues; reload the page → the muted state is preserved.

Ask the user to verify if hardware is unavailable.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/Recording.tsx
git commit -m "feat(recording): audio cues and mute toggle"
```

---

## Self-review checklist (run before handing off)

After all tasks complete, before handing back to the user:

1. Open the spec ([2026-05-04-recording-page-redesign-design.md](docs/superpowers/specs/2026-05-04-recording-page-redesign-design.md)) and check each section maps to a task: layout (Task 4), interaction model + keyboard (Tasks 4, 6), optimistic phase (Task 5), audio cues (Tasks 1, 8), setup modal additions (Tasks 2, 3), removed elements (Task 4), state summary (Tasks 4, 5, 7, 8). All covered.
2. `cd frontend && npx tsc --noEmit` — clean.
3. Search `frontend/src/pages/Recording.tsx` for any remaining references to `transitioningToReset`, `transitioningToNext`, `UrdfViewer`, `UrdfProcessorInitializer`. Should be none.
4. Search the same file for "Arrow", "ESC key", "Right Arrow", "Left Arrow" (in copy strings). Should be none — old instructional copy is gone.
5. Run `lelab --dev` end-to-end with the user: configure recording with a 10s episode / 5s reset (so cycles are quick), start, hit Space, watch the latency feel; let one phase auto-advance to confirm the warning beeps; toggle mute; press Esc and confirm the dialog appears.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-04-recording-page-redesign.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
