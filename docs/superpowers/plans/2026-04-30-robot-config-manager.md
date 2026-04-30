# Robot Config Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Landing's "Select Robot Model" radio with a per-robot tile manager. Each tile holds ports + leader/follower calibration, exposes a gear button to `/calibration` (pre-filled), and a Teleop button (red+disabled when not "clean").

**Architecture:** Backend persists one JSON per robot at `~/.cache/huggingface/lerobot/robots/<name>.json` and exposes CRUD endpoints. The Calibration page accepts an optional `robot_name` from route state and writes calibration results back into the robot record. Frontend introduces a `useRobots` hook (records hydrated from `GET /robots`, visible names backed by `localStorage.lelab.visibleRobots`), three new components (`RobotConfigManager`, `RobotTile`, `AddRobotPicker`), and removes the now-unused teleop modal flow from Landing.

**Tech Stack:** FastAPI (Python 3.10+), React 18 + TypeScript + Vite, shadcn/ui (Radix + Tailwind), `lucide-react` icons, react-router-dom v6.

> **Project context:** This repo has **no test suite, no linter, no build step**. Verification is manual: run `lelab --dev` (Vite on :8080, FastAPI on :8000), exercise the feature, and `curl` endpoints. Do NOT add pytest/jest/vitest scaffolding — those are out of scope per CLAUDE.md.

> **Spec:** [`docs/superpowers/specs/2026-04-30-robot-config-manager-design.md`](../specs/2026-04-30-robot-config-manager-design.md)

## File map

**Backend (modify):**
- `app/config.py` — add `ROBOTS_PATH` and robot-record helpers.
- `app/main.py` — add four `/robots` endpoints.
- `app/calibrating.py` — accept optional `robot_name` in `CalibrationRequest`; write back on completion.

**Frontend (create):**
- `frontend/src/hooks/useRobots.ts` — robot records + visible names state.
- `frontend/src/components/landing/RobotTile.tsx` — single robot tile.
- `frontend/src/components/landing/AddRobotPicker.tsx` — dropdown + free-text + "+ Add Robot".
- `frontend/src/components/landing/RobotConfigManager.tsx` — composition of picker + tile grid.

**Frontend (modify):**
- `frontend/src/pages/Landing.tsx` — swap selector, drop teleop modal/state/action.
- `frontend/src/pages/Calibration.tsx` — accept `robot_name` from route state, pre-fill, pass through.
- `frontend/src/components/landing/ActionList.tsx` — drop `robotModel` prop and the LeKiwi gating now that model selection is gone.

**Frontend (delete):**
- `frontend/src/components/landing/RobotModelSelector.tsx`
- `frontend/src/components/landing/TeleoperationModal.tsx`

---

## Task 1: Backend — robot-record storage helpers in `app/config.py`

**Files:**
- Modify: `app/config.py:21-28` (add `ROBOTS_PATH` near port/config paths)
- Modify: `app/config.py` (append helpers after `get_default_robot_config`, currently the last function)

- [ ] **Step 1: Add `ROBOTS_PATH` constant**

Modify `app/config.py`. After line 28 (end of the storage-paths block), add:

```python
# Robot config records (per-robot JSON metadata)
ROBOTS_PATH = os.path.expanduser("~/.cache/huggingface/lerobot/robots")
```

- [ ] **Step 2: Add `import json` at the top of `app/config.py` if not already imported**

Check the imports at the top of `app/config.py`. If `json` is not there, add `import json` after `import os`.

- [ ] **Step 3: Append robot-record helpers at the end of `app/config.py`**

Add the following after `get_default_robot_config`:

```python
# ---------------------------------------------------------------------------
# Robot record helpers
# ---------------------------------------------------------------------------

# Characters disallowed in a robot name (filesystem safety)
_INVALID_NAME_CHARS = ("/", "\\", "..")
_ROBOT_FIELDS = ("leader_port", "follower_port", "leader_config", "follower_config")


def _robot_record_path(name: str) -> str:
    return os.path.join(ROBOTS_PATH, f"{name}.json")


def is_valid_robot_name(name: str) -> bool:
    """Check that a robot name is safe to use as a filename."""
    if not name or not isinstance(name, str):
        return False
    if name.strip() != name:
        return False
    return not any(bad in name for bad in _INVALID_NAME_CHARS)


def _empty_record(name: str) -> dict:
    record = {"name": name}
    for field in _ROBOT_FIELDS:
        record[field] = ""
    return record


def get_robot_record(name: str) -> dict | None:
    """Return the robot record by name, or None if missing."""
    path = _robot_record_path(name)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        logger.error(f"Failed to read robot record {name}: {e}")
        return None
    # Ensure all expected fields exist (forward/back compat)
    record = _empty_record(name)
    record.update({k: v for k, v in data.items() if k in record})
    record["name"] = name
    return record


def list_robot_records() -> list[dict]:
    """Return all robot records on disk."""
    if not os.path.exists(ROBOTS_PATH):
        return []
    records = []
    for filename in sorted(os.listdir(ROBOTS_PATH)):
        if not filename.endswith(".json"):
            continue
        name = os.path.splitext(filename)[0]
        record = get_robot_record(name)
        if record is not None:
            records.append(record)
    return records


def save_robot_record(name: str, data: dict, allow_create: bool = True) -> bool:
    """
    Upsert a robot record. Merges `data` into the existing record, preserving
    fields not provided. Returns True if a write occurred, False if no-oped.

    - If the record exists: merge and write.
    - If the record does not exist and `allow_create` is True: create with empty
      fields then merge.
    - If the record does not exist and `allow_create` is False: log and no-op.
    """
    if not is_valid_robot_name(name):
        logger.error(f"Invalid robot name: {name!r}")
        return False

    os.makedirs(ROBOTS_PATH, exist_ok=True)
    existing = get_robot_record(name)
    if existing is None and not allow_create:
        logger.info(f"save_robot_record no-op: {name} does not exist (allow_create=False)")
        return False

    record = existing if existing is not None else _empty_record(name)
    for field in _ROBOT_FIELDS:
        if field in data and isinstance(data[field], str):
            record[field] = data[field]
    record["name"] = name

    path = _robot_record_path(name)
    with open(path, "w") as f:
        json.dump(record, f, indent=2)
    logger.info(f"Saved robot record {name}: {record}")
    return True


def delete_robot_record(name: str) -> bool:
    """Delete a robot record. Returns True if a file was removed."""
    if not is_valid_robot_name(name):
        return False
    path = _robot_record_path(name)
    if not os.path.exists(path):
        return False
    os.remove(path)
    logger.info(f"Deleted robot record {name}")
    return True


def is_robot_record_clean(record: dict) -> bool:
    """
    A record is 'clean' when all four operational fields are populated AND both
    referenced calibration files exist on disk.
    """
    if not record:
        return False
    for field in _ROBOT_FIELDS:
        value = record.get(field, "")
        if not isinstance(value, str) or not value.strip():
            return False
    leader_path = os.path.join(LEADER_CONFIG_PATH, record["leader_config"])
    follower_path = os.path.join(FOLLOWER_CONFIG_PATH, record["follower_config"])
    return os.path.exists(leader_path) and os.path.exists(follower_path)
```

- [ ] **Step 4: Smoke-test the helpers via Python REPL**

Run:

```bash
cd /Users/nicolasrabault/Projects/Hackathon/leLab
python -c "
from app.config import save_robot_record, get_robot_record, list_robot_records, delete_robot_record, is_robot_record_clean, is_valid_robot_name
assert is_valid_robot_name('left-arm') is True
assert is_valid_robot_name('') is False
assert is_valid_robot_name('a/b') is False
assert save_robot_record('plan-test-robot', {}, allow_create=True) is True
rec = get_robot_record('plan-test-robot')
assert rec is not None and rec['name'] == 'plan-test-robot' and rec['leader_port'] == ''
assert is_robot_record_clean(rec) is False
assert save_robot_record('plan-test-robot', {'leader_port': '/dev/ttyX'}) is True
assert get_robot_record('plan-test-robot')['leader_port'] == '/dev/ttyX'
assert save_robot_record('does-not-exist', {'leader_port': 'x'}, allow_create=False) is False
assert delete_robot_record('plan-test-robot') is True
assert get_robot_record('plan-test-robot') is None
print('OK')
"
```

Expected output: `OK` (and a few INFO log lines).

- [ ] **Step 5: Commit**

```bash
git add app/config.py
git commit -m "Add robot-record storage helpers in app/config.py"
```

---

## Task 2: Backend — `/robots` endpoints in `app/main.py`

**Files:**
- Modify: `app/main.py` (imports near line 38, new endpoints appended after the existing `/robot-config/...` endpoint at line 642)

- [ ] **Step 1: Extend the `app/config.py` import in `app/main.py`**

Find the existing `from .config import ...` block in `app/main.py` (search for `from .config import`). Add the new helper names to that import line. The result should include: `save_robot_record`, `get_robot_record`, `list_robot_records`, `delete_robot_record`, `is_robot_record_clean`, `is_valid_robot_name`.

If the existing line is, e.g., `from .config import save_robot_port, get_saved_robot_port, ...`, append the new names. Keep the import alphabetized only if the surrounding style does so; otherwise just append.

- [ ] **Step 2: Append the four `/robots` endpoints**

Insert after line 642 (end of `get_robot_config`), before the `@app.on_event("shutdown")` block:

```python
# ============================================================================
# Robot config records (named robots)

def _record_with_clean(record: dict) -> dict:
    """Attach `is_clean` to a record for API responses."""
    return {**record, "is_clean": is_robot_record_clean(record)}


@app.get("/robots")
def get_robots():
    """List all saved robot records."""
    try:
        records = [_record_with_clean(r) for r in list_robot_records()]
        return {"status": "success", "robots": records}
    except Exception as e:
        logger.error(f"Error listing robots: {e}")
        return {"status": "error", "message": str(e), "robots": []}


@app.get("/robots/{name}")
def get_robot(name: str):
    """Get a single robot record by name."""
    record = get_robot_record(name)
    if record is None:
        return {"status": "error", "message": "Robot not found"}, 404
    return {"status": "success", "robot": _record_with_clean(record)}


@app.post("/robots/{name}")
def upsert_robot(name: str, data: dict, create: bool = False):
    """
    Upsert a robot record.

    - `?create=true` is the "Add Robot" path: returns 409 if a record with that
      name already exists; otherwise creates with empty fields then merges body.
    - Without `?create=true` is the "patch" path (e.g., calibration write-back):
      merges body into existing record. If no record exists, no-ops and returns
      success — see deletion-during-calibration edge case in the spec.
    """
    if not is_valid_robot_name(name):
        return {"status": "error", "message": "Invalid robot name"}, 400
    try:
        if create:
            if get_robot_record(name) is not None:
                return {"status": "error", "message": "A robot with this name already exists"}, 409
            save_robot_record(name, data or {}, allow_create=True)
        else:
            save_robot_record(name, data or {}, allow_create=False)
        record = get_robot_record(name)
        if record is None:
            # The patch path against a missing record returns the absent state.
            return {"status": "success", "robot": None}
        return {"status": "success", "robot": _record_with_clean(record)}
    except Exception as e:
        logger.error(f"Error upserting robot {name}: {e}")
        return {"status": "error", "message": str(e)}, 500


@app.delete("/robots/{name}")
def delete_robot(name: str):
    """Delete a robot record."""
    if not is_valid_robot_name(name):
        return {"status": "error", "message": "Invalid robot name"}, 400
    if delete_robot_record(name):
        return {"status": "success"}
    return {"status": "error", "message": "Robot not found"}, 404
```

- [ ] **Step 3: Smoke-test endpoints with curl**

In one terminal:

```bash
cd /Users/nicolasrabault/Projects/Hackathon/leLab
lelab
```

In another terminal:

```bash
# Create
curl -s -X POST 'http://localhost:8000/robots/plan-test-1?create=true' -H 'Content-Type: application/json' -d '{}' | python -m json.tool
# Conflict on second create
curl -s -X POST 'http://localhost:8000/robots/plan-test-1?create=true' -H 'Content-Type: application/json' -d '{}' -o /dev/null -w "%{http_code}\n"
# Patch
curl -s -X POST 'http://localhost:8000/robots/plan-test-1' -H 'Content-Type: application/json' -d '{"leader_port":"/dev/ttyX"}' | python -m json.tool
# List
curl -s 'http://localhost:8000/robots' | python -m json.tool
# Get one
curl -s 'http://localhost:8000/robots/plan-test-1' | python -m json.tool
# Delete
curl -s -X DELETE 'http://localhost:8000/robots/plan-test-1' | python -m json.tool
# 404 on second delete
curl -s -X DELETE 'http://localhost:8000/robots/plan-test-1' -o /dev/null -w "%{http_code}\n"
```

Expected:
- First create returns `{"status":"success","robot":{"name":"plan-test-1","leader_port":"","follower_port":"","leader_config":"","follower_config":"","is_clean":false}}`
- Second create returns HTTP 409.
- Patch returns the record with `leader_port: "/dev/ttyX"` and `is_clean: false`.
- List includes `plan-test-1`.
- Get returns the same record.
- Delete returns `{"status":"success"}`.
- Second delete returns HTTP 404.

Stop `lelab` (Ctrl+C) when done.

- [ ] **Step 4: Commit**

```bash
git add app/main.py
git commit -m "Add /robots CRUD endpoints"
```

---

## Task 3: Backend — calibration write-back integration

**Files:**
- Modify: `app/calibrating.py:46-51` (extend `CalibrationRequest`)
- Modify: `app/calibrating.py:438-468` (add write-back inside `_complete_calibration`)

- [ ] **Step 1: Add `robot_name` to `CalibrationRequest`**

Replace lines 46–51 of `app/calibrating.py`:

```python
@dataclass
class CalibrationRequest:
    """Request parameters for starting calibration"""
    device_type: str  # "robot" or "teleop"
    port: str
    config_file: str
    robot_name: Optional[str] = None  # When set, write port + config back into the robot record on success
```

- [ ] **Step 2: Stash the request on the manager so the worker can read it**

Inside `CalibrationManager.start_calibration` (lines 130–173), right after the `self._update_status(...)` call (around line 151), add:

```python
            self._current_request = request
```

And inside `__init__` (lines 57–71), add the matching attribute initialization right after `self._homing_offsets = {}`:

```python
        self._current_request: Optional[CalibrationRequest] = None
```

- [ ] **Step 3: Write back to the robot record on successful completion**

At the end of `_complete_calibration` (after the existing `logger.info(f"Calibration saved to ...")` line at 468), add:

```python
        # Robot-record write-back: if this calibration was launched from a tile,
        # update the robot's port + config field for the side that was just calibrated.
        request = self._current_request
        if request is not None and request.robot_name:
            from .config import save_robot_record
            if request.device_type == "teleop":
                patch = {"leader_port": request.port, "leader_config": f"{request.config_file}.json"}
            elif request.device_type == "robot":
                patch = {"follower_port": request.port, "follower_config": f"{request.config_file}.json"}
            else:
                patch = None
            if patch is not None:
                save_robot_record(request.robot_name, patch, allow_create=False)
```

Note: `request.config_file` is the *base name* the user typed (no extension); calibration files are saved as `<config_file>.json` in `LEADER_CONFIG_PATH` / `FOLLOWER_CONFIG_PATH`. The robot record stores the filename *with* `.json` (matching how `setup_calibration_files` and `is_robot_record_clean` consume it).

- [ ] **Step 4: Verify with curl by simulating a write-back call directly**

We can't actually drive a full calibration without hardware, but we can prove the write-back code path doesn't error. Create a fake completion via a quick Python check:

```bash
cd /Users/nicolasrabault/Projects/Hackathon/leLab
python -c "
from app.config import save_robot_record, get_robot_record, delete_robot_record
# Simulate write-back from a teleop calibration
save_robot_record('plan-test-2', {}, allow_create=True)
save_robot_record('plan-test-2', {'leader_port': '/dev/ttyA', 'leader_config': 'plan-test-2-leader.json'}, allow_create=False)
rec = get_robot_record('plan-test-2')
assert rec['leader_port'] == '/dev/ttyA'
assert rec['leader_config'] == 'plan-test-2-leader.json'
assert rec['follower_port'] == ''
delete_robot_record('plan-test-2')
print('OK')
"
```

Expected: `OK`. (This validates the merge semantics that the write-back relies on.)

- [ ] **Step 5: Commit**

```bash
git add app/calibrating.py
git commit -m "Write calibration results back into robot record when robot_name is set"
```

---

## Task 4: Frontend — `useRobots` hook

**Files:**
- Create: `frontend/src/hooks/useRobots.ts`

- [ ] **Step 1: Create `useRobots.ts`**

Write the file:

```typescript
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useApi } from "@/contexts/ApiContext";
import { useToast } from "@/hooks/use-toast";

export interface RobotRecord {
  name: string;
  leader_port: string;
  follower_port: string;
  leader_config: string;
  follower_config: string;
  is_clean: boolean;
}

const VISIBLE_KEY = "lelab.visibleRobots";

const readVisible = (): string[] => {
  try {
    const raw = localStorage.getItem(VISIBLE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const writeVisible = (names: string[]) => {
  try {
    localStorage.setItem(VISIBLE_KEY, JSON.stringify(names));
  } catch {
    // Storage may be unavailable (private mode, quota). Failures here are non-fatal.
  }
};

export const useRobots = () => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { toast } = useToast();
  const location = useLocation();

  const [records, setRecords] = useState<Record<string, RobotRecord>>({});
  const [visibleNames, setVisibleNames] = useState<string[]>(() => readVisible());
  const [isLoading, setIsLoading] = useState(false);

  // Re-fetch records whenever Landing is navigated to (location.key changes on every nav)
  useEffect(() => {
    let cancelled = false;
    const fetchAll = async () => {
      setIsLoading(true);
      try {
        const res = await fetchWithHeaders(`${baseUrl}/robots`);
        const data = await res.json();
        if (cancelled) return;
        const next: Record<string, RobotRecord> = {};
        for (const r of data.robots ?? []) next[r.name] = r;
        setRecords(next);
        // Prune visible names whose records vanished (deleted from another tab)
        setVisibleNames((prev) => {
          const pruned = prev.filter((n) => n in next);
          if (pruned.length !== prev.length) writeVisible(pruned);
          return pruned;
        });
      } catch (e) {
        if (!cancelled) {
          console.error("Failed to fetch robots:", e);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    fetchAll();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchWithHeaders, location.key]);

  // Persist visible names to localStorage
  useEffect(() => {
    writeVisible(visibleNames);
  }, [visibleNames]);

  const addToSession = useCallback((name: string) => {
    setVisibleNames((prev) => (prev.includes(name) ? prev : [...prev, name]));
  }, []);

  const removeFromSession = useCallback((name: string) => {
    setVisibleNames((prev) => prev.filter((n) => n !== name));
  }, []);

  const createRobot = useCallback(
    async (rawName: string): Promise<boolean> => {
      const name = rawName.trim();
      if (!name) {
        toast({ title: "Missing name", description: "Robot name cannot be empty.", variant: "destructive" });
        return false;
      }
      if (/[/\\]|\.\./.test(name)) {
        toast({ title: "Invalid name", description: "Robot names cannot contain '/', '\\', or '..'", variant: "destructive" });
        return false;
      }
      try {
        const res = await fetchWithHeaders(`${baseUrl}/robots/${encodeURIComponent(name)}?create=true`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (res.status === 409) {
          toast({
            title: "Already exists",
            description: `A robot named "${name}" already exists. Pick it from the dropdown or choose a different name.`,
            variant: "destructive",
          });
          return false;
        }
        if (!res.ok) {
          const text = await res.text();
          toast({ title: "Failed to create", description: text, variant: "destructive" });
          return false;
        }
        const data = await res.json();
        if (data.robot) {
          setRecords((prev) => ({ ...prev, [name]: data.robot }));
          setVisibleNames((prev) => (prev.includes(name) ? prev : [...prev, name]));
        }
        return true;
      } catch (e) {
        toast({ title: "Network error", description: String(e), variant: "destructive" });
        return false;
      }
    },
    [baseUrl, fetchWithHeaders, toast]
  );

  const deleteRobot = useCallback(
    async (name: string): Promise<boolean> => {
      try {
        const res = await fetchWithHeaders(`${baseUrl}/robots/${encodeURIComponent(name)}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const text = await res.text();
          toast({ title: "Failed to delete", description: text, variant: "destructive" });
          return false;
        }
        setRecords((prev) => {
          const { [name]: _omit, ...rest } = prev;
          return rest;
        });
        setVisibleNames((prev) => prev.filter((n) => n !== name));
        return true;
      } catch (e) {
        toast({ title: "Network error", description: String(e), variant: "destructive" });
        return false;
      }
    },
    [baseUrl, fetchWithHeaders, toast]
  );

  const visibleRecords = useMemo(
    () => visibleNames.map((n) => records[n]).filter((r): r is RobotRecord => Boolean(r)),
    [visibleNames, records]
  );

  const hiddenNames = useMemo(
    () => Object.keys(records).filter((n) => !visibleNames.includes(n)).sort(),
    [records, visibleNames]
  );

  return {
    records,
    visibleRecords,
    hiddenNames,
    isLoading,
    addToSession,
    removeFromSession,
    createRobot,
    deleteRobot,
  };
};
```

- [ ] **Step 2: Verify the file compiles by running Vite**

```bash
cd /Users/nicolasrabault/Projects/Hackathon/leLab/frontend
npm run build
```

Expected: Build succeeds. The hook is unused right now so no runtime errors. If TypeScript reports an unused export warning, that's fine.

If you don't want to run a full build, run only the type-check via:

```bash
cd /Users/nicolasrabault/Projects/Hackathon/leLab/frontend
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useRobots.ts
git commit -m "Add useRobots hook for managing robot records and session visibility"
```

---

## Task 5: Frontend — `RobotTile` component

**Files:**
- Create: `frontend/src/components/landing/RobotTile.tsx`

- [ ] **Step 1: Create `RobotTile.tsx`**

Write the file:

```tsx
import React, { useState } from "react";
import { Settings, X, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RobotRecord } from "@/hooks/useRobots";

interface RobotTileProps {
  robot: RobotRecord;
  onConfigure: (name: string) => void;
  onTeleop: (robot: RobotRecord) => void;
  onRemoveFromSession: (name: string) => void;
  onDelete: (name: string) => void;
}

const RobotTile: React.FC<RobotTileProps> = ({
  robot,
  onConfigure,
  onTeleop,
  onRemoveFromSession,
  onDelete,
}) => {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const status = robot.is_clean ? "Ready" : "Needs configuration";
  const teleopDisabled = !robot.is_clean;

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-4 flex flex-col gap-3 relative">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="font-semibold text-white truncate">{robot.name}</h4>
          <p
            className={`text-xs mt-0.5 ${
              robot.is_clean ? "text-green-400" : "text-amber-400"
            }`}
          >
            {status}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-gray-300 hover:text-white"
                onClick={() => onConfigure(robot.name)}
                aria-label="Configure"
              >
                <Settings className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Configure (calibrate)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-gray-400 hover:text-white"
                onClick={() => onRemoveFromSession(robot.name)}
                aria-label="Hide for this session"
              >
                <X className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Hide for this session</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-red-400 hover:text-red-300 hover:bg-red-900/20"
                onClick={() => setConfirmDelete(true)}
                aria-label="Delete robot"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete robot config</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="w-full">
            <Button
              onClick={() => onTeleop(robot)}
              disabled={teleopDisabled}
              className={`w-full ${
                teleopDisabled
                  ? "bg-red-500/30 hover:bg-red-500/30 text-red-200 cursor-not-allowed"
                  : "bg-yellow-500 hover:bg-yellow-600 text-white"
              }`}
            >
              Teleoperation
            </Button>
          </div>
        </TooltipTrigger>
        {teleopDisabled && (
          <TooltipContent>Configure the robot first.</TooltipContent>
        )}
      </Tooltip>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="bg-gray-900 border-gray-800 text-white">
          <DialogHeader>
            <DialogTitle>Delete robot config?</DialogTitle>
            <DialogDescription className="text-gray-400">
              This deletes the robot config file from disk. Calibration files
              are not removed. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex gap-2 justify-end">
            <Button
              variant="outline"
              className="border-gray-600 text-gray-300"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
            <Button
              className="bg-red-500 hover:bg-red-600 text-white"
              onClick={async () => {
                setConfirmDelete(false);
                await onDelete(robot.name);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default RobotTile;
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/nicolasrabault/Projects/Hackathon/leLab/frontend
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/landing/RobotTile.tsx
git commit -m "Add RobotTile component"
```

---

## Task 6: Frontend — `AddRobotPicker` component

**Files:**
- Create: `frontend/src/components/landing/AddRobotPicker.tsx`

- [ ] **Step 1: Create `AddRobotPicker.tsx`**

Write the file:

```tsx
import React, { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface AddRobotPickerProps {
  hiddenNames: string[];
  onAddExisting: (name: string) => void;
  onCreateNew: (name: string) => Promise<boolean>;
  isLoading: boolean;
}

const AddRobotPicker: React.FC<AddRobotPickerProps> = ({
  hiddenNames,
  onAddExisting,
  onCreateNew,
  isLoading,
}) => {
  const [selected, setSelected] = useState("");
  const [newName, setNewName] = useState("");

  const handleAdd = async () => {
    const trimmed = newName.trim();
    if (trimmed) {
      const ok = await onCreateNew(trimmed);
      if (ok) {
        setNewName("");
        setSelected("");
      }
      return;
    }
    if (selected) {
      onAddExisting(selected);
      setSelected("");
    }
  };

  const canAdd = newName.trim().length > 0 || selected.length > 0;

  return (
    <div className="bg-gray-800/50 rounded-lg p-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div className="space-y-2">
        <Label className="text-sm font-medium text-gray-300">
          Existing Robots
        </Label>
        <Select value={selected} onValueChange={setSelected} disabled={isLoading}>
          <SelectTrigger className="bg-gray-800 border-gray-700 text-white">
            <SelectValue
              placeholder={
                isLoading
                  ? "Loading..."
                  : hiddenNames.length === 0
                  ? "No hidden robots"
                  : "Select a robot"
              }
            />
          </SelectTrigger>
          <SelectContent className="bg-gray-800 border-gray-700">
            {hiddenNames.map((name) => (
              <SelectItem
                key={name}
                value={name}
                className="text-white hover:bg-gray-700"
              >
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium text-gray-300">
          New Robot Name
        </Label>
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="e.g., left-arm"
          className="bg-gray-800 border-gray-700 text-white"
        />
      </div>

      <div className="space-y-2 flex flex-col justify-end">
        <Button
          onClick={handleAdd}
          disabled={!canAdd}
          className="bg-blue-500 hover:bg-blue-600 text-white"
        >
          <Plus className="w-4 h-4 mr-2" />
          Add Robot
        </Button>
      </div>
    </div>
  );
};

export default AddRobotPicker;
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/nicolasrabault/Projects/Hackathon/leLab/frontend
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/landing/AddRobotPicker.tsx
git commit -m "Add AddRobotPicker component"
```

---

## Task 7: Frontend — `RobotConfigManager` component

**Files:**
- Create: `frontend/src/components/landing/RobotConfigManager.tsx`

- [ ] **Step 1: Create `RobotConfigManager.tsx`**

Write the file:

```tsx
import React from "react";
import { useNavigate } from "react-router-dom";
import { Bot } from "lucide-react";
import { useApi } from "@/contexts/ApiContext";
import { useToast } from "@/hooks/use-toast";
import { useRobots, RobotRecord } from "@/hooks/useRobots";
import RobotTile from "./RobotTile";
import AddRobotPicker from "./AddRobotPicker";

const RobotConfigManager: React.FC = () => {
  const navigate = useNavigate();
  const { baseUrl, fetchWithHeaders } = useApi();
  const { toast } = useToast();
  const {
    visibleRecords,
    hiddenNames,
    isLoading,
    addToSession,
    removeFromSession,
    createRobot,
    deleteRobot,
  } = useRobots();

  const handleConfigure = (name: string) => {
    navigate("/calibration", { state: { robot_name: name } });
  };

  const handleTeleop = async (robot: RobotRecord) => {
    try {
      const res = await fetchWithHeaders(`${baseUrl}/move-arm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leader_port: robot.leader_port,
          follower_port: robot.follower_port,
          leader_config: robot.leader_config,
          follower_config: robot.follower_config,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast({
          title: "Teleoperation Started",
          description: data.message || `Started teleoperation for ${robot.name}.`,
        });
        navigate("/teleoperation");
      } else {
        toast({
          title: "Error Starting Teleoperation",
          description: data.message || "Failed to start.",
          variant: "destructive",
        });
      }
    } catch (e) {
      toast({
        title: "Connection Error",
        description: "Could not connect to the backend server.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white text-xl">Robots</h2>
      </div>

      <AddRobotPicker
        hiddenNames={hiddenNames}
        onAddExisting={addToSession}
        onCreateNew={createRobot}
        isLoading={isLoading}
      />

      {visibleRecords.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {visibleRecords.map((r) => (
            <RobotTile
              key={r.name}
              robot={r}
              onConfigure={handleConfigure}
              onTeleop={handleTeleop}
              onRemoveFromSession={removeFromSession}
              onDelete={deleteRobot}
            />
          ))}
        </div>
      ) : (
        <div className="text-center py-8 text-gray-500">
          <Bot className="w-12 h-12 mx-auto mb-4 text-gray-600" />
          <p>No robots configured. Add one to get started.</p>
        </div>
      )}
    </div>
  );
};

export default RobotConfigManager;
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/nicolasrabault/Projects/Hackathon/leLab/frontend
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/landing/RobotConfigManager.tsx
git commit -m "Add RobotConfigManager component"
```

---

## Task 8: Frontend — Wire `RobotConfigManager` into Landing; remove the teleop modal flow

**Files:**
- Modify: `frontend/src/pages/Landing.tsx` (multiple regions)

- [ ] **Step 1: Replace `RobotModelSelector` import and `Landing.tsx` body**

Open `frontend/src/pages/Landing.tsx`. Replace the entire file with:

```tsx
import React, { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import LandingHeader from "@/components/landing/LandingHeader";
import HfAuthBanner from "@/components/landing/HfAuthBanner";
import RobotConfigManager from "@/components/landing/RobotConfigManager";
import ActionList from "@/components/landing/ActionList";
import PermissionModal from "@/components/landing/PermissionModal";
import RecordingModal from "@/components/landing/RecordingModal";

import { Action } from "@/components/landing/types";
import UsageInstructionsModal from "@/components/landing/UsageInstructionsModal";
import { useApi } from "@/contexts/ApiContext";
import { useHfAuth } from "@/contexts/HfAuthContext";
import { CameraConfig } from "@/components/recording/CameraConfiguration";
import { isHostedSpace } from "@/lib/isHostedSpace";

const ON_SPACE = isHostedSpace();

const Landing = () => {
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  const [showUsageModal, setShowUsageModal] = useState(ON_SPACE);

  const { baseUrl, fetchWithHeaders } = useApi();
  const { auth } = useHfAuth();

  // Recording state (kept as-is — out of scope this round)
  const [showRecordingModal, setShowRecordingModal] = useState(false);
  const [recordLeaderPort, setRecordLeaderPort] = useState(
    "/dev/tty.usbmodem5A460816421"
  );
  const [recordFollowerPort, setRecordFollowerPort] = useState(
    "/dev/tty.usbmodem5A460816621"
  );
  const [recordLeaderConfig, setRecordLeaderConfig] = useState("");
  const [recordFollowerConfig, setRecordFollowerConfig] = useState("");
  const [leaderConfigs, setLeaderConfigs] = useState<string[]>([]);
  const [followerConfigs, setFollowerConfigs] = useState<string[]>([]);
  const [isLoadingConfigs, setIsLoadingConfigs] = useState(false);
  const [datasetName, setDatasetName] = useState("");
  const [singleTask, setSingleTask] = useState("");
  const [numEpisodes, setNumEpisodes] = useState(5);
  const [cameras, setCameras] = useState<CameraConfig[]>([]);

  const releaseStreamsRef = useRef<(() => void) | null>(null);

  const navigate = useNavigate();
  const { toast } = useToast();

  // Clear camera state and release streams when returning to landing page
  useEffect(() => {
    if (cameras.length > 0) {
      console.log("🧹 Landing page: Cleaning up camera state from previous session");
      if (releaseStreamsRef.current) {
        releaseStreamsRef.current();
      }
      setCameras([]);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (releaseStreamsRef.current) {
        console.log("🧹 Landing page: Cleaning up camera streams on unmount");
        releaseStreamsRef.current();
      }
    };
  }, []);

  const loadConfigs = async () => {
    setIsLoadingConfigs(true);
    try {
      const response = await fetchWithHeaders(`${baseUrl}/get-configs`);
      const data = await response.json();
      setLeaderConfigs(data.leader_configs || []);
      setFollowerConfigs(data.follower_configs || []);
    } catch (error) {
      toast({
        title: "Error Loading Configs",
        description: "Could not load calibration configs from the backend.",
        variant: "destructive",
      });
    } finally {
      setIsLoadingConfigs(false);
    }
  };

  const handleCalibrationClick = () => {
    navigate("/calibration");
  };

  const handleRecordingClick = () => {
    setShowRecordingModal(true);
    loadConfigs();
  };

  const handleRecordingModalClose = (open: boolean) => {
    setShowRecordingModal(open);
    if (!open && releaseStreamsRef.current) {
      console.log("🧹 Modal closed: Releasing camera streams");
      releaseStreamsRef.current();
    }
  };

  const handleTrainingClick = () => navigate("/training");
  const handleReplayDatasetClick = () => navigate("/replay-dataset");
  const handleInferenceClick = () => navigate("/inference");

  const handleStartRecording = async () => {
    if (!recordLeaderConfig || !recordFollowerConfig || !datasetName || !singleTask) {
      toast({
        title: "Missing Configuration",
        description:
          "Please fill in all required fields: calibration configs, dataset name, and task description.",
        variant: "destructive",
      });
      return;
    }

    const datasetRepoId =
      auth.status === "authenticated" ? `${auth.username}/${datasetName}` : datasetName;

    if (cameras.length > 0 && releaseStreamsRef.current) {
      console.log("🔓 Releasing camera streams before starting recording...");
      toast({
        title: "Preparing Camera Resources",
        description: `Releasing ${cameras.length} camera stream(s) for recording...`,
      });
      releaseStreamsRef.current();
      await new Promise((resolve) => setTimeout(resolve, 500));
      console.log("✅ Camera streams released, proceeding with recording...");
      toast({
        title: "Camera Resources Ready",
        description: "Camera streams released successfully. Starting recording...",
      });
    }

    const cameraDict = cameras.reduce((acc, cam) => {
      acc[cam.name] = {
        type: cam.type,
        camera_index: cam.camera_index,
        width: cam.width,
        height: cam.height,
        fps: cam.fps,
      };
      return acc;
    }, {} as Record<string, { type: string; camera_index?: number; width: number; height: number; fps?: number }>);

    const recordingConfig = {
      leader_port: recordLeaderPort,
      follower_port: recordFollowerPort,
      leader_config: recordLeaderConfig,
      follower_config: recordFollowerConfig,
      dataset_repo_id: datasetRepoId,
      single_task: singleTask,
      num_episodes: numEpisodes,
      episode_time_s: 60,
      reset_time_s: 15,
      fps: 30,
      video: true,
      push_to_hub: false,
      resume: false,
      cameras: cameraDict,
    };

    setShowRecordingModal(false);
    navigate("/recording", { state: { recordingConfig } });
  };

  const handlePermissions = async (allow: boolean) => {
    setShowPermissionModal(false);
    if (allow) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        stream.getTracks().forEach((track) => track.stop());
        toast({
          title: "Permissions Granted",
          description: "Camera and microphone access enabled. Entering control session...",
        });
        navigate("/control");
      } catch (error) {
        toast({
          title: "Permission Denied",
          description: "Camera and microphone access is required for robot control.",
          variant: "destructive",
        });
      }
    } else {
      toast({
        title: "Permission Denied",
        description: "You can proceed, but with limited functionality.",
        variant: "destructive",
      });
      navigate("/control");
    }
  };

  // Teleoperation is now per-robot on the tile, so it's not in this list.
  const actions: Action[] = [
    {
      title: "Calibration",
      description: "Calibrate robot arm positions.",
      handler: handleCalibrationClick,
      color: "bg-indigo-500 hover:bg-indigo-600",
      isWorkInProgress: false,
    },
    {
      title: "Record Dataset",
      description: "Record episodes for training data.",
      handler: handleRecordingClick,
      color: "bg-red-500 hover:bg-red-600",
    },
    {
      title: "Replay Dataset",
      description: "Replay and analyze recorded datasets.",
      handler: handleReplayDatasetClick,
      color: "bg-purple-500 hover:bg-purple-600",
      isWorkInProgress: true,
    },
    {
      title: "Training",
      description: "Train a model on your datasets.",
      handler: handleTrainingClick,
      color: "bg-green-500 hover:bg-green-600",
      isWorkInProgress: true,
    },
    {
      title: "Inference",
      description: "Run a trained model on the robot arm.",
      handler: handleInferenceClick,
      color: "bg-blue-500 hover:bg-blue-600",
      isWorkInProgress: true,
    },
  ];

  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center p-4 pt-12 sm:pt-20">
      <div className="w-full max-w-7xl mx-auto px-4 mb-12">
        <HfAuthBanner />
        <LandingHeader />
      </div>

      <div className="p-8 bg-gray-900 rounded-lg shadow-xl w-full max-w-4xl space-y-6 border border-gray-700">
        <RobotConfigManager />
        <ActionList actions={actions} />
      </div>

      <PermissionModal
        open={showPermissionModal}
        onOpenChange={setShowPermissionModal}
        onPermissionsResult={handlePermissions}
      />

      <UsageInstructionsModal
        open={showUsageModal}
        onOpenChange={setShowUsageModal}
        dismissible={!ON_SPACE}
      />

      <RecordingModal
        open={showRecordingModal}
        onOpenChange={handleRecordingModalClose}
        leaderPort={recordLeaderPort}
        setLeaderPort={setRecordLeaderPort}
        followerPort={recordFollowerPort}
        setFollowerPort={setRecordFollowerPort}
        leaderConfig={recordLeaderConfig}
        setLeaderConfig={setRecordLeaderConfig}
        followerConfig={recordFollowerConfig}
        setFollowerConfig={setRecordFollowerConfig}
        leaderConfigs={leaderConfigs}
        followerConfigs={followerConfigs}
        datasetName={datasetName}
        setDatasetName={setDatasetName}
        singleTask={singleTask}
        setSingleTask={setSingleTask}
        numEpisodes={numEpisodes}
        setNumEpisodes={setNumEpisodes}
        cameras={cameras}
        setCameras={setCameras}
        isLoadingConfigs={isLoadingConfigs}
        onStart={handleStartRecording}
        releaseStreamsRef={releaseStreamsRef}
      />
    </div>
  );
};

export default Landing;
```

`ActionList` is now rendered without the `robotModel` prop. The `ActionList` component itself is updated in Step 2 of this task. The original `handleBeginSession` (which was already dead code in the source — not wired into any JSX) is intentionally not present in the rewrite above.

- [ ] **Step 2: Update `ActionList.tsx` to drop the `robotModel` prop**

Open `frontend/src/components/landing/ActionList.tsx`. Replace the entire file with:

```tsx
import React from "react";
import { Button } from "@/components/ui/button";
import { ArrowRight, AlertTriangle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Action } from "./types";

interface ActionListProps {
  actions: Action[];
}

const ActionList: React.FC<ActionListProps> = ({ actions }) => {
  return (
    <TooltipProvider>
      <div className="pt-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {actions.map((action, index) => (
            <div
              key={index}
              className="flex items-center justify-between p-4 bg-gray-800 rounded-lg border border-gray-700"
            >
              <div className="flex items-center gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-lg text-left">
                      {action.title}
                    </h3>
                    {action.isWorkInProgress && (
                      <div className="flex items-center gap-1">
                        <Tooltip>
                          <TooltipTrigger>
                            <AlertTriangle className="w-4 h-4 text-yellow-500" />
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>Work in progress</p>
                          </TooltipContent>
                        </Tooltip>
                        <span className="text-yellow-500 text-xs font-medium">
                          Work in Progress
                        </span>
                      </div>
                    )}
                  </div>
                  <p className="text-gray-400 text-sm text-left">
                    {action.description}
                  </p>
                </div>
              </div>
              <Button
                onClick={action.handler}
                size="icon"
                className={`${action.color} text-white`}
              >
                <ArrowRight className="w-5 h-5" />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </TooltipProvider>
  );
};

export default ActionList;
```

- [ ] **Step 3: Verify the rewrite removed all teleop-modal references**

Run:

```bash
rtk grep -n "TeleoperationModal\|RobotModelSelector\|handleBeginSession\|handleTeleoperationClick\|handleStartTeleoperation\|showTeleoperationModal" /Users/nicolasrabault/Projects/Hackathon/leLab/frontend/src/pages/Landing.tsx
```

Expected: no results.

Then check `robotModel` is gone from Landing and ActionList:

```bash
rtk grep -rn "robotModel" /Users/nicolasrabault/Projects/Hackathon/leLab/frontend/src
```

Expected: no results in `Landing.tsx` or `ActionList.tsx`. (Other files unrelated to this change won't appear because none reference `robotModel`.)

- [ ] **Step 4: Type-check**

```bash
cd /Users/nicolasrabault/Projects/Hackathon/leLab/frontend
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Manual smoke test**

```bash
cd /Users/nicolasrabault/Projects/Hackathon/leLab
lelab --dev
```

Open `http://localhost:8080/`. Verify:
- "Robots" section appears at the top of the card (no more SO-100/101 vs LeKiwi radio).
- Empty state says "No robots configured. Add one to get started."
- Below, the action list shows Calibration, Record Dataset, Replay Dataset, Training, Inference. **No Teleoperation entry.**
- Type a name into "New Robot Name" → click "+ Add Robot" → tile appears with status "Needs configuration", red disabled Teleop button, gear/X/trash icons.
- Click X → tile disappears.
- Reopen by selecting from the "Existing Robots" dropdown → tile reappears.
- Refresh the page (F5) → tile is still there (localStorage).
- Click trash → confirm modal → tile disappears AND the robot disappears from the dropdown.

Stop `lelab` (Ctrl+C) when done.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Landing.tsx frontend/src/components/landing/ActionList.tsx
git commit -m "Replace robot model selector with RobotConfigManager on Landing"
```

---

## Task 9: Frontend — Calibration page accepts `robot_name` from route state

**Files:**
- Modify: `frontend/src/pages/Calibration.tsx`

- [ ] **Step 1: Read existing structure to find anchor points**

Open `frontend/src/pages/Calibration.tsx` and locate:
- The hooks block near line 67–106 where `useState`s for `deviceType`, `port`, `configFile` are declared.
- The `useApi` import — `useLocation` will be added next to it.
- The fetch call that posts to `/start-calibration` (search for `start-calibration` in this file). The body currently sends `{ device_type, port, config_file }`. We'll add `robot_name`.

- [ ] **Step 2: Add `useLocation` import and read `robot_name` from state**

In `frontend/src/pages/Calibration.tsx`, find:

```typescript
import { useNavigate } from "react-router-dom";
```

Replace with:

```typescript
import { useNavigate, useLocation } from "react-router-dom";
```

Inside the `Calibration` component body, after `const navigate = useNavigate();` (around line 68), add:

```typescript
  const location = useLocation();
  const robotName = (location.state as { robot_name?: string } | null)?.robot_name ?? null;
```

- [ ] **Step 3: Pre-fill ports + config from the robot record on mount**

Add a `useEffect` after the existing form-state declarations (after the `setConfigFile` line near 78). Insert:

```typescript
  // If we arrived from a robot tile, pre-fill the form from that robot's record.
  useEffect(() => {
    if (!robotName) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithHeaders(
          `${baseUrl}/robots/${encodeURIComponent(robotName)}`
        );
        if (!res.ok) return;
        const data = await res.json();
        const robot = data.robot;
        if (!robot || cancelled) return;
        // Default to whichever side still needs calibration.
        const defaultDevice =
          !robot.leader_config && robot.follower_config
            ? "robot"
            : "teleop";
        setDeviceType(defaultDevice);
        if (defaultDevice === "teleop") {
          setPort(robot.leader_port || "");
          setConfigFile(
            robot.leader_config ? robot.leader_config.replace(/\.json$/, "") : ""
          );
        } else {
          setPort(robot.follower_port || "");
          setConfigFile(
            robot.follower_config ? robot.follower_config.replace(/\.json$/, "") : ""
          );
        }
      } catch (e) {
        console.error("Failed to load robot record for prefill:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [robotName, baseUrl, fetchWithHeaders]);
```

Note: `configFile` in this page is the *base name* (no `.json`); the backend appends `.json` when writing. So we strip `.json` when pre-filling.

- [ ] **Step 4: When the user toggles `deviceType`, swap the pre-filled port and config**

Find the `Select` for `deviceType` (search for `setDeviceType`). Add a wrapper handler so that toggling re-pulls the matching side from the robot record (only when `robotName` is set):

```typescript
  const handleDeviceTypeChange = async (next: string) => {
    setDeviceType(next);
    if (!robotName) return;
    try {
      const res = await fetchWithHeaders(
        `${baseUrl}/robots/${encodeURIComponent(robotName)}`
      );
      if (!res.ok) return;
      const data = await res.json();
      const robot = data.robot;
      if (!robot) return;
      if (next === "teleop") {
        setPort(robot.leader_port || "");
        setConfigFile(
          robot.leader_config ? robot.leader_config.replace(/\.json$/, "") : ""
        );
      } else {
        setPort(robot.follower_port || "");
        setConfigFile(
          robot.follower_config ? robot.follower_config.replace(/\.json$/, "") : ""
        );
      }
    } catch (e) {
      console.error("Failed to swap robot record on device toggle:", e);
    }
  };
```

Then change the `Select`'s `onValueChange={setDeviceType}` to `onValueChange={handleDeviceTypeChange}`.

- [ ] **Step 5: Pass `robot_name` in the start-calibration request body**

Find the fetch to `/start-calibration` in this file. The body currently looks like:

```typescript
        body: JSON.stringify({
          device_type: deviceType,
          port: port,
          config_file: configFile,
        }),
```

Replace with:

```typescript
        body: JSON.stringify({
          device_type: deviceType,
          port: port,
          config_file: configFile,
          robot_name: robotName,  // null is fine; backend treats it as no-write-back
        }),
```

- [ ] **Step 6: Type-check**

```bash
cd /Users/nicolasrabault/Projects/Hackathon/leLab/frontend
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Manual smoke test (no hardware needed for prefill paths)**

```bash
cd /Users/nicolasrabault/Projects/Hackathon/leLab
lelab --dev
```

Steps:
1. On Landing, add a robot named "smoke-test". Click its gear icon.
2. On the Calibration page, the URL should be `/calibration` and the form should show: Device Type = `teleop`, Port = (empty for a fresh robot), Config = (empty). All three fields are still editable.
3. Toggle Device Type to `robot` — Port and Config should clear/empty (no follower_port set yet).
4. Manually fill in port and config name to test the regular calibration UI still works (no need to actually start a calibration without hardware).
5. Hit browser back → Landing → tile is still "Needs configuration" (we haven't completed a calibration).
6. To exercise the write-back, run this curl while on a fresh terminal (simulates a successful calibration completion):
   ```bash
   curl -s -X POST 'http://localhost:8000/robots/smoke-test' \
     -H 'Content-Type: application/json' \
     -d '{"leader_port":"/dev/ttyA","leader_config":"smoke-test-leader.json","follower_port":"/dev/ttyB","follower_config":"smoke-test-follower.json"}' \
     | python -m json.tool
   ```
   Then click back to Landing — the tile status should still be "Needs configuration" because the calibration *files* don't exist on disk (we only wrote the metadata). That's correct: `is_clean` requires both files to exist.
7. Cleanup: click the trash on the smoke-test tile.

Stop `lelab` (Ctrl+C) when done.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/Calibration.tsx
git commit -m "Pre-fill Calibration page from robot record and pass robot_name to backend"
```

---

## Task 10: Frontend — Delete the unused `RobotModelSelector` and `TeleoperationModal`

**Files:**
- Delete: `frontend/src/components/landing/RobotModelSelector.tsx`
- Delete: `frontend/src/components/landing/TeleoperationModal.tsx`

- [ ] **Step 1: Confirm no remaining imports**

```bash
rtk grep -rn "RobotModelSelector\|TeleoperationModal" /Users/nicolasrabault/Projects/Hackathon/leLab/frontend/src
```

Expected: no results. (If any results appear, fix the offending import before continuing.)

- [ ] **Step 2: Delete the files**

```bash
cd /Users/nicolasrabault/Projects/Hackathon/leLab
rm frontend/src/components/landing/RobotModelSelector.tsx
rm frontend/src/components/landing/TeleoperationModal.tsx
```

- [ ] **Step 3: Type-check**

```bash
cd /Users/nicolasrabault/Projects/Hackathon/leLab/frontend
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add -A frontend/src/components/landing/
git commit -m "Remove unused RobotModelSelector and TeleoperationModal"
```

---

## Task 11: End-to-end verification

- [ ] **Step 1: Run the dev server**

```bash
cd /Users/nicolasrabault/Projects/Hackathon/leLab
lelab --dev
```

- [ ] **Step 2: Walk through the full flow in the browser at `http://localhost:8080/`**

Verify each of these:

1. **Empty state:** Robots section shows "No robots configured." Action list shows Calibration, Record Dataset, Replay Dataset, Training, Inference (no Teleoperation entry).
2. **Add a robot:** Type "left-arm" → "+ Add Robot". Tile appears with status "Needs configuration", red disabled Teleop button.
3. **Configure (gear):** Click the gear icon. The Calibration page loads with Device Type = `teleop` and empty Port/Config fields. URL is `/calibration`. Toggle Device Type to `robot` — fields clear.
4. **Back to Landing:** Click the browser back button. Tile is still there, still "Needs configuration".
5. **Hide for session (X):** Click X. Tile vanishes. The "Existing Robots" dropdown now shows "left-arm" — pick it → tile returns.
6. **Persistence across refresh:** Refresh (F5). Tile is still visible (localStorage).
7. **Delete (trash):** Click trash → confirm. Tile disappears AND "left-arm" no longer in the Existing Robots dropdown.
8. **File on disk gone:** In a terminal, `ls ~/.cache/huggingface/lerobot/robots/` — should NOT contain `left-arm.json`.
9. **Recording modal still works:** Click "Record Dataset" — its modal still asks for ports + leader/follower configs as before (no regression).

- [ ] **Step 3: Verify `is_clean` flips when both calibration files actually exist**

If you have hardware, run a real calibration through the gear button. Otherwise, simulate by:

```bash
# Make sure the calibration directories exist
mkdir -p ~/.cache/huggingface/lerobot/calibration/teleoperators/so_leader
mkdir -p ~/.cache/huggingface/lerobot/calibration/robots/so_follower
# Drop dummy files
echo '{}' > ~/.cache/huggingface/lerobot/calibration/teleoperators/so_leader/e2e-fake-leader.json
echo '{}' > ~/.cache/huggingface/lerobot/calibration/robots/so_follower/e2e-fake-follower.json
# Add a robot pointing at them
curl -s -X POST 'http://localhost:8000/robots/e2e?create=true' -H 'Content-Type: application/json' -d '{}' > /dev/null
curl -s -X POST 'http://localhost:8000/robots/e2e' -H 'Content-Type: application/json' -d '{
  "leader_port": "/dev/ttyA",
  "follower_port": "/dev/ttyB",
  "leader_config": "e2e-fake-leader.json",
  "follower_config": "e2e-fake-follower.json"
}' | python -m json.tool
```

Expected: the response shows `"is_clean": true`. In the browser, the "e2e" tile (you may need to add it from the dropdown if not visible) should show "Ready" in green, and the Teleop button should be enabled in yellow. Don't actually click Teleop without hardware.

Cleanup:
```bash
curl -s -X DELETE 'http://localhost:8000/robots/e2e' > /dev/null
rm ~/.cache/huggingface/lerobot/calibration/teleoperators/so_leader/e2e-fake-leader.json
rm ~/.cache/huggingface/lerobot/calibration/robots/so_follower/e2e-fake-follower.json
```

Stop `lelab` (Ctrl+C).

- [ ] **Step 4: Build the production bundle to confirm CI compatibility**

```bash
cd /Users/nicolasrabault/Projects/Hackathon/leLab/frontend
npm run build
```

Expected: build succeeds. The committed `frontend/dist/` will be regenerated. **Do not commit `frontend/dist/`** — the GitHub Action `build_frontend.yml` rebuilds it on push to main. (Per CLAUDE.md, local rebuild is for verification only.)

- [ ] **Step 5: Final commit if anything is dirty**

```bash
git status
```

If only `frontend/dist/**` appears as modified, leave it (the workflow rebuilds it). Otherwise investigate before committing.

---

## Out of scope (follow-ups)

- Migrate Recording, Replay, Training, Inference modals to a "Robot" dropdown that selects a saved robot.
- Add a `model` field to the robot record when a second robot model is supported.
- Replace the manual curl/browser verification with an actual test suite.
