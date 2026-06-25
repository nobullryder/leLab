// Consolidated dataset HTTP calls. The dataset list type + listDatasets stay in
// replayApi.ts (the combobox/Train import them there); re-exported here so new
// code has one place to import dataset calls from.
import { Fetcher, apiRequest } from "./apiClient";

export type { DatasetItem, DatasetSource } from "./replayApi";
export { listDatasets } from "./replayApi";

export interface DatasetInfo {
  success: boolean;
  dataset_repo_id: string;
  num_episodes: number;
  single_task: string;
  fps: number;
  features: string[];
  total_frames: number;
  robot_type: string;
  message?: string;
}

export interface SyncStatus {
  on_hub: boolean;
  needs_sync: boolean;
  local_files: number;
  hub_files: number;
  error?: string;
}

export interface EpisodeView {
  camera: string;
  from: number;
  to: number;
}

export interface EpisodeInfo {
  index: number;
  frames: number;
  duration_s: number;
  cameras: string[];
  // Each episode is a [from, to] window inside a (possibly multi-episode) video.
  views?: EpisodeView[];
}

export interface EpisodesResponse {
  success: boolean;
  episodes: EpisodeInfo[];
  cameras: string[];
  fps: number;
  total?: number;
  offset?: number;
  limit?: number | null;
  has_more?: boolean;
  message?: string;
}

export interface UploadResult {
  success: boolean;
  message: string;
  dataset_url?: string;
  num_episodes?: number;
  docs_url?: string;
}

function post<T>(
  baseUrl: string,
  fetcher: Fetcher,
  path: string,
  body: unknown,
  action: string,
): Promise<T> {
  return apiRequest<T>(baseUrl, fetcher, path, { method: "POST", body, action });
}

export const getDatasetInfo = (baseUrl: string, fetcher: Fetcher, repoId: string) =>
  post<DatasetInfo>(baseUrl, fetcher, "/dataset-info", { dataset_repo_id: repoId }, "Get dataset info");

export const getDatasetSyncStatus = (baseUrl: string, fetcher: Fetcher, repoId: string) =>
  post<SyncStatus>(baseUrl, fetcher, "/dataset-sync-status", { dataset_repo_id: repoId }, "Get sync status");

export const listEpisodes = (
  baseUrl: string,
  fetcher: Fetcher,
  repoId: string,
  opts?: { offset?: number; limit?: number },
) =>
  post<EpisodesResponse>(
    baseUrl,
    fetcher,
    "/dataset-episodes",
    { dataset_repo_id: repoId, offset: opts?.offset ?? 0, limit: opts?.limit },
    "List episodes",
  );

export const importDataset = (baseUrl: string, fetcher: Fetcher, repoId: string) =>
  post<{ success: boolean; message: string }>(
    baseUrl,
    fetcher,
    "/import-dataset",
    { dataset_repo_id: repoId },
    "Import dataset",
  );

export interface DeleteResult {
  success: boolean;
  message: string;
  local_deleted?: boolean;
  hub_deleted?: boolean;
  hub_error?: string | null;
}

export const deleteDataset = (
  baseUrl: string,
  fetcher: Fetcher,
  repoId: string,
  deleteHub = false,
) =>
  post<DeleteResult>(
    baseUrl,
    fetcher,
    "/delete-dataset",
    { dataset_repo_id: repoId, delete_hub: deleteHub },
    "Delete dataset",
  );

// Per-episode delete rewrites the local dataset and re-indexes later episodes.
export const deleteEpisode = (
  baseUrl: string,
  fetcher: Fetcher,
  repoId: string,
  episodeIndex: number,
) =>
  post<DeleteResult>(
    baseUrl,
    fetcher,
    "/delete-episode",
    { dataset_repo_id: repoId, episode_index: episodeIndex },
    "Delete episode",
  );

export const uploadDataset = (
  baseUrl: string,
  fetcher: Fetcher,
  repoId: string,
  opts?: { tags?: string[]; private?: boolean },
) =>
  post<UploadResult>(
    baseUrl,
    fetcher,
    "/upload-dataset",
    { dataset_repo_id: repoId, tags: opts?.tags ?? [], private: opts?.private ?? false },
    "Upload dataset",
  );

// The video stream is served on a GET endpoint so a <video> tag can use it as src.
export const episodeVideoUrl = (
  baseUrl: string,
  repoId: string,
  episode: number,
  camera: string,
) =>
  `${baseUrl}/dataset-episode-video?repo_id=${encodeURIComponent(repoId)}` +
  `&episode=${episode}&camera=${encodeURIComponent(camera)}`;
