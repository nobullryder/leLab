import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Bot,
  ChevronDown,
  Gauge,
  GraduationCap,
  Loader2,
  Play,
  Plus,
  Send,
  Settings2,
  Sparkles,
  Square,
  Video,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useApi } from "@/contexts/ApiContext";
import { useRobots } from "@/hooks/useRobots";
import { useDatasets } from "@/hooks/useDatasets";
import { useToast } from "@/hooks/use-toast";
import { JobRecord, listJobs } from "@/lib/jobsApi";
import {
  ChatAction,
  ChatProviders,
  ChatSkill,
  getChatConfig,
  sendChat,
  setChatConfig,
} from "@/lib/chatApi";
import InferenceModal from "@/components/landing/InferenceModal";
import { InferenceStatus, getInferenceStatus, stopInference } from "@/lib/inferenceApi";
import { useChatSessions } from "@/hooks/useChatSessions";
import { Markdown } from "@/components/chat/Markdown";
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

const isSkill = (j: JobRecord) => j.checkpoint_count > 0 || j.runner === "imported";

function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function phraseFor(job: JobRecord): string {
  const ds = job.config?.dataset_repo_id;
  const base = (ds ? ds.split("/").pop() : job.name) || job.name;
  const words = base.replace(/[_\-.]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const PROVIDER_LABEL: Record<string, string> = {
  openai: "API model",
  claude_cli: "Claude CLI",
  codex_cli: "Codex CLI",
};

const MODEL_PLACEHOLDER: Record<string, string> = {
  openai: "gpt-4o-mini",
  claude_cli: "opus · sonnet · haiku (blank = default)",
  codex_cli: "gpt-5.5 · gpt-5.4 (blank = default)",
};

// The pre-selected default for each provider (persists once the user picks one).
const DEFAULT_MODEL: Record<string, string> = {
  openai: "gpt-4o-mini",
  claude_cli: "opus",
  codex_cli: "gpt-5.5",
};

const DEFAULT_EFFORT: Record<string, string> = {
  claude_cli: "medium",
  codex_cli: "medium",
};

// Model choices per provider — the CLI ones mirror the names their TUIs show.
// "Custom…" opens settings for anything not listed (OpenAI-compatible endpoints).
const PROVIDER_MODELS: Record<string, { value: string; label: string }[]> = {
  openai: [
    { value: "gpt-4o-mini", label: "gpt-4o-mini" },
    { value: "gpt-4o", label: "gpt-4o" },
    { value: "gpt-4.1", label: "gpt-4.1" },
    { value: "gpt-4.1-mini", label: "gpt-4.1-mini" },
    { value: "o4-mini", label: "o4-mini" },
    { value: "o3", label: "o3" },
  ],
  claude_cli: [
    { value: "opus", label: "Opus 4.8 (1M)" },
    { value: "sonnet", label: "Sonnet 4.6" },
    { value: "haiku", label: "Haiku 4.5" },
  ],
  codex_cli: [
    { value: "gpt-5.5", label: "gpt-5.5" },
    { value: "gpt-5.4", label: "gpt-5.4" },
    { value: "gpt-5.4-mini", label: "gpt-5.4-mini" },
    { value: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark" },
  ],
};

// Reasoning effort per provider (CLI only).
const PROVIDER_EFFORTS: Record<string, { value: string; label: string }[]> = {
  claude_cli: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra high" },
    { value: "max", label: "Max" },
  ],
  codex_cli: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra high" },
  ],
};

interface UiMessage {
  role: "user" | "assistant";
  content: string;
  actions?: ChatAction[];
}

// Icon + how to handle each action type when its button is clicked.
const ACTION_ICON: Record<ChatAction["type"], typeof Play> = {
  run_skill: Play,
  open_skill: Play,
  stop_skill: Square,
  navigate: ArrowRight,
  record_skill: Video,
  train: GraduationCap,
  calibrate: Wrench,
};

const Chat: React.FC = () => {
  const navigate = useNavigate();
  const { baseUrl, fetchWithHeaders } = useApi();
  const { selectedRecord } = useRobots();
  const { datasets } = useDatasets();
  const { toast } = useToast();

  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [config, setConfig] = useState<ChatProviders | null>(null);
  const [provider, setProvider] = useState<string>("openai");

  const {
    sessions,
    activeId,
    active,
    newSession,
    selectSession,
    deleteSession,
    setActiveMessages,
  } = useChatSessions();
  const messages = active.messages;
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const enabledInit = useRef(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runJob, setRunJob] = useState<JobRecord | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Load skills + saved chat config once.
  useEffect(() => {
    let cancelled = false;
    listJobs(baseUrl, fetchWithHeaders, 200)
      .then((j) => !cancelled && setJobs(j))
      .catch(() => !cancelled && setJobs([]));
    getChatConfig(baseUrl, fetchWithHeaders)
      .then((c) => {
        if (cancelled) return;
        setConfig(c);
        setProvider(c.provider || "openai");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchWithHeaders]);

  const skills = useMemo<ChatSkill[]>(
    () =>
      jobs.filter(isSkill).map((j) => ({
        id: j.id,
        name: phraseFor(j),
        phrase: phraseFor(j),
        dataset: j.config?.dataset_repo_id ?? "",
      })),
    [jobs],
  );

  // Live state the assistant uses for proactive guidance.
  const trainedDatasetIds = useMemo(
    () => new Set(jobs.filter(isSkill).map((j) => j.config?.dataset_repo_id).filter(Boolean)),
    [jobs],
  );
  const untrainedDatasets = useMemo(
    () =>
      datasets
        .filter((d) => (d.source === "local" || d.source === "both") && !trainedDatasetIds.has(d.repo_id))
        .map((d) => d.repo_id),
    [datasets, trainedDatasetIds],
  );
  const trainingActive = useMemo(() => jobs.some((j) => j.state === "running"), [jobs]);

  // Poll inference so the chat shows a live "skill running" strip with Stop.
  const [runStatus, setRunStatus] = useState<InferenceStatus | null>(null);
  useEffect(() => {
    let active = true;
    const poll = () =>
      getInferenceStatus(baseUrl, fetchWithHeaders)
        .then((s) => active && setRunStatus(s))
        .catch(() => active && setRunStatus(null));
    poll();
    const id = setInterval(poll, 2500);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [baseUrl, fetchWithHeaders]);

  // Enable every skill by default the first time they load.
  useEffect(() => {
    if (!enabledInit.current && skills.length) {
      setEnabled(new Set(skills.map((s) => s.id)));
      enabledInit.current = true;
    }
  }, [skills]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  const toggleSkill = (id: string) =>
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const chooseProvider = async (p: string) => {
    setProvider(p);
    try {
      const c = await setChatConfig(baseUrl, fetchWithHeaders, { provider: p });
      setConfig(c);
    } catch {
      /* persisted best-effort */
    }
  };

  const chooseModel = async (value: string) => {
    setConfig((c) => (c ? { ...c, model: value } : c)); // reflect immediately
    try {
      const c = await setChatConfig(baseUrl, fetchWithHeaders, { provider, model: value });
      setConfig(c);
    } catch {
      /* persisted best-effort */
    }
  };

  const chooseEffort = async (value: string) => {
    setConfig((c) => (c ? { ...c, effort: value } : c));
    try {
      const c = await setChatConfig(baseUrl, fetchWithHeaders, { provider, effort: value });
      setConfig(c);
    } catch {
      /* persisted best-effort */
    }
  };

  const chooseFast = async (value: boolean) => {
    setConfig((c) => (c ? { ...c, fast: value } : c));
    try {
      const c = await setChatConfig(baseUrl, fetchWithHeaders, { provider, fast: value });
      setConfig(c);
    } catch {
      /* persisted best-effort */
    }
  };

  const runSkill = (skillId?: string) => {
    const job = skillId ? jobs.find((j) => j.id === skillId) : undefined;
    if (!job) return;
    setRunJob(job);
    setModalOpen(true);
  };

  const stopSkill = async () => {
    try {
      await stopInference(baseUrl, fetchWithHeaders);
      toast({ title: "Stopping the robot" });
    } catch {
      toast({ title: "Couldn't stop", variant: "destructive" });
    }
  };

  // Turn an assistant action into the same UI flow a button on that page would —
  // hardware still goes through the existing confirm modals.
  const handleAction = (action: ChatAction) => {
    switch (action.type) {
      case "run_skill":
      case "open_skill":
        runSkill(action.skill_id);
        break;
      case "stop_skill":
        stopSkill();
        break;
      case "navigate":
        if (action.route) navigate(action.route);
        break;
      case "record_skill":
        navigate("/datasets", {
          state: {
            prefillRecording: {
              task: action.task ?? "",
              dataset: action.dataset ?? "",
              episodes: action.episodes,
            },
          },
        });
        break;
      case "train":
        navigate("/training", { state: { datasetRepoId: action.dataset } });
        break;
      case "calibrate":
        navigate("/calibration");
        break;
    }
  };

  const actionLabel = (a: ChatAction): string => {
    if (a.label) return a.label;
    if (a.type === "run_skill" || a.type === "open_skill") return a.skill_name ?? "Run skill";
    if (a.type === "stop_skill") return "Stop the robot";
    if (a.type === "record_skill") return "Record demonstrations";
    if (a.type === "train") return "Train";
    if (a.type === "calibrate") return "Calibrate";
    return "Open";
  };

  const send = async (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || sending) return;
    const history: UiMessage[] = [...messages, { role: "user", content: text }];
    setActiveMessages(history);
    setInput("");
    setSending(true);
    try {
      const res = await sendChat(baseUrl, fetchWithHeaders, {
        messages: history.map((m) => ({ role: m.role, content: m.content })),
        skills: skills.filter((s) => enabled.has(s.id)),
        provider,
        context: {
          robot_name: selectedRecord?.name ?? null,
          robot_ready: selectedRecord?.is_clean ?? null,
          is_calibrated: selectedRecord?.is_clean ?? null,
          skill_count: skills.length,
          untrained_datasets: untrainedDatasets,
          training_active: trainingActive,
        },
      });
      const actions = res.actions ?? (res.action ? [res.action] : []);
      setActiveMessages((prev) => [
        ...prev,
        { role: "assistant", content: res.reply, actions },
      ]);
      if (res.error === "no_key") setSettingsOpen(true);
    } catch {
      setActiveMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Couldn't reach the assistant. Check the backend and try again." },
      ]);
    } finally {
      setSending(false);
    }
  };

  const enabledCount = skills.filter((s) => enabled.has(s.id)).length;
  const models = PROVIDER_MODELS[provider] ?? [];
  const currentModel = config?.model || DEFAULT_MODEL[provider] || "";
  const currentModelLabel =
    models.find((m) => m.value === currentModel)?.label ?? currentModel;
  const efforts = PROVIDER_EFFORTS[provider] ?? [];
  const currentEffort = config?.effort || DEFAULT_EFFORT[provider] || "";
  const currentEffortLabel =
    efforts.find((e) => e.value === currentEffort)?.label ?? currentEffort;
  const currentFast = !!config?.fast;
  const providerReady =
    provider === "openai"
      ? !!config?.has_key
      : provider === "claude_cli"
        ? !!config?.claude_cli
        : !!config?.codex_cli;

  return (
    <>
      <div className="page page-wide flex h-full min-h-0 flex-col">
        {/* Header */}
        <header className="flex items-center justify-between gap-3 pb-3">
          <div>
            <div className="eyebrow eyebrow-amber">
              <Bot className="h-3.5 w-3.5" />
              Robot assistant
            </div>
            <h1 className="page-title mt-1.5">Chat</h1>
          </div>
          <button className="pill" onClick={() => setSettingsOpen(true)}>
            <Settings2 className="h-3.5 w-3.5" />
            <span className="normal-case">
              {PROVIDER_LABEL[provider] ?? provider}
              {config?.model ? ` · ${config.model}` : ""}
            </span>
          </button>
        </header>

        {/* Session tabs */}
        <div className="lab-scrollbar mb-2.5 flex items-center gap-1.5 overflow-x-auto pb-1">
          {sessions.map((s) => {
            const isActive = s.id === activeId;
            return (
              <div
                key={s.id}
                className={
                  "flex shrink-0 items-center gap-1 rounded-lg border py-1.5 pl-3 pr-1.5 text-sm transition-colors " +
                  (isActive
                    ? "border-[var(--amber-line)] bg-[var(--amber-soft)] text-foreground"
                    : "border-border bg-[var(--surface-1)] text-muted-foreground hover:bg-accent")
                }
              >
                <button onClick={() => selectSession(s.id)} className="max-w-[10rem] truncate">
                  {s.title}
                </button>
                <button
                  onClick={() => (s.messages.length ? setDeleteId(s.id) : deleteSession(s.id))}
                  aria-label="Close chat"
                  className="rounded p-0.5 opacity-60 transition-opacity hover:text-[var(--red)] hover:opacity-100"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
          <button
            onClick={newSession}
            aria-label="New chat"
            className="flex shrink-0 items-center gap-1 rounded-lg border border-dashed border-border px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Plus className="h-4 w-4" />
            New
          </button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="lab-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <span className="grid h-12 w-12 place-items-center rounded-xl border border-border bg-[var(--surface-2)] text-primary">
                <Sparkles className="h-6 w-6" />
              </span>
              <h2 className="mt-4 font-display text-xl font-semibold text-foreground">
                Tell the robot what to do
              </h2>
              <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
                Ask in plain words — the assistant picks the right trained skill and runs it.
                {skills.length === 0 && " Or teach a new one — just describe it."}
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {(skills.length > 0
                  ? ["Run a skill", "What skills do I have?", "How does this work?"]
                  : ["Create a skill", "How do I teach a skill?", "Is my robot ready?"]
                ).map((q) => (
                  <button
                    key={q}
                    onClick={() => send(q)}
                    className="rounded-full border border-border bg-[var(--surface-1)] px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              {messages.map((m, i) => (
                <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                  <div
                    className={
                      m.role === "user"
                        ? "max-w-[80%] rounded-2xl rounded-br-sm border border-[var(--amber-line)] bg-[var(--amber-soft)] px-4 py-2.5 text-sm text-foreground"
                        : "max-w-[80%] rounded-2xl rounded-bl-sm border border-border bg-[var(--surface-1)] px-4 py-2.5 text-sm text-foreground"
                    }
                  >
                    {m.role === "assistant" ? (
                      <Markdown text={m.content} />
                    ) : (
                      <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
                    )}
                    {!!m.actions?.length && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {m.actions.map((a, ai) => {
                          const Icon = ACTION_ICON[a.type] ?? ArrowRight;
                          const primary = a.type === "run_skill" || a.type === "record_skill";
                          return (
                            <Button
                              key={ai}
                              size="sm"
                              variant={
                                a.type === "stop_skill"
                                  ? "destructive"
                                  : primary
                                    ? "default"
                                    : "outline"
                              }
                              onClick={() => handleAction(a)}
                            >
                              <Icon className="mr-1.5 h-4 w-4" />
                              {actionLabel(a)}
                            </Button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {sending && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-border bg-[var(--surface-1)] px-4 py-2.5 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Live status: a running skill (with Stop) or a training job in progress */}
        {(runStatus?.inference_active || trainingActive) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--amber-line)] bg-[var(--amber-soft)] px-3 py-2 text-sm">
            {runStatus?.inference_active ? (
              <>
                <span className="flex items-center gap-2 text-foreground">
                  <span className="dot dot-live animate-pulse" />
                  Skill running · {formatElapsed(runStatus.elapsed_s)}
                </span>
                <Button
                  size="sm"
                  variant="destructive"
                  className="ml-auto h-7"
                  onClick={stopSkill}
                >
                  <Square className="mr-1.5 h-3.5 w-3.5" />
                  Stop
                </Button>
              </>
            ) : (
              <Link to="/training" className="flex items-center gap-2 text-foreground hover:underline">
                <GraduationCap className="h-4 w-4" />
                Training in progress — view jobs
              </Link>
            )}
          </div>
        )}

        {/* Composer */}
        <div className="plate mt-3 p-2.5">
          {!providerReady && (
            <button
              onClick={() => setSettingsOpen(true)}
              className="mb-2 flex w-full items-center gap-2 rounded-md border border-[var(--amber-line)] bg-[var(--amber-soft)] px-3 py-1.5 text-left text-xs text-[var(--amber-bright)]"
            >
              <Settings2 className="h-3.5 w-3.5" />
              {provider === "openai"
                ? "Add an API key to start chatting."
                : "This CLI wasn't detected — open settings to choose another model."}
            </button>
          )}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder="e.g. feed the treat, fill the jar, pick up the block…"
            className="lab-scrollbar max-h-32 w-full resize-none bg-transparent px-2 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {/* Skills toggle */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8">
                    <Sparkles className="mr-1.5 h-4 w-4" />
                    Skills
                    <span className="ml-1.5 font-mono text-[0.65rem] text-muted-foreground">
                      {enabledCount}/{skills.length}
                    </span>
                    <ChevronDown className="ml-1 h-3.5 w-3.5 opacity-60" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-0">
                  <div className="border-b border-border px-3 py-2">
                    <p className="eyebrow">Skills the assistant can use</p>
                  </div>
                  <div className="lab-scrollbar max-h-72 overflow-y-auto p-1.5">
                    {skills.length === 0 ? (
                      <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                        No trained skills yet.{" "}
                        <Link to="/training" className="text-primary underline-offset-2 hover:underline">
                          Train one
                        </Link>
                        .
                      </p>
                    ) : (
                      skills.map((s) => (
                        <div key={s.id} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
                          <div className="min-w-0">
                            <div className="truncate text-sm text-foreground">{s.name}</div>
                            {s.dataset && (
                              <div className="truncate font-mono text-[0.6rem] text-[var(--ink-faint)]">
                                {s.dataset}
                              </div>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              onClick={() => runSkill(s.id)}
                            >
                              <Play className="h-3.5 w-3.5" />
                            </Button>
                            <Switch checked={enabled.has(s.id)} onCheckedChange={() => toggleSkill(s.id)} />
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </PopoverContent>
              </Popover>

              {/* Provider quick-switch */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8">
                    {PROVIDER_LABEL[provider] ?? provider}
                    <ChevronDown className="ml-1 h-3.5 w-3.5 opacity-60" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-56 p-1.5">
                  {[
                    { id: "openai", label: "API model", ok: !!config?.has_key, hint: "OpenAI-compatible" },
                    { id: "claude_cli", label: "Claude Code CLI", ok: !!config?.claude_cli, hint: "detected on PATH" },
                    { id: "codex_cli", label: "Codex CLI", ok: !!config?.codex_cli, hint: "detected on PATH" },
                  ].map((p) => (
                    <button
                      key={p.id}
                      onClick={() => chooseProvider(p.id)}
                      className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent ${
                        provider === p.id ? "text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      <span className="flex flex-col">
                        <span>{p.label}</span>
                        <span className="text-[0.65rem] text-[var(--ink-faint)]">
                          {p.ok ? p.hint : "not configured"}
                        </span>
                      </span>
                      {provider === p.id && <span className="dot dot-amber" />}
                    </button>
                  ))}
                  <div className="mt-1 border-t border-border pt-1">
                    <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => setSettingsOpen(true)}>
                      <Settings2 className="mr-2 h-4 w-4" />
                      Model settings
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>

              {/* Model picker — scoped to the selected provider */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 max-w-[11rem]">
                    <span className="truncate">{currentModelLabel}</span>
                    <ChevronDown className="ml-1 h-3.5 w-3.5 shrink-0 opacity-60" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-52 p-1.5">
                  <div className="px-2 pb-1 pt-0.5">
                    <p className="eyebrow">{PROVIDER_LABEL[provider] ?? provider} model</p>
                  </div>
                  {models.map((m) => (
                    <button
                      key={m.value || "default"}
                      onClick={() => chooseModel(m.value)}
                      className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent ${
                        currentModel === m.value ? "text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      <span>{m.label}</span>
                      {currentModel === m.value && <span className="dot dot-amber" />}
                    </button>
                  ))}
                  <div className="mt-1 border-t border-border pt-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start"
                      onClick={() => setSettingsOpen(true)}
                    >
                      <Settings2 className="mr-2 h-4 w-4" />
                      Custom…
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>

              {/* Reasoning effort — CLI providers only */}
              {efforts.length > 0 && (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="h-8">
                      <Gauge className="mr-1.5 h-4 w-4 opacity-70" />
                      {currentEffortLabel}
                      <ChevronDown className="ml-1 h-3.5 w-3.5 shrink-0 opacity-60" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-48 p-1.5">
                    <div className="px-2 pb-1 pt-0.5">
                      <p className="eyebrow">Reasoning effort</p>
                    </div>
                    {efforts.map((e) => (
                      <button
                        key={e.value || "default"}
                        onClick={() => chooseEffort(e.value)}
                        className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent ${
                          currentEffort === e.value ? "text-foreground" : "text-muted-foreground"
                        }`}
                      >
                        <span>{e.label}</span>
                        {currentEffort === e.value && <span className="dot dot-amber" />}
                      </button>
                    ))}
                  </PopoverContent>
                </Popover>
              )}

              {/* Fast (1.5x) mode — codex only, independent of effort */}
              {provider === "codex_cli" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => chooseFast(!currentFast)}
                  title="Fast mode: 1.5x speed (GPT-5.4), independent of reasoning effort"
                  className={
                    "h-8 " +
                    (currentFast
                      ? "border-[var(--amber-line)] bg-[var(--amber-soft)] text-foreground"
                      : "")
                  }
                >
                  <Zap
                    className={
                      "mr-1.5 h-4 w-4 " +
                      (currentFast ? "text-[var(--amber-bright)]" : "opacity-60")
                    }
                  />
                  Fast
                </Button>
              )}
            </div>

            <Button onClick={() => send()} disabled={!input.trim() || sending} className="h-9">
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              <span className="ml-1.5">Send</span>
            </Button>
          </div>
        </div>
      </div>

      <ChatSettings
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        config={config}
        provider={provider}
        onSaved={(c, p) => {
          setConfig(c);
          setProvider(p);
        }}
      />

      {runJob && (
        <InferenceModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          robot={selectedRecord}
          jobId={runJob.id}
          initialStep={null}
        />
      )}

      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the conversation from this browser. It can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteId) deleteSession(deleteId);
                setDeleteId(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

// --------------------------------------------------------------------------- //
const ChatSettings: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: ChatProviders | null;
  provider: string;
  onSaved: (config: ChatProviders, provider: string) => void;
}> = ({ open, onOpenChange, config, provider, onSaved }) => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { toast } = useToast();

  const [formProvider, setFormProvider] = useState(provider);
  const [baseUrlVal, setBaseUrlVal] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !config) return;
    setFormProvider(provider);
    setBaseUrlVal(config.base_url || "https://api.openai.com/v1");
    setModel(config.models?.[provider] ?? DEFAULT_MODEL[provider] ?? "");
    setApiKey(""); // never prefill the key; blank = keep existing
  }, [open, config, provider]);

  const pickProvider = (id: string) => {
    setFormProvider(id);
    setModel(config?.models?.[id] ?? DEFAULT_MODEL[id] ?? "");
  };

  const save = async () => {
    setSaving(true);
    try {
      const update: Record<string, string> = { provider: formProvider, model };
      if (formProvider === "openai") {
        update.base_url = baseUrlVal;
        if (apiKey.trim()) update.api_key = apiKey.trim();
      }
      const c = await setChatConfig(baseUrl, fetchWithHeaders, update);
      onSaved(c, formProvider);
      toast({ title: "Saved", description: "Model settings updated." });
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "Couldn't save",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const options = [
    { id: "openai", label: "API model", sub: "OpenAI-compatible (key + model)", ok: true },
    { id: "claude_cli", label: "Claude Code CLI", sub: "claude -p", ok: !!config?.claude_cli },
    { id: "codex_cli", label: "Codex CLI", sub: "codex exec", ok: !!config?.codex_cli },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Model settings</DialogTitle>
          <DialogDescription>
            Choose what powers the chat. Your API key is saved on this machine and persists across
            restarts.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-2">
            {options.map((o) => (
              <button
                key={o.id}
                onClick={() => o.ok && pickProvider(o.id)}
                disabled={!o.ok}
                className={`flex items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  formProvider === o.id
                    ? "border-[var(--amber-line)] bg-[var(--amber-soft)]"
                    : "border-border bg-[var(--surface-1)] hover:bg-accent"
                }`}
              >
                <span className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">{o.label}</span>
                  <span className="font-mono text-[0.65rem] text-muted-foreground">
                    {o.ok ? o.sub : "not detected on PATH"}
                  </span>
                </span>
                {formProvider === o.id && <span className="dot dot-amber" />}
              </button>
            ))}
          </div>

          <div className="space-y-3 rounded-lg border border-border bg-[var(--sunken)] p-3">
            <div className="space-y-1.5">
              <Label htmlFor="chat-model" className="field-label">
                Model
              </Label>
              <Input
                id="chat-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={MODEL_PLACEHOLDER[formProvider] ?? ""}
              />
              {formProvider !== "openai" && (
                <p className="text-xs text-muted-foreground">
                  Leave blank to use the CLI's own default model.
                </p>
              )}
            </div>

            {formProvider === "openai" && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="chat-key" className="field-label">
                    API key
                  </Label>
                  <Input
                    id="chat-key"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={config?.has_key ? "•••••••• (saved — leave blank to keep)" : "sk-…"}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="chat-base" className="field-label">
                    Base URL
                  </Label>
                  <Input
                    id="chat-base"
                    value={baseUrlVal}
                    onChange={(e) => setBaseUrlVal(e.target.value)}
                    placeholder="https://api.openai.com/v1"
                  />
                  <p className="text-xs text-muted-foreground">
                    Works with any OpenAI-compatible API (OpenAI, OpenRouter, local servers, etc.).
                  </p>
                </div>
              </>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default Chat;
