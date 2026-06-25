import { useCallback, useEffect, useState } from "react";
import { useApi } from "@/contexts/ApiContext";

export interface AvailableCamera {
  index: number;
  name: string;
  deviceId: string;
  available: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const isGenericCameraName = (label: string, index: number) =>
  norm(label) === `camera ${index}`;

// Bound how long we wait on a promise. On Windows a camera left in a bad state
// (e.g. after a crashed capture) makes getUserMedia hang forever — without this
// the whole "refresh cameras" stalls and the UI looks frozen.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}
const PROBE_TIMEOUT_MS = 4000;

interface UseAvailableCamerasOptions {
  /** When false, do nothing. Use to gate on modal open. */
  enabled?: boolean;
}

/**
 * Enumerates cv2 camera indices from `/available-cameras` and merges each
 * with the matching browser deviceId (by AVFoundation localizedName) so
 * callers can render a preview alongside the bound dropdowns. Refreshes on
 * USB hotplug.
 */
export function useAvailableCameras({
  enabled = true,
}: UseAvailableCamerasOptions = {}) {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [cameras, setCameras] = useState<AvailableCamera[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async (): Promise<AvailableCamera[]> => {
    setIsLoading(true);
    try {
      // Need a permission grant before enumerateDevices() returns labels.
      // Bounded so a wedged camera can't freeze the whole refresh — and the
      // stream is always stopped, even if it resolves after the timeout.
      const probe = navigator.mediaDevices.getUserMedia({ video: true });
      probe.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
      try {
        await withTimeout(probe, PROBE_TIMEOUT_MS);
      } catch {
        // timed out (camera busy / in a bad state) or denied — keep going and
        // list whatever the backend reports, just without browser labels.
      }

      const browserDevices = (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === "videoinput")
        .map((d) => ({ deviceId: d.deviceId, label: d.label }));

      const r = await withTimeout(
        fetchWithHeaders(`${baseUrl}/available-cameras`),
        8000,
      );
      if (!r.ok) {
        setCameras([]);
        return [];
      }
      const data = await r.json();
      const backendCams: {
        index: number;
        name?: string;
        available: boolean;
      }[] = data.cameras ?? [];

      // Browser's MediaDeviceInfo.label starts with AVFoundation's localizedName
      // but Chrome often appends "(vendorId:productId)". Match by exact, then
      // prefix, then either-contains.
      const used = new Set<string>();
      const merged: AvailableCamera[] = backendCams.map((cam) => {
        const label = cam.name || `Camera ${cam.index}`;
        const target = norm(label);
        const candidates = browserDevices.filter(
          (d) => !used.has(d.deviceId) && d.label
        );
        const match =
          candidates.find((d) => norm(d.label) === target) ||
          candidates.find((d) => norm(d.label).startsWith(target)) ||
          candidates.find(
            (d) => norm(d.label).includes(target) || target.includes(norm(d.label))
          ) ||
          (isGenericCameraName(label, cam.index)
            ? candidates[cam.index] ?? candidates[0]
            : undefined);
        if (match) used.add(match.deviceId);
        return {
          index: cam.index,
          name: label,
          deviceId: match?.deviceId ?? "",
          available: cam.available,
        };
      });
      setCameras(merged);
      return merged;
    } catch {
      setCameras([]);
      return [];
    } finally {
      setIsLoading(false);
    }
  }, [baseUrl, fetchWithHeaders]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const handler = () => refresh();
    navigator.mediaDevices.addEventListener("devicechange", handler);
    return () =>
      navigator.mediaDevices.removeEventListener("devicechange", handler);
  }, [enabled, refresh]);

  return { cameras, isLoading, refresh };
}
