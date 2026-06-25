import { useCallback, useEffect, useState } from "react";
import { useApi } from "@/contexts/ApiContext";
import {
  DatasetInfo,
  EpisodeInfo,
  EpisodesResponse,
  SyncStatus,
  getDatasetInfo,
  getDatasetSyncStatus,
  listEpisodes,
} from "@/lib/datasetApi";

const EPISODE_PAGE_SIZE = 48;

const mergeEpisodes = (prev: EpisodesResponse | null, next: EpisodesResponse) => {
  if (!prev) return next;
  const byIndex = new Map<number, EpisodeInfo>();
  for (const ep of prev.episodes) byIndex.set(ep.index, ep);
  for (const ep of next.episodes) byIndex.set(ep.index, ep);
  return {
    ...next,
    episodes: Array.from(byIndex.values()).sort((a, b) => a.index - b.index),
  };
};

/** Everything one Dataset page needs for a single repo. */
export const useDataset = (repoId: string) => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [info, setInfo] = useState<DatasetInfo | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [episodes, setEpisodes] = useState<EpisodesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [episodesLoadingMore, setEpisodesLoadingMore] = useState(false);
  const [episodesError, setEpisodesError] = useState<string | null>(null);

  const refreshSync = useCallback(() => {
    if (!repoId) return;
    getDatasetSyncStatus(baseUrl, fetchWithHeaders, repoId)
      .then(setSync)
      .catch(() => setSync(null));
  }, [baseUrl, fetchWithHeaders, repoId]);

  const loadEpisodesPage = useCallback(
    async (offset = 0, replace = false): Promise<EpisodesResponse | null> => {
      if (!repoId) return null;
      if (offset === 0) {
        setEpisodesLoading(true);
      } else {
        setEpisodesLoadingMore(true);
      }
      setEpisodesError(null);
      try {
        const res = await listEpisodes(baseUrl, fetchWithHeaders, repoId, {
          offset,
          limit: EPISODE_PAGE_SIZE,
        });
        if (res.success === false) {
          throw new Error(res.message || "Episodes could not be loaded.");
        }
        setEpisodes((prev) => (replace ? res : mergeEpisodes(prev, res)));
        return res;
      } catch (e) {
        setEpisodesError(e instanceof Error ? e.message : "Episodes could not be loaded.");
        if (replace) setEpisodes(null);
        return null;
      } finally {
        if (offset === 0) {
          setEpisodesLoading(false);
        } else {
          setEpisodesLoadingMore(false);
        }
      }
    },
    [baseUrl, fetchWithHeaders, repoId],
  );

  const refresh = useCallback(() => {
    if (!repoId) return;
    setLoading(true);
    setError(null);
    setInfo(null);
    setEpisodes(null);
    const episodePromise = loadEpisodesPage(0, true);
    getDatasetInfo(baseUrl, fetchWithHeaders, repoId)
      .then((res) => {
        if (res?.success === false) {
          throw new Error(res.message || "This dataset isn't here — it may have been deleted.");
        }
        setInfo(res);
      })
      .catch(async () => {
        const eps = await episodePromise;
        if (eps && eps.episodes.length > 0) {
          // /dataset-info hiccuped but the dataset clearly exists (episodes
          // loaded) — synthesize minimal info so the page renders instead of
          // flashing "not found".
          setInfo({
            success: true,
            dataset_repo_id: repoId,
            num_episodes: eps.total ?? eps.episodes.length,
            single_task: "",
            fps: eps.fps,
            features: [],
            total_frames: eps.episodes.reduce((sum, e) => sum + e.frames, 0),
            robot_type: "",
          });
        } else {
          setInfo(null);
          setError("This dataset isn't here — it may have been deleted.");
        }
      })
      .finally(() => setLoading(false));
    // Sync status hits the Hub (slower) — load it independently of the page.
    refreshSync();
  }, [baseUrl, fetchWithHeaders, repoId, refreshSync, loadEpisodesPage]);

  const loadMoreEpisodes = useCallback(() => {
    if (!episodes || episodesLoading || episodesLoadingMore || episodes.has_more === false) return;
    void loadEpisodesPage(episodes.episodes.length, false);
  }, [episodes, episodesLoading, episodesLoadingMore, loadEpisodesPage]);

  const reloadEpisodes = useCallback(() => {
    void loadEpisodesPage(0, true);
  }, [loadEpisodesPage]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    info,
    sync,
    episodes,
    loading,
    error,
    episodesLoading,
    episodesLoadingMore,
    episodesError,
    episodesHasMore: episodes?.has_more ?? false,
    refresh,
    refreshSync,
    loadMoreEpisodes,
    reloadEpisodes,
  };
};
