# Job curves persistence implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make loss / learning-rate curves stay visible for every job (running, done, failed, interrupted) across `lelab` restarts and browser refreshes, by replaying metric history from each job's existing `log.jsonl`.

**Architecture:** Backend adds one read endpoint that re-parses `outputs/train/<job_id>/log.jsonl` into a clean per-step series using the existing `parse_metrics_into` regex. Frontend fetches this series on Monitoring mount, seeds the in-memory React state, and continues live-appending ticks. No new persistence file.

**Tech Stack:** FastAPI + Pydantic (backend), React + TypeScript + recharts (frontend). No test framework in this repo per [CLAUDE.md](CLAUDE.md) — validation is curl + manual browser exercise of the running `lelab` server.

**Spec:** [docs/superpowers/specs/2026-05-11-job-curves-persistence-design.md](docs/superpowers/specs/2026-05-11-job-curves-persistence-design.md)

---

## File map

| File | Action | Responsibility |
|---|---|---|
| [lelab/jobs.py](lelab/jobs.py) | Modify | Add `MetricsHistoryPoint` Pydantic model + `JobRegistry.read_metrics_history(job_id)` method. |
| [lelab/server.py](lelab/server.py) | Modify | Add `GET /jobs/{job_id}/metrics-history` route delegating to the new registry method. |
| [frontend/src/lib/jobsApi.ts](frontend/src/lib/jobsApi.ts) | Modify | Add `getJobMetricsHistory` API client function + `MetricsHistoryPoint` TS type. |
| [frontend/src/pages/Training.tsx](frontend/src/pages/Training.tsx) | Modify | Pass `jobId` prop to `MonitoringStats`. |
| [frontend/src/components/training/monitoring/MonitoringStats.tsx](frontend/src/components/training/monitoring/MonitoringStats.tsx) | Modify | Accept `jobId` prop, seed `lossHistory` / `lrHistory` on mount, raise `HISTORY_CAP` to 2000. |

---

### Task 1: Backend — add `MetricsHistoryPoint` model + `read_metrics_history`

**Files:**
- Modify: [lelab/jobs.py](lelab/jobs.py) — add Pydantic model near the other models (around line 96, next to `JobCheckpoint`) and the new method on `JobRegistry` (near `read_persisted_logs` at line 738).

- [ ] **Step 1: Add the `MetricsHistoryPoint` Pydantic model**

Insert this class in `lelab/jobs.py` immediately after the `JobCheckpoint` class definition (~line 105), before `_pid_alive`:

```python
class MetricsHistoryPoint(BaseModel):
    """One (step, metrics) sample reconstructed from a job's log.jsonl.

    Used by GET /jobs/{id}/metrics-history to seed the monitoring charts.
    A point is emitted for each log line that carried a `step: ... loss: ...`
    payload (the log-freq lines from lerobot). Tqdm progress lines are
    skipped — they carry step + ETA but no loss/lr/grdn."""

    step: int
    loss: float | None = None
    lr: float | None = None
    grad_norm: float | None = None
```

- [ ] **Step 2: Add `read_metrics_history` method on `JobRegistry`**

Insert this method in `lelab/jobs.py` immediately after `read_persisted_logs` (which ends at line 761). It mirrors that method's shape (lookup → file read → tolerant per-line parse):

```python
    def read_metrics_history(self, job_id: str) -> builtins.list[MetricsHistoryPoint]:
        """Reconstruct the per-step loss/lr/grad-norm series from log.jsonl.

        Used by the frontend on Monitoring-page mount to seed the curves so
        they survive page reloads, navigation, and lelab restarts. Re-parses
        on every call; cache later if a slow file ever shows up.
        """
        with self._lock:
            if job_id not in self._records:
                raise JobNotFoundError(job_id)
        path = _job_log_path(self._output_root, job_id)
        if not path.exists():
            return []
        points: list[MetricsHistoryPoint] = []
        with path.open() as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    log_line = LogLine.model_validate_json(raw)
                except Exception:
                    continue  # skip malformed line, same as read_persisted_logs
                msg = log_line.message
                # Only the log-freq lines carry per-step metric values.
                # Tqdm lines have a step but no loss/lr — skip them so we
                # don't emit a flat-line point per tqdm tick.
                if "step:" not in msg or "loss:" not in msg:
                    continue
                fresh = TrainingMetrics()
                parse_metrics_into(msg, fresh)
                if fresh.current_step <= 0:
                    continue
                point = MetricsHistoryPoint(
                    step=fresh.current_step,
                    loss=fresh.current_loss,
                    lr=fresh.current_lr,
                    grad_norm=fresh.grad_norm,
                )
                # Dedupe by step: overwrite on consecutive same-step lines.
                if points and points[-1].step == point.step:
                    points[-1] = point
                else:
                    points.append(point)
        points.sort(key=lambda p: p.step)
        return points
```

- [ ] **Step 3: Export `MetricsHistoryPoint` from the module**

In `lelab/jobs.py`, locate the `__all__` list at the bottom (line 987) and add `"MetricsHistoryPoint"` next to `"JobCheckpoint"`:

```python
__all__ = [
    "JobState",
    "JobTarget",
    "TrainingMetrics",
    "LogLine",
    "JobRecord",
    "JobCheckpoint",
    "MetricsHistoryPoint",
    "JobRunner",
    "LocalJobRunner",
    "JobRegistry",
    "JobAlreadyRunningError",
    "JobNotFoundError",
    "JobNotRunningError",
    "job_registry",
    "parse_metrics_into",
]
```

- [ ] **Step 4: Verify the module still imports cleanly**

Run: `python -c "from lelab.jobs import job_registry, MetricsHistoryPoint; print(MetricsHistoryPoint.model_json_schema())"`
Expected: prints a JSON schema with `step`, `loss`, `lr`, `grad_norm` properties — no traceback.

- [ ] **Step 5: Commit**

```bash
git add lelab/jobs.py
git commit -m "feat(jobs): add MetricsHistoryPoint + read_metrics_history"
```

---

### Task 2: Backend — add the HTTP route

**Files:**
- Modify: [lelab/server.py](lelab/server.py) — new route placed right after `/jobs/{job_id}/log-file` (line 564), before `/jobs/{job_id}/checkpoints` (line 567), to keep related endpoints adjacent.

- [ ] **Step 1: Add the route**

Insert this block in `lelab/server.py` between the existing `get_job_log_file` handler (ends at line 564) and `get_job_checkpoints`:

```python
@app.get("/jobs/{job_id}/metrics-history")
def get_job_metrics_history(job_id: str):
    """Return the per-step loss/lr/grad-norm series reconstructed from the
    job's log.jsonl. Used to seed the monitoring charts so curves persist
    across page reloads, navigation, and lelab restarts."""
    try:
        points = job_registry.read_metrics_history(job_id)
    except JobNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Job {job_id!r} not found") from exc
    return {"points": points}
```

No new imports needed — `JobNotFoundError` and `job_registry` are already imported at module top.

- [ ] **Step 2: Start the server and pick an existing job id**

Run `lelab` in one terminal. In another terminal:

```bash
ls outputs/train/ | head -3
```

Pick a job id from the output that has a non-trivial `log.jsonl` (one that ran past the first log-freq step). Export it for the next steps:

```bash
JOB_ID=$(ls outputs/train/ | head -1)
echo "$JOB_ID"
```

- [ ] **Step 3: Curl the new endpoint**

```bash
curl -s "http://localhost:8000/jobs/$JOB_ID/metrics-history" | python -m json.tool | head -40
```

Expected: a JSON object `{"points": [...]}` where each point has `step`, `loss`, `lr`, `grad_norm`. Steps strictly ascending. For a job that hasn't reached its first log-freq step, expected output is `{"points": []}`.

- [ ] **Step 4: Curl the 404 path**

```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8000/jobs/this-id-does-not-exist/metrics-history"
```

Expected: `404`.

- [ ] **Step 5: Commit**

```bash
git add lelab/server.py
git commit -m "feat(server): add GET /jobs/{id}/metrics-history"
```

---

### Task 3: Frontend — API client function + type

**Files:**
- Modify: [frontend/src/lib/jobsApi.ts](frontend/src/lib/jobsApi.ts) — add a TS type and a fetcher function next to the existing job-fetch helpers (around line 124, after `getJobLogFile`).

- [ ] **Step 1: Add the `MetricsHistoryPoint` type**

In `frontend/src/lib/jobsApi.ts`, locate the existing type exports near the top of the file (right next to where `LogLine` is exported). Add:

```typescript
export type MetricsHistoryPoint = {
  step: number;
  loss: number | null;
  lr: number | null;
  grad_norm: number | null;
};
```

If unsure where existing types live, search the file with: `grep -n "^export type\|^export interface" frontend/src/lib/jobsApi.ts` and place the new type adjacent to them.

- [ ] **Step 2: Add the fetcher function**

In `frontend/src/lib/jobsApi.ts`, add this function immediately after `getJobLogFile` (which ends around line 124):

```typescript
export async function getJobMetricsHistory(
  baseUrl: string,
  fetcher: Fetcher,
  id: string,
): Promise<MetricsHistoryPoint[]> {
  const r = await fetcher(`${baseUrl}/jobs/${id}/metrics-history`);
  await expectOk(r, "Get job metrics history");
  const body = await r.json();
  return body.points;
}
```

- [ ] **Step 3: Verify the frontend type-checks**

If a TS server is running in the editor, confirm no red squiggles in `jobsApi.ts`. Otherwise run a quick syntax check:

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors in `src/lib/jobsApi.ts`. Pre-existing errors elsewhere are fine if they're not on the touched file.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/jobsApi.ts
git commit -m "feat(jobs-api): add getJobMetricsHistory client"
```

---

### Task 4: Frontend — seed `MonitoringStats` from history

**Files:**
- Modify: [frontend/src/components/training/monitoring/MonitoringStats.tsx](frontend/src/components/training/monitoring/MonitoringStats.tsx) — accept a `jobId` prop, fetch on mount/change, seed the two `useState`s, raise `HISTORY_CAP`.
- Modify: [frontend/src/pages/Training.tsx](frontend/src/pages/Training.tsx#L549) — pass `jobId` through to `MonitoringStats`.

- [ ] **Step 1: Raise `HISTORY_CAP` and import the new API**

In `frontend/src/components/training/monitoring/MonitoringStats.tsx`:

Replace the existing constant at line 30:

```typescript
const HISTORY_CAP = 2000;
```

Add these imports at the top of the file (next to the existing recharts and lucide imports):

```typescript
import { useApi } from '@/hooks/useApi';
import { getJobMetricsHistory } from '@/lib/jobsApi';
```

If unsure about the exact `useApi` import path, confirm with: `grep -n "from '@/hooks/useApi'" frontend/src/pages/Training.tsx` — that's the file we know uses it.

- [ ] **Step 2: Add `jobId` to the props interface**

In the same file, update the `MonitoringStatsProps` interface (line 14):

```typescript
interface MonitoringStatsProps {
  jobId: string;
  trainingStatus: TrainingStatus;
  getProgressPercentage: () => number;
  formatTime: (seconds: number) => string;
}
```

And the component signature (line 32):

```typescript
const MonitoringStats: React.FC<MonitoringStatsProps> = ({
  jobId,
  trainingStatus,
  getProgressPercentage,
  formatTime,
}) => {
```

- [ ] **Step 3: Add the seed effect**

In the same file, immediately after the existing `lastStepRef` declaration (around line 39) and before the existing live-append `useEffect` (line 43), insert:

```typescript
const { baseUrl, fetchWithHeaders } = useApi();

// Seed the curves from the persisted log on mount (and when the active job
// changes). Without this, the chart starts empty on every page reload,
// after navigating away and back, or after a lelab restart re-attaches to
// a still-running job. Live-append continues from the last seeded step.
useEffect(() => {
  let cancelled = false;
  getJobMetricsHistory(baseUrl, fetchWithHeaders, jobId)
    .then((points) => {
      if (cancelled || points.length === 0) return;
      const lossSeed: LossPoint[] = points
        .filter((p) => p.loss != null)
        .map((p) => ({ step: p.step, loss: p.loss as number }))
        .slice(-HISTORY_CAP);
      const lrSeed: LrPoint[] = points
        .filter((p) => p.lr != null)
        .map((p) => ({ step: p.step, lr: p.lr as number }))
        .slice(-HISTORY_CAP);
      setLossHistory(lossSeed);
      setLrHistory(lrSeed);
      // Pin lastStepRef to the last seeded step so the first live tick
      // (whose step is >= the seed's last step) doesn't trigger the
      // step-regressed reset in the live-append effect below.
      const lastSeededStep =
        points[points.length - 1]?.step ?? 0;
      lastStepRef.current = lastSeededStep;
    })
    .catch(() => {
      // 404 or transient — fall through; live ticks will populate from empty.
    });
  return () => {
    cancelled = true;
  };
}, [baseUrl, fetchWithHeaders, jobId]);
```

- [ ] **Step 4: Pass `jobId` from Training.tsx**

In `frontend/src/pages/Training.tsx`, find the `<MonitoringStats` JSX at line 549 (use `grep -n "<MonitoringStats" frontend/src/pages/Training.tsx` if line numbers have drifted). Add `jobId={jobId}` to the props. The block currently looks like:

```typescript
<MonitoringStats
  trainingStatus={jobToStatus(job, false)}
  ...
```

Change to:

```typescript
<MonitoringStats
  jobId={jobId}
  trainingStatus={jobToStatus(job, false)}
  ...
```

(Keep the rest of the prop list intact — the existing `getProgressPercentage` and `formatTime` props remain unchanged.)

- [ ] **Step 5: Verify type-check**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors on the two files we touched. Pre-existing errors elsewhere are fine.

- [ ] **Step 6: Exercise in the browser**

Start `lelab --dev` (or `lelab` if you don't need hot-reload), then in the browser:

1. Open a finished job from the Jobs list → Monitoring page. Confirm the loss and LR charts render a full curve (not "Waiting for first metric tick…").
2. Refresh the tab on the Monitoring page. Confirm the curves come back immediately, not after a delay.
3. Navigate to the Landing page and back to the same job. Confirm the curves are still there.
4. Open an `interrupted` job (one whose backend was killed mid-run). Confirm the curves show the data that was logged before the interruption.
5. (If a job is currently running) confirm new live ticks continue to extend the chart after the seed.

Note any visual issue or seam between seeded and live data. There should be no gap and no duplicate point at the seam (the `lastStepRef` pinning + the existing `if (last && last.step === step) return prev` dedupe in the live-append effect at line 54-56 handles this).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/training/monitoring/MonitoringStats.tsx frontend/src/pages/Training.tsx
git commit -m "feat(monitoring): seed loss/lr curves from persisted metrics history"
```

---

### Task 5: Rebuild and verify the production frontend bundle

This repo ships the built `frontend/dist/` inside the Python wheel and to the HF Space. The CI workflow auto-rebuilds on push to `main`, so a local rebuild is not strictly required — but a local build confirms the change is production-clean before we ship.

- [ ] **Step 1: Build the frontend**

```bash
cd frontend && npm run build
```

Expected: build completes without errors. `frontend/dist/` is updated.

- [ ] **Step 2: Exercise the built bundle**

Stop any `lelab --dev` server. Start the production server:

```bash
lelab
```

Open `http://localhost:8000` and repeat the browser checks from Task 4 Step 6 (finished job → curves present, refresh → still present, interrupted job → partial curve present).

- [ ] **Step 3: Commit the rebuilt bundle**

```bash
git add frontend/dist
git commit -m "build(frontend): rebuild dist with seeded monitoring curves"
```

(If `git status` shows no changes to `frontend/dist`, skip this commit — the CI workflow will rebuild on push.)

---

## Self-review

**Spec coverage:**
- Backend endpoint `GET /jobs/{id}/metrics-history` → Task 2. ✓
- `read_metrics_history` parsing log.jsonl, skipping non-log-freq lines, dedup by step, sorted → Task 1 Step 2. ✓
- Pydantic models with `step`, `loss`, `lr`, `grad_norm` → Task 1 Step 1. ✓
- 404 on unknown job → Task 2 Step 1 + verified in Step 4. ✓
- Frontend seed on mount + on `jobId` change → Task 4 Step 3. ✓
- `lastStepRef` pinning to prevent the regression-reset on first live tick → Task 4 Step 3 (with inline comment). ✓
- `HISTORY_CAP` raised from 200 to 2000 → Task 4 Step 1. ✓
- Works uniformly for running / done / failed / interrupted jobs → no state-specific branching in `read_metrics_history`; verified manually in Task 4 Step 6. ✓
- No new persistence file → all reads come from existing `log.jsonl`. ✓

**Placeholder scan:** No TBDs, no "add appropriate error handling", no "similar to Task N" — every code change is shown in full at the point of use.

**Type consistency:** `MetricsHistoryPoint` has identical fields on backend (Pydantic: `step`, `loss`, `lr`, `grad_norm` with `int | None`) and frontend (TS: `step`, `loss`, `lr`, `grad_norm` with `number | null`). API function name `getJobMetricsHistory` matches across Task 3 and Task 4 (Step 1 import + Step 3 usage). Route path `/jobs/{job_id}/metrics-history` matches across backend (Task 2 Step 1) and frontend client (Task 3 Step 2).
