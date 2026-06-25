import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  CheckCircle2,
  RotateCcw,
  Square,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  getMuted,
  setMuted as persistMuted,
  playRecordingStartCue,
  playResetStartCue,
  playAutoAdvanceWarning,
} from "@/lib/recordingAudio";
import { useApi } from "@/contexts/ApiContext";
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

interface RecordingConfig {
  leader_port: string;
  follower_port: string;
  leader_config: string;
  follower_config: string;
  dataset_repo_id: string;
  single_task: string;
  num_episodes: number;
  episode_time_s: number;
  reset_time_s: number;
  reset_countdown?: boolean;
  fps: number;
  video: boolean;
  push_to_hub: boolean;
  resume: boolean;
  streaming_encoding: boolean;
}

type Phase = "preparing" | "recording" | "resetting" | "completed";

interface BackendStatus {
  recording_active: boolean;
  current_phase: string;
  current_episode?: number;
  total_episodes?: number;
  saved_episodes?: number;
  phase_elapsed_seconds?: number;
  phase_time_limit_s?: number;
  session_elapsed_seconds?: number;
  session_ended?: boolean;
  dataset_repo_id?: string;
  rerecord_pending?: boolean;
  error?: string;
  available_controls: {
    stop_recording: boolean;
    exit_early: boolean;
    rerecord_episode: boolean;
  };
}

const Recording = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { baseUrl, wsBaseUrl, fetchWithHeaders } = useApi();

  // Get recording config from navigation state
  const recordingConfig = location.state?.recordingConfig as RecordingConfig;

  // Backend status state - this is the single source of truth
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(
    null
  );
  const [recordingSessionStarted, setRecordingSessionStarted] = useState(false);

  const [optimisticPhase, setOptimisticPhase] = useState<Phase | null>(null);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [muted, setMutedState] = useState<boolean>(() => getMuted());
  const prevRealPhaseRef = useRef<Phase | null>(null);
  // Bumps on each re-record so the auto-advance warning re-fires for the same episode number.
  const [rerecordTick, setRerecordTick] = useState(0);
  const warningFiredForPhaseRef = useRef<{ phase: Phase | null; episode: number | null; tick: number }>({ phase: null, episode: null, tick: 0 });
  // Guards against React StrictMode double-invocation of the start effect.
  const startInitiatedRef = useRef(false);

  const toggleMute = useCallback(() => {
    setMutedState((prev) => {
      const next = !prev;
      persistMuted(next);
      return next;
    });
  }, []);

  // Redirect if no config provided
  useEffect(() => {
    if (!recordingConfig) {
      toast({
        title: "No Configuration",
        description: "Please start recording from the main page.",
        variant: "destructive",
      });
      navigate("/");
    }
  }, [recordingConfig, navigate, toast]);

  // Start recording session when component loads. The ref guard prevents
  // React StrictMode (and any future re-renders) from firing /start-recording
  // twice — the second call returns 409 and bounces the user home.
  useEffect(() => {
    if (recordingConfig && !startInitiatedRef.current) {
      startInitiatedRef.current = true;
      startRecordingSession();
    }
    // startRecordingSession is intentionally omitted: re-running this effect
    // on its identity change would re-fire /start-recording.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingConfig]);

  // Refs so the poll interval below stays stable and reads the latest values
  // without tearing itself down on every state change.
  const optimisticPhaseRef = useRef(optimisticPhase);
  optimisticPhaseRef.current = optimisticPhase;
  const rerecordTickRef = useRef(rerecordTick);
  rerecordTickRef.current = rerecordTick;

  // Poll backend status continuously to stay in sync
  useEffect(() => {
    if (!recordingSessionStarted) return;

    const pollStatus = async () => {
      try {
        const response = await fetchWithHeaders(
          `${baseUrl}/recording-status`
        );
        if (!response.ok) return;
        const status = await response.json();
        setBackendStatus(status);

        const currentOptimistic = optimisticPhaseRef.current;
        if (currentOptimistic && status.current_phase === currentOptimistic) {
          setOptimisticPhase(null);
        }

        const real = status.current_phase as Phase;
        const prev = prevRealPhaseRef.current;
        if (prev !== real) {
          if (real === "recording" && prev !== null) {
            playRecordingStartCue();
          } else if (real === "resetting") {
            playResetStartCue();
          }
          prevRealPhaseRef.current = real;
          warningFiredForPhaseRef.current = { phase: null, episode: null, tick: 0 };
        }

        const elapsed = status.phase_elapsed_seconds || 0;
        const limit = status.phase_time_limit_s || 0;
        const inFinalThreeSeconds = limit > 3 && elapsed >= limit - 3;
        const ep = status.current_episode ?? null;
        const tick = rerecordTickRef.current;
        const warned = warningFiredForPhaseRef.current;
        if (
          inFinalThreeSeconds &&
          currentOptimistic === null &&
          (warned.phase !== real ||
            warned.episode !== ep ||
            warned.tick !== tick)
        ) {
          playAutoAdvanceWarning();
          warningFiredForPhaseRef.current = { phase: real, episode: ep, tick };
        }

        if (!status.recording_active && status.session_ended) {
          const repoId = status.dataset_repo_id || recordingConfig.dataset_repo_id;
          if (status.current_phase === "error") {
            // Surface the failure (with the copy button) instead of silently
            // bouncing back to the dataset page.
            toast({
              title: "Recording failed",
              description:
                status.error ||
                "The recording session ended unexpectedly. Check the server logs.",
              variant: "destructive",
            });
          }
          navigate(`/dataset/${repoId}`);
        }
      } catch (error) {
        console.error("Error polling recording status:", error);
      }
    };

    pollStatus();
    const statusInterval = setInterval(pollStatus, 1000);
    return () => clearInterval(statusInterval);
  }, [recordingSessionStarted, recordingConfig, navigate, baseUrl, fetchWithHeaders, toast]);

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  };

  const startRecordingSession = async () => {
    try {
      const response = await fetchWithHeaders(`${baseUrl}/start-recording`, {
        method: "POST",
        body: JSON.stringify(recordingConfig),
      });

      const data = await response.json();

      if (response.ok) {
        setRecordingSessionStarted(true);
        toast({
          title: "Recording Started",
          description: `Started recording ${recordingConfig.num_episodes} episodes`,
        });
      } else {
        toast({
          title: "Error Starting Recording",
          description: data.message || "Failed to start recording session.",
          variant: "destructive",
        });
        navigate("/");
      }
    } catch (error) {
      toast({
        title: "Connection Error",
        description: "Could not connect to the backend server.",
        variant: "destructive",
      });
      navigate("/");
    }
  };

  const handleExitEarly = useCallback(async () => {
    if (!backendStatus?.available_controls.exit_early) return;
    if (optimisticPhase !== null) return;

    const realPhase = backendStatus.current_phase as Phase;
    const next: Phase | null =
      realPhase === "recording" ? "resetting" :
      realPhase === "resetting" ? "recording" : null;

    if (!next) return;

    setOptimisticPhase(next);

    try {
      const response = await fetchWithHeaders(
        `${baseUrl}/recording-exit-early`,
        { method: "POST" }
      );
      if (!response.ok) {
        const data = await response.json();
        setOptimisticPhase(null);
        toast({
          title: "Error",
          description: data.message,
          variant: "destructive",
        });
      }
    } catch (error) {
      setOptimisticPhase(null);
      toast({
        title: "Connection Error",
        description: "Could not connect to the backend server.",
        variant: "destructive",
      });
    }
  }, [backendStatus, optimisticPhase, baseUrl, fetchWithHeaders, toast]);

  const handleRerecordEpisode = useCallback(async () => {
    if (!backendStatus?.available_controls.rerecord_episode) return;

    try {
      const response = await fetchWithHeaders(
        `${baseUrl}/recording-rerecord-episode`,
        {
          method: "POST",
        }
      );
      const data = await response.json();

      if (response.ok) {
        setRerecordTick((t) => t + 1);
        toast({
          title: "Re-recording Episode",
          description: `Episode ${backendStatus.current_episode} will be re-recorded.`,
        });
      } else {
        toast({
          title: "Error",
          description: data.message,
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Connection Error",
        description: "Could not connect to the backend server.",
        variant: "destructive",
      });
    }
  }, [backendStatus, baseUrl, fetchWithHeaders, toast]);

  const handleStopRecording = useCallback(async () => {
    if (!backendStatus?.available_controls.stop_recording) return;
    try {
      await fetchWithHeaders(`${baseUrl}/stop-recording`, {
        method: "POST",
      });

      toast({
        title: "Stopping recording",
        description: "Finalizing dataset…",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to stop recording.",
        variant: "destructive",
      });
    }
  }, [backendStatus, baseUrl, fetchWithHeaders, toast]);

  const requestStopRecording = useCallback(() => {
    if (!backendStatus?.available_controls.stop_recording) return;
    setShowStopConfirm(true);
  }, [backendStatus]);

  const confirmStopRecording = useCallback(async () => {
    setShowStopConfirm(false);
    await handleStopRecording();
  }, [handleStopRecording]);

  const handlersRef = useRef({
    handleExitEarly,
    handleRerecordEpisode,
    requestStopRecording,
    showStopConfirm,
  });
  useEffect(() => {
    handlersRef.current = {
      handleExitEarly,
      handleRerecordEpisode,
      requestStopRecording,
      showStopConfirm,
    };
  });

  const sessionReady = recordingSessionStarted && backendStatus !== null;

  useEffect(() => {
    if (!sessionReady) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (e.key === " " || e.code === "Space" || e.key === "ArrowRight") {
        e.preventDefault();
        handlersRef.current.handleExitEarly();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        handlersRef.current.handleRerecordEpisode();
      } else if (e.key === "Escape") {
        if (handlersRef.current.showStopConfirm) return;
        handlersRef.current.requestStopRecording();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sessionReady]);

  if (!recordingConfig) {
    return (
      <div className="focus-root flex min-h-screen items-center justify-center text-foreground">
        <div className="text-center">
          <p className="text-lg">No recording configuration found.</p>
          <Button onClick={() => navigate("/")} className="mt-4">
            Return to dashboard
          </Button>
        </div>
      </div>
    );
  }

  // Show loading state while waiting for backend status
  if (!backendStatus) {
    return (
      <div className="focus-root flex min-h-screen items-center justify-center text-foreground">
        <div className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-b-2 border-primary"></div>
          <p className="text-lg text-muted-foreground">Connecting to recording session…</p>
        </div>
      </div>
    );
  }

  const realPhase = backendStatus.current_phase as Phase;
  const currentPhase: Phase = optimisticPhase ?? realPhase;
  const currentEpisode = backendStatus.current_episode ?? 1;
  const totalEpisodes =
    backendStatus.total_episodes ?? recordingConfig.num_episodes;

  const phaseElapsedTime = optimisticPhase
    ? 0
    : backendStatus.phase_elapsed_seconds || 0;
  // Between-takes countdown is opt-in. When off, the reset phase has no time
  // limit (0) — the teleoperator advances manually.
  const resetCountdownOn = recordingConfig.reset_countdown !== false;
  const phaseTimeLimit =
    currentPhase === "recording"
      ? recordingConfig.episode_time_s
      : currentPhase === "resetting"
      ? resetCountdownOn
        ? recordingConfig.reset_time_s
        : 0
      : backendStatus.phase_time_limit_s || 0;

  const sessionElapsedTime = backendStatus.session_elapsed_seconds || 0;

  const saved = backendStatus.saved_episodes ?? Math.max(0, currentEpisode - 1);
  const isActivePhase =
    currentPhase === "recording" || currentPhase === "resetting";

  const phaseInfo: Record<
    Phase,
    { state: string; headline: string; sub: string; bar: string; primary?: string }
  > = {
    preparing: {
      state: "PREPARING",
      headline: "Preparing the session",
      sub: "Connecting the robot and cameras…",
      bar: "var(--ink-muted)",
    },
    recording: {
      state: "RECORDING",
      headline: "Do the task",
      sub: "When the robot finishes the task, press Finish take. If the take went badly, press Redo to scrap it and start over.",
      bar: "var(--green)",
      primary: "Finish take",
    },
    resetting: {
      state: "RESET",
      headline: "Was that take good?",
      sub: "Put everything back to the starting position — no rush. Keep it to save this take and continue, or Redo to record this episode again.",
      bar: "var(--amber)",
      primary: "Keep it · next episode",
    },
    completed: {
      state: "DONE",
      headline: "Recording complete",
      sub: "Saving the dataset and taking you to upload…",
      bar: "var(--green)",
    },
  };
  // A redo has been queued: the upcoming reset leads back into re-recording the
  // SAME episode, so the screen must say "start over", not "keep & next".
  const rerecordPending = !!backendStatus.rerecord_pending;
  const showRedo =
    !!backendStatus.available_controls.rerecord_episode && !rerecordPending;
  const p =
    currentPhase === "resetting" && rerecordPending
      ? {
          ...phaseInfo.resetting,
          state: "REDO",
          headline: `Reset, then record episode ${currentEpisode} again`,
          sub: "That take was discarded. Put the scene back to the starting position, then start over.",
          primary: "Start over now",
        }
      : phaseInfo[currentPhase] ?? phaseInfo.preparing;
  const progressPct =
    phaseTimeLimit > 0 ? Math.min((phaseElapsedTime / phaseTimeLimit) * 100, 100) : 0;
  const showDots = totalEpisodes <= 12;

  return (
    <div className="focus-root bg-grid min-h-screen p-4 text-foreground sm:p-8">
      {/* Full-viewport phase color so the state is readable from the corner of
          your eye while you're focused on the leader arm. */}
      <div className="rec-frame" data-tone={currentPhase} aria-hidden="true" />
      <div className="mx-auto max-w-2xl">
        {/* Top bar */}
        <div className="mb-6 flex items-center justify-between gap-3">
          <Button onClick={() => navigate("/")} variant="outline" size="sm">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Dashboard
          </Button>
          <div className="flex items-center gap-2.5">
            <span className="pill" title="Total session time">
              <span className="tabular-nums normal-case">{formatTime(sessionElapsedTime)}</span>
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleMute}
              aria-label={muted ? "Unmute cues" : "Mute cues"}
              className="h-9 w-9"
            >
              {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
            </Button>
          </div>
        </div>

        <div className="plate ticked p-5 sm:p-7">
          {/* Episode progress */}
          <div className="mb-6">
            <div className="flex items-baseline justify-between gap-3">
              <span className="eyebrow min-w-0 truncate" title={recordingConfig.dataset_repo_id}>
                {recordingConfig.single_task || recordingConfig.dataset_repo_id}
              </span>
              <span className="shrink-0 font-mono text-xs uppercase tracking-wider text-[var(--ink-faint)]">
                {saved} / {totalEpisodes} saved
              </span>
            </div>
            {showDots ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {Array.from({ length: totalEpisodes }).map((_, i) => {
                  const state = i < saved ? "saved" : i === saved ? "current" : "todo";
                  return (
                    <span
                      key={i}
                      title={`Episode ${i + 1}`}
                      className={
                        "h-2.5 min-w-[12px] flex-1 rounded-full " +
                        (state === "saved"
                          ? "bg-[var(--green)]"
                          : state === "current"
                            ? "animate-pulse bg-[var(--amber)]"
                            : "border border-border bg-[var(--surface-2)]")
                      }
                    />
                  );
                })}
              </div>
            ) : (
              <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full border border-border bg-[var(--sunken)]">
                <div className="h-full bg-[var(--green)]" style={{ width: `${(saved / totalEpisodes) * 100}%` }} />
              </div>
            )}
          </div>

          {/* Phase banner */}
          <div
            className="rounded-[calc(var(--radius)-2px)] border-2 bg-[var(--sunken)] p-5 text-center sm:p-7"
            style={{ borderColor: p.bar }}
          >
            <div role="status" aria-live="polite" className="flex items-center justify-center gap-3">
              <span
                className={isActivePhase ? "rec-orb animate-pulse" : "rec-orb"}
                style={{ background: p.bar, boxShadow: `0 0 18px ${p.bar}` }}
              />
              <span className="rec-state" style={{ color: p.bar }}>
                {p.state}
              </span>
            </div>
            <h2 className="mt-3 font-display text-lg font-semibold tracking-tight text-foreground sm:text-xl">
              {p.headline}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
              {p.sub}
            </p>

            {isActivePhase && phaseTimeLimit > 0 && (
              <>
                <div className="mt-5 font-mono text-4xl font-semibold tabular-nums text-foreground sm:text-5xl">
                  {formatTime(phaseElapsedTime)}
                  <span className="ml-2 text-base font-normal text-[var(--ink-faint)]">
                    / max {formatTime(phaseTimeLimit)}
                  </span>
                </div>
                <div className="mx-auto mt-3 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-[var(--canvas)] ring-1 ring-border">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${progressPct}%`, background: p.bar }}
                  />
                </div>
              </>
            )}
            {currentPhase === "resetting" && phaseTimeLimit === 0 && (
              <p className="mt-5 font-mono text-sm text-[var(--ink-faint)]">
                No timer — continue when you're ready.
              </p>
            )}
          </div>

          {/* Controls */}
          {currentPhase === "completed" ? (
            <div className="mt-6 text-center">
              <CheckCircle2 className="mx-auto mb-2 h-7 w-7 text-[var(--green)]" />
              <p className="text-sm text-muted-foreground">
                Recorded {saved} episode{saved === 1 ? "" : "s"} — redirecting to upload…
              </p>
            </div>
          ) : (
            <>
              {showRedo ? (
                <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1.5fr]">
                  <Button
                    onClick={handleRerecordEpisode}
                    disabled={!backendStatus.available_controls.rerecord_episode}
                    variant="outline"
                    className="h-14 w-full text-base"
                  >
                    <RotateCcw className="mr-2 h-5 w-5" />
                    Redo take
                    <span className="ml-2 font-mono text-[0.65rem] opacity-60">←</span>
                  </Button>
                  <Button
                    onClick={handleExitEarly}
                    disabled={
                      !backendStatus.available_controls.exit_early || optimisticPhase !== null
                    }
                    className="h-14 w-full text-base font-semibold"
                  >
                    <SkipForward className="mr-2 h-5 w-5" />
                    {p.primary ?? "Continue"}
                    <span className="ml-2 font-mono text-[0.65rem] opacity-70">space / →</span>
                  </Button>
                </div>
              ) : (
                <Button
                  onClick={handleExitEarly}
                  disabled={
                    !backendStatus.available_controls.exit_early || optimisticPhase !== null
                  }
                  className="mt-6 h-14 w-full text-base font-semibold"
                >
                  <SkipForward className="mr-2 h-5 w-5" />
                  {p.primary ?? "Continue"}
                  <span className="ml-2 font-mono text-[0.65rem] opacity-70">space / →</span>
                </Button>
              )}
              <button
                type="button"
                onClick={requestStopRecording}
                disabled={!backendStatus.available_controls.stop_recording}
                className="btn-stop mt-3 h-11 w-full text-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Square className="mr-2 h-4 w-4" />
                Stop session
                <span className="ml-2 font-mono text-[0.65rem] opacity-70">esc</span>
              </button>
              <p className="mt-4 text-center font-mono text-[0.7rem] uppercase tracking-wider text-[var(--ink-faint)]">
                space / → {rerecordPending ? "start over" : "continue"}
                {showRedo && <>&nbsp;&nbsp;·&nbsp;&nbsp;← redo</>}
                &nbsp;&nbsp;·&nbsp;&nbsp;esc stop
              </p>
            </>
          )}
        </div>
      </div>

      <AlertDialog open={showStopConfirm} onOpenChange={setShowStopConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop recording?</AlertDialogTitle>
            <AlertDialogDescription>
              Saved episodes are kept. The session will end and you'll be taken to the upload page.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep recording</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmStopRecording}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Stop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Recording;
