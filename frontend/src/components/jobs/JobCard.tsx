import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
  running: { label: "Running", color: "text-[var(--green)]", Icon: Loader2 },
  done: { label: "Done", color: "text-muted-foreground", Icon: CheckCircle2 },
  failed: { label: "Failed", color: "text-[var(--red)]", Icon: XCircle },
  interrupted: { label: "Interrupted", color: "text-[var(--amber)]", Icon: AlertTriangle },
};

const JobCard: React.FC<Props> = ({ job, onStop, onDelete, onPlay }) => {
  const navigate = useNavigate();
  const { baseUrl, fetchWithHeaders } = useApi();
  const present = statePresentation[job.state];
  const Icon = present.Icon;
  const isRunning = job.state === "running";
  const isImported = job.runner === "imported";
  const importedSource = job.hf_repo_id || job.output_dir;
  const stateLabel = isImported ? "Imported" : present.label;
  const isStarting = isRunning && job.metrics.total_steps === 0;
  const progressPct =
    job.metrics.total_steps > 0
      ? Math.min(100, (job.metrics.current_step / job.metrics.total_steps) * 100)
      : 0;

  const subtitle = isImported
    ? importedSource
    : isStarting
    ? "starting…"
    : isRunning
    ? `started ${relativeTime(job.started_at)}`
    : job.ended_at != null
    ? `ended ${relativeTime(job.ended_at)}`
    : present.label.toLowerCase();

  const [checkpoints, setCheckpoints] = useState<JobCheckpoint[]>([]);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    "stop" | "remove-imported" | "delete" | null
  >(null);

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
      setConfirmAction("stop");
    } else if (isImported) {
      setConfirmAction("remove-imported");
    } else {
      setConfirmAction("delete");
    }
  };

  const confirmDetails =
    confirmAction === "stop"
      ? {
          title: "Stop training?",
          description:
            "The run will stop after the backend receives the request. Saved output stays on disk.",
          action: "Stop",
        }
      : confirmAction === "remove-imported"
      ? {
          title: "Remove imported model?",
          description:
            "This removes the model from LeLab. The source files stay where they are.",
          action: "Remove",
        }
      : {
          title: "Delete training run?",
          description:
            "This removes the run output directory from this computer. This action cannot be undone.",
          action: "Delete",
        };

  const handleConfirmAction = () => {
    if (!confirmAction) return;
    if (confirmAction === "stop") onStop(job.id);
    else onDelete(job.id);
    setConfirmAction(null);
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
      onClick={() => {
        if (!isImported) navigate(`/training/${job.id}`);
      }}
      className={`rounded-xl transition-colors ${
        isImported ? "" : "cursor-pointer hover:border-[var(--line-2)]"
      }`}
    >
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className={`flex items-center gap-1.5 text-xs font-semibold ${present.color}`}>
            <Icon className={`w-3.5 h-3.5 ${isRunning ? "animate-spin" : ""}`} />
            {stateLabel}
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
          <div className="truncate font-semibold text-foreground" title={job.name}>
            {job.name}
          </div>
          {/* Imported subtitles are file paths — truncate the *start* (rtl
              flips the ellipsis to the left) so the more useful tail stays
              visible. The leading LRM keeps the path's first "/" from being
              bidi-reordered to the wrong end. */}
          <div
            className="text-xs text-slate-400 truncate"
            title={subtitle}
            style={isImported ? { direction: "rtl", textAlign: "left" } : undefined}
          >
            {isImported ? "\u200e" + subtitle : subtitle}
          </div>
        </div>
        {showProgressBar ? (
          <div className="relative h-5 w-full overflow-hidden rounded-md border border-border bg-[var(--sunken)]">
            <div
              className="h-full bg-gradient-to-r from-[var(--amber-deep)] to-[var(--amber)] transition-[width] duration-500"
              style={{ width: `${progressPct}%` }}
            />
            <div className="absolute inset-0 flex items-center justify-center font-mono text-xs font-semibold tabular-nums text-foreground drop-shadow">
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
              className="h-8 w-8 bg-[var(--green)] text-[#062013] hover:brightness-110"
              aria-label="Run inference with this checkpoint"
            >
              <Play className="w-4 h-4" />
            </Button>
          </div>
        ) : null}
      </CardContent>
      <AlertDialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
      >
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmDetails.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDetails.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmAction}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {confirmDetails.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
};

export default JobCard;
