export interface DatasetItem {
  repo_id: string;
  last_modified: string | null;
  private: boolean;
}

export interface EpisodeItem {
  episode_index: number;
  length: number;
  tasks: string[];
  duration_seconds: number;
  duration_human: string;
}

export interface EpisodeListResponse {
  fps: number;
  total_episodes: number;
  episodes: EpisodeItem[];
}

type Fetcher = (url: string, options?: RequestInit) => Promise<Response>;

export async function listDatasets(
  baseUrl: string,
  fetcher: Fetcher,
): Promise<DatasetItem[]> {
  const r = await fetcher(`${baseUrl}/datasets`);
  if (!r.ok) throw new Error(`GET /datasets failed: ${r.status}`);
  return r.json();
}

export async function listEpisodes(
  baseUrl: string,
  fetcher: Fetcher,
  repoId: string,
): Promise<EpisodeListResponse> {
  const r = await fetcher(`${baseUrl}/episodes/${repoId}`);
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `GET /episodes failed: ${r.status}`);
  }
  return r.json();
}
