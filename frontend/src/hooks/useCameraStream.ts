import { useEffect, useRef, useState } from "react";

export interface CameraStreamSettings {
  width: number;
  height: number;
  frameRate: number;
}

/**
 * Attach a live browser camera stream to a `<video>` element by deviceId.
 * Set `paused=true` to release the stream (e.g. so cv2.VideoCapture can claim
 * the camera exclusively). The stream is auto-stopped on unmount.
 *
 * Also reports the camera's actual negotiated resolution/frame rate via
 * `settings`, read from the live track — this is the camera's real default
 * mode, which is what cv2/OpenCV will also open, so it can be used to
 * auto-fill the recording config and avoid resolution-mismatch failures.
 */
export function useCameraStream(deviceId: string, paused: boolean) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasError, setHasError] = useState(false);
  const [settings, setSettings] = useState<CameraStreamSettings | null>(null);

  useEffect(() => {
    if (paused || !deviceId) {
      if (!deviceId) setHasError(true);
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    setHasError(false);

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: deviceId } },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        // Read the camera's actual resolution from the negotiated track.
        const track = stream.getVideoTracks()[0];
        const s = track?.getSettings();
        if (!cancelled && s?.width && s?.height) {
          setSettings({
            width: s.width,
            height: s.height,
            frameRate: s.frameRate ? Math.round(s.frameRate) : 30,
          });
        }
      } catch {
        setHasError(true);
      }
    })();

    return () => {
      cancelled = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, [deviceId, paused]);

  return { videoRef, hasError, settings };
}
