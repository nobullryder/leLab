// A "skill" is the lineage of trained models that share a source dataset.
// Dataset edits (add takes / replace an episode) happen in place on the same
// repo id, so retraining produces a new job with the same dataset_repo_id —
// which makes those jobs the version history of one skill.
import { JobRecord } from "./jobsApi";
import { prettyName, recordedAt } from "./prettyName";

export interface Skill {
  datasetRepoId: string;
  name: string;
  recordedAt: Date | null;
  versions: JobRecord[]; // newest first
  latestRunnable: JobRecord | null; // newest version that has checkpoints
}

export function groupJobsIntoSkills(jobs: JobRecord[]): Skill[] {
  const byDataset = new Map<string, JobRecord[]>();
  for (const job of jobs) {
    const key = job.config?.dataset_repo_id || job.id;
    const list = byDataset.get(key);
    if (list) list.push(job);
    else byDataset.set(key, [job]);
  }

  const skills: Skill[] = [];
  for (const [datasetRepoId, group] of byDataset) {
    const versions = [...group].sort((a, b) => b.started_at - a.started_at);
    skills.push({
      datasetRepoId,
      name: prettyName(datasetRepoId),
      recordedAt: recordedAt(datasetRepoId),
      versions,
      latestRunnable: versions.find((v) => v.checkpoint_count > 0) ?? null,
    });
  }

  // Most recently trained skill first.
  skills.sort((a, b) => (b.versions[0]?.started_at ?? 0) - (a.versions[0]?.started_at ?? 0));
  return skills;
}

/** Newest version is the highest number: v{N} for the job at `index` (0 = newest). */
export function versionLabel(versionCount: number, index: number): string {
  return `v${versionCount - index}`;
}
