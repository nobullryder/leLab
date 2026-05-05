# Job Checkpoints + On-Robot Inference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface every checkpoint produced by a training job in the UI (tile dropdown + per-job page), and add a Play button that runs the selected checkpoint as a `lerobot-rollout` subprocess driving the SO-101 follower.

**Architecture:** Three phases of backend work feed two pieces of frontend work. Backend: (1) a checkpoint-listing endpoint scanning the local output dir or the Hub repo, (2) a sidecar uploader baked into the cloud job's command so cloud runs also publish intermediate checkpoints, (3) a new "inference mode" module mirroring `app/teleoperating.py` — single global session, mutex with teleop/recording, subprocess running `lerobot.scripts.lerobot_rollout`. Frontend: a shared `CheckpointDropdown`, a new `InferenceModal` cloned from `RecordingModal`, and a replacement for the empty `/inference` running page.

**Tech Stack:** FastAPI, Pydantic, `huggingface_hub`, `lerobot` (CLI subprocesses), React, TypeScript, Radix UI (`@radix-ui/react-select`, `@radix-ui/react-dialog`), Vite. No backend test framework — validation uses curl + manual UI checks. Frontend uses `npm run build` for type-check.

**Spec:** [docs/superpowers/specs/2026-05-05-job-checkpoints-and-inference-design.md](../specs/2026-05-05-job-checkpoints-and-inference-design.md)

---

## File map

**Backend — new:**
- `app/inferring.py` — inference mode module (request model, state, subprocess lifecycle).

**Backend — modified:**
- `app/jobs.py` — `JobCheckpoint` model, `list_checkpoints` method, `checkpoint_count` field on `JobRecord`, cloud TTL cache.
- `app/runners/hf_cloud.py` — `WRAPPER_SOURCE` constant; switch `start()` to invoke it.
- `app/main.py` — 4 new routes (`GET /jobs/{id}/checkpoints`, `POST /start-inference`, `POST /stop-inference`, `GET /inference-status`). Wire `inferring` module imports.
- `app/teleoperating.py` — tighten `handle_start_teleoperation` mutex (also refuse if recording or inference active).
- `app/recording.py` — tighten `handle_start_recording` mutex similarly.

**Frontend — new:**
- `frontend/src/components/jobs/CheckpointDropdown.tsx` — shared dropdown, used in tile + monitoring panel + modal.
- `frontend/src/components/landing/InferenceModal.tsx` — configure-inference dialog.
- `frontend/src/lib/checkpointsApi.ts` — `listJobCheckpoints`.
- `frontend/src/lib/inferenceApi.ts` — `startInference`, `stopInference`, `getInferenceStatus`.

**Frontend — modified:**
- `frontend/src/lib/jobsApi.ts` — add `checkpoint_count: number` to `JobRecord`.
- `frontend/src/components/jobs/JobCard.tsx` — Play button row, hide progress bar when not running.
- `frontend/src/components/jobs/JobsSection.tsx` — hoist `InferenceModal` state.
- `frontend/src/pages/Training.tsx` — "Run inference" panel in `MonitoringMode`.
- `frontend/src/pages/Inference.tsx` — replace placeholder with running page.

---

## Phase 1 — Backend: local checkpoint listing

### Task 1: Add `JobCheckpoint` model and `list_checkpoints` (local case)

**Files:**
- Modify: `app/jobs.py` (around lines 49–69 for the model addition; new method on `JobRegistry` near line 469).

- [ ] **Step 1: Add the `JobCheckpoint` model**

Open `app/jobs.py`. Right after the `JobRecord` class definition (around line 69), add:

```python
class JobCheckpoint(BaseModel):
    """One checkpoint produced by a training job.

    `ref` is opaque to the frontend; the inference handler resolves it back
    to a usable `--policy.path` value (a local dir for both sources, after
    snapshot_download for hub refs)."""
    step: int
    source: Literal["local", "hub"]
    ref: str
```

`Literal` is already imported at line 16; `BaseModel` at line 18. No new imports needed.

- [ ] **Step 2: Add `list_checkpoints` method to `JobRegistry`**

In `app/jobs.py`, in the `JobRegistry` class, add this method after `read_persisted_logs` (around line 593):

```python
    def list_checkpoints(self, job_id: str) -> List[JobCheckpoint]:
        """Return checkpoints saved for this job, ascending by step.

        Local jobs: scan <output_dir>/checkpoints/<step>/pretrained_model/
        for valid checkpoint dirs. The 'last' symlink is ignored — we sort
        by step and the latest is just max(step).
        Cloud jobs: handled in a later task; raises for now.
        """
        with self._lock:
            record = self._records.get(job_id)
        if record is None:
            raise JobNotFoundError(job_id)

        if record.runner == "local":
            return _list_local_checkpoints(record.output_dir)
        # Cloud branch added in Task 6.
        return []
```

- [ ] **Step 3: Add the `_list_local_checkpoints` helper**

In `app/jobs.py`, near the other top-level helpers (around line 412, just above `_generate_job_id`), add:

```python
def _list_local_checkpoints(output_dir: str) -> List[JobCheckpoint]:
    """Scan an output dir for valid checkpoint subdirectories.

    A directory under <output_dir>/checkpoints/ is a valid checkpoint iff
    its name parses to an int and it contains pretrained_model/config.json.
    """
    root = Path(output_dir) / "checkpoints"
    if not root.is_dir():
        return []
    out: List[JobCheckpoint] = []
    for entry in root.iterdir():
        if entry.is_symlink() or not entry.is_dir():
            continue
        try:
            step = int(entry.name)
        except ValueError:
            continue
        config_json = entry / "pretrained_model" / "config.json"
        if not config_json.is_file():
            continue
        out.append(JobCheckpoint(
            step=step,
            source="local",
            ref=str((entry / "pretrained_model").resolve()),
        ))
    out.sort(key=lambda c: c.step)
    return out
```

- [ ] **Step 4: Restart and validate by hand**

Restart `lelab --dev` (or kill+restart). The module reload alone proves the syntax is good. No endpoint exists yet — the next task wires it.

- [ ] **Step 5: Commit**

```bash
git add app/jobs.py
git commit -m "$(cat <<'EOF'
feat(jobs): add JobCheckpoint model and local checkpoint listing

Scans <output_dir>/checkpoints/<step>/pretrained_model/config.json
and returns a sorted list. Cloud branch returns [] for now; wired
in a later task once the sidecar uploader exists.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Add `GET /jobs/{job_id}/checkpoints` route

**Files:**
- Modify: `app/main.py` — add a route just after `GET /jobs/{job_id}/log-file` (around line 517).

- [ ] **Step 1: Add the route**

Open `app/main.py`. After the `get_job_log_file` route (line 503–516), add:

```python
@app.get("/jobs/{job_id}/checkpoints")
def get_job_checkpoints(job_id: str):
    """List the checkpoints saved for this job, ascending by step."""
    try:
        return {"checkpoints": job_registry.list_checkpoints(job_id)}
    except JobNotFoundError:
        raise HTTPException(status_code=404, detail=f"Job {job_id!r} not found")
```

- [ ] **Step 2: Validate with curl**

Restart lelab. Pick a known local job id (or `curl http://localhost:8000/jobs` to find one):

```bash
curl -s http://localhost:8000/jobs/<JOB_ID>/checkpoints | python -m json.tool
```

Expected (for a fresh job with no checkpoints): `{"checkpoints": []}`.
Expected (for a job past its first save_freq): an array with one or more entries shaped like `{"step": 1000, "source": "local", "ref": "/abs/.../checkpoints/000001000/pretrained_model"}`.

- [ ] **Step 3: Commit**

```bash
git add app/main.py
git commit -m "$(cat <<'EOF'
feat(api): GET /jobs/{id}/checkpoints

Returns the local checkpoint list; cloud listing wired up in a later task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Add `checkpoint_count` to `JobRecord`

The Landing page needs to know which tiles can show a Play button without firing N extra requests. Fold a count into the existing `JobRecord` shape, computed lazily during `list()` and `get()`. Cloud TTL cache lands in Task 6.

**Files:**
- Modify: `app/jobs.py`.

- [ ] **Step 1: Add the field to `JobRecord`**

In `app/jobs.py` around line 49, add a field at the end of `JobRecord`:

```python
class JobRecord(BaseModel):
    id: str
    name: str
    state: JobState
    config: TrainingRequest
    output_dir: str
    started_at: float
    ended_at: Optional[float] = None
    exit_code: Optional[int] = None
    error_message: Optional[str] = None
    metrics: TrainingMetrics = TrainingMetrics()
    runner: Literal["local", "hf_cloud"] = "local"
    process_pid: Optional[int] = None
    hf_job_id: Optional[str] = None
    hf_flavor: Optional[str] = None
    hf_repo_id: Optional[str] = None
    hf_job_url: Optional[str] = None
    # Number of checkpoints currently visible (local: filesystem; cloud:
    # Hub repo). Filled in by JobRegistry.list/get; persisted as zero.
    checkpoint_count: int = 0
```

- [ ] **Step 2: Compute it in `list()` and `get()`**

In `JobRegistry.list()` (around line 469) and `JobRegistry.get()` (around line 475), compute `checkpoint_count` before returning. Replace the `list` method:

```python
    def list(self, limit: int = 10) -> List[JobRecord]:
        with self._lock:
            records = list(self._records.values())
        records.sort(key=lambda r: r.started_at, reverse=True)
        records = records[:limit]
        for r in records:
            r.checkpoint_count = self._count_checkpoints(r)
        return records
```

And `get`:

```python
    def get(self, job_id: str) -> JobRecord:
        with self._lock:
            record = self._records.get(job_id)
        if record is None:
            raise JobNotFoundError(job_id)
        record.checkpoint_count = self._count_checkpoints(record)
        return record
```

- [ ] **Step 3: Add the helper**

Add a private method on `JobRegistry`, near `list_checkpoints`:

```python
    def _count_checkpoints(self, record: JobRecord) -> int:
        if record.runner == "local":
            return len(_list_local_checkpoints(record.output_dir))
        # Cloud counted in Task 6 once the cache exists; zero for now.
        return 0
```

- [ ] **Step 4: Validate**

Restart lelab. Hit `GET /jobs` and confirm each record now includes `"checkpoint_count": 0` (or higher for jobs with completed save_freq cycles):

```bash
curl -s http://localhost:8000/jobs | python -m json.tool | grep checkpoint_count
```

- [ ] **Step 5: Commit**

```bash
git add app/jobs.py
git commit -m "$(cat <<'EOF'
feat(jobs): compute checkpoint_count on list/get

So the Landing page can decide whether to render a Play affordance
without firing N extra requests. Cloud branch wired in a later task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Backend: HF Cloud sidecar uploader

### Task 4: Add `WRAPPER_SOURCE` constant in `hf_cloud.py`

The cloud command becomes a Python wrapper that spawns `lerobot.scripts.lerobot_train` and parallel-uploads each new checkpoint folder.

**Files:**
- Modify: `app/runners/hf_cloud.py`.

- [ ] **Step 1: Add the constant**

In `app/runners/hf_cloud.py`, just below `LEROBOT_IMAGE` (around line 24), add:

```python
# Inlined sidecar uploader for HF Jobs. Spawns the lerobot trainer as a
# subprocess and concurrently uploads new <output_dir>/checkpoints/<step>/
# directories to the Hub model repo, so the lelab UI can list them while
# training is in progress.
#
# Sent verbatim as the value of `python -c '...'`. Anything after `--` in
# the command argv is forwarded to the trainer.
WRAPPER_SOURCE = r'''
import os, re, sys, time, threading, subprocess
from pathlib import Path
from huggingface_hub import HfApi

argv = sys.argv[1:]
if "--" not in argv:
    print("[wrapper] missing -- separator", flush=True)
    sys.exit(2)
sep = argv.index("--")
trainer_argv = argv[sep + 1:]


def _arg(name):
    """Return the value of --name=foo or --name foo from trainer_argv."""
    for i, tok in enumerate(trainer_argv):
        if tok == name and i + 1 < len(trainer_argv):
            return trainer_argv[i + 1]
        if tok.startswith(name + "="):
            return tok.split("=", 1)[1]
    return None


output_dir = _arg("--output_dir")
repo_id = _arg("--policy.repo_id")
if not output_dir or not repo_id:
    print(f"[wrapper] need --output_dir and --policy.repo_id; got {output_dir} / {repo_id}", flush=True)
    sys.exit(2)

api = HfApi()
seen = set()
stop_event = threading.Event()


def _scan_and_upload(final=False):
    root = Path(output_dir) / "checkpoints"
    if not root.is_dir():
        return
    # Snapshot before iterating so deletions during the walk do not raise.
    entries = sorted(p for p in root.iterdir() if p.is_dir() and not p.is_symlink())
    for entry in entries:
        if not re.fullmatch(r"\d+", entry.name):
            continue
        config_json = entry / "pretrained_model" / "config.json"
        if not config_json.is_file():
            continue
        if entry.name in seen:
            continue
        # Final pass: re-upload anyway in case earlier upload was partial.
        try:
            api.upload_folder(
                folder_path=str(entry),
                repo_id=repo_id,
                path_in_repo=f"checkpoints/{entry.name}",
                commit_message=f"checkpoint {entry.name}",
            )
            seen.add(entry.name)
            print(f"[wrapper] uploaded checkpoint {entry.name}", flush=True)
        except Exception as exc:
            print(f"[wrapper] upload failed for {entry.name}: {exc}", flush=True)


def _watch():
    while not stop_event.is_set():
        try:
            _scan_and_upload()
        except Exception as exc:
            print(f"[wrapper] scan error: {exc}", flush=True)
        stop_event.wait(15)


watch_thread = threading.Thread(target=_watch, name="ckpt-watcher", daemon=True)
watch_thread.start()

cmd = ["python", "-m", "lerobot.scripts.lerobot_train", *trainer_argv]
print(f"[wrapper] launching trainer: {' '.join(cmd)}", flush=True)
proc = subprocess.Popen(cmd, env=os.environ.copy())
try:
    rc = proc.wait()
finally:
    stop_event.set()
    # One final pass picks up any checkpoint saved in the last 15s window.
    try:
        _scan_and_upload(final=True)
    except Exception as exc:
        print(f"[wrapper] final scan error: {exc}", flush=True)

print(f"[wrapper] trainer exited with rc={rc}", flush=True)
sys.exit(rc)
'''
```

The `r'''...'''` prevents Python from interpreting `\d` inside the regex literal.

- [ ] **Step 2: Validate it parses**

```bash
python -c "from app.runners.hf_cloud import WRAPPER_SOURCE; compile(WRAPPER_SOURCE, '<wrapper>', 'exec')"
```

Expected: no output (success). A `SyntaxError` here means the constant has a bad triple-quote escape.

- [ ] **Step 3: Commit**

```bash
git add app/runners/hf_cloud.py
git commit -m "$(cat <<'EOF'
feat(runners): add cloud-side checkpoint uploader source

A Python wrapper that runs lerobot.scripts.lerobot_train as a subprocess
while a watcher thread uploads each new <output_dir>/checkpoints/<step>/
to the model repo at path_in_repo=checkpoints/<step>. Sent verbatim as
'python -c ...' to the HF Jobs container.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Switch `HfCloudJobRunner.start()` to the wrapper

**Files:**
- Modify: `app/runners/hf_cloud.py` (the `start` method, around lines 49–93).

- [ ] **Step 1: Build the wrapper command**

In `app/runners/hf_cloud.py`, in `HfCloudJobRunner.start`, replace the block that builds `argv` and calls `run_job`. The current code (around lines 71–86) is:

```python
        argv = build_training_command(config, output_dir)
        logger.info("Submitting HF Cloud job %s on %s: %s",
                    job_id, self._flavor, " ".join(argv))

        # Open the persistent log sink — same shape as LocalJobRunner.
        self._log_file_path.parent.mkdir(parents=True, exist_ok=True)
        self._log_file = self._log_file_path.open("a", buffering=1)

        # HF_TOKEN goes via `secrets` (not `env`) so it doesn't show up in
        # the job's environment variable inspection / logs.
        job = self._api.run_job(
            image=LEROBOT_IMAGE,
            command=argv,
            flavor=self._flavor,
            secrets={"HF_TOKEN": token},
        )
```

Replace with:

```python
        trainer_argv = build_training_command(config, output_dir)
        # The wrapper expects `python -c WRAPPER_SOURCE -- <trainer argv>`.
        # `python -c` consumes the first non-option argument as the script,
        # so we prepend a "--" sentinel of our own.
        wrapped_command = ["python", "-c", WRAPPER_SOURCE, "--", *trainer_argv]
        logger.info(
            "Submitting HF Cloud job %s on %s (wrapped trainer): %s",
            job_id, self._flavor, " ".join(trainer_argv),
        )

        self._log_file_path.parent.mkdir(parents=True, exist_ok=True)
        self._log_file = self._log_file_path.open("a", buffering=1)

        job = self._api.run_job(
            image=LEROBOT_IMAGE,
            command=wrapped_command,
            flavor=self._flavor,
            secrets={"HF_TOKEN": token},
        )
```

- [ ] **Step 2: Restart lelab**

The change is type-safe (Python list of strings) — `lelab --dev` reload picks it up. Don't actually launch a cloud job yet; we validate via the end-to-end test in Task 18.

- [ ] **Step 3: Commit**

```bash
git add app/runners/hf_cloud.py
git commit -m "$(cat <<'EOF'
feat(runners): use sidecar uploader as cloud job command

Cloud trainings now run under the inlined Python wrapper, which spawns
lerobot.scripts.lerobot_train and concurrently uploads each new
checkpoint subdir to the model repo so the lelab UI can list them
while the run is in progress.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Add cloud branch to `list_checkpoints` (+ TTL cache)

**Files:**
- Modify: `app/jobs.py`.

- [ ] **Step 1: Add a per-job TTL cache for cloud listings**

In `app/jobs.py`, in `JobRegistry.__init__` (around line 452), add a cache after the existing fields:

```python
        # repo_id -> (expires_at_epoch, checkpoint list)
        self._cloud_ckpt_cache: Dict[str, tuple[float, List[JobCheckpoint]]] = {}
```

`Dict` is already imported. Add `Tuple` to the typing import at the top if your linter wants `Tuple[float, List[JobCheckpoint]]` instead — Python 3.10+ accepts the lowercase form, which matches what the rest of this file already uses.

- [ ] **Step 2: Add the cloud helper**

Near `_list_local_checkpoints` (top-level), add:

```python
_CLOUD_CKPT_TTL_SECONDS = 30.0
_CKPT_PATH_RE = re.compile(r"^checkpoints/(\d+)/pretrained_model/config\.json$")


def _list_hub_checkpoints(api, repo_id: str) -> List[JobCheckpoint]:
    """List checkpoints by introspecting the model repo file tree."""
    try:
        files = api.list_repo_files(repo_id, repo_type="model")
    except Exception:
        # Repo may not exist yet (training just started, sidecar hasn't
        # uploaded anything). Treat as no checkpoints.
        return []
    seen: Dict[int, JobCheckpoint] = {}
    for path in files:
        m = _CKPT_PATH_RE.match(path)
        if not m:
            continue
        step = int(m.group(1))
        seen[step] = JobCheckpoint(
            step=step,
            source="hub",
            ref=f"{repo_id}@checkpoints/{step}",
        )
    out = list(seen.values())
    out.sort(key=lambda c: c.step)
    return out
```

`re` is already imported at line 9. `HfApi` instances are passed in to keep this helper testable.

- [ ] **Step 3: Wire the cloud branch + cache into `list_checkpoints`**

Replace the body of `JobRegistry.list_checkpoints` with:

```python
    def list_checkpoints(self, job_id: str) -> List[JobCheckpoint]:
        with self._lock:
            record = self._records.get(job_id)
        if record is None:
            raise JobNotFoundError(job_id)
        if record.runner == "local":
            return _list_local_checkpoints(record.output_dir)
        return self._list_cloud_cached(record.hf_repo_id)
```

And add the cache-aware helper:

```python
    def _list_cloud_cached(self, repo_id: Optional[str]) -> List[JobCheckpoint]:
        if not repo_id:
            return []
        from huggingface_hub import HfApi  # lazy: keeps unit-test imports cheap
        now = time.time()
        cached = self._cloud_ckpt_cache.get(repo_id)
        if cached is not None and cached[0] > now:
            return cached[1]
        result = _list_hub_checkpoints(HfApi(), repo_id)
        self._cloud_ckpt_cache[repo_id] = (now + _CLOUD_CKPT_TTL_SECONDS, result)
        return result
```

- [ ] **Step 4: Wire the cloud branch into `_count_checkpoints`**

Replace `_count_checkpoints` with:

```python
    def _count_checkpoints(self, record: JobRecord) -> int:
        if record.runner == "local":
            return len(_list_local_checkpoints(record.output_dir))
        return len(self._list_cloud_cached(record.hf_repo_id))
```

- [ ] **Step 5: Validate**

Restart lelab. The endpoint should still work for local jobs:

```bash
curl -s http://localhost:8000/jobs/<LOCAL_JOB_ID>/checkpoints | python -m json.tool
```

If you have a finished cloud job tracked by the registry, hit it too. Empty list is acceptable when the repo hasn't been pushed to.

- [ ] **Step 6: Commit**

```bash
git add app/jobs.py
git commit -m "$(cat <<'EOF'
feat(jobs): list cloud-job checkpoints from the Hub repo

Adds a 30s TTL cache per repo so /jobs (which now reads
checkpoint_count for every record) doesn't hit list_repo_files on
every poll.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Backend: inference mode

### Task 7: Create `app/inferring.py`

**Files:**
- Create: `app/inferring.py`.

- [ ] **Step 1: Write the module**

Create `app/inferring.py`:

```python
"""Inference mode: drives the SO-101 follower with a trained policy.

Mirrors `app/teleoperating.py` in shape — single global session, mutex
with teleoperation/recording (the follower's serial bus can only be
opened once), `lerobot.scripts.lerobot_rollout` running as a subprocess
for clean cancellation. Hub-checkpoint refs are resolved to a local dir
via huggingface_hub.snapshot_download before we spawn the subprocess.
"""

from __future__ import annotations

import logging
import os
import re
import signal
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, Optional

from pydantic import BaseModel

from .config import setup_calibration_files

logger = logging.getLogger(__name__)


class InferenceRequest(BaseModel):
    follower_port: str
    follower_config: str
    policy_ref: str          # opaque ref returned by /jobs/{id}/checkpoints
    task: str = ""
    cameras: Dict[str, Dict[str, Any]] = {}
    duration_s: int = 60


inference_active: bool = False
_inference_proc: Optional[subprocess.Popen] = None
_inference_started_at: Optional[float] = None
_inference_meta: Dict[str, Any] = {}
_HUB_REF_RE = re.compile(r"^(?P<repo>[^@]+)@checkpoints/(?P<step>\d+)$")


def _detect_device() -> str:
    """cuda → mps → cpu, picked once at start time."""
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def _resolve_policy_path(policy_ref: str) -> str:
    """Turn a checkpoints API ref into a local path that lerobot accepts.

    Local refs are already absolute paths to a pretrained_model dir.
    Hub refs look like 'user/repo@checkpoints/<step>' and need a
    snapshot_download of just that subdir.
    """
    if Path(policy_ref).is_dir():
        return policy_ref
    m = _HUB_REF_RE.match(policy_ref)
    if not m:
        raise ValueError(f"Unrecognised policy ref: {policy_ref!r}")
    from huggingface_hub import snapshot_download
    repo_id, step = m.group("repo"), m.group("step")
    local_root = snapshot_download(
        repo_id=repo_id,
        repo_type="model",
        allow_patterns=[f"checkpoints/{step}/pretrained_model/*"],
    )
    return str(Path(local_root) / "checkpoints" / step / "pretrained_model")


def _format_cameras_arg(cameras: Dict[str, Dict[str, Any]]) -> str:
    """Convert {name: {type, camera_index, width, height, fps}} into
    lerobot's CLI dict syntax."""
    parts = []
    for name, cfg in cameras.items():
        body = ", ".join(f"{k}: {v}" for k, v in cfg.items() if v is not None)
        parts.append(f"{name}: {{{body}}}")
    return "{" + ", ".join(parts) + "}"


def handle_start_inference(request: InferenceRequest) -> Dict[str, Any]:
    """Start a one-shot rollout subprocess. Returns a dict — the route
    layer turns it into a JSON response or HTTPException as appropriate."""
    global inference_active, _inference_proc, _inference_started_at, _inference_meta

    # Mutex with teleop and recording: all three drive the same serial bus.
    from .teleoperating import teleoperation_active
    from .recording import recording_active

    if teleoperation_active:
        return {"success": False, "status_code": 409,
                "message": "Teleoperation is currently active. Stop it first."}
    if recording_active:
        return {"success": False, "status_code": 409,
                "message": "Recording is currently active. Stop it first."}
    if inference_active:
        return {"success": False, "status_code": 409,
                "message": "Inference is already active. Stop it first."}

    try:
        # Recording has a single-arg setup but follower-only is fine — we
        # pass the same name twice; setup_calibration_files keys on
        # follower_config for the follower side, which is all we need.
        setup_calibration_files(request.follower_config, request.follower_config)
        policy_path = _resolve_policy_path(request.policy_ref)

        cmd = [
            "python", "-m", "lerobot.scripts.lerobot_rollout",
            "--strategy.type=base",
            f"--policy.path={policy_path}",
            f"--policy.device={_detect_device()}",
            "--robot.type=so101_follower",
            f"--robot.port={request.follower_port}",
            f"--robot.id={request.follower_config}",
            f"--task={request.task}",
            f"--duration={request.duration_s}",
        ]
        if request.cameras:
            cmd.append(f"--robot.cameras={_format_cameras_arg(request.cameras)}")

        log_dir = Path.home() / ".cache" / "huggingface" / "lerobot" / "inference_logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / f"{int(time.time())}.log"
        log_handle = log_path.open("w", buffering=1)

        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        proc = subprocess.Popen(
            cmd,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            env=env,
        )
    except Exception as exc:
        logger.exception("Failed to start inference")
        return {"success": False, "status_code": 500,
                "message": f"Failed to start inference: {exc}"}

    inference_active = True
    _inference_proc = proc
    _inference_started_at = time.time()
    _inference_meta = {
        "policy_ref": request.policy_ref,
        "duration_s": request.duration_s,
        "log_path": str(log_path),
    }
    logger.info("Inference started: pid=%s policy=%s", proc.pid, policy_path)
    return {"success": True, "message": "Inference started", "log_path": str(log_path)}


def handle_stop_inference() -> Dict[str, Any]:
    global inference_active, _inference_proc, _inference_started_at, _inference_meta
    if not inference_active or _inference_proc is None:
        return {"success": False, "status_code": 409, "message": "No inference is active"}
    proc = _inference_proc
    try:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            logger.warning("Inference did not exit in 5s; killing")
            proc.kill()
            proc.wait()
    except Exception as exc:
        logger.exception("Stop inference: %s", exc)
    inference_active = False
    _inference_proc = None
    _inference_started_at = None
    _inference_meta = {}
    return {"success": True, "message": "Inference stopped"}


def handle_inference_status() -> Dict[str, Any]:
    global inference_active, _inference_proc, _inference_started_at, _inference_meta
    # If the subprocess died on its own, finalize state lazily.
    if _inference_proc is not None and _inference_proc.poll() is not None:
        rc = _inference_proc.returncode
        logger.info("Inference subprocess exited rc=%s", rc)
        inference_active = False
        _inference_proc = None
        finished_meta = _inference_meta
        finished_started = _inference_started_at
        _inference_started_at = None
        _inference_meta = {}
        return {
            "inference_active": False,
            "exited": True,
            "exit_code": rc,
            "policy_ref": finished_meta.get("policy_ref"),
            "duration_s": finished_meta.get("duration_s"),
            "log_path": finished_meta.get("log_path"),
            "started_at": finished_started,
        }
    elapsed = (time.time() - _inference_started_at) if _inference_started_at else 0
    return {
        "inference_active": inference_active,
        "started_at": _inference_started_at,
        "elapsed_s": elapsed,
        "duration_s": _inference_meta.get("duration_s"),
        "policy_ref": _inference_meta.get("policy_ref"),
        "log_path": _inference_meta.get("log_path"),
    }
```

- [ ] **Step 2: Validate it imports**

```bash
python -c "from app.inferring import handle_start_inference, handle_stop_inference, handle_inference_status, InferenceRequest"
```

Expected: no output. Any error here means a syntax or import problem to fix before continuing.

- [ ] **Step 3: Commit**

```bash
git add app/inferring.py
git commit -m "$(cat <<'EOF'
feat(inferring): add inference mode module

Single global session running lerobot.scripts.lerobot_rollout as a
subprocess with mutex against teleop and recording. Hub policy refs are
resolved via snapshot_download before spawn. Routes wired in a later
task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Tighten teleop and recording mutexes

The two existing modules check only their own `_active` flag. They should also refuse if either of the other two modes is busy, since all three drive the same serial bus.

**Files:**
- Modify: `app/teleoperating.py` (around line 113–114).
- Modify: `app/recording.py` — find the equivalent guard at the start of `handle_start_recording`.

- [ ] **Step 1: Update teleoperating.py**

Open `app/teleoperating.py`. Replace lines 109–114 (the start-of-handler block):

```python
def handle_start_teleoperation(request: TeleoperateRequest, websocket_manager=None) -> Dict[str, Any]:
    """Handle start teleoperation request"""
    global teleoperation_active, teleoperation_thread, current_robot, current_teleop

    if teleoperation_active:
        return {"success": False, "message": "Teleoperation is already active"}
```

with:

```python
def handle_start_teleoperation(request: TeleoperateRequest, websocket_manager=None) -> Dict[str, Any]:
    """Handle start teleoperation request"""
    global teleoperation_active, teleoperation_thread, current_robot, current_teleop

    if teleoperation_active:
        return {"success": False, "message": "Teleoperation is already active"}
    from .recording import recording_active
    from .inferring import inference_active
    if recording_active:
        return {"success": False, "message": "Recording is currently active. Stop it first."}
    if inference_active:
        return {"success": False, "message": "Inference is currently active. Stop it first."}
```

- [ ] **Step 2: Update recording.py**

Open `app/recording.py`. Find the equivalent guard inside `handle_start_recording` (search for `recording_active` near a `return {"success": False`). Add the same two cross-checks immediately after the existing guard. The pattern should look like:

```python
    if recording_active:
        return {"success": False, "message": "Recording is already active"}
    from .teleoperating import teleoperation_active
    from .inferring import inference_active
    if teleoperation_active:
        return {"success": False, "message": "Teleoperation is currently active. Stop it first."}
    if inference_active:
        return {"success": False, "message": "Inference is currently active. Stop it first."}
```

If the existing message text differs from "Recording is already active", keep the existing line and only add the two new guards after it.

- [ ] **Step 3: Restart lelab**

The reload should succeed; cycle teleop on/off via the existing UI to confirm nothing regressed.

- [ ] **Step 4: Commit**

```bash
git add app/teleoperating.py app/recording.py
git commit -m "$(cat <<'EOF'
feat(mutex): refuse if any of teleop/recording/inference is active

All three drive the SO-101 follower's serial bus, which can only be
opened once. Each handler now refuses if either of the other two is busy.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Wire `/start-inference`, `/stop-inference`, `/inference-status` routes

**Files:**
- Modify: `app/main.py`.

- [ ] **Step 1: Import the new handlers**

In `app/main.py`, just below the `from .teleoperating import (...)` block (around line 38), add:

```python
from .inferring import (
    InferenceRequest,
    handle_start_inference,
    handle_stop_inference,
    handle_inference_status,
)
```

- [ ] **Step 2: Add the three routes**

Pick a logical home in `main.py` — e.g. just after the teleoperation routes (search for `/stop-teleoperation`). Add:

```python
@app.post("/start-inference")
def start_inference(request: InferenceRequest):
    result = handle_start_inference(request)
    if not result.get("success"):
        raise HTTPException(
            status_code=result.get("status_code", 500),
            detail=result.get("message", "Failed to start inference"),
        )
    return result


@app.post("/stop-inference")
def stop_inference():
    result = handle_stop_inference()
    if not result.get("success"):
        raise HTTPException(
            status_code=result.get("status_code", 500),
            detail=result.get("message", "Failed to stop inference"),
        )
    return result


@app.get("/inference-status")
def inference_status():
    return handle_inference_status()
```

- [ ] **Step 3: Validate with curl**

Restart lelab. With no inference running:

```bash
curl -s http://localhost:8000/inference-status | python -m json.tool
```

Expected: `{"inference_active": false, "started_at": null, "elapsed_s": 0, ...}`.

Try a stop with nothing running:

```bash
curl -s -X POST http://localhost:8000/stop-inference -w "\n%{http_code}\n"
```

Expected: HTTP 409 with `{"detail": "No inference is active"}`.

- [ ] **Step 4: Commit**

```bash
git add app/main.py
git commit -m "$(cat <<'EOF'
feat(api): inference start/stop/status endpoints

Wires the inferring module's handlers as POST /start-inference,
POST /stop-inference, GET /inference-status.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Frontend: API + types

### Task 10: Add `checkpoint_count` to `JobRecord`, create `checkpointsApi.ts` and `inferenceApi.ts`

**Files:**
- Modify: `frontend/src/lib/jobsApi.ts` (around the `JobRecord` interface, line 47).
- Create: `frontend/src/lib/checkpointsApi.ts`.
- Create: `frontend/src/lib/inferenceApi.ts`.

- [ ] **Step 1: Update `JobRecord`**

In `frontend/src/lib/jobsApi.ts`, modify the `JobRecord` interface to include the new field:

```ts
export interface JobRecord {
  id: string;
  name: string;
  state: JobState;
  config: TrainingRequest;
  output_dir: string;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  error_message: string | null;
  metrics: TrainingMetrics;
  runner: "local" | "hf_cloud";
  hf_job_id: string | null;
  hf_flavor: string | null;
  hf_repo_id: string | null;
  hf_job_url: string | null;
  checkpoint_count: number;
}
```

- [ ] **Step 2: Create `checkpointsApi.ts`**

Create `frontend/src/lib/checkpointsApi.ts`:

```ts
type Fetcher = (url: string, options?: RequestInit) => Promise<Response>;

export interface JobCheckpoint {
  step: number;
  source: "local" | "hub";
  ref: string;
}

export async function listJobCheckpoints(
  baseUrl: string,
  fetcher: Fetcher,
  jobId: string,
): Promise<JobCheckpoint[]> {
  const r = await fetcher(`${baseUrl}/jobs/${jobId}/checkpoints`);
  if (!r.ok) {
    throw new Error(`List checkpoints failed: ${r.status}`);
  }
  const body = await r.json();
  return body.checkpoints;
}
```

- [ ] **Step 3: Create `inferenceApi.ts`**

Create `frontend/src/lib/inferenceApi.ts`:

```ts
type Fetcher = (url: string, options?: RequestInit) => Promise<Response>;

export interface StartInferenceRequest {
  follower_port: string;
  follower_config: string;
  policy_ref: string;
  task: string;
  cameras: Record<string, {
    type: string;
    camera_index?: number;
    width: number;
    height: number;
    fps?: number;
  }>;
  duration_s: number;
}

export interface InferenceStatus {
  inference_active: boolean;
  started_at: number | null;
  elapsed_s: number;
  duration_s: number | null;
  policy_ref: string | null;
  log_path: string | null;
  exited?: boolean;
  exit_code?: number | null;
}

async function expectOk(r: Response, action: string): Promise<Response> {
  if (!r.ok) {
    let detail = `${r.status}`;
    try {
      const body = await r.json();
      detail = body.detail || detail;
    } catch {
      // ignore
    }
    throw new Error(`${action} failed: ${detail}`);
  }
  return r;
}

export async function startInference(
  baseUrl: string,
  fetcher: Fetcher,
  request: StartInferenceRequest,
): Promise<{ message: string; log_path: string }> {
  const r = await fetcher(`${baseUrl}/start-inference`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  await expectOk(r, "Start inference");
  return r.json();
}

export async function stopInference(
  baseUrl: string,
  fetcher: Fetcher,
): Promise<{ message: string }> {
  const r = await fetcher(`${baseUrl}/stop-inference`, { method: "POST" });
  await expectOk(r, "Stop inference");
  return r.json();
}

export async function getInferenceStatus(
  baseUrl: string,
  fetcher: Fetcher,
): Promise<InferenceStatus> {
  const r = await fetcher(`${baseUrl}/inference-status`);
  await expectOk(r, "Get inference status");
  return r.json();
}
```

- [ ] **Step 4: Type-check the frontend**

```bash
cd frontend && npm run build 2>&1 | tail -30
```

Expected: build succeeds. If TypeScript complains about a missing field in `JobRecord` consumers, those are real call sites — they'll be updated in subsequent tasks.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/jobsApi.ts frontend/src/lib/checkpointsApi.ts frontend/src/lib/inferenceApi.ts
git commit -m "$(cat <<'EOF'
feat(frontend): JobRecord.checkpoint_count + checkpoints/inference API clients

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 — Frontend: UI components

### Task 11: Create `CheckpointDropdown` component

A compact Radix Select wrapper used in the tile, the monitoring panel, and inside the modal.

**Files:**
- Create: `frontend/src/components/jobs/CheckpointDropdown.tsx`.

- [ ] **Step 1: Write the component**

Create `frontend/src/components/jobs/CheckpointDropdown.tsx`:

```tsx
import React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { JobCheckpoint } from "@/lib/checkpointsApi";

interface Props {
  checkpoints: JobCheckpoint[];
  selectedStep: number | null;
  onChange: (step: number) => void;
  disabled?: boolean;
  placeholder?: string;
}

export const CheckpointDropdown: React.FC<Props> = ({
  checkpoints,
  selectedStep,
  onChange,
  disabled,
  placeholder = "Select checkpoint",
}) => {
  const value = selectedStep != null ? String(selectedStep) : undefined;
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(Number(v))}
      disabled={disabled || checkpoints.length === 0}
    >
      <SelectTrigger
        className="bg-slate-800 border-slate-700 text-white h-8 text-xs px-2 w-auto min-w-[110px]"
        onClick={(e) => e.stopPropagation()}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="bg-slate-900 border-slate-700 text-white">
        {checkpoints.map((c) => (
          <SelectItem
            key={c.step}
            value={String(c.step)}
            onClick={(e) => e.stopPropagation()}
          >
            step {c.step}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

export default CheckpointDropdown;
```

`onClick={e => e.stopPropagation()}` is critical: when this dropdown lives inside a `JobCard` (which has its own click-to-navigate handler), every interaction must NOT bubble.

- [ ] **Step 2: Type-check**

```bash
cd frontend && npm run build 2>&1 | tail -10
```

Expected: success.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/jobs/CheckpointDropdown.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): CheckpointDropdown shared component

Compact Radix Select wrapper. Shared between the JobCard tile, the
MonitoringMode panel, and the InferenceModal. stopPropagation on the
trigger and items so it can sit inside the click-to-navigate JobCard.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Create `InferenceModal` component

**Files:**
- Create: `frontend/src/components/landing/InferenceModal.tsx`.

- [ ] **Step 1: Write the component**

Create `frontend/src/components/landing/InferenceModal.tsx`:

```tsx
import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, CheckCircle, Play } from "lucide-react";
import CameraConfiguration, {
  CameraConfig,
} from "@/components/recording/CameraConfiguration";
import { RobotRecord } from "@/hooks/useRobots";
import { useApi } from "@/contexts/ApiContext";
import { useToast } from "@/hooks/use-toast";
import { useNavigate } from "react-router-dom";
import {
  JobCheckpoint,
  listJobCheckpoints,
} from "@/lib/checkpointsApi";
import { startInference } from "@/lib/inferenceApi";
import CheckpointDropdown from "@/components/jobs/CheckpointDropdown";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  robot: RobotRecord | null;
  jobId: string;
  initialStep: number | null;
}

const InferenceModal: React.FC<Props> = ({
  open,
  onOpenChange,
  robot,
  jobId,
  initialStep,
}) => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [checkpoints, setCheckpoints] = useState<JobCheckpoint[]>([]);
  const [selectedStep, setSelectedStep] = useState<number | null>(initialStep);
  const [task, setTask] = useState("");
  const [durationS, setDurationS] = useState(60);
  const [cameras, setCameras] = useState<CameraConfig[]>(
    robot ? [...(robot.cameras ?? [])] : [],
  );
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    listJobCheckpoints(baseUrl, fetchWithHeaders, jobId)
      .then((cks) => {
        setCheckpoints(cks);
        if (cks.length > 0) {
          // Latest preselected if the caller didn't pin one.
          const latest = cks[cks.length - 1].step;
          setSelectedStep((prev) => (prev != null ? prev : latest));
        }
      })
      .catch(() => setCheckpoints([]));
  }, [open, baseUrl, fetchWithHeaders, jobId]);

  useEffect(() => {
    if (open && robot) setCameras([...(robot.cameras ?? [])]);
  }, [open, robot]);

  const selectedRef =
    selectedStep != null
      ? checkpoints.find((c) => c.step === selectedStep)?.ref ?? null
      : null;

  const canStart =
    !!robot &&
    robot.is_clean &&
    selectedRef != null &&
    !submitting;

  const handleStart = async () => {
    if (!robot || selectedRef == null) return;
    setSubmitting(true);
    const cameraDict = cameras.reduce(
      (acc, cam) => {
        acc[cam.name] = {
          type: cam.type,
          camera_index: cam.camera_index,
          width: cam.width,
          height: cam.height,
          fps: cam.fps,
        };
        return acc;
      },
      {} as Record<string, {
        type: string; camera_index?: number; width: number; height: number; fps?: number;
      }>,
    );
    try {
      await startInference(baseUrl, fetchWithHeaders, {
        follower_port: robot.follower_port,
        follower_config: robot.follower_config,
        policy_ref: selectedRef,
        task,
        cameras: cameraDict,
        duration_s: durationS,
      });
      onOpenChange(false);
      navigate("/inference");
    } catch (e) {
      toast({
        title: "Couldn't start inference",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-gray-900 border-gray-800 text-white sm:max-w-[600px] p-8 max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex justify-center items-center mb-4">
            <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center">
              <Play className="w-4 h-4 text-white" />
            </div>
          </div>
          <DialogTitle className="text-white text-center text-2xl font-bold">
            Configure Inference
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <DialogDescription className="text-gray-400 text-base leading-relaxed text-center">
            Pick a checkpoint and confirm hardware. The selected policy will
            drive the follower autonomously for the configured duration.
          </DialogDescription>

          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-white border-b border-gray-700 pb-2">
              Robot Configuration
            </h3>
            {!robot ? (
              <Alert className="bg-amber-900/40 border-amber-700 text-amber-100">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  Select and configure a robot on the Landing page first.
                </AlertDescription>
              </Alert>
            ) : !robot.is_clean ? (
              <Alert className="bg-amber-900/40 border-amber-700 text-amber-100">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  <strong>{robot.name}</strong> is missing a calibration.
                  Configure it before running inference.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle className="w-4 h-4 text-green-400" />
                <span className="text-slate-200">
                  Running on <strong>{robot.name}</strong>
                </span>
              </div>
            )}
          </div>

          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-white border-b border-gray-700 pb-2">
              Checkpoint
            </h3>
            {checkpoints.length === 0 ? (
              <Alert className="bg-amber-900/40 border-amber-700 text-amber-100">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  No checkpoints available for this job yet.
                </AlertDescription>
              </Alert>
            ) : (
              <CheckpointDropdown
                checkpoints={checkpoints}
                selectedStep={selectedStep}
                onChange={setSelectedStep}
              />
            )}
          </div>

          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-white border-b border-gray-700 pb-2">
              Run parameters
            </h3>
            <div className="space-y-2">
              <Label htmlFor="task" className="text-sm font-medium text-gray-300">
                Task description
              </Label>
              <Input
                id="task"
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder="e.g., pick up the red block"
                className="bg-gray-800 border-gray-700 text-white"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="durationS" className="text-sm font-medium text-gray-300">
                Max duration (seconds)
              </Label>
              <Input
                id="durationS"
                type="number"
                min={1}
                value={durationS}
                onChange={(e) => setDurationS(parseInt(e.target.value || "0"))}
                className="bg-gray-800 border-gray-700 text-white"
              />
            </div>
          </div>

          <CameraConfiguration cameras={cameras} onCamerasChange={setCameras} />

          <div className="flex flex-col sm:flex-row gap-4 justify-center pt-4">
            <Button
              onClick={handleStart}
              disabled={!canStart}
              className="w-full sm:w-auto bg-green-500 hover:bg-green-600 text-white px-10 py-6 text-lg disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Play className="w-5 h-5 mr-2" />
              {submitting ? "Starting…" : "Start Inference"}
            </Button>
            <Button
              onClick={() => onOpenChange(false)}
              variant="outline"
              className="w-full sm:w-auto border-gray-500 hover:border-gray-200 px-10 py-6 text-lg text-zinc-500 bg-zinc-900 hover:bg-zinc-800"
            >
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default InferenceModal;
```

- [ ] **Step 2: Type-check**

```bash
cd frontend && npm run build 2>&1 | tail -10
```

Expected: success.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/landing/InferenceModal.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): InferenceModal — Configure Inference dialog

Mirrors RecordingModal in shape and styling. Loads checkpoints for the
job, defaults to the latest, accepts task description, max duration,
and a CameraConfiguration. POSTs /start-inference and navigates to
/inference on success.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Update `JobCard` — Play row + hide progress bar when not running

**Files:**
- Modify: `frontend/src/components/jobs/JobCard.tsx`.

- [ ] **Step 1: Add Play affordance + checkpoint dropdown**

Replace the entire contents of `frontend/src/components/jobs/JobCard.tsx`:

```tsx
import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { JobRecord } from "@/lib/jobsApi";
import {
  Square,
  X,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  XCircle,
  ExternalLink,
  Play,
} from "lucide-react";
import { useApi } from "@/contexts/ApiContext";
import {
  JobCheckpoint,
  listJobCheckpoints,
} from "@/lib/checkpointsApi";
import CheckpointDropdown from "@/components/jobs/CheckpointDropdown";

interface Props {
  job: JobRecord;
  onStop: (id: string) => void;
  onDelete: (id: string) => void;
  onPlay: (job: JobRecord, step: number) => void;
}

function relativeTime(epochSec: number): string {
  const diff = Math.max(0, Date.now() / 1000 - epochSec);
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const statePresentation: Record<
  JobRecord["state"],
  { label: string; color: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  running: { label: "Running", color: "text-green-400", Icon: Loader2 },
  done: { label: "Done", color: "text-slate-400", Icon: CheckCircle2 },
  failed: { label: "Failed", color: "text-red-400", Icon: XCircle },
  interrupted: { label: "Interrupted", color: "text-amber-400", Icon: AlertTriangle },
};

const JobCard: React.FC<Props> = ({ job, onStop, onDelete, onPlay }) => {
  const navigate = useNavigate();
  const { baseUrl, fetchWithHeaders } = useApi();
  const present = statePresentation[job.state];
  const Icon = present.Icon;
  const isRunning = job.state === "running";
  const isStarting = isRunning && job.metrics.total_steps === 0;
  const progressPct =
    job.metrics.total_steps > 0
      ? Math.min(100, (job.metrics.current_step / job.metrics.total_steps) * 100)
      : 0;

  const subtitle = isStarting
    ? "starting…"
    : isRunning
    ? `started ${relativeTime(job.started_at)}`
    : job.ended_at != null
    ? `ended ${relativeTime(job.ended_at)}`
    : present.label.toLowerCase();

  const [checkpoints, setCheckpoints] = useState<JobCheckpoint[]>([]);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);

  useEffect(() => {
    if (job.checkpoint_count <= 0) {
      setCheckpoints([]);
      setSelectedStep(null);
      return;
    }
    let cancelled = false;
    listJobCheckpoints(baseUrl, fetchWithHeaders, job.id)
      .then((cks) => {
        if (cancelled) return;
        setCheckpoints(cks);
        if (cks.length > 0) {
          const latest = cks[cks.length - 1].step;
          setSelectedStep((prev) =>
            prev != null && cks.some((c) => c.step === prev) ? prev : latest,
          );
        } else {
          setSelectedStep(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCheckpoints([]);
          setSelectedStep(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchWithHeaders, job.id, job.checkpoint_count]);

  const handleAction = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRunning) {
      if (window.confirm("Stop this run?")) onStop(job.id);
    } else {
      if (window.confirm("Delete this run? This wipes the output directory.")) onDelete(job.id);
    }
  };

  const handlePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (selectedStep == null) return;
    onPlay(job, selectedStep);
  };

  const showProgressBar = isRunning;
  const showInferenceRow = checkpoints.length > 0 && selectedStep != null;

  return (
    <Card
      onClick={() => navigate(`/training/${job.id}`)}
      className="bg-slate-800/50 border-slate-700 rounded-xl cursor-pointer hover:border-slate-500 transition-colors"
    >
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className={`flex items-center gap-1.5 text-xs font-semibold ${present.color}`}>
            <Icon className={`w-3.5 h-3.5 ${isRunning ? "animate-spin" : ""}`} />
            {present.label}
          </div>
          {job.runner === "hf_cloud" && job.hf_job_url ? (
            <Button
              variant="ghost"
              size="icon"
              asChild
              className="h-7 w-7 text-slate-400 hover:text-white"
              aria-label="Open Hub job page"
            >
              <a
                href={job.hf_job_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              onClick={handleAction}
              className="h-7 w-7 text-slate-400 hover:text-white"
              aria-label={isRunning ? "Stop job" : "Delete job"}
            >
              {isRunning ? <Square className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
            </Button>
          )}
        </div>
        <div>
          <div className="text-white font-semibold truncate" title={job.name}>
            {job.name}
          </div>
          <div className="text-xs text-slate-400">{subtitle}</div>
        </div>
        {showProgressBar ? (
          <div className="relative h-5 w-full overflow-hidden rounded-md bg-slate-900 border border-slate-700">
            <div
              className="h-full bg-gradient-to-r from-blue-500 to-sky-400 transition-[width] duration-500"
              style={{ width: `${progressPct}%` }}
            />
            <div className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-white tabular-nums drop-shadow">
              {isStarting ? "Training starting…" : `${progressPct.toFixed(1)}%`}
            </div>
          </div>
        ) : null}
        {showInferenceRow ? (
          <div className="flex items-center gap-2">
            <CheckpointDropdown
              checkpoints={checkpoints}
              selectedStep={selectedStep}
              onChange={setSelectedStep}
            />
            <Button
              size="icon"
              onClick={handlePlay}
              className="h-8 w-8 bg-green-500 hover:bg-green-600 text-white"
              aria-label="Run inference with this checkpoint"
            >
              <Play className="w-4 h-4" />
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
};

export default JobCard;
```

- [ ] **Step 2: Type-check**

```bash
cd frontend && npm run build 2>&1 | tail -10
```

Expected: TypeScript will complain that `JobsSection` doesn't pass `onPlay`. That's fixed in the next task.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/jobs/JobCard.tsx
git commit -m "$(cat <<'EOF'
feat(JobCard): Play row + hide progress bar when not running

When the job has at least one checkpoint, render a row with a
CheckpointDropdown (latest preselected) and a green Play button. The
progress bar is hidden once the job leaves the running state, which
makes room for the inference row on done/failed tiles.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Update `JobsSection` to mount `InferenceModal`

**Files:**
- Modify: `frontend/src/components/jobs/JobsSection.tsx`.

- [ ] **Step 1: Hoist modal state**

In `frontend/src/components/jobs/JobsSection.tsx`, add new imports near the top:

```tsx
import InferenceModal from "@/components/landing/InferenceModal";
import { useRobots } from "@/hooks/useRobots";
```

Inside the component (above the `refresh` useCallback at line 37), add:

```tsx
  const { selectedRecord } = useRobots();
  const [inferenceModalOpen, setInferenceModalOpen] = useState(false);
  const [inferenceJob, setInferenceJob] = useState<JobRecord | null>(null);
  const [inferenceStep, setInferenceStep] = useState<number | null>(null);
```

Add the handler near `handleStop` / `handleDelete`:

```tsx
  const handlePlay = (job: JobRecord, step: number) => {
    setInferenceJob(job);
    setInferenceStep(step);
    setInferenceModalOpen(true);
  };
```

- [ ] **Step 2: Pass `onPlay` to every `JobCard`**

Find each `<JobCard ... />` instantiation in the file (there are three: localJobs map, trackedCloudActive map, and trackedCloudCancelled map). Add `onPlay={handlePlay}` to each. Example for localJobs:

```tsx
            {localJobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                onStop={handleStop}
                onDelete={handleDelete}
                onPlay={handlePlay}
              />
            ))}
```

Repeat for the other two.

- [ ] **Step 3: Mount the modal**

Just above the closing `</section>` tag at the end of the JSX, add:

```tsx
      {inferenceJob ? (
        <InferenceModal
          open={inferenceModalOpen}
          onOpenChange={setInferenceModalOpen}
          robot={selectedRecord}
          jobId={inferenceJob.id}
          initialStep={inferenceStep}
        />
      ) : null}
```

- [ ] **Step 4: Type-check**

```bash
cd frontend && npm run build 2>&1 | tail -10
```

Expected: success.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/jobs/JobsSection.tsx
git commit -m "$(cat <<'EOF'
feat(JobsSection): mount InferenceModal, wire JobCard.onPlay

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Update `MonitoringMode` (`Training.tsx`) — "Run inference" panel

**Files:**
- Modify: `frontend/src/pages/Training.tsx` — `MonitoringMode` component (lines 275–470).

- [ ] **Step 1: Add imports + new state**

In `frontend/src/pages/Training.tsx`, extend the existing imports near the top:

```tsx
import {
  JobCheckpoint,
  listJobCheckpoints,
} from "@/lib/checkpointsApi";
import CheckpointDropdown from "@/components/jobs/CheckpointDropdown";
import InferenceModal from "@/components/landing/InferenceModal";
import { useRobots } from "@/hooks/useRobots";
import { Play } from "lucide-react";
```

(Some of those may already be imported indirectly — adjust to avoid duplicates the linter would complain about.)

Inside `MonitoringMode` (around line 280–283 where the existing `useState` calls live), add:

```tsx
  const { selectedRecord } = useRobots();
  const [checkpoints, setCheckpoints] = useState<JobCheckpoint[]>([]);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [inferenceModalOpen, setInferenceModalOpen] = useState(false);
```

- [ ] **Step 2: Poll checkpoints**

Add a new effect after the existing log-seeding effect (around line 302):

```tsx
  // Poll checkpoints — every 5s while the job is running, then once on stop.
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      listJobCheckpoints(baseUrl, fetchWithHeaders, jobId)
        .then((cks) => {
          if (cancelled) return;
          setCheckpoints(cks);
          if (cks.length > 0) {
            const latest = cks[cks.length - 1].step;
            setSelectedStep((prev) =>
              prev != null && cks.some((c) => c.step === prev) ? prev : latest,
            );
          } else {
            setSelectedStep(null);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setCheckpoints([]);
            setSelectedStep(null);
          }
        });
    };
    tick();
    const id = setInterval(() => {
      if (cancelled) return;
      // Once the job is no longer running we don't need to keep polling.
      if (job?.state && job.state !== "running") return;
      tick();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [baseUrl, fetchWithHeaders, jobId, job?.state]);
```

- [ ] **Step 3: Render the panel above `<TrainingLogs>`**

Find the existing `<TrainingLogs ... />` line (around line 466). Just above it, add:

```tsx
        <div className="bg-slate-800/40 border border-slate-700 rounded-lg p-4 flex items-center gap-3">
          <span className="text-sm font-semibold text-slate-300">Run inference</span>
          {checkpoints.length === 0 ? (
            <span className="text-xs text-slate-500">No checkpoints yet — wait for the first save.</span>
          ) : (
            <>
              <CheckpointDropdown
                checkpoints={checkpoints}
                selectedStep={selectedStep}
                onChange={setSelectedStep}
              />
              <Button
                onClick={() => setInferenceModalOpen(true)}
                disabled={selectedStep == null}
                className="bg-green-500 hover:bg-green-600 text-white"
              >
                <Play className="w-4 h-4 mr-2" />
                Run on robot
              </Button>
            </>
          )}
        </div>
        <InferenceModal
          open={inferenceModalOpen}
          onOpenChange={setInferenceModalOpen}
          robot={selectedRecord}
          jobId={jobId}
          initialStep={selectedStep}
        />
```

- [ ] **Step 4: Type-check**

```bash
cd frontend && npm run build 2>&1 | tail -10
```

Expected: success.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Training.tsx
git commit -m "$(cat <<'EOF'
feat(MonitoringMode): Run inference panel

Adds a checkpoint dropdown + Play button above the training logs on
the per-job page. Polls /jobs/{id}/checkpoints every 5s while the job
is running. Opens the same InferenceModal as the tile Play button.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Replace `Inference.tsx` placeholder with running page

**Files:**
- Modify: `frontend/src/pages/Inference.tsx`.

- [ ] **Step 1: Replace the file**

Overwrite `frontend/src/pages/Inference.tsx` with:

```tsx
import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import Logo from "@/components/Logo";
import { useApi } from "@/contexts/ApiContext";
import { useToast } from "@/hooks/use-toast";
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
import {
  InferenceStatus,
  getInferenceStatus,
  stopInference,
} from "@/lib/inferenceApi";

const POLL_MS = 1000;

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

const Inference: React.FC = () => {
  const navigate = useNavigate();
  const { baseUrl, fetchWithHeaders } = useApi();
  const { toast } = useToast();
  const [status, setStatus] = useState<InferenceStatus | null>(null);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const navigatedAwayRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await getInferenceStatus(baseUrl, fetchWithHeaders);
        if (cancelled) return;
        setStatus(next);
        // Auto-bounce home once the run is done.
        if (!next.inference_active && !navigatedAwayRef.current) {
          navigatedAwayRef.current = true;
          if (next.exited) {
            toast({
              title: "Inference finished",
              description:
                next.exit_code === 0
                  ? "Run completed."
                  : `Exit code ${next.exit_code}. See ${next.log_path}.`,
              variant: next.exit_code === 0 ? "default" : "destructive",
            });
          }
          navigate("/");
        }
      } catch (e) {
        if (!cancelled) {
          toast({
            title: "Lost connection to backend",
            description: e instanceof Error ? e.message : String(e),
            variant: "destructive",
          });
        }
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [baseUrl, fetchWithHeaders, navigate, toast]);

  const handleStop = async () => {
    setShowStopConfirm(false);
    try {
      await stopInference(baseUrl, fetchWithHeaders);
      // Status poll will catch the inactive state and navigate home.
    } catch (e) {
      toast({
        title: "Stop failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  };

  if (!status) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin mr-3" /> Connecting to inference…
      </div>
    );
  }

  const elapsed = status.elapsed_s ?? 0;
  const duration = status.duration_s ?? 0;
  const pct = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0;

  return (
    <div className="min-h-screen bg-black text-white flex flex-col p-4 sm:p-6 lg:p-8">
      <div className="flex items-center gap-4 mb-8">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/")}
          className="text-slate-400 hover:bg-slate-800 hover:text-white rounded-lg"
        >
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <Logo />
        <h1 className="font-bold text-white text-2xl">Inference</h1>
      </div>

      <div className="flex-1 flex items-center justify-center">
        <div className="bg-gray-900 rounded-lg border border-gray-700 p-8 w-full max-w-xl">
          <div className="text-center mb-6">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold tracking-widest bg-green-500/15 text-green-300">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              {status.inference_active ? "RUNNING" : "FINISHED"}
            </div>
          </div>

          <div className="text-center mb-4">
            <div className="text-7xl font-mono font-bold leading-none text-green-400">
              {formatTime(elapsed)}
            </div>
            <div className="text-sm text-gray-500 mt-2">
              / {formatTime(duration)}
            </div>
          </div>

          <div className="w-full bg-gray-800 rounded-full h-1.5 mb-8">
            <div
              className="h-1.5 rounded-full bg-green-500 transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>

          <div className="text-xs text-slate-500 break-all mb-6">
            policy: {status.policy_ref ?? "(unknown)"}
          </div>

          <Button
            onClick={() => setShowStopConfirm(true)}
            disabled={!status.inference_active}
            className="w-full bg-red-500 hover:bg-red-600 text-white font-semibold py-6 text-lg disabled:opacity-50"
          >
            <Square className="w-5 h-5 mr-2" />
            Stop
          </Button>
        </div>
      </div>

      <AlertDialog open={showStopConfirm} onOpenChange={setShowStopConfirm}>
        <AlertDialogContent className="bg-gray-900 border-gray-700 text-white">
          <AlertDialogHeader>
            <AlertDialogTitle>Stop inference?</AlertDialogTitle>
            <AlertDialogDescription className="text-gray-400">
              The follower will hold its current pose. You can launch another
              run from the job tile.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-gray-800 border-gray-700 text-white hover:bg-gray-700">
              Keep running
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleStop}
              className="bg-red-500 hover:bg-red-600 text-white"
            >
              Stop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Inference;
```

- [ ] **Step 2: Type-check + build the production bundle**

```bash
cd frontend && npm run build 2>&1 | tail -10
```

Expected: success. The committed `frontend/dist/` will be regenerated by CI on push (per CLAUDE.md), but the build should still pass locally.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Inference.tsx
git commit -m "$(cat <<'EOF'
feat(Inference): replace placeholder with running page

Polls /inference-status every 1s. Shows a status pill, elapsed/duration
timer, progress bar, and a Stop button. Auto-navigates home when the
backend reports the run is no longer active.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6 — End-to-end validation

### Task 17: Manual end-to-end test — local job

- [ ] **Step 1: Run a fast local training**

Start `lelab --dev`. From the Training page, kick off a local job with:
- Dataset: any dataset you've recorded (the smaller the better).
- `policy_type=act` (default), `steps=200`, `save_freq=50`, `log_freq=10`.

Confirm the job appears in the Landing page Jobs section.

- [ ] **Step 2: Watch checkpoints appear live**

Within ~1 minute, the dropdown row should appear on the running tile with `step 50` available. Wait until step 100 is also offered. Confirm `progress bar still shown above the inference row` while running.

- [ ] **Step 3: Try Play from the tile**

With the job still running, click the green ▶ next to `step 50`. The InferenceModal opens, pre-selecting that step. Cancel without starting (we still want training to finish).

- [ ] **Step 4: Wait for the run to finish**

When state flips to "Done", confirm the **progress bar is hidden** and the inference row remains.

- [ ] **Step 5: Run inference**

With a clean robot selected on the Landing page, click ▶ on the tile. In the modal:
- Confirm the latest step is preselected.
- Set task to "test rollout".
- Set duration to 10s.
- Click "Start Inference".

The page should navigate to `/inference`. Watch the elapsed counter tick. After 10s the page should auto-bounce home and show a "Inference finished" toast.

- [ ] **Step 6: Try the mutex**

While inference is running, attempt to start teleoperation from the Landing page. Expect a clear failure message naming inference as the active mode.

- [ ] **Step 7: No commit needed**

Phase 6 is validation. If anything failed, fix it and re-run. Otherwise proceed.

---

### Task 18: Manual end-to-end test — cloud job

- [ ] **Step 1: Submit a fast cloud job**

From the Training page, switch the target to `hf_cloud`, pick the cheapest GPU flavor (`a10g-small` or similar), set `steps=200`, `save_freq=50`. Submit.

- [ ] **Step 2: Watch the Hub repo for checkpoints**

Within a couple of minutes, browse to the Hub repo URL (visible on the cloud job tile via the External Link icon). Refresh occasionally. You should see `checkpoints/00000050/`, `checkpoints/00000100/`, ... appear under the repo's file tree as the run progresses.

- [ ] **Step 3: Confirm the dropdown populates**

On the Landing page, the cloud job tile should populate its dropdown identically to a local job.

- [ ] **Step 4: Run inference from a cloud checkpoint**

Once at least one checkpoint is in the Hub, click ▶ on the cloud tile, confirm the modal opens and the dropdown lists the steps. Start the run as in Task 17 step 5. The first run will take longer because `snapshot_download` runs synchronously inside `/start-inference` — expect 5–60s of "Starting…" before the inference page appears, depending on checkpoint size.

- [ ] **Step 5: No commit needed**

If anything failed, fix it. Otherwise this plan is complete.

---

## Self-review

**Spec coverage:** Every section of the spec maps to at least one task here:
- Goal / list checkpoints → Tasks 1–3, 6, 11.
- Cloud sidecar → Tasks 4–6.
- Inference mode (mutex, subprocess, hub-snapshot resolution) → Tasks 7, 8, 9.
- InferenceModal mirroring RecordingModal → Task 12.
- Inference running page → Task 16.
- Tile + monitoring Play affordances → Tasks 13, 14, 15.
- `checkpoint_count` extension → Task 3 backend, Task 10 frontend.
- Edge cases (mutex 409, empty checkpoints, hub repo not yet created) → Tasks 8, 12, 6 (early-return on `list_repo_files` exception).
- Manual validation strategy → Tasks 17, 18.

**Placeholders:** No `TBD`, no "implement later", no "similar to Task N" — every code step contains the exact code an engineer needs.

**Type consistency:** All cross-task identifiers (`JobCheckpoint`, `JobCheckpoint.ref` shape `f"{repo_id}@checkpoints/{step}"`, `JobRecord.checkpoint_count`, `InferenceRequest` field names, `StartInferenceRequest` TS interface, `policy_ref` everywhere) match between the spec, the backend tasks, and the frontend tasks.

**Known v1 limits acknowledged in the spec:**
- No live URDF during inference (subprocess owns the bus).
- Final-step model at the cloud repo root not surfaced if `total_steps` doesn't align with `save_freq` — user is at most `save_freq` steps behind.
- `snapshot_download` is synchronous inside `/start-inference` — multi-hundred-MB checkpoints make the modal "Starting…" state long-lived. UI affordance for that lives in Task 16's existing toast surface.
