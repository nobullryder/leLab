# Dataset Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separate "Record Dataset" and "Replay Dataset" actions on the landing page with a single "Dataset" action whose button opens a popover combobox supporting pick-existing, type-to-create-new (then opens RecordingModal), and type-org/name (opens HF viewer).

**Architecture:** New `DatasetPicker` component using the same Radix `Popover` + `Command` pattern as `RobotSelector`. A new `useDatasets` hook centralizes the fetch (was inline in `ReplayDataset`). `ActionList` gains an optional `trigger` field on the `Action` type to let one row render a popover-anchored button instead of a plain navigation arrow. The `/replay-dataset` route plus its page-only files are removed.

**Tech Stack:** React 18 + TypeScript, Vite, react-router-dom, Radix UI primitives via shadcn (`Popover`, `Command`, `Button`), `@/contexts/ApiContext` for fetcher, `@/hooks/use-toast` for feedback.

**Validation note:** This repo has no test suite, linter config, or build step ([CLAUDE.md](../../CLAUDE.md)). Each task ends with manual verification using `lelab --dev` (Vite at `:8080`, FastAPI at `:8000`). Keep commits frequent and small.

---

### Task 1: Add `useDatasets` hook

**Files:**
- Create: `frontend/src/hooks/useDatasets.ts`

- [ ] **Step 1: Write the hook**

Create `frontend/src/hooks/useDatasets.ts`:

```ts
import { useCallback, useEffect, useState } from "react";
import { useApi } from "@/contexts/ApiContext";
import { DatasetItem, listDatasets } from "@/lib/replayApi";

export const useDatasets = () => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [datasets, setDatasets] = useState<DatasetItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    listDatasets(baseUrl, fetchWithHeaders)
      .then(setDatasets)
      .catch(() => setDatasets([]))
      .finally(() => setLoading(false));
  }, [baseUrl, fetchWithHeaders]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { datasets, loading, refresh };
};
```

- [ ] **Step 2: Manual smoke check**

Run: `lelab --dev`, open `http://localhost:8080`. The hook is unused yet — confirm Vite compiles without TS errors (browser console + Vite terminal output should be clean). No UI change expected.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useDatasets.ts
git commit -m "feat(frontend): add useDatasets hook"
```

---

### Task 2: Create the `DatasetPicker` component

**Files:**
- Create: `frontend/src/components/landing/DatasetPicker.tsx`

The component is a controlled popover-combobox. It does not fetch on its own; consumer passes the list. It exposes three branches via callbacks. The trigger button is provided as `children` so the consumer can place it inside `ActionList` cleanly.

- [ ] **Step 1: Write the component**

Create `frontend/src/components/landing/DatasetPicker.tsx`:

```tsx
import React, { useState } from "react";
import { Plus, Check, ChevronsUpDown, ExternalLink } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { DatasetItem } from "@/lib/replayApi";

interface DatasetPickerProps {
  datasets: DatasetItem[];
  loading: boolean;
  onPickExisting: (repoId: string) => void;
  onCreateNew: (name: string) => void;
  onOpenCustom: (repoId: string) => void;
  children: React.ReactNode;
}

const REPO_ID_RE = /^[\w.\-]+\/[\w.\-]+$/;
const NAME_RE = /^[A-Za-z0-9._-]+$/;

const DatasetPicker: React.FC<DatasetPickerProps> = ({
  datasets,
  loading,
  onPickExisting,
  onCreateNew,
  onOpenCustom,
  children,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const trimmed = query.trim();
  const matchesExisting = datasets.some(
    (d) => d.repo_id.toLowerCase() === trimmed.toLowerCase(),
  );
  const isRepoId = REPO_ID_RE.test(trimmed);
  const isName = NAME_RE.test(trimmed) && !trimmed.includes("/");
  const canCreate = trimmed.length > 0 && isName && !matchesExisting;
  const canOpenCustom = isRepoId && !matchesExisting;

  const reset = () => {
    setQuery("");
    setOpen(false);
  };

  const handlePick = (repoId: string) => {
    onPickExisting(repoId);
    reset();
  };

  const handleCreate = () => {
    if (!canCreate) return;
    onCreateNew(trimmed);
    reset();
  };

  const handleOpenCustom = () => {
    if (!canOpenCustom) return;
    onOpenCustom(trimmed);
    reset();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className="w-[320px] p-0 bg-gray-800 border-gray-700 text-white"
        align="end"
      >
        <Command className="bg-gray-800">
          <CommandInput
            placeholder="Search, type a new name, or org/name…"
            value={query}
            onValueChange={setQuery}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              if (canCreate) {
                e.preventDefault();
                handleCreate();
              } else if (canOpenCustom) {
                e.preventDefault();
                handleOpenCustom();
              }
            }}
            className="text-white"
          />
          <CommandList>
            {datasets.length === 0 && !canCreate && !canOpenCustom && (
              <CommandEmpty className="py-4 text-sm text-gray-400 text-center">
                {loading
                  ? "Loading datasets…"
                  : "No datasets yet. Type a name to create one."}
              </CommandEmpty>
            )}
            {datasets.length > 0 && (
              <CommandGroup heading="Existing">
                {datasets.map((d) => (
                  <CommandItem
                    key={d.repo_id}
                    value={d.repo_id}
                    onSelect={() => handlePick(d.repo_id)}
                    className="text-white aria-selected:bg-gray-700"
                  >
                    <Check className="mr-2 h-4 w-4 opacity-0" />
                    <span className="flex-1 truncate">{d.repo_id}</span>
                    {d.private && (
                      <span className="text-xs text-amber-400">private</span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {canCreate && (
              <CommandGroup heading="New">
                <CommandItem
                  value={`__create__${trimmed}`}
                  onSelect={handleCreate}
                  className="text-white aria-selected:bg-gray-700"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Create &quot;{trimmed}&quot;
                </CommandItem>
              </CommandGroup>
            )}
            {canOpenCustom && (
              <CommandGroup heading="Custom repo">
                <CommandItem
                  value={`__open__${trimmed}`}
                  onSelect={handleOpenCustom}
                  className="text-white aria-selected:bg-gray-700"
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Open &quot;{trimmed}&quot; in viewer
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

export default DatasetPicker;
```

- [ ] **Step 2: Manual smoke check**

Run: `lelab --dev`. Confirm no TS errors in Vite output. Component is unused — no UI change yet.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/landing/DatasetPicker.tsx
git commit -m "feat(frontend): add DatasetPicker component"
```

---

### Task 3: Allow `ActionList` rows to render a custom trigger

**Files:**
- Modify: `frontend/src/components/landing/types.ts`
- Modify: `frontend/src/components/landing/ActionList.tsx`

Add an optional `trigger` slot on `Action`. When present, the row renders the provided node where the default arrow button would go; the row's own `handler` is then unused for that action.

- [ ] **Step 1: Update the `Action` type**

Replace the contents of `frontend/src/components/landing/types.ts`:

```ts
import { ReactNode } from "react";

export interface Action {
  title: string;
  description: string;
  handler: () => void;
  color: string;
  isWorkInProgress?: boolean;
  trigger?: ReactNode;
}
```

- [ ] **Step 2: Update `ActionList` to honor `trigger`**

In `frontend/src/components/landing/ActionList.tsx`, replace the `<Button …>` block at lines 52–58 with a conditional. Final file contents:

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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {actions.map((action, index) => (
          <div
            key={index}
            className="flex items-center justify-between p-3 bg-gray-800 rounded-lg border border-gray-700"
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
            {action.trigger ?? (
              <Button
                onClick={action.handler}
                size="icon"
                className={`${action.color} text-white`}
              >
                <ArrowRight className="w-5 h-5" />
              </Button>
            )}
          </div>
        ))}
      </div>
    </TooltipProvider>
  );
};

export default ActionList;
```

- [ ] **Step 3: Manual smoke check**

Run: `lelab --dev`. Open `:8080`. Verify the action list still renders all four actions identically (no behavioral change yet — `trigger` is unused everywhere). Click each — Record/Replay/Training/Inference still work as before.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/landing/types.ts frontend/src/components/landing/ActionList.tsx
git commit -m "feat(frontend): allow ActionList rows to render custom trigger"
```

---

### Task 4: Wire `DatasetPicker` into `Landing.tsx`

**Files:**
- Modify: `frontend/src/pages/Landing.tsx`

Replace the two action entries with a single Dataset entry whose `trigger` is the `DatasetPicker` popover. Move the open-in-viewer logic from `ReplayDataset` into Landing as `handlePickExisting`/`handleOpenCustom`. The "create" branch sets `datasetName` and reuses `handleRecordingClick`.

- [ ] **Step 1: Replace `Landing.tsx` contents**

Final file contents for `frontend/src/pages/Landing.tsx`:

```tsx
import React, { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import LandingTopBar from "@/components/landing/LandingTopBar";
import RobotConfigManager from "@/components/landing/RobotConfigManager";
import ActionList from "@/components/landing/ActionList";
import RecordingModal from "@/components/landing/RecordingModal";
import DatasetPicker from "@/components/landing/DatasetPicker";
import JobsSection from "@/components/jobs/JobsSection";

import { Action } from "@/components/landing/types";
import UsageInstructionsModal from "@/components/landing/UsageInstructionsModal";
import { useHfAuth } from "@/contexts/HfAuthContext";
import { useRobots } from "@/hooks/useRobots";
import { useDatasets } from "@/hooks/useDatasets";
import { CameraConfig } from "@/components/recording/CameraConfiguration";
import { isHostedSpace } from "@/lib/isHostedSpace";

const ON_SPACE = isHostedSpace();

const Landing = () => {
  const [showUsageModal, setShowUsageModal] = useState(ON_SPACE);
  const { auth } = useHfAuth();

  const {
    selectedName,
    selectedRecord,
    availableNames,
    isLoading: isLoadingRobots,
    selectRobot,
    createRobot,
    deleteRobot,
  } = useRobots();

  const { datasets, loading: datasetsLoading } = useDatasets();

  // Recording modal state
  const [showRecordingModal, setShowRecordingModal] = useState(false);
  const [datasetName, setDatasetName] = useState("");
  const [singleTask, setSingleTask] = useState("");
  const [numEpisodes, setNumEpisodes] = useState(5);
  const [episodeTimeS, setEpisodeTimeS] = useState(60);
  const [resetTimeS, setResetTimeS] = useState(15);
  const [cameras, setCameras] = useState<CameraConfig[]>([]);

  const releaseStreamsRef = useRef<(() => void) | null>(null);

  const navigate = useNavigate();
  const { toast } = useToast();

  // Clear camera state and release streams when returning to landing page
  useEffect(() => {
    if (cameras.length > 0) {
      console.log(
        "🧹 Landing page: Cleaning up camera state from previous session",
      );
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

  const openRecordingModal = () => {
    setCameras(selectedRecord ? [...(selectedRecord.cameras ?? [])] : []);
    setShowRecordingModal(true);
  };

  const handleRecordingModalClose = (open: boolean) => {
    setShowRecordingModal(open);
    if (!open && releaseStreamsRef.current) {
      console.log("🧹 Modal closed: Releasing camera streams");
      releaseStreamsRef.current();
    }
  };

  const handleTrainingClick = () => navigate("/training");
  const handleInferenceClick = () => navigate("/inference");

  const openDatasetInViewer = (repoId: string) => {
    const found = datasets.find((d) => d.repo_id === repoId);
    const needsAuth = !found || found.private;
    const spacePath = `/spaces/lerobot/visualize_dataset?path=${encodeURIComponent(`/${repoId}`)}`;
    const target = needsAuth
      ? `https://huggingface.co/login?next=${encodeURIComponent(spacePath)}`
      : `https://huggingface.co${spacePath}`;
    window.open(target, "_blank", "noopener,noreferrer");
  };

  const handleCreateDataset = (name: string) => {
    setDatasetName(name);
    openRecordingModal();
  };

  const handleStartRecording = async () => {
    if (!selectedRecord) {
      toast({
        title: "No robot selected",
        description: "Select or create a robot on the Landing page first.",
        variant: "destructive",
      });
      return;
    }
    const robot = selectedRecord;
    if (!robot.is_clean) {
      toast({
        title: "Robot not ready",
        description: `${robot.name} is missing a calibration. Configure it before recording.`,
        variant: "destructive",
      });
      return;
    }
    if (!datasetName || !singleTask) {
      toast({
        title: "Missing dataset details",
        description: "Please enter a dataset name and task description.",
        variant: "destructive",
      });
      return;
    }

    const datasetRepoId =
      auth.status === "authenticated"
        ? `${auth.username}/${datasetName}`
        : datasetName;

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
        description:
          "Camera streams released successfully. Starting recording...",
      });
    }

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
      {} as Record<
        string,
        {
          type: string;
          camera_index?: number;
          width: number;
          height: number;
          fps?: number;
        }
      >,
    );

    const recordingConfig = {
      leader_port: robot.leader_port,
      follower_port: robot.follower_port,
      leader_config: robot.leader_config,
      follower_config: robot.follower_config,
      dataset_repo_id: datasetRepoId,
      single_task: singleTask,
      num_episodes: numEpisodes,
      episode_time_s: episodeTimeS,
      reset_time_s: resetTimeS,
      fps: 30,
      video: true,
      push_to_hub: false,
      resume: false,
      cameras: cameraDict,
    };

    setShowRecordingModal(false);
    navigate("/recording", { state: { recordingConfig } });
  };

  const datasetTrigger = (
    <DatasetPicker
      datasets={datasets}
      loading={datasetsLoading}
      onPickExisting={openDatasetInViewer}
      onOpenCustom={openDatasetInViewer}
      onCreateNew={handleCreateDataset}
    >
      <Button
        size="icon"
        className="bg-purple-500 hover:bg-purple-600 text-white"
      >
        <ArrowRight className="w-5 h-5" />
      </Button>
    </DatasetPicker>
  );

  const actions: Action[] = [
    {
      title: "Dataset",
      description: "Pick an existing dataset or create a new one to record.",
      handler: () => {},
      color: "bg-purple-500 hover:bg-purple-600",
      trigger: datasetTrigger,
    },
    {
      title: "Training",
      description: "Train a model on your datasets.",
      handler: handleTrainingClick,
      color: "bg-green-500 hover:bg-green-600",
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
    <div
      className="min-h-screen bg-black text-white"
      style={{ ["--lelab-topbar-h" as string]: "48px" }}
    >
      <LandingTopBar />

      <div
        className="sticky z-20 bg-black/95 backdrop-blur supports-[backdrop-filter]:bg-black/70 border-b border-gray-800"
        style={{ top: "var(--lelab-topbar-h)" }}
      >
        <div className="mx-auto max-w-7xl px-4 py-4 grid gap-4 grid-cols-1 lg:grid-cols-[1.2fr_2fr]">
          <RobotConfigManager
            selectedName={selectedName}
            selectedRecord={selectedRecord}
            availableNames={availableNames}
            isLoading={isLoadingRobots}
            selectRobot={selectRobot}
            createRobot={createRobot}
            deleteRobot={deleteRobot}
          />
          <ActionList actions={actions} />
        </div>
      </div>

      <main className="mx-auto max-w-7xl px-4 py-6">
        <JobsSection />
      </main>

      <UsageInstructionsModal
        open={showUsageModal}
        onOpenChange={setShowUsageModal}
        dismissible={!ON_SPACE}
      />

      <RecordingModal
        open={showRecordingModal}
        onOpenChange={handleRecordingModalClose}
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
    </div>
  );
};

export default Landing;
```

- [ ] **Step 2: Manual validation**

Run: `lelab --dev`, open `http://localhost:8080`.

Verify:
1. Action list now shows three rows: **Dataset** (purple), **Training** (green), **Inference** (blue).
2. Click the purple arrow on **Dataset** → popover opens, shows existing datasets (or "Loading…"/"No datasets yet…" if none).
3. Pick an existing dataset → new tab opens at `huggingface.co/spaces/lerobot/visualize_dataset?path=…` (or login bounce for private). Popover closes. Landing page does not navigate.
4. Type a fresh single-word name (e.g. `pickup_v1`) → "Create *pickup_v1*" item appears → click it → `RecordingModal` opens with **Dataset Name** field pre-filled with `pickup_v1`.
5. Type `someorg/some-dataset` (with slash) → "Open *someorg/some-dataset* in viewer" item appears → click → new tab opens at the HF login bounce.
6. Type something with bad characters (`foo bar`, `foo/`, `/bar`) → no Create or Open item shown.
7. Robot picker, Training, Inference still work.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Landing.tsx
git commit -m "feat(frontend): merge record/replay into single Dataset action"
```

---

### Task 5: Remove dead code

**Files:**
- Delete: `frontend/src/pages/ReplayDataset.tsx`
- Delete: `frontend/src/components/replay/ReplayHeader.tsx`
- Delete: `frontend/src/components/replay/DatasetCombobox.tsx`
- Delete: `frontend/src/components/replay/` (directory, after files removed)
- Modify: `frontend/src/App.tsx`

`replayApi.ts` is **kept** (used by `useDatasets`).

- [ ] **Step 1: Confirm `replayApi.ts` is the only retained user**

Run from repo root:

```bash
grep -rn "from \"@/components/replay/" frontend/src/
grep -rn "from \"@/pages/ReplayDataset\"" frontend/src/
```

Expected: only matches inside files we are about to delete or modify in this task (e.g. `App.tsx`, `ReplayDataset.tsx`). If any other file consumes them, stop and report — the plan needs revision.

- [ ] **Step 2: Update `App.tsx`**

Edit `frontend/src/App.tsx`:
- Remove the import line `import ReplayDataset from "@/pages/ReplayDataset";` (line 18).
- Remove the route line `<Route path="/replay-dataset" element={<ReplayDataset />} />` (line 49).

- [ ] **Step 3: Delete the dead files**

```bash
rm frontend/src/pages/ReplayDataset.tsx
rm frontend/src/components/replay/ReplayHeader.tsx
rm frontend/src/components/replay/DatasetCombobox.tsx
rmdir frontend/src/components/replay
```

- [ ] **Step 4: Manual validation**

Run: `lelab --dev`. Confirm:
1. No TS / Vite errors in terminal output.
2. Landing page renders correctly (three actions).
3. Visiting `http://localhost:8080/replay-dataset` directly now shows the **NotFound** page.
4. The flows from Task 4 Step 2 still work.

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src/App.tsx frontend/src/pages/ReplayDataset.tsx frontend/src/components/replay/
git commit -m "chore(frontend): drop /replay-dataset route and dead components"
```

(Note: `git add -A` on deleted paths records the deletions. The `replay/` dir vanishes naturally once empty.)

---

### Task 6: Final end-to-end manual verification

**Files:** none

- [ ] **Step 1: Run a full smoke test**

Run: `lelab --dev`. From a fresh browser session at `http://localhost:8080`:

1. Action list shows exactly: Dataset (purple), Training (green), Inference (blue, with "Work in Progress" tag).
2. Robot section unchanged — pick / create / configure / teleop work.
3. Dataset popover:
   - Empty input + no datasets → "No datasets yet. Type a name to create one."
   - Existing dataset selected → opens HF viewer in new tab; popover closes; we stay on `/`.
   - Type new name → "Create" item; selecting opens RecordingModal with name pre-filled.
   - Type `org/name` → "Open in viewer" item; selecting opens HF login bounce.
   - Type invalid input (e.g. `foo bar`, `foo/`) → no actionable items.
4. Recording flow end-to-end (with a calibrated robot): create a dataset name → modal opens with name → fill task description → Start Recording → navigates to `/recording`.
5. Visit `/replay-dataset` directly → NotFound.
6. Browser console clean (only the existing camera-cleanup logs).

- [ ] **Step 2: Build the production bundle (optional sanity)**

If you want to confirm the production path is also clean (the GH Action does this on push, but local check is cheap):

```bash
cd frontend && npm run build
```

Expected: build succeeds, `frontend/dist/` updates. **Do not commit the rebuilt `dist/`** as part of this branch — the `build_frontend.yml` workflow handles that on `main` ([CLAUDE.md](../../CLAUDE.md)).

- [ ] **Step 3: No commit needed**

If everything passes, the feature is done.
