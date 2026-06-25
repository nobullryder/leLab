import { Fetcher, apiRequest } from "./apiClient";

export interface StartInferenceRequest {
  follower_port: string;
  follower_config: string;
  policy_ref: string;
  task: string;
  cameras: Record<string, {
    type: string;
    camera_index?: number;
    width: number;
    height: number;
    fps?: number;
  }>;
  duration_s: number;
}

export interface InferenceStatus {
  inference_active: boolean;
  started_at: number | null;
  rollout_started_at: number | null;
  elapsed_s: number;
  rollout_elapsed_s: number;
  duration_s: number | null;
  policy_ref: string | null;
  log_path: string | null;
  exited?: boolean;
  exit_code?: number | null;
  // "ran_with_warning" = the skill ran but cleanup tripped on a loaded motor
  // (e.g. the gripper still holding an object at shutdown) — not a real failure.
  outcome?: "ok" | "ran_with_warning" | "failed";
  error?: string | null; // real error pulled from the rollout log on failure
  hint?: string | null; // plain-language, actionable headline for common failures
}

export async function startInference(
  baseUrl: string,
  fetcher: Fetcher,
  request: StartInferenceRequest,
): Promise<{ message: string; log_path: string }> {
  return apiRequest<{ message: string; log_path: string }>(
    baseUrl,
    fetcher,
    "/start-inference",
    { method: "POST", body: request, action: "Start inference" },
  );
}

export async function stopInference(
  baseUrl: string,
  fetcher: Fetcher,
): Promise<{ message: string }> {
  return apiRequest<{ message: string }>(baseUrl, fetcher, "/stop-inference", {
    method: "POST",
    action: "Stop inference",
  });
}

export async function getInferenceStatus(
  baseUrl: string,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<InferenceStatus> {
  return apiRequest<InferenceStatus>(baseUrl, fetcher, "/inference-status", {
    signal,
    action: "Get inference status",
  });
}
