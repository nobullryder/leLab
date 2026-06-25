import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Database,
  Download,
  ExternalLink,
  GraduationCap,
  LayoutGrid,
  List,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useToast } from "@/hooks/use-toast";
import { useHfAuth } from "@/contexts/HfAuthContext";
import { useRobots } from "@/hooks/useRobots";
import { useDatasets } from "@/hooks/useDatasets";
import { useRecordingPrefs } from "@/hooks/useRecordingPrefs";
import { DatasetItem, deleteDataset, importDataset } from "@/lib/datasetApi";
import { collidingNames, prettyName, recordedAtLabel } from "@/lib/prettyName";
import { CameraConfig } from "@/components/recording/CameraConfiguration";
import RecordingModal from "@/components/landing/RecordingModal";

const VIEW_KEY = "lelab.datasetsView";

// Pretty title + the raw repo id (and recorded date when two share a name) so
// same-named datasets are easy to tell apart.
const DatasetLabel: React.FC<{ repoId: string; ambiguous: boolean }> = ({ repoId, ambiguous }) => {
  const date = recordedAtLabel(repoId);
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <span className="truncate font-semibold text-foreground">{prettyName(repoId)}</span>
        {ambiguous && date && <span className="pill pill-amber shrink-0">{date}</span>}
      </div>
      <div className="truncate font-mono text-xs text-[var(--ink-faint)]" title={repoId}>
        {repoId}
      </div>
    </div>
  );
};

const SourceBadge: React.FC<{ source: DatasetItem["source"] }> = ({ source }) => {
  if (source === "both") {
    return (
      <span className="shrink-0 rounded-md border border-[var(--green-line)] bg-[var(--green-soft)] px-2 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wide text-[#9bf0c4]">
        on Hub
      </span>
    );
  }
  if (source === "hub") {
    return (
      <span className="shrink-0 rounded-md border border-border px-2 py-0.5 font-mono text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground">
        Hub
      </span>
    );
  }
  return null;
};

const Datasets: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const { auth } = useHfAuth();
  const { baseUrl, fetchWithHeaders } = useApi();
  const { selectedRecord } = useRobots();
  const { datasets, loading, refresh } = useDatasets();
  const nameCollisions = collidingNames(datasets.map((d) => d.repo_id));

  const [deleteTarget, setDeleteTarget] = useState<DatasetItem | null>(null);
  const [deleteHub, setDeleteHub] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [view, setView] = useState<"grid" | "list">(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  const chooseView = (v: "grid" | "list") => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  };

  // Recording dialog state (moved here from the retired Teach page).
  const [showRecordingModal, setShowRecordingModal] = useState(false);
  const [datasetName, setDatasetName] = useState("");
  const [singleTask, setSingleTask] = useState("");
  const [numEpisodes, setNumEpisodes] = useState(5);
  const [episodeTimeS, setEpisodeTimeS] = useState(60);
  const { resetCountdown, resetTimeS, setResetCountdown, setResetTimeS } = useRecordingPrefs();
  const [streamingEncoding, setStreamingEncoding] = useState(true);
  const [cameras, setCameras] = useState<CameraConfig[]>([]);
  const releaseStreamsRef = useRef<(() => void) | null>(null);

  useEffect(() => () => releaseStreamsRef.current?.(), []);

  const openRecordingModal = () => {
    setCameras(selectedRecord?.cameras ? [...selectedRecord.cameras] : []);
    setShowRecordingModal(true);
  };
  const handleRecordingModalClose = (open: boolean) => {
    setShowRecordingModal(open);
    if (!open) releaseStreamsRef.current?.();
  };

  // The chat's record_skill action routes here with a prefill, then opens the dialog.
  useEffect(() => {
    const prefill = (
      location.state as {
        prefillRecording?: { task?: string; dataset?: string; episodes?: number };
      } | null
    )?.prefillRecording;
    if (!prefill) return;
    if (prefill.task) setSingleTask(prefill.task);
    if (prefill.dataset) setDatasetName(prefill.dataset);
    if (prefill.episodes && prefill.episodes > 0) setNumEpisodes(prefill.episodes);
    openRecordingModal();
    navigate(location.pathname, { replace: true, state: {} });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  const handleStartRecording = async () => {
    if (!selectedRecord) {
      toast({
        title: "No robot selected",
        description: "Pick a robot on the Robot page first.",
        variant: "destructive",
      });
      return;
    }
    if (!selectedRecord.is_clean) {
      toast({
        title: "Robot not ready",
        description: `${selectedRecord.name} still needs calibration. Finish it on the Robot page.`,
        variant: "destructive",
      });
      return;
    }
    if (!datasetName || !singleTask) {
      toast({
        title: "Missing details",
        description: "Add a name for the recording and describe the task.",
        variant: "destructive",
      });
      return;
    }

    const robot = selectedRecord;
    const datasetRepoId =
      auth.status === "authenticated" ? `${auth.username}/${datasetName}` : datasetName;

    if (cameras.length > 0 && releaseStreamsRef.current) {
      releaseStreamsRef.current();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const cameraDict = cameras.reduce(
      (acc, cam) => {
        acc[cam.name] = {
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
      leader_port: robot.leader_port,
      follower_port: robot.follower_port,
      leader_config: robot.leader_config,
      follower_config: robot.follower_config,
      dataset_repo_id: datasetRepoId,
      single_task: singleTask,
      num_episodes: numEpisodes,
      episode_time_s: episodeTimeS,
      reset_time_s: resetTimeS,
      reset_countdown: resetCountdown,
      fps: 30,
      video: true,
      push_to_hub: false,
      resume: false,
      streaming_encoding: streamingEncoding,
      cameras: cameraDict,
    };

    setShowRecordingModal(false);
    navigate("/recording", { state: { recordingConfig } });
  };

  const handleImport = async (d: DatasetItem) => {
    setImporting(d.repo_id);
    try {
      const res = await importDataset(baseUrl, fetchWithHeaders, d.repo_id);
      if (res.success) {
        toast({ title: "Imported", description: `${d.repo_id} is now available locally.` });
        refresh();
      } else {
        toast({ title: "Import failed", description: res.message, variant: "destructive" });
      }
    } catch (e) {
      toast({
        title: "Import failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setImporting(null);
    }
  };

  const openDataset = (d: DatasetItem) => navigate(`/dataset/${d.repo_id}`);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await deleteDataset(baseUrl, fetchWithHeaders, deleteTarget.repo_id, deleteHub);
      if (res.success) {
        const hubNote = deleteHub
          ? res.hub_deleted
            ? " (also removed from the Hub)"
            : ` (Hub delete failed: ${res.hub_error ?? "unknown"})`
          : "";
        toast({
          title: "Dataset deleted",
          description: `${deleteTarget.repo_id} removed from disk.${hubNote}`,
        });
        refresh();
      } else {
        toast({ title: "Delete failed", description: res.message, variant: "destructive" });
      }
    } catch {
      toast({ title: "Delete failed", description: "Could not reach the backend.", variant: "destructive" });
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
      setDeleteHub(false);
    }
  };

  const actions = (d: DatasetItem) => (
    <div className="flex shrink-0 gap-2">
      {d.source === "hub" ? (
        <Button size="sm" onClick={() => handleImport(d)} disabled={importing === d.repo_id}>
          {importing === d.repo_id ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Download className="mr-1.5 h-4 w-4" />
          )}
          {importing === d.repo_id ? "Importing…" : "Import"}
        </Button>
      ) : (
        <Button size="sm" onClick={() => openDataset(d)}>
          <ExternalLink className="mr-1.5 h-4 w-4" />
          Open
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={() => navigate("/training", { state: { datasetRepoId: d.repo_id } })}
      >
        <GraduationCap className="mr-1.5 h-4 w-4" />
        Train
      </Button>
      {(d.source === "local" || d.source === "both") && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setDeleteTarget(d)}
          aria-label="Delete dataset"
          className="text-[var(--red)] hover:bg-[var(--red-soft)] hover:text-[#ffb0ab]"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </div>
  );

  return (
    <div className="page page-stack">
      <header className="page-head">
        <div>
          <div className="eyebrow eyebrow-amber">
            <Database className="h-3.5 w-3.5" />
            Datasets
          </div>
          <h1 className="page-title mt-2.5">Your datasets</h1>
          <p className="page-subtitle">
            Every recording you've made. Open one to watch its episodes, add takes, publish it to
            the Hub, or train a skill from it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-border p-0.5">
            {(["grid", "list"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => chooseView(v)}
                aria-label={`${v} view`}
                aria-pressed={view === v}
                className={`grid h-8 w-8 place-items-center rounded-md transition-colors ${
                  view === v
                    ? "bg-[var(--surface-2)] text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {v === "grid" ? <LayoutGrid className="h-4 w-4" /> : <List className="h-4 w-4" />}
              </button>
            ))}
          </div>
          <Button onClick={openRecordingModal}>
            <Plus className="mr-2 h-4 w-4" />
            Record new
          </Button>
        </div>
      </header>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="mr-3 h-5 w-5 animate-spin text-primary" /> Loading datasets…
        </div>
      ) : datasets.length === 0 ? (
        <div className="plate plate-pad text-center">
          <p className="text-sm text-muted-foreground">
            No datasets yet — record your first task to create one.
          </p>
          <Button className="mt-4" onClick={openRecordingModal}>
            <Plus className="mr-2 h-4 w-4" />
            Record new
          </Button>
        </div>
      ) : view === "grid" ? (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {datasets.map((d) => (
            <div key={d.repo_id} className="plate plate-pad flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <DatasetLabel
                  repoId={d.repo_id}
                  ambiguous={nameCollisions.has(prettyName(d.repo_id).toLowerCase())}
                />
                <SourceBadge source={d.source} />
              </div>
              {actions(d)}
            </div>
          ))}
        </div>
      ) : (
        <div className="plate divide-y divide-border overflow-hidden">
          {datasets.map((d) => (
            <div key={d.repo_id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <DatasetLabel
                  repoId={d.repo_id}
                  ambiguous={nameCollisions.has(prettyName(d.repo_id).toLowerCase())}
                />
              </div>
              <SourceBadge source={d.source} />
              {actions(d)}
            </div>
          ))}
        </div>
      )}

      <RecordingModal
        open={showRecordingModal}
        onOpenChange={handleRecordingModalClose}
        robot={selectedRecord}
        datasetName={datasetName}
        setDatasetName={setDatasetName}
        singleTask={singleTask}
        setSingleTask={setSingleTask}
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
        onStart={handleStartRecording}
        releaseStreamsRef={releaseStreamsRef}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) {
            setDeleteTarget(null);
            setDeleteHub(false);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this dataset?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes{" "}
              <span className="font-mono text-foreground">{deleteTarget?.repo_id}</span> from your
              computer. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteTarget?.source === "both" && (
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

export default Datasets;
