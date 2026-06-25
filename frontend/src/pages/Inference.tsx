import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import Logo from "@/components/Logo";
import { useApi } from "@/contexts/ApiContext";
import { useToast } from "@/hooks/use-toast";
import { useGoBack } from "@/hooks/useGoBack";
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
  InferenceStatus,
  getInferenceStatus,
  stopInference,
} from "@/lib/inferenceApi";

const POLL_MS = 1000;

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

const Inference: React.FC = () => {
  const goBack = useGoBack();
  const { baseUrl, fetchWithHeaders } = useApi();
  const { toast } = useToast();
  const [status, setStatus] = useState<InferenceStatus | null>(null);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const navigatedAwayRef = useRef(false);
  // Independent flag: we may request a stop (safety net) before the run
  // is actually inactive. We must not flip navigatedAwayRef yet — that
  // would block the natural completion path on the next tick.
  const stopRequestedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const stopIfHung = async () => {
      try {
        await stopInference(baseUrl, fetchWithHeaders);
      } catch {
        // The next status poll will surface the failure if it persists.
      }
    };
    const tick = async () => {
      try {
        const next = await getInferenceStatus(baseUrl, fetchWithHeaders);
        if (cancelled) return;
        setStatus(next);
        // Auto-bounce home once the run is done.
        if (!next.inference_active && !navigatedAwayRef.current) {
          navigatedAwayRef.current = true;
          if (next.exited) {
            const outcome =
              next.outcome ?? (next.exit_code === 0 ? "ok" : "failed");
            if (outcome === "ok") {
              toast({ title: "Inference finished", description: "Run completed." });
            } else if (outcome === "ran_with_warning") {
              // The skill ran; only shutdown choked on a loaded motor (usually
              // the gripper holding an object). Not a failure.
              toast({
                title: "Skill ran — gripper was under load at shutdown",
                description:
                  next.hint ??
                  "The arm was still holding or pushing when the run ended. Remove the object or open the gripper; power-cycle the arm if a motor stops responding.",
                duration: 15000,
              });
            } else {
              toast({
                title: next.hint ?? "Inference failed",
                description:
                  next.error ??
                  `Exit code ${next.exit_code}. Log: ${next.log_path ?? "(unavailable)"}`,
                variant: "destructive",
                duration: 15000,
              });
            }
          }
          goBack();
          return;
        }
        // Safety net: only fire after the rollout *main loop* has actually
        // started (lerobot honours --duration there). Setup time — policy
        // load, snapshot_download, bus connect, camera connect — can take
        // 10–30s and must NOT count against the user's configured duration.
        if (
          next.inference_active &&
          next.rollout_started_at != null &&
          next.duration_s != null &&
          next.duration_s > 0 &&
          next.rollout_elapsed_s > next.duration_s + 10 &&
          !stopRequestedRef.current
        ) {
          stopRequestedRef.current = true;
          toast({
            title: "Inference seems hung",
            description: `Rollout past duration by ${Math.round(
              next.rollout_elapsed_s - next.duration_s,
            )}s. Stopping.`,
            variant: "destructive",
          });
          stopIfHung();
        }
      } catch (e) {
        if (!cancelled) {
          toast({
            title: "Lost connection to backend",
            description: e instanceof Error ? e.message : String(e),
            variant: "destructive",
          });
        }
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [baseUrl, fetchWithHeaders, toast, goBack]);

  // Esc stops the run, matching the Recording screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && status?.inference_active) setShowStopConfirm(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status?.inference_active]);

  const handleStop = async () => {
    setShowStopConfirm(false);
    try {
      await stopInference(baseUrl, fetchWithHeaders);
      // Status poll will catch the inactive state and navigate home.
    } catch (e) {
      toast({
        title: "Stop failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  };

  if (!status) {
    return (
      <div className="focus-root flex min-h-screen items-center justify-center text-muted-foreground">
        <Loader2 className="mr-3 h-6 w-6 animate-spin text-primary" /> Connecting to
        inference…
      </div>
    );
  }

  const setupElapsed = status.elapsed_s ?? 0;
  const rolloutElapsed = status.rollout_elapsed_s ?? 0;
  const duration = status.duration_s ?? 0;
  const isSettingUp = status.inference_active && status.rollout_started_at == null;
  const isRunning = status.inference_active && status.rollout_started_at != null;
  // When setting up: progress is uncertain — show a soft pulsing bar.
  // When rolling out: progress is rolloutElapsed / duration.
  const pct =
    isRunning && duration > 0
      ? Math.min(100, (rolloutElapsed / duration) * 100)
      : 0;
  const timerSeconds = isRunning ? rolloutElapsed : setupElapsed;
  const tone = isSettingUp ? "var(--amber)" : "var(--green)";

  return (
    <div className="focus-root bg-grid min-h-screen p-4 text-foreground sm:p-6 lg:p-8">
      {/* Full-viewport color so the state reads from across the room, like the
          Recording screen: amber while setting up, green while running. */}
      <div
        className="rec-frame"
        data-tone={isRunning ? "recording" : "resetting"}
        aria-hidden="true"
      />

      {/* Top bar */}
      <div className="mx-auto flex max-w-2xl items-center gap-3">
        <Button onClick={goBack} variant="outline" size="sm">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <div className="ml-1 flex items-center gap-2.5">
          <Logo iconOnly />
          <span className="eyebrow eyebrow-amber">Running a skill · live</span>
        </div>
      </div>

      {/* Center plate */}
      <div className="mx-auto mt-6 max-w-2xl sm:mt-10">
        <div
          className="plate ticked border-2 p-6 text-center sm:p-8"
          style={{ borderColor: tone }}
        >
          {/* Glanceable state */}
          <div
            role="status"
            aria-live="polite"
            className="flex items-center justify-center gap-3"
          >
            <span
              className="rec-orb animate-pulse"
              style={{ background: tone, boxShadow: `0 0 18px ${tone}` }}
            />
            <span className="rec-state" style={{ color: tone }}>
              {isSettingUp ? "SETTING UP" : "RUNNING"}
            </span>
          </div>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
            {isSettingUp
              ? "Loading the policy and connecting the arm and cameras — this can take 10–30s."
              : "The robot is performing the skill on its own. Watch it, and press Stop if anything looks off."}
          </p>

          {/* Timer */}
          <div
            className="mt-6 font-mono text-6xl font-semibold leading-none tabular-nums sm:text-7xl"
            style={{ color: tone }}
          >
            {formatTime(timerSeconds)}
            {isRunning && duration > 0 && (
              <span className="ml-2 align-baseline text-base font-normal text-[var(--ink-faint)]">
                / {formatTime(duration)}
              </span>
            )}
          </div>

          {/* Progress */}
          <div className="mx-auto mt-4 h-1.5 w-full max-w-sm overflow-hidden rounded-full border border-border bg-[var(--canvas)]">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                isSettingUp ? "w-full animate-pulse" : ""
              }`}
              style={{ width: isSettingUp ? "100%" : `${pct}%`, background: tone }}
            />
          </div>

          {/* Policy */}
          <div
            className="mt-5 truncate font-mono text-xs text-[var(--ink-faint)]"
            title={status.policy_ref ?? undefined}
          >
            policy · {status.policy_ref ?? "(unknown)"}
          </div>

          {/* Stop */}
          <button
            type="button"
            onClick={() => setShowStopConfirm(true)}
            disabled={!status.inference_active}
            className="btn-stop mt-6 h-12 w-full text-base disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Square className="mr-2 h-5 w-5" />
            Stop the robot
            <span className="ml-2 font-mono text-[0.65rem] opacity-70">esc</span>
          </button>
        </div>
      </div>

      <AlertDialog open={showStopConfirm} onOpenChange={setShowStopConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop inference?</AlertDialogTitle>
            <AlertDialogDescription>
              The follower will hold its current pose. You can launch another
              run from the job tile.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep running</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleStop}
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

export default Inference;
