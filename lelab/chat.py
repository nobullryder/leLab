# Copyright 2025 The HuggingFace Inc. team. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Robot assistant chat.

Talks to either an OpenAI-compatible API (user-supplied key + base URL +
model) or a locally installed Claude Code / Codex CLI, and is aware of the
robot's trained skills. It does NOT drive the arm itself: when the model
decides a skill should run it returns a ``run_skill`` action and the UI
launches the existing inference flow (camera binding, duration, safety stop),
keeping a human in the loop on hardware.

The API key is persisted under the LeRobot config dir so it survives restarts.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from lerobot.utils.constants import HF_LEROBOT_HOME

from .utils.config import CONFIG_STORAGE_PATH

logger = logging.getLogger(__name__)

CHAT_CONFIG_PATH = os.path.join(CONFIG_STORAGE_PATH, "chat.json")
DEFAULT_OPENAI_BASE = "https://api.openai.com/v1"
VALID_PROVIDERS = ("openai", "claude_cli", "codex_cli")
# Each backend uses different model ids, so the model is stored per provider.
# Empty for the CLI backends means "use the CLI's own default model".
DEFAULT_MODELS = {"openai": "gpt-4o-mini", "claude_cli": "opus", "codex_cli": "gpt-5.5"}
DEFAULT_EFFORTS = {"claude_cli": "medium", "codex_cli": "medium"}
# Cap turns sent to the model so a long chat doesn't grow tokens unbounded.
MAX_HISTORY = 24

# Routes the assistant may link/navigate to, each with a one-line description fed
# to the model as an "app map". Navigation targets are validated against this
# allowlist so the agent can't send the user to an arbitrary URL.
APP_ROUTES = {
    "/": "Home — overview and where to start",
    "/robot": "Robot — add a robot, set ports, calibrate",
    "/datasets": "Datasets — your recordings; record new (opens the Record dialog), watch episodes, publish, train",
    "/training": "Train — train a policy from a recording; see training jobs",
    "/skills": "Skills — your trained policies grouped by dataset, with version history; run a version on the robot or delete it",
    "/calibration": "Calibration — calibrate the leader/follower arms",
    "/teleoperation": "Teleoperate — move the follower arm with the leader",
    "/chat": "Chat — this assistant",
}
ALLOWED_ROUTES = set(APP_ROUTES)
# Every action the agent can hand back as a clickable affordance.
ACTION_TYPES = (
    "run_skill",
    "stop_skill",
    "navigate",
    "record_skill",
    "train",
    "calibrate",
    "open_skill",
)


def _app_map() -> str:
    return "Pages you can link or send the user to (use these exact routes):\n" + "\n".join(
        f"- {route}: {desc}" for route, desc in APP_ROUTES.items()
    )


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #
class ChatSkill(BaseModel):
    id: str
    name: str
    phrase: str = ""
    dataset: str = ""


class ChatMessage(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class ChatConfig(BaseModel):
    provider: str = "openai"
    base_url: str = DEFAULT_OPENAI_BASE
    api_key: str = ""
    models: dict[str, str] = {}  # per-provider model override
    efforts: dict[str, str] = {}  # per-provider reasoning effort
    fasts: dict[str, bool] = {}  # per-provider /fast (1.5x) mode, independent of effort


def _model_for(cfg: ChatConfig, provider: str) -> str:
    chosen = (cfg.models or {}).get(provider, "")
    return chosen or DEFAULT_MODELS.get(provider, "")


def _effort_for(cfg: ChatConfig, provider: str) -> str:
    return (cfg.efforts or {}).get(provider) or DEFAULT_EFFORTS.get(provider, "")


def _fast_for(cfg: ChatConfig, provider: str) -> bool:
    return bool((cfg.fasts or {}).get(provider, False))


class ChatConfigUpdate(BaseModel):
    provider: str | None = None
    base_url: str | None = None
    model: str | None = None
    effort: str | None = None
    fast: bool | None = None
    api_key: str | None = None  # "" clears, None leaves unchanged


class ChatContext(BaseModel):
    """Live app state the UI passes in so the assistant knows its situation."""

    robot_name: str | None = None
    robot_ready: bool | None = None
    is_calibrated: bool | None = None
    skill_count: int | None = None
    untrained_datasets: list[str] = []
    training_active: bool | None = None


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    skills: list[ChatSkill] = []
    provider: str | None = None  # override the saved provider for this turn
    context: ChatContext | None = None


# --------------------------------------------------------------------------- #
# Config persistence
# --------------------------------------------------------------------------- #
def _load_config() -> ChatConfig:
    try:
        with open(CHAT_CONFIG_PATH) as f:
            return ChatConfig(**json.load(f))
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return ChatConfig()


def _save_config(cfg: ChatConfig) -> None:
    os.makedirs(os.path.dirname(CHAT_CONFIG_PATH), exist_ok=True)
    tmp = f"{CHAT_CONFIG_PATH}.tmp"
    with open(tmp, "w") as f:
        json.dump(cfg.model_dump(), f, indent=2)
    os.replace(tmp, CHAT_CONFIG_PATH)
    with contextlib.suppress(OSError):
        os.chmod(CHAT_CONFIG_PATH, 0o600)  # the key is sensitive


def _resolve_cli(command: str) -> str | None:
    """Resolve a CLI on PATH, accounting for Windows .cmd/.exe shims."""
    if os.name == "nt" and not Path(command).suffix:
        for suffix in (".cmd", ".exe", ".bat"):
            found = shutil.which(command + suffix)
            if found:
                return found
    return shutil.which(command)


def detect_providers() -> dict[str, Any]:
    cfg = _load_config()
    return {
        "provider": cfg.provider,
        "model": _model_for(cfg, cfg.provider),
        "models": cfg.models or {},
        "effort": _effort_for(cfg, cfg.provider),
        "efforts": cfg.efforts or {},
        "fast": _fast_for(cfg, cfg.provider),
        "fasts": cfg.fasts or {},
        "base_url": cfg.base_url,
        "has_key": bool(cfg.api_key),
        "openai_configured": bool(cfg.api_key),
        "claude_cli": _resolve_cli("claude") is not None,
        "codex_cli": _resolve_cli("codex") is not None,
    }


def handle_get_chat_config() -> dict[str, Any]:
    return detect_providers()


def handle_set_chat_config(update: ChatConfigUpdate) -> dict[str, Any]:
    cfg = _load_config()
    # The model is set for whichever provider this update targets.
    target = update.provider if update.provider in VALID_PROVIDERS else cfg.provider
    if update.provider is not None and update.provider in VALID_PROVIDERS:
        cfg.provider = update.provider
    if update.base_url is not None:
        cfg.base_url = update.base_url.strip() or DEFAULT_OPENAI_BASE
    if update.model is not None:
        models = dict(cfg.models or {})
        models[target] = update.model.strip()
        cfg.models = models
    if update.effort is not None:
        efforts = dict(cfg.efforts or {})
        efforts[target] = update.effort.strip()
        cfg.efforts = efforts
    if update.fast is not None:
        fasts = dict(cfg.fasts or {})
        fasts[target] = bool(update.fast)
        cfg.fasts = fasts
    if update.api_key is not None:
        cfg.api_key = update.api_key.strip()
    _save_config(cfg)
    return detect_providers()


# --------------------------------------------------------------------------- #
# Prompt + providers
# --------------------------------------------------------------------------- #
def _inference_state() -> tuple[bool, str | None]:
    """Best-effort read of whether a skill (rollout) is running right now."""
    try:
        from .rollout import handle_inference_status

        status = handle_inference_status()
        return bool(status.get("inference_active")), status.get("outcome")
    except Exception:  # noqa: BLE001 - status is advisory; never break chat over it
        return False, None


def _state_block(context: ChatContext | None, running: bool) -> str:
    parts: list[str] = []
    # Robot readiness -> add / calibrate proactively.
    if context and context.robot_name:
        if context.robot_ready:
            parts.append(f'Robot "{context.robot_name}" is ready.')
        else:
            parts.append(
                f'Robot "{context.robot_name}" is set up but not fully calibrated '
                "(a calibrate step at /calibration is needed before it can run)."
            )
    else:
        parts.append("No robot is selected yet (one is needed before running skills — /robot adds one).")
    # Facts about progress — let the reply decide if a button is the right next step.
    if context and context.skill_count == 0:
        parts.append("No trained skills yet (recording the first one is where it starts).")
    if context and context.untrained_datasets:
        names = ", ".join(context.untrained_datasets[:3])
        parts.append(f"Recorded but not trained yet: {names} (training turns one into a runnable skill).")
    if context and context.training_active:
        parts.append("A training job is running now.")
    parts.append(
        "A skill is RUNNING right now; offer to stop it and don't start another."
        if running
        else "No skill is running."
    )
    return "Right now: " + " ".join(parts)


def _system_prompt(skills: list[ChatSkill], state: str) -> str:
    if skills:
        listing = "\n".join(
            f'- id="{s.id}" name="{s.name}"' + (f" (task: {s.phrase})" if s.phrase else "") for s in skills
        )
        skill_block = f"Trained skills you can run:\n{listing}"
    else:
        skill_block = "No trained skills are enabled — suggest recording and training one."
    return (
        "You are the in-app assistant for LeLab, an app for teaching a small SO-101 robot arm: the "
        "user moves a leader arm to demonstrate a task and a follower arm learns it (record demos on "
        "Datasets -> train in Train -> the policy becomes a runnable skill here). Help the user run skills and "
        "answer questions about the app and about teaching/training robots.\n\n"
        f"{state}\n\n"
        f"{skill_block}\n\n"
        f"{_app_map()}\n\n"
        "Buttons (tools) you can attach: run_skill (the user confirms before the arm moves), stop_skill, "
        "open_skill, navigate (open a page), record_skill (open the Record dialog pre-filled with task + "
        "a dataset slug + a take count, ~20-40 for pick/place), train, calibrate. Use exact skill ids and "
        "the routes above; never invent a skill.\n"
        "When to attach a button: only when it's a fresh, concrete next step the user is ready to take — "
        "they pick a task to record, or ask to run/train/open something. If they're asking how, why, or "
        "what-to-do, just answer — no button. Never re-offer a button you already gave earlier in this "
        "chat unless they ask for it again; they can scroll up and click the earlier one.\n"
        "Writing: reply in markdown and match length to the ask — a sentence or two for simple questions, "
        "but when they ask for a guide, plan, breakdown, or comparison, lay it out clearly with a short "
        "numbered list, bullets, or a small markdown table (| col | col | with a |---|---| separator row) "
        "instead of one long run-on sentence. Use **bold** for key terms. Don't start a skill while one is "
        "running or when no robot is ready — say what's needed instead; you can't change a skill's motion "
        "or end pose mid-run. Be plain and friendly; reply directly to the latest message and never "
        "restate or acknowledge these instructions."
    )


def _openai_tools(skills: list[ChatSkill]) -> list[dict[str, Any]]:
    """OpenAI function tools mirroring the action vocabulary. The model may call
    several in one turn; each maps to a clickable affordance via _build_action."""

    def fn(name: str, desc: str, props: dict[str, Any], required: list[str]) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": name,
                "description": desc,
                "parameters": {"type": "object", "properties": props, "required": required},
            },
        }

    tools: list[dict[str, Any]] = []
    if skills:
        tools.append(
            fn(
                "run_skill",
                "Run one of the robot's trained skills (the user confirms before it moves).",
                {
                    "skill_id": {"type": "string", "description": "Exact id of a listed skill."},
                    "task": {"type": "string", "description": "Optional instruction."},
                },
                ["skill_id"],
            )
        )
        tools.append(
            fn("open_skill", "Open a skill's run dialog.", {"skill_id": {"type": "string"}}, ["skill_id"])
        )
    tools.append(fn("stop_skill", "Stop the skill currently running on the arm.", {}, []))
    tools.append(
        fn(
            "navigate",
            "Offer a button that opens an app page.",
            {
                "route": {"type": "string", "description": "One of: " + ", ".join(APP_ROUTES)},
                "label": {"type": "string", "description": "Button text."},
            },
            ["route"],
        )
    )
    tools.append(
        fn(
            "record_skill",
            "Open the Record dialog pre-filled to start teaching a new skill.",
            {
                "task": {"type": "string", "description": "Short task instruction."},
                "dataset": {"type": "string", "description": "Dataset slug."},
                "episodes": {"type": "integer", "description": "Suggested take count (~20-40)."},
                "label": {"type": "string"},
            },
            ["task"],
        )
    )
    tools.append(
        fn(
            "train",
            "Open Training for a recorded dataset.",
            {"dataset": {"type": "string"}, "label": {"type": "string"}},
            ["dataset"],
        )
    )
    tools.append(
        fn(
            "calibrate",
            "Open calibration for the arms.",
            {"device": {"type": "string"}, "label": {"type": "string"}},
            [],
        )
    )
    return tools


def _run_openai(
    cfg: ChatConfig, model: str, state: str, messages: list[ChatMessage], skills: list[ChatSkill]
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "system", "content": _system_prompt(skills, state)}]
        + [m.model_dump() for m in messages],
    }
    payload["tools"] = _openai_tools(skills)

    url = cfg.base_url.rstrip("/") + "/chat/completions"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {cfg.api_key}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = json.loads(resp.read().decode())

    message = (body.get("choices") or [{}])[0].get("message", {})
    reply = message.get("content") or ""
    actions: list[dict[str, Any]] = []
    for call in message.get("tool_calls") or []:
        func = call.get("function", {})
        name = func.get("name")
        if name not in ACTION_TYPES:
            continue
        try:
            args = json.loads(func.get("arguments") or "{}")
        except (json.JSONDecodeError, TypeError):
            args = {}
        if not isinstance(args, dict):
            args = {}
        args["type"] = name
        built = _build_action(args, skills)
        if built:
            actions.append(built)
    if not reply:
        reply = "Ready when you are." if actions else "(no response)"
    return {"reply": reply, "actions": actions}


def _decode(raw: bytes | None) -> str:
    """Decode CLI output trying UTF-8, then the Windows codepage, then latin-1 —
    different CLIs emit different encodings (em-dash vs cp1252 smart quotes)."""
    if not raw:
        return ""
    for enc in ("utf-8", "cp1252", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _chat_workdir() -> str:
    """An empty scratch dir to run the coding CLIs in, so they don't pick up the
    LeLab repo as context (keeps replies conversational, not code-agent-y)."""
    path = str(Path(HF_LEROBOT_HOME) / "chat_workdir")
    os.makedirs(path, exist_ok=True)
    return path


def _cleanup(path: str | None) -> None:
    if path:
        with contextlib.suppress(OSError):
            os.remove(path)


# Codex exec returns a final message that must match this schema, so the model
# fills the action as DATA (reliable) rather than deciding to "take an action"
# (which it refuses to do in a chat). Mirrors T3 Code's text-generation pattern.
_CLI_ACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "reply": {
            "type": "string",
            "description": (
                "Friendly chat reply in markdown. Brief for simple questions; for a guide/plan/list/"
                "comparison use a numbered list, bullets, or a small markdown table (with a |---| row)."
            ),
        },
        "actions": {
            "type": "array",
            "description": (
                "Buttons to offer only when there is a fresh next step the user is ready to take; [] for "
                "how/why/info questions. Don't repeat a button already offered earlier in the chat."
            ),
            "items": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": list(ACTION_TYPES)},
                    "label": {"type": "string", "description": "Button text, e.g. 'Record demonstrations'."},
                    "skill_id": {"type": "string", "description": "For run_skill/open_skill; else ''."},
                    "route": {
                        "type": "string",
                        "description": "For navigate, an app route like /datasets; else ''.",
                    },
                    "task": {
                        "type": "string",
                        "description": "For record_skill, the task instruction; else ''.",
                    },
                    "dataset": {
                        "type": "string",
                        "description": "For record_skill/train, a dataset slug; else ''.",
                    },
                    "episodes": {
                        "type": "integer",
                        "description": "For record_skill, suggested take count; else 0.",
                    },
                    "device": {"type": "string", "description": "For calibrate: 'teleop'/'robot'; else ''."},
                },
                # OpenAI strict structured output requires every property in required.
                "required": ["type", "label", "skill_id", "route", "task", "dataset", "episodes", "device"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["reply", "actions"],
    "additionalProperties": False,
}


def _structured_cli_prompt(state: str, messages: list[ChatMessage], skills: list[ChatSkill]) -> str:
    skill_lines = "; ".join(f'id={s.id} name="{s.name}"' for s in skills) if skills else "(none trained yet)"
    last = messages[-1].content if messages else ""
    prior = messages[:-1]
    prior_block = ""
    if prior:
        convo = "\n".join(f"{'Assistant' if m.role == 'assistant' else 'User'}: {m.content}" for m in prior)
        prior_block = f"Earlier in this chat:\n{convo}\n\n"
    return (
        "You are LeLab's friendly in-app assistant for a small SO-101 robot arm. Workflow: record "
        "demonstrations (Datasets) -> train a policy (Train) -> the trained policy becomes a runnable "
        "skill you start here. You run/stop skills and answer questions about the app and about "
        "teaching/training; you can't move hardware except by running a skill, which the user confirms.\n"
        f"{state}\n"
        f"Skills you can run (only these): {skill_lines}.\n"
        f"{_app_map()}\n\n"
        f"{prior_block}"
        f'The user says: "{last}"\n\n'
        'Write a friendly reply in markdown in "reply": match length to the ask — a sentence or two for '
        "simple questions, but for a guide/plan/breakdown/comparison lay it out with a short numbered "
        "list, bullets, or a small markdown table (| col | col | with a |---|---| separator row) rather "
        'than one long run-on sentence; use **bold** for key terms. In "actions" add buttons only when '
        "there is a fresh, concrete next step the user is ready to take (picking a task to record, asking "
        "to run/train/open something); for how/why/what questions leave it [] and just answer. Never "
        "repeat a button already offered earlier in this chat unless asked again. Buttons: "
        "run_skill{skill_id}; stop_skill; navigate{route,label}; record_skill{task,dataset,episodes,label} "
        "(episodes ~20-40 for pick/place); train{dataset,label}; calibrate{device,label}; "
        'open_skill{skill_id}. Use exact skill ids/routes above; never invent a skill; fill unused fields '
        'with "" or 0.'
    )


def _build_action(raw: dict[str, Any], skills: list[ChatSkill]) -> dict[str, Any] | None:
    """Validate one model-proposed action into a typed affordance, or drop it."""
    if not isinstance(raw, dict):
        return None
    kind = raw.get("type")
    label = (raw.get("label") or "").strip()
    if kind in ("run_skill", "open_skill"):
        skill = next((s for s in skills if s.id == raw.get("skill_id")), None)
        if not skill:
            return None
        return {
            "type": kind,
            "skill_id": skill.id,
            "skill_name": skill.name,
            "label": label or skill.name,
            "task": (raw.get("task") or skill.phrase),
        }
    if kind == "stop_skill":
        return {"type": "stop_skill", "label": label or "Stop"}
    if kind == "navigate":
        route = (raw.get("route") or "").strip()
        if route not in ALLOWED_ROUTES:  # never navigate somewhere we didn't allow
            return None
        return {"type": "navigate", "route": route, "label": label or "Open"}
    if kind == "record_skill":
        action: dict[str, Any] = {
            "type": "record_skill",
            "task": (raw.get("task") or "").strip(),
            "label": label or "Record demonstrations",
        }
        if raw.get("dataset"):
            action["dataset"] = str(raw["dataset"]).strip()
        episodes = raw.get("episodes")
        if isinstance(episodes, int) and episodes > 0:
            action["episodes"] = episodes
        return action
    if kind == "train":
        return {"type": "train", "dataset": (raw.get("dataset") or "").strip(), "label": label or "Train"}
    if kind == "calibrate":
        return {
            "type": "calibrate",
            "device": (raw.get("device") or "").strip(),
            "label": label or "Calibrate",
        }
    return None


def _structured_actions(data: dict[str, Any], skills: list[ChatSkill]) -> tuple[str, list[dict[str, Any]]]:
    reply = (data.get("reply") or "").strip() or "(no response)"
    raw_actions = data.get("actions")
    if raw_actions is None and data.get("action"):  # tolerate the older single-action shape
        raw_actions = [{"type": data.get("action"), "skill_id": data.get("skill_id", "")}]
    actions: list[dict[str, Any]] = []
    for raw in raw_actions or []:
        built = _build_action(raw, skills)
        if built:
            actions.append(built)
    return reply, actions


def _parse_structured_cli_output(raw: str) -> dict[str, Any]:
    data = json.loads(raw)
    if isinstance(data, dict) and isinstance(data.get("result"), str):
        # Claude Code's `--output-format json` wraps the final text in a result
        # field. Accept it if users configure a CLI alias that adds that flag.
        with contextlib.suppress(json.JSONDecodeError, TypeError):
            nested = json.loads(data["result"])
            if isinstance(nested, dict):
                return nested
    if not isinstance(data, dict):
        raise json.JSONDecodeError("structured CLI output must be a JSON object", raw, 0)
    return data


def _run_claude(
    path: str,
    model: str,
    effort: str,
    state: str,
    messages: list[ChatMessage],
    skills: list[ChatSkill],
) -> dict[str, Any]:
    """Run Claude Code print mode with a JSON schema and no saved CLI session."""
    cmd = [path]
    if model:
        cmd += ["--model", model]
    if effort:
        cmd += ["--effort", effort]
    cmd += [
        "--safe-mode",
        "--no-session-persistence",
        "--tools",
        "",
        "--json-schema",
        json.dumps(_CLI_ACTION_SCHEMA),
        "-p",
        _structured_cli_prompt(state, messages, skills),
    ]
    try:
        proc = subprocess.run(  # noqa: S603 - user-installed CLI by absolute path
            cmd,
            capture_output=True,
            timeout=180,
            cwd=_chat_workdir(),
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        return {"reply": "Claude Code took too long to respond.", "actions": [], "error": "timeout"}
    except FileNotFoundError:
        return {"reply": "Claude Code isn't installed or on PATH.", "actions": [], "error": "no_cli"}

    raw = _decode(proc.stdout).strip()
    if not raw:
        detail = _decode(proc.stderr).strip()[:300]
        if proc.returncode:
            return {
                "reply": f"Claude Code CLI failed: {detail or proc.returncode}",
                "actions": [],
                "error": "cli_failed",
            }
        return {"reply": detail or "(no response)", "actions": [], "error": "empty"}
    try:
        data = _parse_structured_cli_output(raw)
    except json.JSONDecodeError:
        return {
            "reply": "Claude Code returned an unreadable response. Try again or choose another provider.",
            "actions": [],
            "error": "bad_output",
        }

    reply, actions = _structured_actions(data, skills)
    return {"reply": reply, "actions": actions}


def _run_codex(
    path: str,
    model: str,
    effort: str,
    fast: bool,
    state: str,
    messages: list[ChatMessage],
    skills: list[ChatSkill],
) -> dict[str, Any]:
    """Run codex exec with a JSON output schema (the way T3 Code does it), so the
    skill action comes back as reliable structured data and the prompt is fed via
    stdin. `fast` enables /fast (1.5x) mode, independent of reasoning effort."""
    workdir = _chat_workdir()
    schema_fd, schema_path = tempfile.mkstemp(suffix=".json", dir=workdir)
    os.close(schema_fd)
    out_fd, out_path = tempfile.mkstemp(suffix=".txt", dir=workdir)
    os.close(out_fd)
    try:
        with open(schema_path, "w") as f:
            json.dump(_CLI_ACTION_SCHEMA, f)
        cmd = [
            path,
            "exec",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--skip-git-repo-check",
            "-s",
            "read-only",
        ]
        if model:
            cmd += ["--model", model]
        cmd += ["--config", f'model_reasoning_effort="{effort or "medium"}"']
        if fast:
            # /fast mode: 1.5x speed via the "fast" service tier (GPT-5.4).
            cmd += ["--config", 'service_tier="fast"', "--enable", "fast_mode"]
        cmd += ["--output-schema", schema_path, "--output-last-message", out_path, "-"]
        try:
            proc = subprocess.run(  # noqa: S603 - user-installed CLI by absolute path
                cmd,
                input=_structured_cli_prompt(state, messages, skills).encode("utf-8"),
                capture_output=True,
                timeout=180,
                cwd=workdir,
            )
        except subprocess.TimeoutExpired:
            return {"reply": "Codex took too long to respond.", "actions": [], "error": "timeout"}
        except FileNotFoundError:
            return {"reply": "Codex isn't installed or on PATH.", "actions": [], "error": "no_cli"}

        raw = ""
        try:
            with open(out_path, "rb") as f:
                raw = _decode(f.read()).strip()
        except OSError:
            raw = ""
        if not raw:
            raw = _decode(proc.stdout).strip()
        if not raw:
            detail = _decode(proc.stderr).strip()[:300]
            if proc.returncode:
                return {
                    "reply": f"Codex CLI failed: {detail or proc.returncode}",
                    "actions": [],
                    "error": "cli_failed",
                }
            return {
                "reply": detail or "(no response)",
                "actions": [],
                "error": "empty",
            }

        try:
            data = _parse_structured_cli_output(raw)
        except json.JSONDecodeError:
            return {
                "reply": "Codex returned an unreadable response. Try again or choose another provider.",
                "actions": [],
                "error": "bad_output",
            }
        reply, actions = _structured_actions(data, skills)
        return {"reply": reply, "actions": actions}
    finally:
        _cleanup(schema_path)
        _cleanup(out_path)


def handle_chat(request: ChatRequest) -> dict[str, Any]:
    cfg = _load_config()
    provider = request.provider or cfg.provider
    model = _model_for(cfg, provider)
    effort = _effort_for(cfg, provider)
    skills = request.skills
    messages = request.messages[-MAX_HISTORY:]  # bound token use on long chats
    running, _ = _inference_state()
    state = _state_block(request.context, running)
    logger.info(
        "chat turn: provider=%s model=%s effort=%s skills=%d msgs=%d skill_running=%s",
        provider,
        model or "(cli default)",
        effort or "(default)",
        len(skills),
        len(messages),
        running,
    )
    try:
        if provider == "openai":
            if not cfg.api_key:
                return {
                    "reply": "Add an OpenAI-compatible API key in chat settings to use this model.",
                    "actions": [],
                    "error": "no_key",
                }
            result = _run_openai(cfg, model, state, messages, skills)
        elif provider == "claude_cli":
            path = _resolve_cli("claude")
            if not path:
                return {"reply": "Claude Code CLI not found on PATH.", "actions": [], "error": "no_cli"}
            result = _run_claude(path, model, effort, state, messages, skills)
        elif provider == "codex_cli":
            path = _resolve_cli("codex")
            if not path:
                return {"reply": "Codex CLI not found on PATH.", "actions": [], "error": "no_cli"}
            result = _run_codex(path, model, effort, _fast_for(cfg, provider), state, messages, skills)
        else:
            return {"reply": f"Unknown chat provider: {provider}", "actions": [], "error": "bad_provider"}
        result["actions"] = result.get("actions") or []
        # Back-compat mirror for any caller still reading a single `action`.
        result["action"] = result["actions"][0] if result["actions"] else None
        if result["actions"]:
            logger.info("chat actions: %s", [a.get("type") for a in result["actions"]])
        return result
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:300]
        logger.warning("Chat API HTTP %s: %s", exc.code, detail)
        return {
            "reply": f"The model API returned an error ({exc.code}). Check your key, model, and base URL.",
            "actions": [],
            "error": "http",
        }
    except urllib.error.URLError as exc:
        return {"reply": f"Couldn't reach the model API: {exc.reason}", "actions": [], "error": "network"}
    except Exception as exc:  # noqa: BLE001 - surface any failure to the UI rather than 500
        logger.exception("Chat failed")
        return {"reply": f"Chat error: {exc}", "actions": [], "error": "exception"}
