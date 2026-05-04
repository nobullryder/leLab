# Training Page Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Training page's 8-card configuration grid with a focused two-card layout — one essentials card surfacing the 5 fields users actually need, one collapsible Advanced card holding the rest — and drop fields that don't apply to SO-101 (sim-environment / eval) or are dead UI.

**Architecture:** Frontend-only refactor inside `frontend/src/components/training/`. Two new components (`EssentialsCard`, `AdvancedCard`) replace 8 deleted ones. `TrainingConfig` interface and `Training.tsx` state initialiser are trimmed of removed fields. Backend (`app/training.py`) is untouched — its Pydantic defaults already cover every removed field.

**Tech Stack:** React + TypeScript + Vite, shadcn/ui primitives (`Card`, `Input`, `Label`, `Switch`, `Select`, `Button`, `Separator`), `lucide-react` icons, Tailwind classes consistent with existing pages.

**Spec:** [docs/superpowers/specs/2026-05-04-training-page-simplification-design.md](../specs/2026-05-04-training-page-simplification-design.md)

**No test suite exists in this repo** (per `CLAUDE.md`). Verification is a combination of TypeScript compilation (`npm run build` from `frontend/`) and manual checks in `lelab --dev`. Each task ends with at least a `tsc`-clean check; the user-facing tasks include manual smoke testing.

**Task ordering rationale:** Build new components first (codebase still uses old ones, no breakage). Wire ConfigurationTab to the new components (old card files still exist on disk but are no longer imported, types still have all fields, build stays green). Smoke-test in browser. Delete old files. Strip types + state initialiser together (must be one commit because Training.tsx initial state must agree with the type at all times).

---

### Task 1: Create `EssentialsCard.tsx`

**Files:**
- Create: `frontend/src/components/training/config/EssentialsCard.tsx`

- [ ] **Step 1: Create the file**

Create `frontend/src/components/training/config/EssentialsCard.tsx` with this exact content:

```tsx
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ConfigComponentProps } from '../types';

const EssentialsCard: React.FC<ConfigComponentProps> = ({ config, updateConfig }) => {
  return (
    <Card className="bg-slate-800/50 border-slate-700 rounded-xl">
      <CardHeader>
        <CardTitle className="text-white">Run Configuration</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <Label htmlFor="dataset_repo_id" className="text-slate-300">
            Dataset Repository ID *
          </Label>
          <Input
            id="dataset_repo_id"
            value={config.dataset_repo_id}
            onChange={(e) => updateConfig('dataset_repo_id', e.target.value)}
            placeholder="e.g., your-username/your-dataset"
            className="bg-slate-900 border-slate-600 text-white rounded-lg"
          />
          <p className="text-xs text-slate-500 mt-1">
            HuggingFace Hub dataset repository ID
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="policy_type" className="text-slate-300">
              Policy
            </Label>
            <Select
              value={config.policy_type}
              onValueChange={(value) => updateConfig('policy_type', value)}
            >
              <SelectTrigger className="bg-slate-900 border-slate-600 text-white rounded-lg">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-600">
                <SelectItem value="act">ACT (Action Chunking Transformer)</SelectItem>
                <SelectItem value="diffusion">Diffusion Policy</SelectItem>
                <SelectItem value="pi0">PI0</SelectItem>
                <SelectItem value="smolvla">SmolVLA</SelectItem>
                <SelectItem value="tdmpc">TD-MPC</SelectItem>
                <SelectItem value="vqbet">VQ-BeT</SelectItem>
                <SelectItem value="pi0fast">PI0 Fast</SelectItem>
                <SelectItem value="sac">SAC</SelectItem>
                <SelectItem value="reward_classifier">Reward Classifier</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="steps" className="text-slate-300">
              Training Steps
            </Label>
            <Input
              id="steps"
              type="number"
              value={config.steps}
              onChange={(e) => updateConfig('steps', parseInt(e.target.value))}
              className="bg-slate-900 border-slate-600 text-white rounded-lg"
            />
          </div>

          <div>
            <Label htmlFor="batch_size" className="text-slate-300">
              Batch Size
            </Label>
            <Input
              id="batch_size"
              type="number"
              value={config.batch_size}
              onChange={(e) => updateConfig('batch_size', parseInt(e.target.value))}
              className="bg-slate-900 border-slate-600 text-white rounded-lg"
            />
          </div>

          <div className="flex items-center space-x-3 pt-6">
            <Switch
              id="wandb_enable"
              checked={config.wandb_enable}
              onCheckedChange={(checked) => updateConfig('wandb_enable', checked)}
            />
            <Label htmlFor="wandb_enable" className="text-slate-300">
              Enable Weights & Biases
            </Label>
          </div>
        </div>

        {config.wandb_enable && (
          <div>
            <Label htmlFor="wandb_project" className="text-slate-300">
              W&B Project Name
            </Label>
            <Input
              id="wandb_project"
              value={config.wandb_project || ''}
              onChange={(e) =>
                updateConfig('wandb_project', e.target.value || undefined)
              }
              placeholder="my-robotics-project"
              className="bg-slate-900 border-slate-600 text-white rounded-lg"
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default EssentialsCard;
```

- [ ] **Step 2: Verify TypeScript compiles**

Run from `frontend/`:

```bash
npm run build
```

Expected: build succeeds. The new file is unused at this point but should compile cleanly.

If you see "Cannot find module" for any UI primitive, list the files in `frontend/src/components/ui/` to confirm names — this codebase uses standard shadcn names (`card.tsx`, `input.tsx`, `label.tsx`, `switch.tsx`, `select.tsx`).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/training/config/EssentialsCard.tsx
git commit -m "feat(training): add EssentialsCard for primary run configuration"
```

---

### Task 2: Create `AdvancedCard.tsx`

**Files:**
- Create: `frontend/src/components/training/config/AdvancedCard.tsx`

- [ ] **Step 1: Create the file**

Create `frontend/src/components/training/config/AdvancedCard.tsx` with this exact content:

```tsx
import React, { useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { ConfigComponentProps } from '../types';

const SectionHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
    {children}
  </h4>
);

const AdvancedCard: React.FC<ConfigComponentProps> = ({ config, updateConfig }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card className="bg-slate-800/50 border-slate-700 rounded-xl">
      <CardHeader
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        className="cursor-pointer select-none flex flex-row items-center justify-between"
      >
        <span className="text-white font-semibold">Advanced</span>
        <span className="flex items-center gap-1 text-slate-400 text-sm">
          {expanded ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
          {expanded ? 'Hide' : 'Show'}
        </span>
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-8">
          {/* Policy */}
          <section className="space-y-4">
            <SectionHeading>Policy</SectionHeading>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="policy_device" className="text-slate-300">
                  Device
                </Label>
                <Select
                  value={config.policy_device || 'cuda'}
                  onValueChange={(value) => updateConfig('policy_device', value)}
                >
                  <SelectTrigger className="bg-slate-900 border-slate-600 text-white rounded-lg">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-600">
                    <SelectItem value="cuda">CUDA (GPU)</SelectItem>
                    <SelectItem value="cpu">CPU</SelectItem>
                    <SelectItem value="mps">MPS (Apple Silicon)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center space-x-3 pt-6">
                <Switch
                  id="policy_use_amp"
                  checked={config.policy_use_amp}
                  onCheckedChange={(checked) => updateConfig('policy_use_amp', checked)}
                />
                <Label htmlFor="policy_use_amp" className="text-slate-300">
                  Use Automatic Mixed Precision
                </Label>
              </div>
            </div>
          </section>

          <Separator className="bg-slate-700" />

          {/* Training */}
          <section className="space-y-4">
            <SectionHeading>Training</SectionHeading>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="seed" className="text-slate-300">
                  Random Seed
                </Label>
                <Input
                  id="seed"
                  type="number"
                  value={config.seed ?? ''}
                  onChange={(e) =>
                    updateConfig(
                      'seed',
                      e.target.value ? parseInt(e.target.value) : undefined
                    )
                  }
                  className="bg-slate-900 border-slate-600 text-white rounded-lg"
                />
              </div>
              <div>
                <Label htmlFor="num_workers" className="text-slate-300">
                  Number of Workers
                </Label>
                <Input
                  id="num_workers"
                  type="number"
                  value={config.num_workers}
                  onChange={(e) => updateConfig('num_workers', parseInt(e.target.value))}
                  className="bg-slate-900 border-slate-600 text-white rounded-lg"
                />
              </div>
            </div>
          </section>

          <Separator className="bg-slate-700" />

          {/* Optimizer */}
          <section className="space-y-4">
            <SectionHeading>Optimizer</SectionHeading>
            <div>
              <Label htmlFor="optimizer_type" className="text-slate-300">
                Optimizer
              </Label>
              <Select
                value={config.optimizer_type || 'adam'}
                onValueChange={(value) => updateConfig('optimizer_type', value)}
              >
                <SelectTrigger className="bg-slate-900 border-slate-600 text-white rounded-lg">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-600">
                  <SelectItem value="adam">Adam</SelectItem>
                  <SelectItem value="adamw">AdamW</SelectItem>
                  <SelectItem value="sgd">SGD</SelectItem>
                  <SelectItem value="multi_adam">Multi Adam</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label htmlFor="optimizer_lr" className="text-slate-300">
                  Learning Rate
                </Label>
                <Input
                  id="optimizer_lr"
                  type="number"
                  step="0.0001"
                  value={config.optimizer_lr ?? ''}
                  onChange={(e) =>
                    updateConfig(
                      'optimizer_lr',
                      e.target.value ? parseFloat(e.target.value) : undefined
                    )
                  }
                  placeholder="Use policy default"
                  className="bg-slate-900 border-slate-600 text-white rounded-lg"
                />
              </div>
              <div>
                <Label htmlFor="optimizer_weight_decay" className="text-slate-300">
                  Weight Decay
                </Label>
                <Input
                  id="optimizer_weight_decay"
                  type="number"
                  step="0.0001"
                  value={config.optimizer_weight_decay ?? ''}
                  onChange={(e) =>
                    updateConfig(
                      'optimizer_weight_decay',
                      e.target.value ? parseFloat(e.target.value) : undefined
                    )
                  }
                  placeholder="Use policy default"
                  className="bg-slate-900 border-slate-600 text-white rounded-lg"
                />
              </div>
              <div>
                <Label htmlFor="optimizer_grad_clip_norm" className="text-slate-300">
                  Gradient Clipping
                </Label>
                <Input
                  id="optimizer_grad_clip_norm"
                  type="number"
                  value={config.optimizer_grad_clip_norm ?? ''}
                  onChange={(e) =>
                    updateConfig(
                      'optimizer_grad_clip_norm',
                      e.target.value ? parseFloat(e.target.value) : undefined
                    )
                  }
                  placeholder="Use policy default"
                  className="bg-slate-900 border-slate-600 text-white rounded-lg"
                />
              </div>
            </div>
          </section>

          <Separator className="bg-slate-700" />

          {/* Logging & Checkpointing */}
          <section className="space-y-4">
            <SectionHeading>Logging & Checkpointing</SectionHeading>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="log_freq" className="text-slate-300">
                  Log Frequency
                </Label>
                <Input
                  id="log_freq"
                  type="number"
                  value={config.log_freq}
                  onChange={(e) => updateConfig('log_freq', parseInt(e.target.value))}
                  className="bg-slate-900 border-slate-600 text-white rounded-lg"
                />
              </div>
              <div>
                <Label htmlFor="save_freq" className="text-slate-300">
                  Save Frequency
                </Label>
                <Input
                  id="save_freq"
                  type="number"
                  value={config.save_freq}
                  onChange={(e) => updateConfig('save_freq', parseInt(e.target.value))}
                  className="bg-slate-900 border-slate-600 text-white rounded-lg"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="output_dir" className="text-slate-300">
                Output Directory
              </Label>
              <Input
                id="output_dir"
                value={config.output_dir}
                onChange={(e) => updateConfig('output_dir', e.target.value)}
                className="bg-slate-900 border-slate-600 text-white rounded-lg"
              />
            </div>
            <div>
              <Label htmlFor="job_name" className="text-slate-300">
                Job Name (optional)
              </Label>
              <Input
                id="job_name"
                value={config.job_name || ''}
                onChange={(e) =>
                  updateConfig('job_name', e.target.value || undefined)
                }
                className="bg-slate-900 border-slate-600 text-white rounded-lg"
              />
            </div>
            <div className="flex items-center space-x-3">
              <Switch
                id="save_checkpoint"
                checked={config.save_checkpoint}
                onCheckedChange={(checked) => updateConfig('save_checkpoint', checked)}
              />
              <Label htmlFor="save_checkpoint" className="text-slate-300">
                Save Checkpoints
              </Label>
            </div>
            <div className="flex items-center space-x-3">
              <Switch
                id="resume"
                checked={config.resume}
                onCheckedChange={(checked) => updateConfig('resume', checked)}
              />
              <Label htmlFor="resume" className="text-slate-300">
                Resume from Checkpoint
              </Label>
            </div>
          </section>

          {config.wandb_enable && (
            <>
              <Separator className="bg-slate-700" />
              <section className="space-y-4">
                <SectionHeading>Weights & Biases</SectionHeading>
                <div>
                  <Label htmlFor="wandb_entity" className="text-slate-300">
                    W&B Entity (optional)
                  </Label>
                  <Input
                    id="wandb_entity"
                    value={config.wandb_entity || ''}
                    onChange={(e) =>
                      updateConfig('wandb_entity', e.target.value || undefined)
                    }
                    placeholder="your-username"
                    className="bg-slate-900 border-slate-600 text-white rounded-lg"
                  />
                </div>
                <div>
                  <Label htmlFor="wandb_notes" className="text-slate-300">
                    W&B Notes (optional)
                  </Label>
                  <Input
                    id="wandb_notes"
                    value={config.wandb_notes || ''}
                    onChange={(e) =>
                      updateConfig('wandb_notes', e.target.value || undefined)
                    }
                    placeholder="Training run notes..."
                    className="bg-slate-900 border-slate-600 text-white rounded-lg"
                  />
                </div>
                <div>
                  <Label htmlFor="wandb_mode" className="text-slate-300">
                    W&B Mode
                  </Label>
                  <Select
                    value={config.wandb_mode || 'online'}
                    onValueChange={(value) => updateConfig('wandb_mode', value)}
                  >
                    <SelectTrigger className="bg-slate-900 border-slate-600 text-white rounded-lg">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-slate-800 border-slate-600">
                      <SelectItem value="online">Online</SelectItem>
                      <SelectItem value="offline">Offline</SelectItem>
                      <SelectItem value="disabled">Disabled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center space-x-3">
                  <Switch
                    id="wandb_disable_artifact"
                    checked={config.wandb_disable_artifact}
                    onCheckedChange={(checked) =>
                      updateConfig('wandb_disable_artifact', checked)
                    }
                  />
                  <Label htmlFor="wandb_disable_artifact" className="text-slate-300">
                    Disable Artifacts
                  </Label>
                </div>
              </section>
            </>
          )}

          <Separator className="bg-slate-700" />

          {/* Misc */}
          <section className="space-y-4">
            <SectionHeading>Misc</SectionHeading>
            <div className="flex items-center space-x-3">
              <Switch
                id="use_policy_training_preset"
                checked={config.use_policy_training_preset}
                onCheckedChange={(checked) =>
                  updateConfig('use_policy_training_preset', checked)
                }
              />
              <Label htmlFor="use_policy_training_preset" className="text-slate-300">
                Use Policy Training Preset
              </Label>
            </div>
          </section>
        </CardContent>
      )}
    </Card>
  );
};

export default AdvancedCard;
```

- [ ] **Step 2: Verify TypeScript compiles**

Run from `frontend/`:

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/training/config/AdvancedCard.tsx
git commit -m "feat(training): add collapsible AdvancedCard for power-user knobs"
```

---

### Task 3: Replace `ConfigurationTab` to use the new cards

**Files:**
- Modify: `frontend/src/components/training/ConfigurationTab.tsx` (full rewrite)

- [ ] **Step 1: Replace the file contents**

Overwrite `frontend/src/components/training/ConfigurationTab.tsx` with:

```tsx
import React from 'react';
import EssentialsCard from './config/EssentialsCard';
import AdvancedCard from './config/AdvancedCard';
import { ConfigComponentProps } from './types';

const ConfigurationTab: React.FC<ConfigComponentProps> = ({ config, updateConfig }) => {
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <EssentialsCard config={config} updateConfig={updateConfig} />
      <AdvancedCard config={config} updateConfig={updateConfig} />
    </div>
  );
};

export default ConfigurationTab;
```

The eight old config files (`DatasetConfig.tsx`, `PolicyConfig.tsx`, `TrainingParams.tsx`, `OptimizerConfig.tsx`, `LoggingConfig.tsx`, `WandbConfig.tsx`, `EnvEvalConfig.tsx`, `AdvancedConfig.tsx`) still exist on disk but are no longer imported. They'll be deleted in Task 5. The build stays green at this checkpoint because `TrainingConfig` still has every field they reference.

- [ ] **Step 2: Verify TypeScript compiles**

Run from `frontend/`:

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 3: Manual smoke test in dev mode**

In one terminal: `lelab --dev` (this spawns Vite on :8080 and uvicorn on :8000, opens browser to :8080).

Visit `/training` (click Training from the landing page or navigate directly). Verify:

- [ ] Page renders without console errors.
- [ ] A single "Run Configuration" card is visible with: Dataset Repository ID input, then a 2-column grid with Policy / Steps / Batch Size / Enable Weights & Biases toggle.
- [ ] Toggling "Enable Weights & Biases" reveals a "W&B Project Name" input below the grid.
- [ ] An "Advanced" card sits below it, collapsed, with a chevron and "Show" label.
- [ ] Clicking the Advanced header expands it and reveals: Policy section (Device, AMP toggle), Training (Seed, Num Workers), Optimizer (Optimizer + LR/WD/Grad-Clip row), Logging & Checkpointing (Log Freq, Save Freq, Output Dir, Job Name, Save Checkpoints, Resume), and Misc (Use Policy Training Preset).
- [ ] When W&B is enabled, expanding Advanced also shows a "Weights & Biases" section with Entity / Notes / Mode / Disable Artifacts.
- [ ] The "Start Training" floating button at bottom-right is disabled when Dataset Repository ID is empty, enabled when filled.

If any of these fail, fix the relevant Task 1/2 component before continuing. Stop the dev server (`Ctrl+C`).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/training/ConfigurationTab.tsx
git commit -m "refactor(training): swap 8-card grid for Essentials + Advanced layout"
```

---

### Task 4: Network smoke test — confirm `POST /start-training` still works

**Goal:** Confirm the trimmed payload (still sending all current `TrainingConfig` fields, since types haven't been stripped yet) starts a training process and the backend accepts it. This catches any pre-existing bug *before* we touch types in Task 6, so a future regression is unambiguous.

This task uses a deliberately impossible dataset ID so training starts but exits quickly with a "dataset not found"-class error in the logs. It validates request acceptance, not training success.

- [ ] **Step 1: Start dev server**

Run `lelab --dev` in a terminal.

- [ ] **Step 2: In the browser at `/training`, fill the form**

- Dataset Repository ID: `nonexistent-user/nonexistent-dataset-test-only`
- Leave everything else default.
- Click **Start Training**.

- [ ] **Step 3: Verify acceptance**

Expected:
- A green "Training Started" toast appears.
- The page automatically switches to the Monitoring tab.
- Logs begin streaming. Within a few seconds you should see error messages from the LeRobot CLI complaining about the missing dataset (e.g. a `RepositoryNotFoundError` or similar). This is the expected outcome — the request was accepted by the backend.

If instead you see a "Failed to start training" toast, inspect the browser DevTools network tab for the response body of `POST /start-training` and the uvicorn terminal for any 422 validation errors. Fix before continuing.

- [ ] **Step 4: Stop the test run**

Click **Stop Training** (the red floating button). Confirm the toast says "Training Stopped". Stop the dev server.

- [ ] **Step 5: No commit**

This task makes no code changes — it's pure verification.

---

### Task 5: Delete the eight old config files

**Files:**
- Delete: `frontend/src/components/training/config/DatasetConfig.tsx`
- Delete: `frontend/src/components/training/config/PolicyConfig.tsx`
- Delete: `frontend/src/components/training/config/TrainingParams.tsx`
- Delete: `frontend/src/components/training/config/OptimizerConfig.tsx`
- Delete: `frontend/src/components/training/config/LoggingConfig.tsx`
- Delete: `frontend/src/components/training/config/WandbConfig.tsx`
- Delete: `frontend/src/components/training/config/EnvEvalConfig.tsx`
- Delete: `frontend/src/components/training/config/AdvancedConfig.tsx`

- [ ] **Step 1: Confirm none of them are imported anywhere**

Run from the repo root:

```bash
grep -rn "DatasetConfig\|PolicyConfig\|TrainingParams\|OptimizerConfig\|LoggingConfig\|WandbConfig\|EnvEvalConfig" frontend/src --include='*.tsx' --include='*.ts'
grep -rn "from './AdvancedConfig'\|from \"./AdvancedConfig\"\|/AdvancedConfig'" frontend/src --include='*.tsx' --include='*.ts'
```

(Two greps because `AdvancedConfig` is too generic — search by import path.)

Expected: no output for either. If anything matches, the import is stale and must be cleaned up before deleting (almost certainly a leftover import in `ConfigurationTab.tsx`, which Task 3 already replaced).

- [ ] **Step 2: Delete the files**

```bash
git rm frontend/src/components/training/config/DatasetConfig.tsx \
       frontend/src/components/training/config/PolicyConfig.tsx \
       frontend/src/components/training/config/TrainingParams.tsx \
       frontend/src/components/training/config/OptimizerConfig.tsx \
       frontend/src/components/training/config/LoggingConfig.tsx \
       frontend/src/components/training/config/WandbConfig.tsx \
       frontend/src/components/training/config/EnvEvalConfig.tsx \
       frontend/src/components/training/config/AdvancedConfig.tsx
```

- [ ] **Step 3: Verify TypeScript compiles**

Run from `frontend/`:

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(training): drop the eight old per-section config cards"
```

---

### Task 6: Strip removed fields from `TrainingConfig` and `Training.tsx` state

**Why one commit:** `Training.tsx` initialises every field declared on `TrainingConfig`. If we strip the type without trimming state init we get TS errors; if we trim state init without stripping the type the unused fields silently linger and reappear next time someone reads the type. Do both atomically.

**Files:**
- Modify: `frontend/src/components/training/types.ts` (full rewrite of the `TrainingConfig` interface)
- Modify: `frontend/src/pages/Training.tsx` lines 15-38 (the `useState<TrainingConfig>({...})` initialiser)

- [ ] **Step 1: Replace `frontend/src/components/training/types.ts`**

Overwrite the entire file with:

```ts
export interface TrainingConfig {
  // Dataset configuration
  dataset_repo_id: string;

  // Policy configuration
  policy_type: string;

  // Core training parameters
  steps: number;
  batch_size: number;
  seed?: number;
  num_workers: number;

  // Logging and checkpointing
  log_freq: number;
  save_freq: number;
  save_checkpoint: boolean;

  // Output configuration
  output_dir: string;
  resume: boolean;
  job_name?: string;

  // Weights & Biases
  wandb_enable: boolean;
  wandb_project?: string;
  wandb_entity?: string;
  wandb_notes?: string;
  wandb_mode?: string;
  wandb_disable_artifact: boolean;

  // Policy-specific parameters
  policy_device?: string;
  policy_use_amp: boolean;

  // Optimizer parameters
  optimizer_type?: string;
  optimizer_lr?: number;
  optimizer_weight_decay?: number;
  optimizer_grad_clip_norm?: number;

  // Advanced configuration
  use_policy_training_preset: boolean;
}

export interface TrainingStatus {
  training_active: boolean;
  current_step: number;
  total_steps: number;
  current_loss?: number;
  current_lr?: number;
  grad_norm?: number;
  epoch_time?: number;
  eta_seconds?: number;
  available_controls: {
    stop_training: boolean;
    pause_training: boolean;
    resume_training: boolean;
  };
}

export interface LogEntry {
  timestamp: number;
  message: string;
}

export interface ConfigComponentProps {
  config: TrainingConfig;
  updateConfig: <T extends keyof TrainingConfig>(
    key: T,
    value: TrainingConfig[T]
  ) => void;
}
```

(Removed from `TrainingConfig`: `dataset_revision`, `dataset_root`, `dataset_episodes`, `eval_freq`, `env_type`, `env_task`, `eval_n_episodes`, `eval_batch_size`, `eval_use_async_envs`, `wandb_run_id`, `config_path`. `TrainingStatus`, `LogEntry`, and `ConfigComponentProps` are unchanged.)

- [ ] **Step 2: Trim the state initialiser in `Training.tsx`**

In `frontend/src/pages/Training.tsx`, find the `useState<TrainingConfig>` block at lines 15-38. Replace:

```tsx
  const [trainingConfig, setTrainingConfig] = useState<TrainingConfig>({
    dataset_repo_id: "",
    policy_type: "act",
    steps: 10000,
    batch_size: 8,
    seed: 1000,
    num_workers: 4,
    log_freq: 250,
    save_freq: 1000,
    eval_freq: 0,
    save_checkpoint: true,
    output_dir: "outputs/train",
    resume: false,
    wandb_enable: false,
    wandb_mode: "online",
    wandb_disable_artifact: false,
    eval_n_episodes: 10,
    eval_batch_size: 50,
    eval_use_async_envs: false,
    policy_device: "cuda",
    policy_use_amp: false,
    optimizer_type: "adam",
    use_policy_training_preset: true,
  });
```

with:

```tsx
  const [trainingConfig, setTrainingConfig] = useState<TrainingConfig>({
    dataset_repo_id: "",
    policy_type: "act",
    steps: 10000,
    batch_size: 8,
    seed: 1000,
    num_workers: 4,
    log_freq: 250,
    save_freq: 1000,
    save_checkpoint: true,
    output_dir: "outputs/train",
    resume: false,
    wandb_enable: false,
    wandb_mode: "online",
    wandb_disable_artifact: false,
    policy_device: "cuda",
    policy_use_amp: false,
    optimizer_type: "adam",
    use_policy_training_preset: true,
  });
```

(Four lines removed: `eval_freq: 0,`, `eval_n_episodes: 10,`, `eval_batch_size: 50,`, `eval_use_async_envs: false,`.)

- [ ] **Step 3: Verify TypeScript compiles**

Run from `frontend/`:

```bash
npm run build
```

Expected: build succeeds with no errors. If TS complains about extra/missing properties on `TrainingConfig` somewhere, grep for the field name in `frontend/src` to find any stale reference and update it.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/training/types.ts frontend/src/pages/Training.tsx
git commit -m "refactor(training): drop sim-env, eval, and dead config fields"
```

---

### Task 7: Final verification + production build sanity check

- [ ] **Step 1: Production build**

Run from `frontend/`:

```bash
npm run build
```

Expected: builds successfully and writes to `frontend/dist/`. Per `CLAUDE.md`, the `frontend/dist/` rebuild is normally handled by CI, but doing it locally now lets us confirm the production bundle is healthy and gives us a final sanity gate.

- [ ] **Step 2: Run the production server end-to-end**

```bash
lelab
```

This serves the freshly-built bundle from `:8000`. Open `http://localhost:8000/training` and re-run the smoke checklist from Task 3 Step 3. Also start a fake training run as in Task 4 to confirm `POST /start-training` still works against the real (non-Vite) frontend.

If everything looks right, `Ctrl+C` to stop.

- [ ] **Step 3: Decide whether to commit `frontend/dist/`**

Per `CLAUDE.md`, the `build_frontend.yml` GitHub Action auto-rebuilds `frontend/dist/` when `frontend/**` (excluding `dist/**`) changes on `main` and commits it back. So **do not commit `frontend/dist/` from this branch unless explicitly asked**. Run:

```bash
git status frontend/dist/
```

If it shows changes, leave them unstaged. The CI commit will land after merge.

- [ ] **Step 4: Confirm clean tree (apart from possibly unstaged dist)**

```bash
git status
```

Expected: working tree clean except for changes under `frontend/dist/` (if any), which are intentionally not staged.

---

## Out-of-scope reminders

These were explicitly considered and excluded by the spec — do not pull them into this plan:

- Backend changes to `app/training.py` or `TrainingRequest`. The Pydantic defaults already handle every removed field.
- Persisting `AdvancedCard.expanded` state across navigations.
- Changes to `TrainingHeader`, `TrainingTabs`, `TrainingControls`, `MonitoringTab`, or any monitoring sub-components.
- Adding policy types or new fields.
