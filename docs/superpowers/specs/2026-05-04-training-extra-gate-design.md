# Training Extra Gate — Design

**Date:** 2026-05-04
**Status:** Approved

## Problem

The Training page invokes `python -m lerobot.scripts.lerobot_train`, which depends on the `accelerate` package gated by `lerobot`'s `[training]` extra. If `accelerate` isn't installed, the subprocess crashes within milliseconds (`ImportError`) and the user sees a confusing failure with no clear remediation. Today, the only way to know is to read the streamed logs and recognize the import error.

We've added `training` to the project's `pyproject.toml` extras, so fresh `pip install -e .` runs cover this. But existing installations still need the user to either re-run install or `pip install accelerate` manually. We want the Training page itself to detect the gap, surface a clear warning, and let the user resolve it without touching a terminal.

## Goal

- Detect at runtime whether the LeRobot training extra is usable.
- Replace the entire Training page UI with a single warning card when it's not.
- Offer one-click install of the missing dependency from the warning card.
- Be honest about the restart requirement: after install completes, the user must restart `lelab` for the change to take effect — no auto-restart.

## Scope

Single capability for now: the LeRobot training extra (gated by `accelerate`). The API shape generalizes naturally to additional capabilities later (cameras, sim envs) but no other gates are built in this round.

## Architecture

### Backend: `app/system.py`

New module owning capability detection and the install subprocess. Two responsibilities; both small enough to fit in one file.

**Detection (cached at module load):**

```python
import importlib.util

TRAINING_AVAILABLE: bool = importlib.util.find_spec("accelerate") is not None
TRAINING_INSTALL_HINT: str = "pip install accelerate"
```

The flag is computed once at process start and never re-evaluated. This matches the "manual restart" UX decision — the running uvicorn process can't import a freshly-installed module without restarting, so re-checking would lie about availability.

**Install management:** `InstallManager` singleton with state `"idle" | "installing" | "done" | "error"`, a `log_queue`, and a monitor thread. Mirrors the existing `TrainingManager` pattern (`app/training.py`) but smaller — no metric parsing, fewer fields. Transitions:

- `idle → installing` (on `start()` if not already installing)
- `installing → done` when the pip subprocess exits with code 0
- `installing → error` when it exits with a non-zero code (or fails to spawn)
- `done | error → installing` when `start()` is called again (allows retry)

The install command:

```python
[sys.executable, "-m", "pip", "install", "accelerate"]
```

Reasoning over `pip install 'lerobot[training] @ git+...'`:
- Fast (~10s vs minutes — pip would re-fetch the lerobot source archive).
- `accelerate` is the exact module LeRobot's `require_package` checks for.
- The pyproject.toml change handles fresh installs faithfully; this is the runtime quick-fix path. If LeRobot's `[training]` extra grows further deps, this constant is updated and the pyproject.toml change continues to cover fresh installs. The divergence is acceptable.

### API endpoints (in `app/main.py`)

Three endpoints under a `/system/` namespace:

| Method | Path | Returns |
|---|---|---|
| `GET` | `/system/training-extra` | `{ available: bool, install_hint: str }` |
| `POST` | `/system/training-extra/install` | `{ started: bool, message: str }` |
| `GET` | `/system/training-extra/install-status` | `{ state: str, error: str \| null, logs: [{timestamp: float, message: str}] }` |

The status endpoint drains the log queue on read (same pattern as `/training-logs`). The frontend appends received logs and the backend forgets them — no double-emission.

`POST` returns `started=false` if a subprocess is already running, so a second click is a no-op. `started=true` indicates a fresh subprocess was spawned.

### Frontend: gate at the Training page level

In [Training.tsx](frontend/src/pages/Training.tsx), fetch `/system/training-extra` on mount via the existing `useApi()` plumbing. Three render modes:

1. **Loading** — render `<TrainingHeader />` and a spinner placeholder for the body. Skip tabs and TrainingControls.
2. **Available** — render the current full UI (header, tabs, ConfigurationTab/MonitoringTab, floating Start/Stop button).
3. **Missing** — render `<TrainingHeader />` and a single `<TrainingExtraGate />` card centered in `max-w-3xl`. Skip the tabs and the floating button entirely.

Gating at the page level (not inside `EssentialsCard`) is deliberate: the floating Start button should disappear, the Monitoring tab should be unreachable, and we want one clear obstacle to address rather than several broken-looking sub-components.

### `TrainingExtraGate` component

New file `frontend/src/components/training/TrainingExtraGate.tsx`. Card styled `bg-slate-800/50 border-slate-700 rounded-xl` to match the rest of the Training page. Local React state for the install state machine: `"idle" | "installing" | "done" | "error"`. Owns its own polling loop, gated on `state === "installing"`, polling `/system/training-extra/install-status` at 1.5s.

Render branches:

- **Idle:** Title "Training Extra Not Installed". Body explains the gap and shows the exact install command (`pip install accelerate`) in a `font-mono` code box with a copy-to-clipboard button (same pattern as the Get Started modal's command box). Primary button "Install Now". Click → POST `/system/training-extra/install`, then **immediately set local state to `installing`** so the polling effect kicks in (same chicken-and-egg fix as `Training.tsx`'s training-status polling).
- **Installing:** Inline spinner + "Installing `accelerate`. This usually takes about 10 seconds." Install button disabled.
- **Done:** Green checkmark + "Install complete. Restart `lelab` (Ctrl+C, then `lelab --dev` or `lelab`) to enable training." No further interactive elements — the gate stays closed for this process. The user must restart.
- **Error:** Red icon + the error message from the backend. Auto-expanded log panel showing pip stdout/stderr (`font-mono text-sm` like `TrainingLogs`). "Try again" button resets to `idle`.

### Recovery / edge cases

- **Concurrent install clicks:** Backend returns `started=false` and the second POST is a no-op. The frontend ignores it; polling continues.
- **Page refresh mid-install (or post-install):** When the gate component mounts (i.e. when training-extra availability returned `false`), it calls `/system/training-extra/install-status` once to seed its local state. The returned `state` is used directly: `idle` → show Idle UI; `installing` → jump to Installing UI and start the polling loop without re-POSTing; `done` → jump to Done UI with the restart message; `error` → jump to Error UI with the log panel populated by the returned `logs`. This makes refresh transparent regardless of when it happens.
- **Backend pip failure (no network, permissions, etc.):** Subprocess exits non-zero; state transitions to `error`; log panel shows what pip said.
- **User installs accelerate manually before reloading:** The cached `TRAINING_AVAILABLE` flag is still false until restart. The gate stays closed and tells them to restart. Correct outcome.

## Out of scope

- Re-checking availability after a successful install in the same process. The cached flag and "manual restart" message are the contract.
- Detecting other capabilities (cameras, simulators). API generalizes but no additional gates are built.
- HF Spaces detection. The pip subprocess will fail in a read-only/Docker-rebuild environment; the error message surfaces what pip said. Fine for MVP.
- Cancellation of an in-flight install. The subprocess is short and the cost of letting it finish is small.

## Acceptance

- Visiting `/training` while `accelerate` is missing shows a single warning card. No tabs, no Start button.
- Clicking Install Now spawns a backend pip subprocess; the warning card transitions to Installing with a spinner. Within ~10s on a normal machine, it transitions to Done with the restart message.
- Clicking Install Now when pip will fail (e.g. simulated by setting `PIP_INDEX_URL` to a bogus URL) shows the Error state with auto-expanded log panel. Try again resets to Idle.
- Refreshing the page during an active install picks up the Installing state without re-spawning.
- Visiting `/training` after a successful install + manual restart shows the normal Training UI (EssentialsCard, AdvancedCard, tabs, floating button).
