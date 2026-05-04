import React, { useEffect, useState } from "react";
import ReplayHeader from "@/components/replay/ReplayHeader";
import DatasetCombobox from "@/components/replay/DatasetCombobox";
import EpisodeList from "@/components/replay/EpisodeList";
import { useApi } from "@/contexts/ApiContext";
import {
  DatasetItem,
  EpisodeItem,
  listDatasets,
  listEpisodes,
} from "@/lib/replayApi";

const SPACE_BASE_URL = "https://lerobot-visualize-dataset.hf.space";

const ReplayDataset: React.FC = () => {
  const { baseUrl, fetchWithHeaders } = useApi();

  const [datasets, setDatasets] = useState<DatasetItem[]>([]);
  const [datasetsLoading, setDatasetsLoading] = useState(true);

  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeItem[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [episodesError, setEpisodesError] = useState<string | null>(null);
  const [selectedEpisode, setSelectedEpisode] = useState<number | null>(null);

  useEffect(() => {
    setDatasetsLoading(true);
    listDatasets(baseUrl, fetchWithHeaders)
      .then(setDatasets)
      .catch(() => setDatasets([]))
      .finally(() => setDatasetsLoading(false));
  }, [baseUrl, fetchWithHeaders]);

  useEffect(() => {
    setSelectedEpisode(null);
    setEpisodes([]);
    setEpisodesError(null);
    if (!selectedRepo) return;
    setEpisodesLoading(true);
    listEpisodes(baseUrl, fetchWithHeaders, selectedRepo)
      .then((r) => setEpisodes(r.episodes))
      .catch((e) => setEpisodesError(e.message || "Failed to load episodes"))
      .finally(() => setEpisodesLoading(false));
  }, [selectedRepo, baseUrl, fetchWithHeaders]);

  const embedUrl =
    selectedRepo && selectedEpisode !== null
      ? `${SPACE_BASE_URL}/${selectedRepo}/episode_${selectedEpisode}`
      : null;

  return (
    <div className="h-screen overflow-hidden bg-black text-white flex flex-col p-4 gap-3">
      <ReplayHeader repoId={selectedRepo} episode={selectedEpisode} />

      <div className="grid lg:grid-cols-2 gap-4 h-44 shrink-0">
        <DatasetCombobox
          datasets={datasets}
          loading={datasetsLoading}
          value={selectedRepo}
          onChange={setSelectedRepo}
        />
        <EpisodeList
          episodes={episodes}
          selected={selectedEpisode}
          loading={episodesLoading}
          error={episodesError}
          onSelect={setSelectedEpisode}
        />
      </div>

      <div className="flex-1 min-h-0 bg-gray-900 rounded-lg border border-gray-700 overflow-hidden">
        {embedUrl ? (
          <iframe
            key={embedUrl}
            src={embedUrl}
            className="w-full h-full border-0"
            allow="autoplay; fullscreen"
            title="LeRobot dataset viewer"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-500 text-sm">
            Pick a dataset and episode to load the viewer.
          </div>
        )}
      </div>
    </div>
  );
};

export default ReplayDataset;
