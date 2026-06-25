import React, { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  GraduationCap,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  UploadCloud,
} from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useApi } from "@/contexts/ApiContext";
import { useToast } from "@/hooks/use-toast";
import { useRobots } from "@/hooks/useRobots";
import { useDataset } from "@/hooks/useDataset";
import { useRecordingPrefs } from "@/hooks/useRecordingPrefs";
import {
  EpisodeInfo,
  SyncStatus,
  deleteDataset,
  deleteEpisode,
  episodeVideoUrl,
  uploadDataset,
} from "@/lib/datasetApi";
import { CameraConfig } from "@/components/recording/CameraConfiguration";
import RecordingModal from "@/components/landing/RecordingModal";
import EpisodeVideo from "@/components/dataset/EpisodeVideo";
import { Checkbox } from "@/components/ui/checkbox";

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return (h > 0 ? `${h}:` : "") + `${mm}:${String(sec).padStart(2, "0")}`;
}

const SyncPill: React.FC<{ sync: SyncStatus | null }> = ({ sync }) => {
  if (!sync) {
    return (
      <span className="pill text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking Hub…
      </span>
    );
  }
  if (sync.on_hub && !sync.needs_sync) {
    return (
      <span className="pill pill-live">
        <span className="dot dot-live" />
        Synced to Hub
      </span>
    );
  }
  if (sync.on_hub && sync.needs_sync) {
    return (
      <span className="pill pill-amber">
        <span className="dot dot-amber" />
        Changes to publish
      </span>
    );
  }
  return <span className="pill text-muted-foreground">Local only</span>;
};

const Stat: React.FC<{ value: React.ReactNode; label: string }> = ({ value, label }) => (
  <div className="min-w-0">
    <div className="font-mono text-2xl font-semibold tabular-nums text-foreground sm:text-3xl">
      {value}
    </div>
    <div className="field-label mt-1">{label}</div>
  </div>
);

const Dataset: React.FC = () => {
  const params = useParams();
  const repoId = decodeURIComponent(params["*"] ?? "");
  const navigate = useNavigate();
  const { toast } = useToast();
  const { baseUrl, fetchWithHeaders } = useApi();
  const { selectedRecord } = useRobots();
  const {
    info,
    sync,
    episodes,
    loading,
    error,
    episodesLoading,
    episodesLoadingMore,
    episodesError,
    episodesHasMore,
    refresh,
    refreshSync,
    loadMoreEpisodes,
    reloadEpisodes,
  } = useDataset(repoId);

  const [publishing, setPublishing] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleteHub, setDeleteHub] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activeEpisode, setActiveEpisode] = useState<EpisodeInfo | null>(null);
  const [episodeActionPending, setEpisodeActionPending] = useState(false);

  // Resume-recording modal state.
  const [showResume, setShowResume] = useState(false);
  const [numEpisodes, setNumEpisodes] = useState(5);
  const [episodeTimeS, setEpisodeTimeS] = useState(60);
  const { resetCountdown, resetTimeS, setResetCountdown, setResetTimeS } = useRecordingPrefs();
  const [streamingEncoding, setStreamingEncoding] = useState(true);
  const [cameras, setCameras] = useState<CameraConfig[]>([]);
  const releaseStreamsRef = useRef<(() => void) | null>(null);

  useEffect(() => () => releaseStreamsRef.current?.(), []);

  const openResume = () => {
    if (!selectedRecord || !selectedRecord.is_clean) {
      toast({
        title: "Robot not ready",
        description: selectedRecord
          ? `${selectedRecord.name} needs calibration before recording.`
          : "Pick and calibrate a robot on the Robot page first.",
        variant: "destructive",
      });
      return;
    }
    setCameras(selectedRecord.cameras ? [...selectedRecord.cameras] : []);
    setShowResume(true);
  };

  const handleStartMoreTakes = async () => {
    if (!selectedRecord || !info) return;
    if (cameras.length > 0 && releaseStreamsRef.current) {
      releaseStreamsRef.current();
      await new Promise((r) => setTimeout(r, 500));
    }
    // Resume requires the exact camera feature keys the dataset was recorded
    // with. Windows enumerates camera names inconsistently (icspring_camera one
    // run, cam0 the next), so the robot's saved name can drift from the
    // dataset's. Take the name from the dataset and keep only the physical
    // config (index/resolution/backend) from the robot. Mapped by order — the
    // common case is a single camera.
    const datasetCamNames = (episodes?.cameras ?? []).map((c) => c.split(".").pop() ?? c);
    const cameraDict = cameras.reduce(
      (acc, cam, i) => {
        const name = datasetCamNames[i] ?? cam.name;
        acc[name] = {
          type: cam.type,
          camera_index: cam.camera_index,
          width: cam.width,
          height: cam.height,
          fps: cam.fps,
          ...(cam.fourcc ? { fourcc: cam.fourcc } : {}),
          ...(cam.backend ? { backend: cam.backend } : {}),
        };
        return acc;
      },
      {} as Record<string, Record<string, unknown>>,
    );
    const recordingConfig = {
      leader_port: selectedRecord.leader_port,
      follower_port: selectedRecord.follower_port,
      leader_config: selectedRecord.leader_config,
      follower_config: selectedRecord.follower_config,
      dataset_repo_id: repoId, // verbatim — backend skips the timestamp stamp on resume
      single_task: info.single_task,
      num_episodes: numEpisodes,
      episode_time_s: episodeTimeS,
      reset_time_s: resetTimeS,
      reset_countdown: resetCountdown,
      fps: 30,
      video: true,
      push_to_hub: false,
      resume: true,
      streaming_encoding: streamingEncoding,
      cameras: cameraDict,
    };
    setShowResume(false);
    navigate("/recording", { state: { recordingConfig } });
  };

  const handlePublish = async () => {
    setPublishing(true);
    try {
      const res = await uploadDataset(baseUrl, fetchWithHeaders, repoId);
      if (res.success) {
        toast({ title: "Published to Hub", description: repoId });
        refreshSync();
      } else {
        toast({ title: "Publish failed", description: res.message, variant: "destructive" });
      }
    } catch (e) {
      toast({
        title: "Publish failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setPublishing(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await deleteDataset(baseUrl, fetchWithHeaders, repoId, deleteHub);
      if (res.success) {
        const hubNote = deleteHub
          ? res.hub_deleted
            ? " (also removed from the Hub)"
            : ` (Hub delete failed: ${res.hub_error ?? "unknown"})`
          : "";
        toast({ title: "Dataset deleted", description: `${repoId} removed from disk.${hubNote}` });
        navigate("/datasets");
      } else {
        toast({ title: "Delete failed", description: res.message, variant: "destructive" });
      }
    } catch {
      toast({ title: "Delete failed", description: "Could not reach the backend.", variant: "destructive" });
    } finally {
      setDeleting(false);
      setShowDelete(false);
    }
  };

  const deleteEpisodeByIndex = async (index: number) => {
    setEpisodeActionPending(true);
    // Close the player and let the browser drop the video stream first — the
    // backend can't swap/remove a locked .mp4 while it's still being served
    // (Windows: WinError 32).
    setActiveEpisode(null);
    await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      const res = await deleteEpisode(baseUrl, fetchWithHeaders, repoId, index);
      if (!res.success) {
        toast({
          title: "Episode delete failed",
          description: res.message,
          variant: "destructive",
        });
        return false;
      }
      toast({
        title: "Episode deleted",
        description: `Episode ${index + 1} was removed and the dataset was re-indexed.`,
      });
      refresh();
      return true;
    } catch (e) {
      toast({
        title: "Episode delete failed",
        description: e instanceof Error ? e.message : "Could not reach the backend.",
        variant: "destructive",
      });
      return false;
    } finally {
      setEpisodeActionPending(false);
    }
  };

  const handleDeleteEpisode = async (index: number) => {
    await deleteEpisodeByIndex(index);
  };

  const handleReplaceEpisode = async (index: number) => {
    if (!selectedRecord || !selectedRecord.is_clean) {
      toast({
        title: "Robot not ready",
        description: selectedRecord
          ? `${selectedRecord.name} needs calibration before recording a replacement.`
          : "Pick and calibrate a robot on the Robot page before replacing an episode.",
        variant: "destructive",
      });
      return;
    }
    const deleted = await deleteEpisodeByIndex(index);
    if (deleted) {
      setCameras(selectedRecord.cameras ? [...selectedRecord.cameras] : []);
      setShowResume(true);
    }
  };

  if (loading) {
    return (
      <div className="page flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="mr-3 h-6 w-6 animate-spin text-primary" /> Loading dataset…
      </div>
    );
  }

  if (error || !info) {
    return (
      <div className="page">
        <div className="eyebrow eyebrow-amber">Dataset</div>
        <h1 className="page-title mt-2.5">Not found</h1>
        <p className="page-subtitle">{error ?? "This dataset isn't here — it may have been deleted."}</p>
        <Button className="mt-5" onClick={() => navigate("/datasets")}>
          Back to recordings
        </Button>
      </div>
    );
  }

  const totalDuration = info.fps && info.total_frames ? info.total_frames / info.fps : 0;
  const canPublish = !sync || sync.needs_sync || !sync.on_hub;
  const eps = episodes?.episodes ?? [];
  const totalEpisodes = episodes?.total ?? info.num_episodes ?? eps.length;
  const episodeCountLabel =
    episodesLoading && eps.length === 0
      ? "Loading…"
      : totalEpisodes > eps.length
        ? `${eps.length} of ${totalEpisodes} loaded`
        : `${eps.length} recorded`;

  return (
    <div className="page page-stack">
      <header className="page-head">
        <div className="min-w-0">
          <div className="eyebrow eyebrow-amber">Dataset</div>
          <h1 className="page-title mt-2.5 truncate">{info.single_task || repoId}</h1>
          <p className="mt-1 truncate font-mono text-sm text-muted-foreground">{repoId}</p>
        </div>
        <SyncPill sync={sync} />
      </header>

      {/* Stat strip */}
      <section className="plate plate-pad">
        <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
          <Stat value={info.num_episodes ?? 0} label="Episodes" />
          <Stat value={(info.total_frames ?? 0).toLocaleString()} label="Frames" />
          <Stat value={formatDuration(totalDuration)} label="Duration" />
          <Stat value={`${info.fps ?? 0}`} label="FPS" />
          <Stat
            value={<span className="text-base sm:text-lg">{info.robot_type ?? "—"}</span>}
            label="Robot"
          />
        </div>
      </section>

      {/* Actions */}
      <section className="flex flex-wrap items-center gap-2.5">
        <Button onClick={openResume}>
          <Plus className="mr-2 h-4 w-4" />
          Record more takes
        </Button>
        <Button variant="outline" onClick={handlePublish} disabled={publishing || !canPublish}>
          {publishing ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <UploadCloud className="mr-2 h-4 w-4" />
          )}
          {sync && sync.on_hub && !sync.needs_sync ? "Up to date" : "Publish to Hub"}
        </Button>
        <Button
          variant="outline"
          onClick={() => navigate("/training", { state: { datasetRepoId: repoId } })}
        >
          <GraduationCap className="mr-2 h-4 w-4" />
          Train this
        </Button>
        <Button
          variant="ghost"
          onClick={() => setShowDelete(true)}
          className="ml-auto text-[var(--red)] hover:bg-[var(--red-soft)] hover:text-[#ffb0ab]"
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Delete
        </Button>
      </section>

      {/* Episodes */}
      <section className="page-stack" style={{ gap: "0.85rem" }}>
        <div className="flex items-baseline justify-between">
          <span className="eyebrow">Episodes</span>
          <span className="font-mono text-xs uppercase tracking-wider text-[var(--ink-faint)]">
            {episodeCountLabel}
          </span>
        </div>
        {episodesLoading && eps.length === 0 ? (
          <div className="plate plate-pad flex items-center justify-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            Loading episodes…
          </div>
        ) : episodesError && eps.length === 0 ? (
          <div className="plate plate-pad flex flex-col items-center gap-3 text-center text-sm text-muted-foreground">
            <span>{episodesError}</span>
            <Button variant="outline" size="sm" onClick={reloadEpisodes}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry episodes
            </Button>
          </div>
        ) : eps.length === 0 ? (
          <div className="plate plate-pad text-center text-sm text-muted-foreground">
            No episodes to show yet.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {eps.map((ep) => (
                <button
                  key={ep.index}
                  type="button"
                  onClick={() => setActiveEpisode(ep)}
                  className="plate group overflow-hidden text-left transition-colors hover:border-[var(--amber-line)]"
                >
                  <div className="relative aspect-video bg-[var(--canvas)]">
                    {ep.cameras[0] ? (
                      <video
                        preload="metadata"
                        muted
                        playsInline
                        className="h-full w-full object-cover"
                        src={`${episodeVideoUrl(baseUrl, repoId, ep.index, ep.cameras[0])}#t=${
                          (ep.views?.[0]?.from ?? 0) + 0.04
                        }`}
                      />
                    ) : null}
                    <div className="absolute inset-0 grid place-items-center bg-black/20 opacity-0 transition-opacity group-hover:opacity-100">
                      <span className="grid h-10 w-10 place-items-center rounded-full bg-[var(--amber)] text-black">
                        <Play className="h-5 w-5" />
                      </span>
                    </div>
                  </div>
                  <div className="flex items-baseline justify-between px-3 py-2">
                    <span className="font-mono text-sm text-foreground">Ep {ep.index + 1}</span>
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {formatDuration(ep.duration_s)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
            {(episodesHasMore || episodesLoadingMore || episodesError) && (
              <div className="flex flex-col items-center justify-center gap-2 pt-1 text-center text-xs text-muted-foreground">
                {episodesError && eps.length > 0 ? <span>{episodesError}</span> : null}
                {(episodesHasMore || episodesLoadingMore) && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={loadMoreEpisodes}
                    disabled={episodesLoadingMore}
                  >
                    {episodesLoadingMore ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="mr-2 h-4 w-4" />
                    )}
                    {episodesLoadingMore ? "Loading episodes…" : "Load more episodes"}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </section>

      <EpisodePlayer
        repoId={repoId}
        baseUrl={baseUrl}
        episode={activeEpisode}
        onClose={() => setActiveEpisode(null)}
        onDeleteEpisode={handleDeleteEpisode}
        onReplaceEpisode={handleReplaceEpisode}
        busy={episodeActionPending}
      />

      <RecordingModal
        open={showResume}
        onOpenChange={(o) => {
          setShowResume(o);
          if (!o) releaseStreamsRef.current?.();
        }}
        robot={selectedRecord}
        datasetName={repoId}
        setDatasetName={() => {}}
        singleTask={info.single_task}
        setSingleTask={() => {}}
        numEpisodes={numEpisodes}
        setNumEpisodes={setNumEpisodes}
        episodeTimeS={episodeTimeS}
        setEpisodeTimeS={setEpisodeTimeS}
        resetTimeS={resetTimeS}
        setResetTimeS={setResetTimeS}
        resetCountdown={resetCountdown}
        setResetCountdown={setResetCountdown}
        streamingEncoding={streamingEncoding}
        setStreamingEncoding={setStreamingEncoding}
        cameras={cameras}
        setCameras={setCameras}
        onStart={handleStartMoreTakes}
        resumeRepoId={repoId}
        releaseStreamsRef={releaseStreamsRef}
      />

      <AlertDialog
        open={showDelete}
        onOpenChange={(o) => {
          setShowDelete(o);
          if (!o) setDeleteHub(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this dataset?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes{" "}
              <span className="font-mono text-foreground">{repoId}</span> from your computer. This
              can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {sync?.on_hub && (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-[var(--red-line)] bg-[var(--red-soft)] px-3 py-2.5 text-sm">
              <Checkbox
                checked={deleteHub}
                onCheckedChange={(v) => setDeleteHub(v === true)}
                className="mt-0.5"
              />
              <span className="text-foreground">
                Also delete from the Hugging Face Hub
                <span className="block text-xs text-muted-foreground">
                  Permanently removes the published copy too (needs write access).
                </span>
              </span>
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
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

const EpisodePlayer: React.FC<{
  repoId: string;
  baseUrl: string;
  episode: EpisodeInfo | null;
  onClose: () => void;
  onDeleteEpisode?: (index: number) => void | Promise<void>;
  onReplaceEpisode?: (index: number) => void | Promise<void>;
  busy?: boolean;
}> = ({ repoId, baseUrl, episode, onClose, onDeleteEpisode, onReplaceEpisode, busy = false }) => {
  const [camera, setCamera] = useState<string>("");
  const [confirming, setConfirming] = useState<"delete" | "replace" | null>(null);
  useEffect(() => {
    if (episode) {
      setCamera(episode.cameras[0] ?? "");
      setConfirming(null);
    }
  }, [episode]);

  const cameraLabel = (key: string) => key.split(".").pop() ?? key;
  const view = episode?.views?.find((v) => v.camera === camera);
  const hasSegment = !!view && view.to > view.from;
  const url = episode && camera ? episodeVideoUrl(baseUrl, repoId, episode.index, camera) : "";

  return (
    <Dialog open={!!episode} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[820px]">
        <DialogHeader className="border-b border-border px-5 py-3 pr-14 text-left">
          <DialogTitle className="text-base">
            Episode {episode ? episode.index + 1 : ""}
          </DialogTitle>
        </DialogHeader>
        <div className="bg-black">
          {episode && camera ? (
            hasSegment ? (
              <EpisodeVideo
                key={`${episode.index}-${camera}`}
                src={url}
                from={view!.from}
                to={view!.to}
              />
            ) : (
              <video
                key={`${episode.index}-${camera}`}
                controls
                autoPlay
                playsInline
                className="max-h-[70vh] w-full"
                src={url}
              />
            )
          ) : null}
        </div>
        {episode && episode.cameras.length > 1 && (
          <div className="flex flex-wrap gap-1.5 border-t border-border px-5 py-3">
            {episode.cameras.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setCamera(key)}
                className={`pill ${key === camera ? "pill-amber" : "text-muted-foreground"}`}
              >
                {cameraLabel(key)}
              </button>
            ))}
          </div>
        )}

        {episode && (onDeleteEpisode || onReplaceEpisode) && (
          <div className="border-t border-border px-5 py-3">
            {confirming ? (
              <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-muted-foreground">
                  {confirming === "replace" ? "Replace" : "Delete"} episode {episode.index + 1}? This{" "}
                  <span className="font-semibold text-foreground">rewrites the dataset</span> and
                  renumbers the later episodes. {confirming === "replace"
                    ? "A resume recording modal opens after deletion."
                    : "This can't be undone."}
                </p>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="outline" onClick={() => setConfirming(null)} disabled={busy}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      if (confirming === "replace") {
                        onReplaceEpisode?.(episode.index);
                      } else {
                        onDeleteEpisode?.(episode.index);
                      }
                      setConfirming(null);
                    }}
                    disabled={busy}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {busy ? "Rewriting…" : confirming === "replace" ? "Delete and replace" : "Delete episode"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-end gap-2">
                {onReplaceEpisode && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setConfirming("replace")}
                    disabled={busy}
                  >
                    <RefreshCw className="mr-1.5 h-4 w-4" />
                    Replace
                  </Button>
                )}
                {onDeleteEpisode && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirming("delete")}
                    disabled={busy}
                    className="text-[var(--red)] hover:bg-[var(--red-soft)] hover:text-[#ffb0ab]"
                  >
                    <Trash2 className="mr-1.5 h-4 w-4" />
                    Delete episode
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default Dataset;
