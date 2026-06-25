import React, { useEffect, useRef, useState } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";

function fmt(s: number): string {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/**
 * A video player scoped to a single episode's [from, to] window inside a shared
 * (multi-episode) video file. The timeline, time readout, and seeking are all
 * relative to the episode, and playback stops at the episode's end — so you only
 * ever see that episode, not the rest of the file.
 */
export const EpisodeVideo: React.FC<{ src: string; from: number; to: number }> = ({
  src,
  from,
  to,
}) => {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(from);
  const [ended, setEnded] = useState(false);

  const dur = Math.max(0.001, to - from);
  const rel = Math.min(Math.max(0, t - from), dur);
  const pct = (rel / dur) * 100;

  const onLoaded = () => {
    const v = ref.current;
    if (v) {
      v.currentTime = from;
      setT(from);
    }
  };
  const onTime = () => {
    const v = ref.current;
    if (!v) return;
    if (v.currentTime >= to) {
      v.pause();
      v.currentTime = to;
      setT(to);
      setEnded(true);
      return;
    }
    setT(v.currentTime);
    setEnded(false);
  };
  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime >= to - 0.03 || v.currentTime < from) v.currentTime = from;
      setEnded(false);
      void v.play();
    } else {
      v.pause();
    }
  };
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const v = ref.current;
    if (!v) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    v.currentTime = from + frac * dur;
    setT(v.currentTime);
    setEnded(false);
  };

  // Re-anchor to the start when the segment changes (e.g. switching cameras).
  useEffect(() => {
    const v = ref.current;
    if (v) {
      v.currentTime = from;
      setT(from);
      setEnded(false);
    }
  }, [src, from, to]);

  // On unmount, fully release the media element so the browser drops its
  // connection to the video endpoint — otherwise the backend keeps the .mp4
  // open and a subsequent episode delete fails (Windows file lock).
  useEffect(() => {
    const v = ref.current;
    return () => {
      if (!v) return;
      try {
        v.pause();
        v.removeAttribute("src");
        v.load();
      } catch {
        /* ignore */
      }
    };
  }, []);

  return (
    <div className="relative">
      <video
        ref={ref}
        src={src}
        playsInline
        autoPlay
        className="max-h-[70vh] w-full bg-black"
        onLoadedMetadata={onLoaded}
        onTimeUpdate={onTime}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onClick={toggle}
      />
      <div className="flex items-center gap-3 bg-black/85 px-4 py-2.5">
        <button
          type="button"
          onClick={toggle}
          aria-label={ended ? "Replay" : playing ? "Pause" : "Play"}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--amber)] text-black"
        >
          {ended ? (
            <RotateCcw className="h-4 w-4" />
          ) : playing ? (
            <Pause className="h-4 w-4" />
          ) : (
            <Play className="h-4 w-4" />
          )}
        </button>
        <div
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(dur)}
          aria-valuenow={Math.round(rel)}
          tabIndex={0}
          className="h-1.5 flex-1 cursor-pointer overflow-hidden rounded-full bg-white/20"
          onClick={seek}
        >
          <div className="h-full rounded-full bg-[var(--amber)]" style={{ width: `${pct}%` }} />
        </div>
        <span className="shrink-0 font-mono text-xs tabular-nums text-white/80">
          {fmt(rel)} / {fmt(dur)}
        </span>
      </div>
    </div>
  );
};

export default EpisodeVideo;
