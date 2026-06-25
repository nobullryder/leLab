import { useCallback, useState } from "react";

/** Per-user recording preferences that survive restarts (localStorage).
 *
 * The between-takes countdown is OFF by default — beginners reset the scene and
 * advance manually; an advanced teleoperator can turn it on and pick a duration. */
export interface RecordingPrefs {
  resetCountdown: boolean;
  resetTimeS: number;
}

const KEY = "lelab.recordingPrefs";
const DEFAULT: RecordingPrefs = { resetCountdown: false, resetTimeS: 15 };

function load(): RecordingPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT, ...JSON.parse(raw) } : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function useRecordingPrefs() {
  const [prefs, setPrefs] = useState<RecordingPrefs>(load);

  const update = useCallback((patch: Partial<RecordingPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* ignore quota / private-mode errors */
      }
      return next;
    });
  }, []);

  return {
    resetCountdown: prefs.resetCountdown,
    resetTimeS: prefs.resetTimeS,
    setResetCountdown: (v: boolean) => update({ resetCountdown: v }),
    setResetTimeS: (v: number) => update({ resetTimeS: v }),
  };
}
