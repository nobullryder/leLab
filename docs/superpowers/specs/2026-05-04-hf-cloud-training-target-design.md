# HF Cloud as a training target

**Date:** 2026-05-04
**Status:** Design approved, ready for plan
**Related:** [training-jobs-design](2026-05-04-training-jobs-design.md), [hf-auth-check-design](2026-04-29-hf-auth-check-design.md)

## Goal

Let users run their LeRobot training on Hugging Face's GPU jobs (`hf jobs`) directly from the Training page, with HF Cloud as the default target and Local as the available fallback. Surface flavor names and live prices in the dropdown so the upsell is concrete: "this run will cost ~$X/hr" turns an abstract decision into a buying decision.

## Non-goals

- Per-step checkpoint pushes during training. Only the final policy uploads to the Hub.
- Multi-GPU optimisation. Multi-GPU flavors appear in the dropdown but the bootstrap does not pass DDP flags; they run single-GPU.
- Resume-from-Hub for HF jobs.
- Scheduled jobs (`hf jobs scheduled`).
- Cost guardrails / "you are about to spend $X" confirmation dialogs / per-user budgets. Listed as future work.
- Mutual exclusion relaxation: one running job at a time across both runners (same as today).

## Architecture

The codebase already has the seam. [JobRunner Protocol](../../../app/jobs.py) defines the runner interface (`start`, `stop`, `is_running`, `returncode`, `stream_log_lines`); `JobRecord.runner: Literal["local"]` is the field that widens. Plan:

- **New runner:** `app/runners/hf_cloud.py` defines `HfCloudJobRunner`, implementing `JobRunner`. Internally uses `huggingface_hub.HfApi` (`run_job`, `cancel_job`, `fetch_job_logs`, `inspect_job`, `whoami`) instead of `subprocess.Popen`.
- **JobRegistry change:** `start(config, target)` accepts a target spec (`{"runner": "local" | "hf_cloud", "flavor": str | None}`) and instantiates the matching runner. Watchdog finalisation, persistence, log file tailing — all unchanged. Both runners write `LogLine` records into `outputs/train/<job_id>/log.jsonl` exactly as today.
- **`JobRecord` widens:** new fields `runner: Literal["local", "hf_cloud"]` (default `"local"`), `hf_job_id: Optional[str]`, `hf_flavor: Optional[str]`, `hf_repo_id: Optional[str]`. Persistence to `job.json` round-trips via Pydantic; old files load fine because all new fields have defaults.
- **Frontend:** new `TargetCard` (sibling to EssentialsCard / AdvancedCard) at the top of ConfigurationTab. Dropdown lists Local + every flavor returned by a new `GET /jobs/runners/hardware` endpoint, each with cost. Default = HF Cloud + `a10g-small` when authed, else Local.
- **Auth handling:** existing `HfAuthBanner` component is rendered at the top of the training page when unauthed. HF flavor entries in the dropdown render disabled with a "log in" hint until auth resolves.

## Component design

### `TrainingRequest` schema additions (`app/training.py`)

Two fields are added to enable Hub upload:

- `policy_push_to_hub: bool = False`
- `policy_repo_id: Optional[str] = None`

`build_training_command` is modified so that if `request.policy_push_to_hub` is True, it emits `--policy.push_to_hub true` followed by `--policy.repo_id <id>`; otherwise it keeps emitting `--policy.push_to_hub false` (today's hardcoded behaviour at [training.py:109](../../../app/training.py)). Local-target requests leave both fields at their defaults; HF Cloud-target requests have both set by the runner. The frontend form does not expose these fields directly — they are runner-driven.

### `HfCloudJobRunner` (`app/runners/hf_cloud.py`)

Single-shot, like `LocalJobRunner`. Constructed with metrics + log_file_path + flavor + auth token. Implements the `JobRunner` protocol.

**`start(job_id, config, output_dir)`:**

1. Resolve HF username via `HfApi.whoami()["name"]`. Compute `policy_repo_id = f"{user}/{<slug>}"` where `<slug>` is `slug(config.job_name)` if set, else the same slug used for the local `job_id` (policy_type + dataset slug + timestamp from `_generate_job_id`). Mutate the config in-place: `policy_push_to_hub=True`, `policy_repo_id=<computed>`. (Acknowledged side effect — see "Mutating config" below.)
2. Build the lerobot argv via the existing [build_training_command](../../../app/training.py).
3. Call `HfApi.run_job(image="huggingface/lerobot-gpu:latest", command=<argv>, flavor=<selected>, environment={"HF_TOKEN": <token>})`. The image is HuggingFace's official lerobot-gpu image (Python + CUDA + PyTorch + lerobot pre-installed), so no bootstrap install is needed — argv runs directly. Token comes from `huggingface_hub.HfFolder.get_token()` (the same token `hf auth login` writes). Capture the returned `Job.id` → `record.hf_job_id`.
5. Spawn a daemon log-tailing thread (mirrors `LocalJobRunner._pump_stdout`).

**Log-tailing thread:**

`HfApi.fetch_job_logs(job_id)` is a generator yielding lines as they arrive. The thread iterates it, calls `parse_metrics_into(line, metrics)` (the existing tqdm + `step:/loss:/lr:` parser works unchanged — same lerobot stdout), tees each line to `log.jsonl`, and pushes onto an in-memory `LogLine` queue. `stream_log_lines()` drains the queue exactly as `LocalJobRunner` does.

If the SSE/WebSocket disconnects mid-stream, retry with exponential backoff up to 3 attempts. After that, leave the job in "running" state and let the watchdog catch the eventual transition via `inspect_job`.

**Lifecycle:**

- `is_running()` → `HfApi.inspect_job(id).status in {RUNNING, QUEUED}`.
- `returncode()` → `0` on COMPLETED, `1` on FAILED/CANCELLED, `None` while live. Existing watchdog finalisation (`state = "done" if rc == 0 else "failed"`) applies unchanged.
- `stop()` → `HfApi.cancel_job(id)`. HF processes the cancel asynchronously; the next `is_running()` poll picks up the transition.

**Reattachment after uvicorn reload:**

`JobRecord.hf_job_id` is persisted, so the registry can re-attach. New branch in `JobRegistry._load_from_disk`:

```
if record.runner == "hf_cloud" and record.state == "running":
    status = api.inspect_job(record.hf_job_id).status
    if status in {RUNNING, QUEUED}:
        re-spawn log-tailing thread
    else:
        finalise based on terminal status
```

No PID concept needed — HF job_id is the durable handle. Mirrors the local `TailingJobRunner` shape.

### Backend API surface (changes in [app/main.py](../../../app/main.py))

**New: `GET /jobs/runners/hardware`**

Returns the flavor catalog + auth state:

```json
{
  "authenticated": true,
  "username": "nrabault",
  "flavors": [
    {
      "name": "cpu-basic",
      "pretty_name": "CPU Basic",
      "cpu": "2 vCPU",
      "ram": "16 GB",
      "accelerator": null,
      "unit_cost_usd": 0.000167,
      "unit_label": "minute"
    }
    /* … */
  ]
}
```

Implementation: thin wrapper around `HfApi.list_jobs_hardware()` + `HfApi.whoami()`. In-process cache for the flavors list with 5-minute TTL (avoid hammering on rapid page loads / pollers). When unauthed, return `{authenticated: false, username: null, flavors: []}`.

**Modified: `POST /jobs/training`**

Request body widens with one optional block:

```json
{
  /* … all existing fields … */
  "target": { "runner": "hf_cloud", "flavor": "a10g-small" }
}
```

Validation:

- Omitted `target` ⇒ `{"runner": "local"}`. Backwards-compatible for any existing client.
- `runner == "hf_cloud"` requires non-empty `flavor` AND HF auth resolves; 400 otherwise with `"HF authentication required"` or `"flavor required for hf_cloud target"`.
- `flavor` value not validated against the live catalog at request time (avoids a second `list_jobs_hardware` call); HF's `run_job` will return an error if invalid, which we surface verbatim via the existing 500/409 path.

**Modified: `JobRecord` response shape**

Adds `runner`, `hf_job_id`, `hf_flavor`, `hf_repo_id` (all optional/nullable for backwards compatibility). Existing local jobs persist as `runner: "local"`, others null.

**Unchanged endpoints:** `GET /jobs`, `GET /jobs/{id}`, `GET /jobs/{id}/logs`, `GET /jobs/{id}/log-file`, `POST /jobs/{id}/stop`, `DELETE /jobs/{id}`. They delegate to `JobRegistry` / `JobRunner` whose contract has not changed.

### Frontend changes

**New component: `frontend/src/components/training/config/TargetCard.tsx`**

Sits at the top of `ConfigurationTab`, above `EssentialsCard`. Single shadcn `<Select>` labelled "Compute target":

- **Local — your machine** (free) — selectable always.
- One row per HF flavor, formatted as `<pretty_name> · <accelerator> · $<unit_cost_usd × 60>/hr` (e.g. *"Nvidia A10G small · 1× A10G 24 GB · $1.00/hr"*). Disabled rows when unauthed, with a "log in to HF" hint shown as the row's secondary line.

Default selection on mount:

- If `/jobs/runners/hardware` returns `authenticated: true` and the catalog includes `a10g-small`: select `{ runner: "hf_cloud", flavor: "a10g-small" }`.
- Else: select `{ runner: "local" }`.

Footer text under the dropdown: *"Cost shown is per running hour. Final policy uploads to your HF account when training completes."*

**Auth banner on training page:**

At the top of `ConfigurationMode` in [Training.tsx](../../../frontend/src/pages/Training.tsx), render `<HfAuthBanner />` (already exists, just import it). When unauthed, the banner provides the login command + "I've logged in — recheck" button — same UX as Landing.

**Type / plumbing changes:**

- `TrainingConfig` (in [training/types.ts](../../../frontend/src/components/training/types.ts)) gains:
  ```ts
  target: { runner: "local" | "hf_cloud"; flavor?: string };
  ```
- `configToRequest` in [Training.tsx](../../../frontend/src/pages/Training.tsx) passes `target` through unchanged.
- New helper `listRunnerHardware(baseUrl, fetchWithHeaders)` in `frontend/src/lib/jobsApi.ts` — thin GET wrapper over `/jobs/runners/hardware`. Hook into the existing `useEffect` cluster in `ConfigurationMode`.

**Monitoring page:**

In [MonitoringMode](../../../frontend/src/pages/Training.tsx)'s header, add a sibling badge next to `<h1>{job.name}</h1>`:

- `runner === "local"` → slate-coloured "Local" badge.
- `runner === "hf_cloud"` → amber "HF · `<flavor>`" badge.

For HF jobs whose `hf_repo_id` is non-null (i.e. the upload completed at training end), append a "View on Hub ↗" link pointing at `https://huggingface.co/<hf_repo_id>`. The link is omitted while training is in progress and the field is still null.

**Start button validation:**

Disabled when `target.runner === "hf_cloud"` AND (`unauthed` OR `flavor not selected`). Tooltip surfaces the reason. Local-target Start button keeps its existing disabled rules (dataset_repo_id required, no other running job).

## Data flow

```
User opens Training page
  → fetch /jobs/runners/hardware
  → if authed: TargetCard defaults to {hf_cloud, a10g-small}
  → if unauthed: HfAuthBanner shows; TargetCard defaults to local; HF rows disabled

User clicks Start
  → POST /jobs/training {…config, target}
  → JobRegistry.start chooses runner by target.runner
  → HfCloudJobRunner.start(): mutate config (push_to_hub, repo_id), bootstrap+run
  → record persisted with hf_job_id, hf_flavor, runner="hf_cloud"
  → frontend navigates to /training/<job_id> (MonitoringMode)

MonitoringMode polls
  → GET /jobs/<id> every 1s — same as today
  → GET /jobs/<id>/logs every 1s — same as today
  → log-tailing thread on backend keeps log.jsonl + log queue fed
  → on training completion: registry watchdog finalises, hf_repo_id field populates
     (read from inspect_job's metadata or from the persisted policy_repo_id), "View on Hub" link appears
```

## Persistence on disk

Same `outputs/train/<job_id>/` directory layout for both runners:

- `job.json` — `JobRecord` Pydantic model. Widens with the four new fields; old files load via Pydantic defaults.
- `log.jsonl` — line-delimited `LogLine` records. Both runners write here through the same code path. No format change.

No migration script needed.

## Error handling

| Case | Behaviour |
|---|---|
| `HfApi.run_job` raises (auth expired, flavor unavailable, quota exceeded) | Registry catches, marks record `failed`, sets `error_message` to the HF API error string, persists, surfaces via existing 500 path. Frontend toast handles it. |
| `fetch_job_logs` disconnects mid-stream | Log-tailing thread retries with exponential backoff, max 3 attempts. After that, leave job in "running"; watchdog catches eventual transition via `inspect_job`. |
| `cancel_job` 404 (job already completed) | Swallow; watchdog finalises naturally on next tick. |
| User clicks Start while unauthed | Backend returns 400 `"HF authentication required"`. Frontend toast surfaces the message. |
| User opens page while HF API is unreachable | `/jobs/runners/hardware` returns `{authenticated: false, flavors: []}` after a short timeout. TargetCard renders Local-only. |
| `inspect_job` returns terminal status (COMPLETED/FAILED/CANCELLED) but registry record is "running" | Watchdog finalises on its next tick using the `returncode()` mapping. |

## Concurrency

Existing `JobAlreadyRunningError` rule (one running job at a time) keeps applying across both runners — local and HF jobs are mutually exclusive. Acceptable for this iteration; can be relaxed later by partitioning the registry per-runner.

## Mutating config (acknowledged side effect)

When the runner is `hf_cloud`, the registry mutates `config.policy_push_to_hub = True` and sets `config.policy_repo_id` to the derived value, regardless of what the form sent. This is deliberate: Hub upload is the only durable artifact for an HF job (the filesystem is ephemeral), so we can't accept "off". The mutated config is what gets persisted to `job.json`, so the historical record reflects what actually ran. The frontend form may eventually surface a "policy will upload to: `<user>/<job_name>`" hint when HF Cloud is selected, but it's not required for v1.

## Lerobot version coupling

The HF job uses `huggingface/lerobot-gpu:latest`, whose lerobot version is whatever HuggingFace last published. leLab's local install tracks `main` from git ([pyproject.toml](../../../pyproject.toml)). These can drift — typically by hours to a few days. For hackathon scope this is acceptable; users running the same training locally and on cloud may see slightly different lerobot behaviour if they happen to install across a release boundary. If pinning becomes important later, switch to a version-tagged image (e.g. `huggingface/lerobot-gpu:0.x.y`) and surface the version in the JobRecord.

## Future work (explicitly out of scope here)

- Cost guardrail: confirmation dialog before launching HF jobs above some threshold ($/hr or estimated total).
- Per-user budget cap.
- Multi-GPU support (DDP flags in bootstrap).
- Resume-from-Hub on HF Cloud.
- Scheduled jobs.
- Custom docker image input ("advanced: bring your own image").
- Mid-training checkpoint pushes to Hub (vs. only the final policy).
