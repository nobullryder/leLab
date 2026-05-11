# Job curves persistence across lelab restarts

**Date:** 2026-05-11
**Status:** design approved, plan pending

## Problem

When a user opens a training job in the Monitoring page, the loss and learning-rate curves are populated tick-by-tick from live `trainingStatus` polling into React `useState` ([MonitoringStats.tsx:37-67](frontend/src/components/training/monitoring/MonitoringStats.tsx#L37-L67)). The curves disappear whenever:

- the browser tab is refreshed,
- the user navigates away and comes back,
- the `lelab` process is restarted (the in-flight job re-attaches via `TailingJobRunner`, but the frontend still starts from an empty series),
- the job is `done`, `failed`, or `interrupted` and the user opens it cold.

The raw data needed to reconstruct the curve already lives on disk in each job's `outputs/train/<job_id>/log.jsonl` (one JSON line per stdout line, including the `step:N ... loss:X lr:Y grdn:Z ...` log-freq lines that the existing `parse_metrics_into` function understands). Nothing currently replays it to the frontend.

## Goal

Make loss / learning-rate curves stay visible for every job — `running`, `done`, `failed`, `interrupted` — independent of frontend state lifecycle and backend process restarts. No new persistence layer; reuse `log.jsonl`.

## Non-goals

- Persisting grad-norm chart (not currently rendered; we can include the value in the response payload for free, but no new chart).
- Charting wall-clock time on the X axis (step-indexed only, matches today's UI).
- Wandb-style downsampling, smoothing, or aggregation controls.
- Surfacing curves anywhere outside the existing Monitoring page.

## Design

### Backend

**New endpoint:** `GET /jobs/{job_id}/metrics-history`

Response schema:

```python
class MetricsHistoryPoint(BaseModel):
    step: int
    loss: float | None = None
    lr: float | None = None
    grad_norm: float | None = None

class MetricsHistoryResponse(BaseModel):
    points: list[MetricsHistoryPoint]
```

**Implementation** lives on `JobRegistry` as `read_metrics_history(job_id) -> list[MetricsHistoryPoint]`, parallel in shape to the existing `read_persisted_logs` ([jobs.py:738-761](lelab/jobs.py#L738-L761)):

1. Resolve `<output_root>/<job_id>/log.jsonl`. If it doesn't exist, return `[]`.
2. Stream the file line by line. For each line that parses as a `LogLine`:
   - Skip unless `"step:" in line.message and "loss:" in line.message` — the log-freq lines are the only ones that carry per-step metric values; tqdm progress lines carry step + ETA but no loss/lr/grdn.
   - Run the existing `parse_metrics_into` against a *fresh* `TrainingMetrics` instance per line so we extract only what this line actually advertises (no carryover from prior lines).
   - Emit one `MetricsHistoryPoint(step, loss, lr, grad_norm)`.
3. Dedupe by step: if two consecutive points share a step, keep the last one (overwrite). This handles rare repeated lines without an O(n) set.
4. Sort by step ascending (the log is already in order, but be defensive — re-attached tails can in theory interleave).
5. Return the list. No caching in v1; re-parses on every request (multi-MB files run in tens of ms).

**Endpoint wiring** in `server.py`: route handler delegates to `job_registry.read_metrics_history(job_id)`, returns `MetricsHistoryResponse`. Raises 404 via `JobNotFoundError` like the other job endpoints.

### Frontend

In [MonitoringStats.tsx](frontend/src/components/training/monitoring/MonitoringStats.tsx):

1. **Raise `HISTORY_CAP` from 200 → 2000.** Long runs (100k steps at log_freq=250 = 400 points) fit easily; even smolvla-scale runs (1M steps = ~4000 points) only lose the head. Memory cost is negligible (a few numbers × 2000 = single-digit KB).
2. **On mount and whenever the active `jobId` changes**, call `GET /jobs/{id}/metrics-history`:
   - Map the response into `lossHistory` (only points with `loss != null`) and `lrHistory` (only points with `lr != null`).
   - Take the **trailing `HISTORY_CAP`** so we match the cap behaviour of the live-append path.
   - Set `lastStepRef.current` to the last seeded step so the existing "step regressed → reset history" check doesn't immediately wipe the seed when the first live tick arrives with a step ≥ the seed's last step.
3. **Keep the existing live-append `useEffect` unchanged.** It will naturally continue appending new ticks on top of the seeded history.

### Why this design

- **No new persistence file, no schema migration, no doubled write path.** `log.jsonl` is the single source of truth, which is already true for the existing log replay.
- **The parser is reused verbatim.** `parse_metrics_into` already knows how to read these lines; centralizing parsing means future log-format tweaks update exactly one place.
- **Uniform across job states.** A `done` job, a `failed` job after a crash, an `interrupted` job whose backend restarted — they all have the same `log.jsonl` shape, so they all serve the same way.
- **Latency.** Re-parsing a 10MB file is on the order of tens of ms in CPython. The endpoint is hit once on page mount per job, not on every tick. A TTL cache can be added later if profiling shows a need.

## Edge cases

- **No log file yet** (job just started, no log-freq line has fired): endpoint returns `points: []`. Frontend renders "Waiting for first metric tick…" exactly like today.
- **Malformed line in log.jsonl**: skipped silently, same as `read_persisted_logs` ([jobs.py:758-760](lelab/jobs.py#L758-L760)).
- **Interrupted job that never reached the first log-freq line**: empty curve. Correct — there's literally no data to show.
- **Step regression on a fresh run reusing the same `jobId`**: the existing reset logic still fires on the first live tick whose step is below `lastStepRef`. This isn't reachable in practice (each `start()` generates a new `job_id`), but the safety check costs nothing.
- **Very long runs that exceed `HISTORY_CAP=2000`**: the head is dropped. Acceptable for v1; downsampling can land later if/when this matters.

## Out of scope (revisit later)

- Server-side downsampling (e.g. LTTB) once `HISTORY_CAP` becomes the binding constraint.
- TTL cache on `read_metrics_history` once a slow file shows up in profiling.
- Charting grad-norm and other metrics.
- Time-axis charts (wall-clock or relative).
