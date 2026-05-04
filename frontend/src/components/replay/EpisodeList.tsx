import React from "react";
import { ListVideo } from "lucide-react";
import { cn } from "@/lib/utils";
import { EpisodeItem } from "@/lib/replayApi";

interface Props {
  episodes: EpisodeItem[];
  selected: number | null;
  loading: boolean;
  error: string | null;
  onSelect: (episodeIndex: number) => void;
}

const EpisodeList: React.FC<Props> = ({ episodes, selected, loading, error, onSelect }) => {
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg flex flex-col h-full min-h-0">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-700 text-white shrink-0">
        <ListVideo className="w-4 h-4 text-purple-400" />
        <span className="font-semibold text-sm">Episodes</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
        {loading && <div className="text-center text-gray-500 py-6 text-sm">Loading episodes…</div>}
        {error && <div className="text-center text-red-400 py-6 text-sm">{error}</div>}
        {!loading && !error && episodes.length === 0 && (
          <div className="text-center text-gray-500 py-6 text-sm">Pick a dataset to see episodes.</div>
        )}
        {!loading && !error && episodes.map((ep) => (
          <button
            key={ep.episode_index}
            onClick={() => onSelect(ep.episode_index)}
            className={cn(
              "w-full text-left p-2 rounded-md transition-colors text-sm flex items-center justify-between",
              selected === ep.episode_index
                ? "bg-purple-500/20 text-purple-300"
                : "hover:bg-gray-800 text-gray-300"
            )}
          >
            <span>Episode {ep.episode_index}</span>
            <span className="font-mono text-xs text-gray-500">{ep.duration_human}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default EpisodeList;
