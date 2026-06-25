import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Play, Plus, Sparkles, Trash2, History } from "lucide-react";
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
import { useApi } from "@/contexts/ApiContext";
import { useRobots } from "@/hooks/useRobots";
import { useToast } from "@/hooks/use-toast";
import { JobRecord, deleteJob, listJobs } from "@/lib/jobsApi";
import { Skill, groupJobsIntoSkills, versionLabel } from "@/lib/skills";
import { collidingNames, recordedAtLabel } from "@/lib/prettyName";
import InferenceModal from "@/components/landing/InferenceModal";

const trainedLabel = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

const stepsLabel = (steps: number) =>
  steps >= 1000 ? `${Math.round(steps / 1000)}k steps` : `${steps} steps`;

const STATE: Record<JobRecord["state"], { label: string; cls: string }> = {
  done: { label: "Ready", cls: "pill-live" },
  running: { label: "Training", cls: "pill-amber" },
  failed: { label: "Failed", cls: "text-[var(--red)]" },
  interrupted: { label: "Stopped", cls: "text-muted-foreground" },
};

type DeleteTarget =
  | { kind: "version"; job: JobRecord; skill: Skill }
  | { kind: "skill"; skill: Skill }
  | null;

const Skills: React.FC = () => {
  const navigate = useNavigate();
  const { baseUrl, fetchWithHeaders } = useApi();
  const { selectedRecord } = useRobots();
  const { toast } = useToast();

  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [runTarget, setRunTarget] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const jobs = await listJobs(baseUrl, fetchWithHeaders, 200);
      setSkills(groupJobsIntoSkills(jobs));
    } catch {
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, [baseUrl, fetchWithHeaders]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const collisions = collidingNames(skills.map((s) => s.datasetRepoId));

  const runVersion = (job: JobRecord) => {
    if (job.checkpoint_count === 0) return;
    if (!selectedRecord) {
      toast({
        title: "No robot selected",
        description: "Pick and calibrate a robot on the Robot page to run a skill.",
        variant: "destructive",
      });
      return;
    }
    setRunTarget(job.id);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const ids =
      deleteTarget.kind === "version"
        ? [deleteTarget.job.id]
        : deleteTarget.skill.versions.map((v) => v.id);
    try {
      await Promise.all(ids.map((id) => deleteJob(baseUrl, fetchWithHeaders, id)));
      toast({
        title: deleteTarget.kind === "version" ? "Version deleted" : "Skill deleted",
        description:
          deleteTarget.kind === "version"
            ? "The trained model was removed."
            : `All ${ids.length} version${ids.length === 1 ? "" : "s"} were removed.`,
      });
      await refresh();
    } catch (e) {
      toast({
        title: "Delete failed",
        description: e instanceof Error ? e.message : "Could not delete.",
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const runningJob = runTarget ? skills.flatMap((s) => s.versions).find((v) => v.id === runTarget) : null;

  return (
    <div className="page page-stack">
      <div className="page-head">
        <div className="max-w-3xl">
          <div className="eyebrow eyebrow-amber">
            <Sparkles className="h-3.5 w-3.5" /> Skills
          </div>
          <h1 className="page-title mt-2.5">Your skills</h1>
          <p className="page-subtitle">
            Every policy you've trained. Each skill keeps its version history — retrain after editing a
            dataset and the old version stays here to run. Run any version on the robot, or trim the
            ones you don't need.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="mr-3 h-6 w-6 animate-spin text-primary" /> Loading skills…
        </div>
      ) : skills.length === 0 ? (
        <div className="plate plate-pad flex flex-col items-center gap-3 py-16 text-center">
          <Sparkles className="h-7 w-7 text-muted-foreground" />
          <div className="text-lg font-semibold">No skills yet</div>
          <p className="max-w-md text-sm text-muted-foreground">
            Record demonstrations on Datasets, then train a policy. Your trained skills will show up
            here, ready to run.
          </p>
          <div className="mt-1 flex gap-2">
            <Button variant="outline" onClick={() => navigate("/datasets")}>
              <Plus className="mr-1.5 h-4 w-4" /> Record a dataset
            </Button>
            <Button onClick={() => navigate("/training")}>Train a skill</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {skills.map((skill) => (
            <SkillCard
              key={skill.datasetRepoId}
              skill={skill}
              ambiguous={collisions.has(skill.name.toLowerCase())}
              onRun={runVersion}
              onDeleteVersion={(job) => setDeleteTarget({ kind: "version", job, skill })}
              onDeleteSkill={() => setDeleteTarget({ kind: "skill", skill })}
            />
          ))}
        </div>
      )}

      {runningJob && (
        <InferenceModal
          open={!!runTarget}
          onOpenChange={(o) => !o && setRunTarget(null)}
          robot={selectedRecord}
          jobId={runningJob.id}
          initialStep={null}
        />
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.kind === "skill"
                ? `Delete all of "${deleteTarget.skill.name}"?`
                : `Delete this version?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.kind === "skill"
                ? `This removes all ${deleteTarget.skill.versions.length} trained version${
                    deleteTarget.skill.versions.length === 1 ? "" : "s"
                  }. The source dataset is not affected. This can't be undone.`
                : "This removes the trained model and its checkpoints. The source dataset is not affected. This can't be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

const SkillCard: React.FC<{
  skill: Skill;
  ambiguous: boolean;
  onRun: (job: JobRecord) => void;
  onDeleteVersion: (job: JobRecord) => void;
  onDeleteSkill: () => void;
}> = ({ skill, ambiguous, onRun, onDeleteVersion, onDeleteSkill }) => {
  const recorded = recordedAtLabel(skill.datasetRepoId);
  const versionWord = skill.versions.length === 1 ? "version" : "versions";

  return (
    <div className="plate plate-pad">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-xl font-semibold text-foreground">{skill.name}</h2>
            {/* Disambiguator: when two skills share a name, lead with the recorded date. */}
            {ambiguous && recorded && <span className="pill pill-amber">{recorded}</span>}
            <span className="pill text-muted-foreground">
              {skill.versions.length} {versionWord}
            </span>
          </div>
          <div className="mt-1 truncate font-mono text-xs text-[var(--ink-faint)]" title={skill.datasetRepoId}>
            {skill.datasetRepoId}
            {!ambiguous && recorded ? ` · recorded ${recorded}` : ""}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {skill.latestRunnable && (
            <Button onClick={() => onRun(skill.latestRunnable!)}>
              <Play className="mr-1.5 h-4 w-4" /> Run latest
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Delete skill"
            onClick={onDeleteSkill}
            className="text-[var(--ink-faint)] hover:bg-[var(--red-soft)] hover:text-[var(--red)]"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-1.5 text-xs uppercase tracking-wide text-[var(--ink-faint)]">
        <History className="h-3.5 w-3.5" /> History
      </div>
      <div className="mt-2 flex flex-col divide-y divide-[var(--line)] overflow-hidden rounded-lg border border-[var(--line)]">
        {skill.versions.map((job, i) => {
          const isLatest = job.id === skill.latestRunnable?.id;
          const state = STATE[job.state];
          const runnable = job.checkpoint_count > 0;
          return (
            <div
              key={job.id}
              className={`flex flex-wrap items-center justify-between gap-3 px-3.5 py-3 ${
                isLatest ? "bg-[var(--surface-2)]" : ""
              }`}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className={`font-mono text-sm font-semibold ${
                    isLatest ? "text-[var(--amber-bright)]" : "text-muted-foreground"
                  }`}
                >
                  {versionLabel(skill.versions.length, i)}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-foreground">{job.config.policy_type.toUpperCase()}</span>
                    <span className={`pill ${state.cls}`}>{state.label}</span>
                    {isLatest && <span className="pill pill-live">Latest</span>}
                  </div>
                  <div className="mt-0.5 text-xs text-[var(--ink-faint)]">
                    {stepsLabel(job.config.steps)} · {job.checkpoint_count} checkpoint
                    {job.checkpoint_count === 1 ? "" : "s"} · trained {trainedLabel(job.started_at)}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  variant={isLatest ? "default" : "outline"}
                  size="sm"
                  disabled={!runnable}
                  title={runnable ? "" : "No checkpoints to run yet"}
                  onClick={() => onRun(job)}
                >
                  <Play className="mr-1.5 h-3.5 w-3.5" /> Run
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Delete version"
                  onClick={() => onDeleteVersion(job)}
                  className="h-8 w-8 text-[var(--ink-faint)] hover:bg-[var(--red-soft)] hover:text-[var(--red)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default Skills;
