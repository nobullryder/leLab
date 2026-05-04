# Training Extra Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect at runtime whether the LeRobot training extra (`accelerate`) is installed; when missing, replace the Training page UI with a single warning card that offers a one-click `pip install accelerate` and tells the user to restart `lelab` after the install completes.

**Architecture:** New `app/system.py` module owns capability detection (cached at module load) and an `InstallManager` singleton that runs `python -m pip install accelerate` as a managed subprocess (state machine + log queue, mirroring `app/training.py`). Three FastAPI endpoints under `/system/training-extra` expose the flag, an install trigger, and a status/logs feed. On the frontend, `Training.tsx` gates the entire page on the availability flag; when missing, a new `TrainingExtraGate` component owns the install state machine and polling.

**Tech Stack:** Python 3.12+ (FastAPI, Pydantic, threading + subprocess), React + TypeScript + Vite, shadcn/ui primitives (Card, Button), Tailwind, `lucide-react` icons.

**Spec:** [docs/superpowers/specs/2026-05-04-training-extra-gate-design.md](../specs/2026-05-04-training-extra-gate-design.md)

**No test suite exists in this repo** (per `CLAUDE.md`). Verification is `npm run build` (frontend) and direct `curl` against the backend (after restarting `lelab --dev`). Each task ends with whichever verification fits its surface area.

**Existing context the implementer needs:**

- `app/training.py` already has the `TrainingManager` pattern (subprocess + state + log queue + monitor thread). Use it as the reference for `InstallManager` — same shape, smaller scope.
- `app/main.py` follows a thin-router pattern: feature modules expose `handle_*` functions and Pydantic models; `main.py` imports them and wires routes. New routes for this feature go in the same file.
- `frontend/src/pages/Training.tsx` already uses `useApi()` (`baseUrl`, `fetchWithHeaders`) and has a polling pattern in a `useEffect` — copy that pattern, don't reinvent it.
- `frontend/src/components/landing/UsageInstructionsModal.tsx` has a "click-to-copy code box" implementation worth referencing for the install command display.
- The subprocess command must use `sys.executable -m pip ...`, not bare `python -m pip ...` — the running process's Python may not be the one in PATH.

**Task ordering rationale:** Backend first (detection + install manager + endpoints) so the frontend has a real API to talk to. Then the frontend gate component. Then wire the gate into `Training.tsx`. Finally a manual end-to-end smoke test.

---

### Task 1: Create `app/system.py` with detection + InstallManager

**Files:**
- Create: `app/system.py`

- [ ] **Step 1: Create `app/system.py` with the full module**

Create `/Users/nicolasrabault/Projects/Hackathon/leLab/app/system.py` with this exact content:

```python
import importlib.util
import logging
import queue
import subprocess
import sys
import threading
import time
from typing import Any, Dict, List, Optional

from pydantic import BaseModel

logger = logging.getLogger(__name__)


# Cached at module load — never re-checked. After install, the user must
# restart lelab for a freshly-installed accelerate to be importable.
TRAINING_AVAILABLE: bool = importlib.util.find_spec("accelerate") is not None
TRAINING_INSTALL_HINT: str = "pip install accelerate"

INSTALL_CMD: List[str] = [sys.executable, "-m", "pip", "install", "accelerate"]


class TrainingExtraStatus(BaseModel):
    available: bool
    install_hint: str


class InstallStartResponse(BaseModel):
    started: bool
    message: str


class InstallStatusResponse(BaseModel):
    state: str  # "idle" | "installing" | "done" | "error"
    error: Optional[str] = None
    logs: List[Dict[str, Any]] = []


class InstallManager:
    def __init__(self) -> None:
        self.state: str = "idle"
        self.error: Optional[str] = None
        self.process: Optional[subprocess.Popen] = None
        self.log_queue: "queue.Queue[Dict[str, Any]]" = queue.Queue()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

    def start(self) -> Dict[str, Any]:
        with self._lock:
            if self.state == "installing":
                return {"started": False, "message": "Install already in progress"}
            # Reset for a fresh attempt (covers retry from done/error/idle).
            self.state = "installing"
            self.error = None
            self._drain_queue()

        try:
            self.process = subprocess.Popen(
                INSTALL_CMD,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                universal_newlines=True,
                bufsize=1,
            )
        except Exception as exc:
            logger.exception("Failed to spawn pip subprocess")
            with self._lock:
                self.state = "error"
                self.error = f"Failed to spawn pip: {exc}"
            return {"started": False, "message": str(exc)}

        self._thread = threading.Thread(target=self._monitor, daemon=True)
        self._thread.start()
        return {"started": True, "message": "Install started"}

    def get_status(self) -> Dict[str, Any]:
        logs: List[Dict[str, Any]] = []
        try:
            while not self.log_queue.empty():
                logs.append(self.log_queue.get_nowait())
        except queue.Empty:
            pass
        return {"state": self.state, "error": self.error, "logs": logs}

    def _monitor(self) -> None:
        assert self.process is not None
        try:
            for line in iter(self.process.stdout.readline, ""):
                if not line:
                    break
                self._enqueue(line.rstrip())
        except Exception as exc:
            logger.exception("Error reading pip output")
            self._enqueue(f"[install-monitor] error reading output: {exc}")

        self.process.wait()
        return_code = self.process.returncode
        with self._lock:
            if return_code == 0:
                self.state = "done"
                self.error = None
            else:
                self.state = "error"
                self.error = f"pip exited with code {return_code}"

    def _enqueue(self, message: str) -> None:
        # Cap queue size so a chatty pip can't grow memory unbounded.
        if self.log_queue.qsize() >= 1000:
            try:
                self.log_queue.get_nowait()
            except queue.Empty:
                pass
        self.log_queue.put({"timestamp": time.time(), "message": message})

    def _drain_queue(self) -> None:
        try:
            while not self.log_queue.empty():
                self.log_queue.get_nowait()
        except queue.Empty:
            pass


install_manager = InstallManager()


def handle_get_training_extra() -> Dict[str, Any]:
    return {"available": TRAINING_AVAILABLE, "install_hint": TRAINING_INSTALL_HINT}


def handle_install_training_extra() -> Dict[str, Any]:
    return install_manager.start()


def handle_install_training_extra_status() -> Dict[str, Any]:
    return install_manager.get_status()
```

- [ ] **Step 2: Sanity-check imports and the cached flag**

Run from repo root:

```bash
.venv/bin/python -c "from app.system import TRAINING_AVAILABLE, TRAINING_INSTALL_HINT, install_manager; print(TRAINING_AVAILABLE, TRAINING_INSTALL_HINT, install_manager.state)"
```

Expected output (one of):
- `True pip install accelerate idle` (if accelerate is already in the venv — fine; flag will be True)
- `False pip install accelerate idle` (if not installed — fine; flag will be False)

Either is OK; we just need to confirm the module imports cleanly and the singleton initializes.

- [ ] **Step 3: Commit**

```bash
git add app/system.py
git commit -m "feat(system): add training-extra detection and InstallManager"
```

---

### Task 2: Wire the three endpoints in `app/main.py`

**Files:**
- Modify: `app/main.py`

- [ ] **Step 1: Add the import**

Open `app/main.py` and find the existing `from .training import (...)` block (around line 42). Add a new import block immediately after it:

```python
from .system import (
    handle_get_training_extra,
    handle_install_training_extra,
    handle_install_training_extra_status,
)
```

- [ ] **Step 2: Add the three endpoints**

Locate the existing `# TRAINING ENDPOINTS` section (the one that defines `@app.post("/start-training")`, around line 342). After the last training endpoint in that section, add this block:

```python
# ============================================================================
# SYSTEM ENDPOINTS
# ============================================================================


@app.get("/system/training-extra")
def get_training_extra():
    """Return whether the LeRobot training extra (accelerate) is importable."""
    return handle_get_training_extra()


@app.post("/system/training-extra/install")
def install_training_extra():
    """Spawn `pip install accelerate` as a background subprocess. No-op if already running."""
    return handle_install_training_extra()


@app.get("/system/training-extra/install-status")
def install_training_extra_status():
    """Return current install state plus any pending log lines (drained on read)."""
    return handle_install_training_extra_status()
```

(Do not change any existing routes.)

- [ ] **Step 3: Restart and verify with curl**

The implementer must restart `lelab --dev` for the new routes to register. Ask the human controller to restart it, then verify from a separate terminal:

```bash
curl -s http://localhost:8000/system/training-extra
```

Expected: a JSON object containing `available` (bool) and `install_hint` ("pip install accelerate").

```bash
curl -s http://localhost:8000/system/training-extra/install-status
```

Expected: `{"state":"idle","error":null,"logs":[]}`.

If either curl returns a 404 or the FastAPI auto-generated HTML, the import or the route definition has a typo. Fix and restart.

- [ ] **Step 4: Commit**

```bash
git add app/main.py
git commit -m "feat(system): expose training-extra detection and install endpoints"
```

---

### Task 3: Build the `TrainingExtraGate` React component

**Files:**
- Create: `frontend/src/components/training/TrainingExtraGate.tsx`

The component owns the install state machine, polls `/system/training-extra/install-status` while installing, and renders one of four sub-UIs (idle / installing / done / error). It's mounted *only* when the parent has determined that training is unavailable.

- [ ] **Step 1: Create the file**

Create `/Users/nicolasrabault/Projects/Hackathon/leLab/frontend/src/components/training/TrainingExtraGate.tsx` with this exact content:

```tsx
import React, { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { useApi } from "@/contexts/ApiContext";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Loader2,
  XCircle,
} from "lucide-react";

type InstallState = "idle" | "installing" | "done" | "error";

interface LogEntry {
  timestamp: number;
  message: string;
}

interface InstallStatus {
  state: InstallState;
  error: string | null;
  logs: LogEntry[];
}

interface Props {
  installHint: string;
}

const POLL_INTERVAL_MS = 1500;

const TrainingExtraGate: React.FC<Props> = ({ installHint }) => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { toast } = useToast();

  const [state, setState] = useState<InstallState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logBoxRef = useRef<HTMLDivElement>(null);

  // Seed local state from the backend on mount so refresh-mid-install picks
  // up where we left off (or shows Done/Error if the install already finished).
  useEffect(() => {
    let cancelled = false;
    fetchWithHeaders(`${baseUrl}/system/training-extra/install-status`)
      .then((r) => r.json())
      .then((status: InstallStatus) => {
        if (cancelled) return;
        setState(status.state);
        setError(status.error);
        if (status.logs.length > 0) {
          setLogs(status.logs);
        }
      })
      .catch(() => {
        // Backend unreachable — stay in idle; the user can still try.
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchWithHeaders]);

  // Poll while installing.
  useEffect(() => {
    if (state !== "installing") return;
    const id = setInterval(async () => {
      try {
        const r = await fetchWithHeaders(`${baseUrl}/system/training-extra/install-status`);
        if (!r.ok) return;
        const status: InstallStatus = await r.json();
        if (status.logs && status.logs.length > 0) {
          setLogs((prev) => [...prev, ...status.logs]);
        }
        if (status.state !== "installing") {
          setState(status.state);
          setError(status.error);
        }
      } catch {
        // Transient errors are fine; we'll retry on next tick.
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [state, baseUrl, fetchWithHeaders]);

  // Auto-scroll the log panel as new lines arrive.
  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs]);

  const handleInstall = async () => {
    // Optimistically transition so the polling effect kicks in even if the
    // backend response is slow.
    setState("installing");
    setError(null);
    setLogs([]);
    try {
      const r = await fetchWithHeaders(`${baseUrl}/system/training-extra/install`, {
        method: "POST",
      });
      const body: { started: boolean; message: string } = await r.json();
      if (!body.started && r.ok) {
        // Backend says "already installing" — that's fine; polling already running.
        return;
      }
      if (!r.ok) {
        setState("error");
        setError(body.message || `Install request failed (${r.status})`);
      }
    } catch (e) {
      setState("error");
      setError(`Install request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleRetry = () => {
    setState("idle");
    setError(null);
    setLogs([]);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(installHint);
      toast({ title: "Copied", description: installHint });
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the command and copy manually.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      <Card className="bg-slate-800/50 border-slate-700 rounded-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-3 text-white">
            {state === "done" ? (
              <CheckCircle2 className="w-6 h-6 text-green-400" />
            ) : state === "error" ? (
              <XCircle className="w-6 h-6 text-red-400" />
            ) : state === "installing" ? (
              <Loader2 className="w-6 h-6 text-sky-400 animate-spin" />
            ) : (
              <AlertTriangle className="w-6 h-6 text-amber-400" />
            )}
            {state === "done"
              ? "Install Complete"
              : state === "error"
              ? "Install Failed"
              : state === "installing"
              ? "Installing…"
              : "Training Extra Not Installed"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {state === "idle" && (
            <>
              <p className="text-slate-300">
                Training requires the <code className="px-1 py-0.5 rounded bg-slate-900 text-sky-300">accelerate</code> package, which isn't installed in this environment. Install it to enable the Training page.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 font-mono">
                  {installHint}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleCopy}
                  className="text-slate-400 hover:text-white"
                  aria-label="Copy install command"
                >
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
              <Button
                onClick={handleInstall}
                className="bg-green-500 hover:bg-green-600 text-white font-semibold"
              >
                Install Now
              </Button>
            </>
          )}

          {state === "installing" && (
            <p className="text-slate-300">
              Installing <code className="px-1 py-0.5 rounded bg-slate-900 text-sky-300">accelerate</code>. This usually takes about 10 seconds.
            </p>
          )}

          {state === "done" && (
            <p className="text-slate-300">
              Install complete. Restart <code className="px-1 py-0.5 rounded bg-slate-900 text-sky-300">lelab</code> (Ctrl+C in the terminal running it, then re-run <code className="px-1 py-0.5 rounded bg-slate-900 text-sky-300">lelab --dev</code> or <code className="px-1 py-0.5 rounded bg-slate-900 text-sky-300">lelab</code>) to enable training.
            </p>
          )}

          {state === "error" && (
            <>
              <p className="text-red-300">{error || "Install failed."}</p>
              <Button
                onClick={handleRetry}
                className="bg-slate-700 hover:bg-slate-600 text-white"
              >
                Try again
              </Button>
            </>
          )}

          {state === "error" && logs.length > 0 && (
            <div
              ref={logBoxRef}
              className="bg-slate-900 rounded-lg p-3 h-48 overflow-y-auto font-mono text-xs border border-slate-700 text-slate-300 whitespace-pre-wrap break-words"
            >
              {logs.map((log, idx) => (
                <div key={idx}>{log.message}</div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default TrainingExtraGate;
```

- [ ] **Step 2: Verify the component compiles**

Run from `/Users/nicolasrabault/Projects/Hackathon/leLab/frontend/`:

```bash
npm run build
```

Expected: build succeeds. The new file is unused at this point (Task 4 wires it in), but it should compile cleanly. Any TS error means a typo or a wrong import path; fix before continuing.

- [ ] **Step 3: Commit**

Stage only the new file (the working tree may have unrelated user modifications):

```bash
git add frontend/src/components/training/TrainingExtraGate.tsx
git commit -m "feat(training): add TrainingExtraGate component"
```

---

### Task 4: Gate `Training.tsx` on the availability flag

**Files:**
- Modify: `frontend/src/pages/Training.tsx`

The page fetches `/system/training-extra` once on mount. Three render modes: loading, available, missing. Gate at the page level so the floating Start button and the tabs disappear when training is unavailable.

- [ ] **Step 1: Add new imports**

Open `frontend/src/pages/Training.tsx`. Find the existing imports near the top of the file. The page already imports `useApi`, `useState`, `useEffect`, `useRef`, etc. Add this import (alphabetically near the other `@/components/training` imports):

```tsx
import TrainingExtraGate from "@/components/training/TrainingExtraGate";
```

- [ ] **Step 2: Add availability state and fetch**

After the existing `const [datasets, setDatasets] = useState<DatasetItem[]>([]);` / `const [datasetsLoading, setDatasetsLoading] = useState(true);` block (or wherever the dataset state lives — find it by searching for `datasetsLoading`), add:

```tsx
  const [trainingExtraAvailable, setTrainingExtraAvailable] = useState<boolean | null>(null);
  const [trainingExtraInstallHint, setTrainingExtraInstallHint] = useState<string>("pip install accelerate");

  useEffect(() => {
    fetchWithHeaders(`${baseUrl}/system/training-extra`)
      .then((r) => r.json())
      .then((data: { available: boolean; install_hint: string }) => {
        setTrainingExtraAvailable(data.available);
        setTrainingExtraInstallHint(data.install_hint);
      })
      .catch(() => {
        // Treat fetch failure as "available" so we don't lock the user out
        // if the new endpoint isn't there yet (e.g. older backend).
        setTrainingExtraAvailable(true);
      });
  }, [baseUrl, fetchWithHeaders]);
```

- [ ] **Step 3: Branch the render based on availability**

Find the existing `return (...)` JSX block at the bottom of the component. It currently looks like:

```tsx
  return (
    <div className="min-h-screen bg-slate-900 text-white p-4">
      <div className="max-w-7xl mx-auto">
        <TrainingHeader trainingStatus={trainingStatus} />
        <TrainingTabs activeTab={activeTab} setActiveTab={setActiveTab} />

        {activeTab === "config" && (
          <ConfigurationTab
            config={trainingConfig}
            updateConfig={updateConfig}
            datasets={datasets}
            datasetsLoading={datasetsLoading}
          />
        )}

        {activeTab === "monitoring" && (
          <MonitoringTab ... />
        )}

        <TrainingControls ... />
      </div>
    </div>
  );
```

Replace the entire `return (...)` with:

```tsx
  return (
    <div className="min-h-screen bg-slate-900 text-white p-4">
      <div className="max-w-7xl mx-auto">
        <TrainingHeader trainingStatus={trainingStatus} />

        {trainingExtraAvailable === null && (
          <div className="flex items-center justify-center py-24 text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin mr-3" />
            Checking training environment…
          </div>
        )}

        {trainingExtraAvailable === false && (
          <TrainingExtraGate installHint={trainingExtraInstallHint} />
        )}

        {trainingExtraAvailable === true && (
          <>
            <TrainingTabs activeTab={activeTab} setActiveTab={setActiveTab} />

            {activeTab === "config" && (
              <ConfigurationTab
                config={trainingConfig}
                updateConfig={updateConfig}
                datasets={datasets}
                datasetsLoading={datasetsLoading}
              />
            )}

            {activeTab === "monitoring" && (
              <MonitoringTab
                trainingStatus={trainingStatus}
                logs={logs}
                logContainerRef={logContainerRef}
                getProgressPercentage={getProgressPercentage}
                formatTime={formatTime}
              />
            )}

            <TrainingControls
              trainingStatus={trainingStatus}
              isStartingTraining={isStartingTraining}
              trainingConfig={trainingConfig}
              handleStartTraining={handleStartTraining}
              handleStopTraining={handleStopTraining}
            />
          </>
        )}
      </div>
    </div>
  );
```

(The MonitoringTab and TrainingControls JSX should keep whatever exact props the existing file passes — copy them from the current `return` rather than retyping. The structural change is the surrounding `{trainingExtraAvailable === ... && (...)}` blocks.)

- [ ] **Step 4: Add the `Loader2` import if it isn't already imported**

Check the existing imports. If `Loader2` from `lucide-react` isn't already imported in this file, add it. Today the file imports it via `TrainingControls`, not directly, so you likely need to add:

```tsx
import { Loader2 } from "lucide-react";
```

near the existing imports.

- [ ] **Step 5: Verify TypeScript compiles**

Run from `/Users/nicolasrabault/Projects/Hackathon/leLab/frontend/`:

```bash
npm run build
```

Expected: build succeeds. If TS complains about `TrainingExtraGate` props or about missing `installHint`, double-check Task 3 created the component with the `Props { installHint: string }` interface.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Training.tsx
git commit -m "feat(training): gate page on training-extra availability"
```

---

### Task 5: Manual end-to-end smoke test

This task makes no code changes — it confirms the new feature works in a running `lelab --dev`.

**Prerequisite:** restart `lelab --dev` so the new backend module loads. Ask the human controller to do this; the implementer cannot.

- [ ] **Step 1: Verify the available branch (accelerate already installed)**

If `accelerate` is in the active venv (check with `.venv/bin/python -c "import accelerate; print(accelerate.__version__)"`), the gate should NOT trigger. Open `http://localhost:8080/training` and confirm:

- The full Training page renders (Run Configuration card, Advanced card, floating Start button).
- No warning card appears.

- [ ] **Step 2: Simulate the missing-extra branch without uninstalling accelerate**

(Uninstalling `accelerate` would break this venv for real training; instead, force the backend to report unavailable temporarily.)

In `app/system.py`, change the `TRAINING_AVAILABLE = ...` line to:

```python
TRAINING_AVAILABLE: bool = False  # FIXME: temporary for smoke test
```

Save the file. Because uvicorn runs with `--reload`, this change should auto-reload. (If it doesn't, restart `lelab --dev` manually.)

- [ ] **Step 3: Confirm the gate appears**

Reload `http://localhost:8080/training`. Expect:

- Header still visible.
- A single warning card titled "Training Extra Not Installed".
- The install command `pip install accelerate` shown in a code box, with a copy button.
- An "Install Now" button.
- No tabs, no floating Start button.

- [ ] **Step 4: Click Install Now**

Click the button. Expect (within ~10 seconds):

- Card title flips to "Installing…" with a spinning icon.
- Card transitions to "Install Complete" with a green checkmark and the "Restart `lelab`…" message.

(Because `accelerate` is already installed, `pip install accelerate` will succeed quickly with "Requirement already satisfied".)

If it fails (state goes to "Install Failed" with red icon), expand the log panel and read what pip said. Common causes: no network, restricted env. Note the failure mode and proceed.

- [ ] **Step 5: Revert the smoke-test change**

In `app/system.py`, restore the original line:

```python
TRAINING_AVAILABLE: bool = importlib.util.find_spec("accelerate") is not None
```

Save. uvicorn should reload. The Training page should now show the full UI on next reload.

- [ ] **Step 6: No commit**

This task makes no permanent code changes. Verify with:

```bash
git status
```

Expected: no new modifications to `app/system.py`. (Other unrelated working-tree changes are fine and should be left alone.)

---

## Out-of-scope reminders

These were explicitly considered and excluded by the spec — do not pull them into this plan:

- Re-checking availability after a successful install in the same process. The cached `TRAINING_AVAILABLE` flag and the "manual restart" message are the contract.
- Other capability gates (cameras, simulators). Single-flag MVP.
- HF Spaces detection. Pip will fail in such environments; the error UI surfaces what pip said.
- Cancelling an in-flight install. The subprocess is short.
