import React, { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TrainingStatus } from '../types';
import { CheckCircle, Activity, Clock } from 'lucide-react';
import { useApi } from '@/contexts/ApiContext';
import { getJobMetricsHistory } from '@/lib/jobsApi';
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface MonitoringStatsProps {
  jobId: string;
  trainingStatus: TrainingStatus;
  getProgressPercentage: () => number;
  formatTime: (seconds: number) => string;
}

interface LossPoint {
  step: number;
  loss: number;
}

interface LrPoint {
  step: number;
  lr: number;
}

const HISTORY_CAP = 2000;

// Live "how is training going" badge. Same heuristic we reason about by hand:
// look at the relative drop in loss over a trailing ~10k-step window. The raw
// loss is noisy, so compare small neighborhood averages, not single points.
const STATE_WINDOW = 10000;

interface TrainState {
  label: string;
  cls: string;
  tip: string;
}

const avgNear = (h: LossPoint[], idx: number, span = 2): number => {
  const lo = Math.max(0, idx - span);
  const hi = Math.min(h.length - 1, idx + span);
  let sum = 0;
  let n = 0;
  for (let i = lo; i <= hi; i++) {
    sum += h[i].loss;
    n += 1;
  }
  return n ? sum / n : h[idx].loss;
};

const trainingState = (history: LossPoint[]): TrainState | null => {
  if (history.length < 2) return null;
  const latest = history[history.length - 1];

  // Earliest point at least one window behind the latest.
  let pastIdx = -1;
  for (let i = history.length - 2; i >= 0; i--) {
    if (latest.step - history[i].step >= STATE_WINDOW) {
      pastIdx = i;
      break;
    }
  }
  if (pastIdx < 0) {
    return {
      label: 'Warming up',
      cls: 'text-muted-foreground',
      tip: `Gathering the first ~${STATE_WINDOW / 1000}k steps before judging the trend.`,
    };
  }

  const recent = avgNear(history, history.length - 1);
  const past = avgNear(history, pastIdx);
  if (past <= 0) return null;

  const drop = (past - recent) / past; // relative improvement over the window
  const pct = Math.round(drop * 100);
  const spanK = Math.round((latest.step - history[pastIdx].step) / 1000);
  const over = `over the last ~${spanK}k steps`;

  if (drop < -0.02)
    return {
      label: 'Loss rising',
      cls: 'text-[var(--red)]',
      tip: `Loss went up ${Math.abs(pct)}% ${over} — possible instability or overfitting; consider an earlier checkpoint.`,
    };
  if (drop >= 0.1)
    return { label: 'Learning fast', cls: 'pill-live', tip: `Loss down ${pct}% ${over} — keep going.` };
  if (drop >= 0.03)
    return { label: 'Slowing', cls: 'pill-amber', tip: `Loss down ${pct}% ${over} — still improving, more slowly.` };
  if (drop >= 0.01)
    return {
      label: 'Diminishing returns',
      cls: 'pill-amber',
      tip: `Loss down ${pct}% ${over} — little left from more steps; start testing checkpoints.`,
    };
  return {
    label: 'Plateau',
    cls: 'text-muted-foreground',
    tip: `Loss ${pct <= 0 ? 'flat' : `only down ${pct}%`} ${over} — more steps won't help much; test checkpoints on the robot or add data.`,
  };
};

const MonitoringStats: React.FC<MonitoringStatsProps> = ({
  jobId,
  trainingStatus,
  getProgressPercentage,
  formatTime,
}) => {
  const [lossHistory, setLossHistory] = useState<LossPoint[]>([]);
  const [lrHistory, setLrHistory] = useState<LrPoint[]>([]);
  const lastStepRef = useRef(0);
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
        const lastSeededStep = points[points.length - 1]?.step ?? 0;
        lastStepRef.current = lastSeededStep;
      })
      .catch(() => {
        // 404 or transient — fall through; live ticks will populate from empty.
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchWithHeaders, jobId]);

  // Append new metric points as they arrive; reset when a new run starts
  // (current_step resets back to 0).
  useEffect(() => {
    const step = trainingStatus.current_step;
    if (step < lastStepRef.current) {
      setLossHistory([]);
      setLrHistory([]);
    }
    lastStepRef.current = step;

    if (step > 0 && trainingStatus.current_loss != null) {
      const loss = trainingStatus.current_loss;
      setLossHistory((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.step === step) return prev;
        return [...prev, { step, loss }].slice(-HISTORY_CAP);
      });
    }

    if (step > 0 && trainingStatus.current_lr != null) {
      const lr = trainingStatus.current_lr;
      setLrHistory((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.step === step) return prev;
        return [...prev, { step, lr }].slice(-HISTORY_CAP);
      });
    }
  }, [trainingStatus.current_step, trainingStatus.current_loss, trainingStatus.current_lr]);

  const progress = getProgressPercentage();
  // Until tqdm fires its first progress line, total_steps is 0 — show
  // "Training starting…" instead of a misleading 0/0 0% reading.
  const isStarting = trainingStatus.training_active && trainingStatus.total_steps === 0;
  const stepLabel = isStarting
    ? 'Training starting…'
    : `${trainingStatus.current_step.toLocaleString()} / ${trainingStatus.total_steps.toLocaleString()}`;
  const etaLabel =
    trainingStatus.eta_seconds != null ? formatTime(trainingStatus.eta_seconds) : '—';
  const lossState = trainingState(lossHistory);

  return (
    <div className="space-y-6">
      <Card className="rounded-xl">
        <CardContent className="p-6">
          <div className="mb-3 flex items-baseline justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--amber-soft)] text-[var(--amber)]">
                <Activity className="h-5 w-5" />
              </div>
              <div>
                <h3 className="readout-label">Progress</h3>
                <div className="font-mono text-base font-semibold tabular-nums text-foreground">{stepLabel}</div>
              </div>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Clock className="h-4 w-4" />
              <span className="font-mono text-sm uppercase tracking-wider">
                ETA <span className="font-semibold text-foreground">{etaLabel}</span>
              </span>
            </div>
          </div>
          <div className="relative h-8 w-full overflow-hidden rounded-md border border-border bg-[var(--sunken)]">
            <div
              className="h-full bg-gradient-to-r from-[var(--amber-deep)] to-[var(--amber)] transition-[width] duration-500"
              style={{ width: `${progress}%` }}
            />
            <div className="absolute inset-0 flex items-center justify-center font-mono text-sm font-semibold tabular-nums text-foreground drop-shadow">
              {isStarting ? 'warming up…' : `${progress.toFixed(1)}%`}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="rounded-xl">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-3 text-base text-foreground">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-500/20 text-green-400">
                  <CheckCircle className="w-4 h-4" />
                </div>
                <span>
                  Loss{' '}
                  <span className="text-slate-400 text-sm font-normal">
                    ({trainingStatus.current_loss?.toFixed(4) ?? '—'})
                  </span>
                </span>
              </CardTitle>
              {lossState && (
                <span className={`pill shrink-0 ${lossState.cls}`} title={lossState.tip}>
                  {lossState.label}
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="h-48">
              {lossHistory.length === 0 ? (
                <div className="flex h-full items-center justify-center text-slate-500 text-sm">
                  Waiting for first metric tick…
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={lossHistory}
                    margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                  >
                    <XAxis
                      dataKey="step"
                      tick={{ fill: '#94a3b8', fontSize: 11 }}
                      stroke="#475569"
                    />
                    <YAxis
                      tick={{ fill: '#94a3b8', fontSize: 11 }}
                      stroke="#475569"
                      width={48}
                    />
                    <Tooltip
                      contentStyle={{
                        background: '#1b2125',
                        border: '1px solid #2a3137',
                        borderRadius: 8,
                      }}
                      labelStyle={{ color: '#cbd5e1' }}
                      itemStyle={{ color: '#34d399' }}
                      formatter={(v: number) => v.toFixed(4)}
                    />
                    <Line
                      type="monotone"
                      dataKey="loss"
                      stroke="#34d399"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-3 text-base text-foreground">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-500/20 text-orange-400">
                <Activity className="w-4 h-4" />
              </div>
              <span>
                Learning Rate{' '}
                <span className="text-slate-400 text-sm font-normal">
                  ({trainingStatus.current_lr?.toExponential(2) ?? '—'})
                </span>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="h-48">
              {lrHistory.length === 0 ? (
                <div className="flex h-full items-center justify-center text-slate-500 text-sm">
                  Waiting for first metric tick…
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={lrHistory}
                    margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                  >
                    <XAxis
                      dataKey="step"
                      tick={{ fill: '#94a3b8', fontSize: 11 }}
                      stroke="#475569"
                    />
                    <YAxis
                      tick={{ fill: '#94a3b8', fontSize: 11 }}
                      stroke="#475569"
                      width={48}
                      tickFormatter={(v: number) => v.toExponential(0)}
                    />
                    <Tooltip
                      contentStyle={{
                        background: '#1b2125',
                        border: '1px solid #2a3137',
                        borderRadius: 8,
                      }}
                      labelStyle={{ color: '#cbd5e1' }}
                      itemStyle={{ color: '#fb923c' }}
                      formatter={(v: number) => v.toExponential(2)}
                    />
                    <Line
                      type="monotone"
                      dataKey="lr"
                      stroke="#fb923c"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default MonitoringStats;
