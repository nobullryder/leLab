import React, { useState } from 'react';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ConfigComponentProps } from './types';
import { DatasetItem } from '@/lib/replayApi';
import { RunnerFlavor } from '@/lib/jobsApi';
import DatasetCombobox from '@/components/replay/DatasetCombobox';
import WandbInstallDialog from './WandbInstallDialog';
import AdvancedCard from './config/AdvancedCard';
import { useApi } from '@/contexts/ApiContext';

interface ConfigurationTabProps extends ConfigComponentProps {
  datasets: DatasetItem[];
  datasetsLoading: boolean;
  authenticated: boolean;
  flavors: RunnerFlavor[];
  hardwareLoading: boolean;
}

const formatHourly = (unitCostUsd: number, unitLabel: string): string => {
  const hourly = unitLabel === 'minute' ? unitCostUsd * 60 : unitCostUsd;
  return `$${hourly.toFixed(2)}/hr`;
};

const formatFlavorLine = (f: RunnerFlavor): string =>
  `${f.pretty_name} · ${f.accelerator ? f.accelerator : f.cpu} · ${formatHourly(f.unit_cost_usd, f.unit_label)}`;

const ConfigurationTab: React.FC<ConfigurationTabProps> = ({
  config,
  updateConfig,
  datasets,
  datasetsLoading,
  authenticated,
  flavors,
  hardwareLoading,
}) => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [wandbDialogOpen, setWandbDialogOpen] = useState(false);
  const [wandbInstallHint, setWandbInstallHint] = useState('pip install wandb');

  const handleWandbToggle = async (checked: boolean) => {
    if (!checked) {
      updateConfig('wandb_enable', false);
      return;
    }
    // Check availability before flipping on, so the user doesn't start a run
    // that fails because wandb isn't installed.
    try {
      const r = await fetchWithHeaders(`${baseUrl}/system/wandb-extra`);
      const data: { available: boolean; install_hint: string } = await r.json();
      if (data.available) {
        updateConfig('wandb_enable', true);
      } else {
        setWandbInstallHint(data.install_hint);
        setWandbDialogOpen(true);
      }
    } catch {
      updateConfig('wandb_enable', true);
    }
  };

  const target = config.target;
  const targetValue = target.runner === 'local' ? 'local' : `hf:${target.flavor ?? ''}`;
  const handleTargetChange = (v: string) => {
    if (v === 'local') updateConfig('target', { runner: 'local' });
    else if (v.startsWith('hf:')) updateConfig('target', { runner: 'hf_cloud', flavor: v.slice('hf:'.length) });
  };

  return (
    <div className="space-y-4">
      <div className="plate plate-pad space-y-5">
        {/* Recording (wide) + where to train */}
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-1.5 lg:col-span-2">
            <Label className="field-label">Recording to learn from</Label>
            <DatasetCombobox
              datasets={datasets}
              loading={datasetsLoading}
              value={config.dataset_repo_id || null}
              onChange={(repoId) => {
                if (repoId) updateConfig('dataset_repo_id', repoId);
              }}
            />
            <p className="text-xs text-muted-foreground">
              The demonstrations you recorded on the Datasets page.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="field-label">Where to train</Label>
            <Select value={targetValue} onValueChange={handleTargetChange}>
              <SelectTrigger>
                <SelectValue placeholder={hardwareLoading ? 'Loading…' : 'Select'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">Your machine — free</SelectItem>
                {flavors.map((f) => (
                  <SelectItem key={f.name} value={`hf:${f.name}`} disabled={!authenticated}>
                    {formatFlavorLine(f)}
                    {!authenticated && (
                      <span className="ml-2 text-xs text-[var(--amber-bright)]">log in to HF</span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Local is free. Cloud uses your HF account.</p>
          </div>
        </div>

        {/* Policy · steps · batch */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="policy_type" className="field-label">
              Policy (how it learns)
            </Label>
            <Select value={config.policy_type} onValueChange={(value) => updateConfig('policy_type', value)}>
              <SelectTrigger id="policy_type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="act">ACT — recommended</SelectItem>
                <SelectItem value="diffusion">Diffusion Policy</SelectItem>
                <SelectItem value="pi0">PI0</SelectItem>
                <SelectItem value="smolvla">SmolVLA</SelectItem>
                <SelectItem value="tdmpc">TD-MPC</SelectItem>
                <SelectItem value="vqbet">VQ-BeT</SelectItem>
                <SelectItem value="pi0_fast">PI0 Fast</SelectItem>
                <SelectItem value="sac">SAC</SelectItem>
                <SelectItem value="reward_classifier">Reward Classifier</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="steps" className="field-label">
              Training steps
            </Label>
            <NumberInput
              id="steps"
              value={config.steps}
              onChange={(v) => {
                if (v !== undefined) updateConfig('steps', v);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="batch_size" className="field-label">
              Batch size
            </Label>
            <NumberInput
              id="batch_size"
              value={config.batch_size}
              onChange={(v) => {
                if (v !== undefined) updateConfig('batch_size', v);
              }}
            />
          </div>
        </div>

        {/* Weights & Biases */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <label
            htmlFor="wandb_enable"
            className="flex cursor-pointer items-center gap-2.5 text-sm text-foreground"
          >
            <Switch id="wandb_enable" checked={config.wandb_enable} onCheckedChange={handleWandbToggle} />
            Track with Weights &amp; Biases
          </label>
          {config.wandb_enable && (
            <Input
              className="h-9 w-full max-w-xs"
              value={config.wandb_project || ''}
              placeholder="W&B project name"
              onChange={(e) => updateConfig('wandb_project', e.target.value || undefined)}
            />
          )}
        </div>

        <WandbInstallDialog
          open={wandbDialogOpen}
          onOpenChange={setWandbDialogOpen}
          installHint={wandbInstallHint}
        />
      </div>

      <AdvancedCard config={config} updateConfig={updateConfig} />
    </div>
  );
};

export default ConfigurationTab;
