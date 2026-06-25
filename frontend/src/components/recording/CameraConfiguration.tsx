import React, { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NumberInput } from "@/components/ui/number-input";
import { Camera, Plus, X, VideoOff, RefreshCw, ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { AvailableCamera, useAvailableCameras } from "@/hooks/useAvailableCameras";
import { useCameraStream } from "@/hooks/useCameraStream";
import { cn } from "@/lib/utils";

// Sentinels distinguish "leave unset" (auto-detect / platform default) from an
// explicit choice. Radix Select disallows an empty-string value, so we map these
// to `undefined` on the CameraConfig.
const FOURCC_AUTO = "__auto__";
const BACKEND_DEFAULT = "__default__";
const FOURCC_OPTIONS = ["MJPG", "YUYV", "I420", "NV12", "H264", "MP4V"];
// Mirrors lerobot's Cv2Backends enum names.
const BACKEND_OPTIONS = [
  "ANY",
  "V4L2",
  "DSHOW",
  "PVAPI",
  "ANDROID",
  "AVFOUNDATION",
  "MSMF",
];

const slugName = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24);

// A friendly, unique default name so adding a camera needs zero typing.
function defaultCameraName(deviceName: string, index: number, existing: string[]): string {
  let base = slugName(deviceName);
  if (!base || /^camera_?\d*$/.test(base)) base = `cam${index}`;
  let name = base;
  let n = 2;
  while (existing.includes(name)) {
    name = `${base}_${n}`;
    n += 1;
  }
  return name;
}

export interface CameraConfig {
  id: string;
  name: string;
  type: string;
  camera_index?: number; // cv2 index — what the recorder opens
  device_id: string; // Browser deviceId matched to the cv2 index by AVFoundation localizedName
  width: number;
  height: number;
  fps?: number;
  fourcc?: string; // 4-char OpenCV pixel format (e.g. "MJPG"); undefined = auto-detect
  backend?: string; // Cv2Backends name (e.g. "AVFOUNDATION"); undefined = platform default
}

interface CameraConfigurationProps {
  cameras: CameraConfig[];
  onCamerasChange: (cameras: CameraConfig[]) => void;
  releaseStreamsRef?: React.MutableRefObject<(() => void) | null>; // Ref to expose stream release function
  compact?: boolean;
}

const CameraConfiguration: React.FC<CameraConfigurationProps> = ({
  cameras,
  onCamerasChange,
  releaseStreamsRef,
  compact = false,
}) => {
  const { toast } = useToast();

  const {
    cameras: availableCameras,
    isLoading: isLoadingCameras,
    refresh: refreshCameras,
  } = useAvailableCameras();
  // Cameras added this session that should auto-fill their resolution from the
  // live preview the first time it reports the camera's real capture mode.
  const [autoDetectIds, setAutoDetectIds] = useState<Set<string>>(new Set());
  const clearAutoDetect = useCallback((id: string) => {
    setAutoDetectIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // cv2's AVFoundation order is uniqueID-sorted, so plugging/unplugging a
  // device between sessions shifts indices. The browser device_id stays
  // stable per-origin, so use it to refresh each seeded camera's
  // camera_index — otherwise the recorder opens the wrong physical device
  // and the dropdown's "already added" check guards a stale index.
  useEffect(() => {
    if (availableCameras.length === 0 || cameras.length === 0) return;
    let changed = false;
    const refreshed = cameras.map((cam) => {
      if (!cam.device_id) return cam;
      const match = availableCameras.find((m) => m.deviceId === cam.device_id);
      if (match && match.index !== cam.camera_index) {
        changed = true;
        return { ...cam, camera_index: match.index };
      }
      return cam;
    });
    if (changed) onCamerasChange(refreshed);
    // We deliberately don't depend on `cameras`/`onCamerasChange` to avoid
    // re-running every keystroke in the camera-name input — re-syncing only
    // when the available-cameras list itself changes is sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableCameras]);

  // One tap to add a detected camera: auto-named (no typing), with its real
  // resolution auto-detected from the preview. Duplicate-guarded by cv2 index
  // or browser deviceId so the same physical device can't sneak in twice.
  const addCameraDirect = (camera: AvailableCamera) => {
    const isDuplicate = cameras.some(
      (c) =>
        c.camera_index === camera.index ||
        (camera.deviceId && c.device_id === camera.deviceId),
    );
    if (isDuplicate) return;

    const newCamera: CameraConfig = {
      id: `camera_${Date.now()}`,
      name: defaultCameraName(camera.name, camera.index, cameras.map((c) => c.name)),
      type: "opencv",
      camera_index: camera.index,
      device_id: camera.deviceId,
      width: 640,
      height: 480,
      fps: 30,
    };

    onCamerasChange([...cameras, newCamera]);
    setAutoDetectIds((prev) => new Set(prev).add(newCamera.id));
  };

  const removeCamera = (cameraId: string) => {
    onCamerasChange(cameras.filter((cam) => cam.id !== cameraId));
    toast({
      title: "Camera Removed",
      description: "Camera has been removed from the configuration.",
    });
  };

  const updateCamera = (cameraId: string, updates: Partial<CameraConfig>) => {
    onCamerasChange(
      cameras.map((cam) =>
        cam.id === cameraId ? { ...cam, ...updates } : cam
      )
    );
  };

  // When the recording session is starting, the parent calls
  // releaseStreamsRef.current() to make every CameraPreview drop its browser
  // stream so cv2.VideoCapture can grab the camera exclusively.
  const [streamsPaused, setStreamsPaused] = useState(false);
  const releaseAllCameraStreams = useCallback(() => {
    setStreamsPaused(true);
  }, []);

  useEffect(() => {
    if (releaseStreamsRef) {
      releaseStreamsRef.current = releaseAllCameraStreams;
    }
  }, [releaseStreamsRef, releaseAllCameraStreams]);

  const addableCameras = availableCameras.filter(
    (cam) =>
      cam.available &&
      !cameras.some(
        (c) =>
          c.camera_index === cam.index ||
          (cam.deviceId && c.device_id === cam.deviceId),
      ),
  );

  return (
    <div className={cn("space-y-4", compact && "space-y-3")}>
      <h3
        className={cn(
          "border-b border-border pb-2 font-semibold text-foreground",
          compact ? "text-base" : "text-lg"
        )}
      >
        Cameras
      </h3>

      {/* Add a camera — one tap, auto-named, resolution auto-detected. */}
      <div className={cn("rounded-lg border border-border bg-[var(--sunken)]", compact ? "p-3" : "p-4")}>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="field-label">Available cameras</h4>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => refreshCameras()}
            disabled={isLoadingCameras}
            className="h-6 w-6"
            title="Rescan for cameras (e.g. after plugging in a new USB camera)"
            aria-label="Rescan for cameras"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoadingCameras ? "animate-spin" : ""}`} />
          </Button>
        </div>

        {isLoadingCameras ? (
          <p className="py-2 text-xs text-muted-foreground">Scanning for cameras…</p>
        ) : addableCameras.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">
            {availableCameras.length === 0
              ? "No cameras detected. Plug one in, then tap refresh."
              : "All detected cameras added."}
          </p>
        ) : (
          <div className="space-y-1.5">
            {addableCameras.map((camera) => (
              <div
                key={camera.index}
                className="flex items-center justify-between gap-2 rounded-md border border-border bg-[var(--surface-1)] px-2.5 py-1.5"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Camera className="h-4 w-4 flex-none text-muted-foreground" />
                  <span className="min-w-0 truncate text-sm text-foreground">{camera.name}</span>
                  <span className="shrink-0 font-mono text-[0.65rem] text-[var(--ink-faint)]">
                    #{camera.index}
                  </span>
                </div>
                <Button size="sm" onClick={() => addCameraDirect(camera)} className="h-8 shrink-0 px-3">
                  <Plus className="mr-1 h-4 w-4" />
                  Add
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Configured Cameras */}
      {cameras.length > 0 && (
        <div className={cn("space-y-4", compact && "space-y-3")}>
          <h4
            className={cn(
              "font-medium text-gray-300",
              compact ? "text-sm" : "text-base"
            )}
          >
            Configured Cameras ({cameras.length})
          </h4>

          <div
            className={cn(
              "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2",
              compact ? "gap-3" : "gap-4"
            )}
          >
            {cameras.map((camera) => (
              <CameraPreview
                key={camera.id}
                camera={camera}
                paused={streamsPaused}
                autoDetect={autoDetectIds.has(camera.id)}
                onAutoDetected={() => clearAutoDetect(camera.id)}
                onRemove={() => removeCamera(camera.id)}
                onUpdate={(updates) => updateCamera(camera.id, updates)}
              />
            ))}
          </div>
        </div>
      )}

      {cameras.length === 0 && (
        <div
          className={cn(
            "text-center text-gray-500",
            compact ? "py-4" : "py-8"
          )}
        >
          <Camera
            className={cn(
              "mx-auto text-gray-600",
              compact ? "mb-2 h-8 w-8" : "mb-4 h-12 w-12"
            )}
          />
          <p>No cameras configured. Add a camera to get started.</p>
        </div>
      )}
    </div>
  );
};

interface CameraPreviewProps {
  camera: CameraConfig;
  paused: boolean;
  autoDetect: boolean;
  onAutoDetected: () => void;
  onRemove: () => void;
  onUpdate: (updates: Partial<CameraConfig>) => void;
}

const CameraPreview: React.FC<CameraPreviewProps> = ({
  camera,
  paused,
  autoDetect,
  onAutoDetected,
  onRemove,
  onUpdate,
}) => {
  const { videoRef, hasError: streamError, settings } = useCameraStream(
    camera.device_id,
    paused
  );
  const showVideo = !paused && camera.device_id && !streamError;

  // Auto-fill resolution/fps from the live preview the first time we learn the
  // camera's real mode — only for freshly added cameras, so a resolution the
  // user set on purpose is never clobbered.
  useEffect(() => {
    if (autoDetect && settings) {
      onUpdate({
        width: settings.width,
        height: settings.height,
        fps: settings.frameRate,
      });
      onAutoDetected();
    }
  }, [autoDetect, settings, onUpdate, onAutoDetected]);

  const resolutionMismatch =
    !!settings &&
    (settings.width !== camera.width || settings.height !== camera.height);
  return (
    <div className="bg-gray-900 rounded-lg border border-gray-700 overflow-hidden">
      <div className="aspect-[4/3] bg-gray-800 relative">
        {showVideo ? (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center">
            <VideoOff className="w-8 h-8 text-gray-500 mb-2" />
            <span className="text-gray-500 text-sm">
              {paused
                ? "Preview paused"
                : camera.device_id
                ? "Preview failed"
                : "No browser match"}
            </span>
          </div>
        )}
      </div>

      {/* Camera Info */}
      <div className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <input
            value={camera.name}
            onChange={(e) =>
              onUpdate({ name: e.target.value.replace(/[^A-Za-z0-9_-]/g, "_") })
            }
            aria-label="Camera name (click to rename)"
            spellCheck={false}
            className="min-w-0 flex-1 truncate rounded bg-transparent px-1 py-0.5 font-medium text-foreground outline-none transition-colors hover:bg-[var(--surface-2)] focus:bg-[var(--surface-2)] focus:ring-1 focus:ring-[var(--amber-line)]"
          />
          <Button
            onClick={onRemove}
            size="sm"
            variant="ghost"
            className="text-red-400 hover:text-red-300 hover:bg-red-900/20 p-1"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs font-medium text-gray-300 hover:text-white transition-colors">
            <ChevronRight className="w-3.5 h-3.5 transition-transform group-data-[state=open]:rotate-90" />
            Configuration
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2 space-y-2">
            <div className="grid grid-cols-1 gap-2 text-xs text-gray-400">
              <div className="flex items-center gap-2">
                <span className="w-16">Resolution:</span>
                <div className="flex items-center gap-1">
                  <NumberInput
                    value={camera.width}
                    onChange={(v) => {
                      if (v !== undefined) onUpdate({ width: v });
                    }}
                    className="h-6 w-16 px-2 text-xs"
                    min="320"
                    max="1920"
                  />
                  <span className="flex items-center">×</span>
                  <NumberInput
                    value={camera.height}
                    onChange={(v) => {
                      if (v !== undefined) onUpdate({ height: v });
                    }}
                    className="h-6 w-16 px-2 text-xs"
                    min="240"
                    max="1080"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-xs"
                    disabled={!settings}
                    onClick={() =>
                      settings &&
                      onUpdate({
                        width: settings.width,
                        height: settings.height,
                        fps: settings.frameRate,
                      })
                    }
                    title={
                      settings
                        ? `Use detected ${settings.width}×${settings.height}`
                        : "Start the preview to detect the camera's resolution"
                    }
                  >
                    Auto
                  </Button>
                </div>
              </div>
              {resolutionMismatch && settings && (
                <p className="text-[10px] leading-tight text-[var(--amber-bright)]">
                  Camera reports {settings.width}×{settings.height}. Click Auto to
                  match it — recording fails if the resolution doesn't.
                </p>
              )}
              <div className="flex items-center gap-2">
                <span className="w-16">FPS:</span>
                <NumberInput
                  value={camera.fps ?? 30}
                  onChange={(v) => {
                    if (v !== undefined) onUpdate({ fps: v });
                  }}
                  className="bg-gray-800 border-gray-700 text-white text-xs h-6 px-2 w-16"
                  min="10"
                  max="60"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="w-16">FOURCC:</span>
                <Select
                  value={camera.fourcc ?? FOURCC_AUTO}
                  onValueChange={(v) =>
                    onUpdate({ fourcc: v === FOURCC_AUTO ? undefined : v })
                  }
                >
                  <SelectTrigger className="bg-gray-800 border-gray-700 text-white text-xs h-6 px-2 w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-gray-800 border-gray-700">
                    <SelectItem
                      value={FOURCC_AUTO}
                      className="text-white hover:bg-gray-700 text-xs"
                    >
                      Auto
                    </SelectItem>
                    {FOURCC_OPTIONS.map((code) => (
                      <SelectItem
                        key={code}
                        value={code}
                        className="text-white hover:bg-gray-700 text-xs"
                      >
                        {code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-16">Backend:</span>
                <Select
                  value={camera.backend ?? BACKEND_DEFAULT}
                  onValueChange={(v) =>
                    onUpdate({ backend: v === BACKEND_DEFAULT ? undefined : v })
                  }
                >
                  <SelectTrigger className="bg-gray-800 border-gray-700 text-white text-xs h-6 px-2 w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-gray-800 border-gray-700">
                    <SelectItem
                      value={BACKEND_DEFAULT}
                      className="text-white hover:bg-gray-700 text-xs"
                    >
                      Default
                    </SelectItem>
                    {BACKEND_OPTIONS.map((name) => (
                      <SelectItem
                        key={name}
                        value={name}
                        className="text-white hover:bg-gray-700 text-xs"
                      >
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-[10px] text-gray-500 leading-tight">
                Overriding the backend can reorder camera indices on macOS.
              </p>
            </div>
            <div className="text-xs text-gray-500">
              Type: {camera.type} | Device:{" "}
              {camera.device_id?.substring(0, 10)}...
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  );
};

export default CameraConfiguration;
