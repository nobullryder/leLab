import { Fetcher, apiRequest } from "./apiClient";

export interface ChatProviders {
  provider: string; // "openai" | "claude_cli" | "codex_cli"
  model: string; // model for the current provider
  models?: Record<string, string>; // per-provider model overrides
  effort?: string; // reasoning effort for the current provider
  efforts?: Record<string, string>; // per-provider reasoning effort
  fast?: boolean; // /fast (1.5x) mode for the current provider
  fasts?: Record<string, boolean>; // per-provider fast mode
  base_url: string;
  has_key: boolean;
  openai_configured: boolean;
  claude_cli: boolean;
  codex_cli: boolean;
}

export interface ChatSkill {
  id: string;
  name: string;
  phrase?: string;
  dataset?: string;
}

export interface ChatTurnMessage {
  role: "user" | "assistant";
  content: string;
}

export type ChatActionType =
  | "run_skill"
  | "stop_skill"
  | "navigate"
  | "record_skill"
  | "train"
  | "calibrate"
  | "open_skill";

export interface ChatAction {
  type: ChatActionType;
  label?: string;
  skill_id?: string;
  skill_name?: string;
  task?: string;
  route?: string;
  dataset?: string;
  episodes?: number;
  device?: string;
}

export interface ChatContext {
  robot_name?: string | null;
  robot_ready?: boolean | null;
  is_calibrated?: boolean | null;
  skill_count?: number;
  untrained_datasets?: string[];
  training_active?: boolean | null;
}

export interface ChatResponse {
  reply: string;
  actions?: ChatAction[];
  action?: ChatAction | null; // deprecated single-action mirror
  error?: string;
}

export interface ChatConfigUpdate {
  provider?: string;
  base_url?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
  api_key?: string; // "" clears, omit to leave unchanged
}

export function getChatConfig(baseUrl: string, fetcher: Fetcher): Promise<ChatProviders> {
  return apiRequest<ChatProviders>(baseUrl, fetcher, "/chat/config", {
    action: "Get chat config",
  });
}

export function setChatConfig(
  baseUrl: string,
  fetcher: Fetcher,
  update: ChatConfigUpdate,
): Promise<ChatProviders> {
  return apiRequest<ChatProviders>(baseUrl, fetcher, "/chat/config", {
    method: "POST",
    body: update,
    action: "Save chat config",
  });
}

export function sendChat(
  baseUrl: string,
  fetcher: Fetcher,
  body: {
    messages: ChatTurnMessage[];
    skills: ChatSkill[];
    provider?: string;
    context?: ChatContext;
  },
): Promise<ChatResponse> {
  return apiRequest<ChatResponse>(baseUrl, fetcher, "/chat", {
    method: "POST",
    body,
    action: "Chat",
  });
}
