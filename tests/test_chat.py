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
"""Tests for LeLab chat provider wiring."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from lelab import chat
from lelab.chat import ChatMessage, ChatRequest, ChatSkill


def _skill() -> ChatSkill:
    return ChatSkill(id="fake_policy", name="Fake policy", phrase="pick up the block")


def _message(text: str = "run the fake policy") -> ChatMessage:
    return ChatMessage(role="user", content=text)


@pytest.fixture(autouse=True)
def isolated_chat_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    saved = tmp_path / "saved_configs" / "chat.json"
    workdir = tmp_path / "chat_workdir"
    workdir.mkdir()
    monkeypatch.setattr(chat, "CHAT_CONFIG_PATH", str(saved))
    monkeypatch.setattr(chat, "_chat_workdir", lambda: str(workdir))
    monkeypatch.setattr(chat, "_inference_state", lambda: (False, None))
    return workdir


def test_chat_config_persists_per_provider_models_and_flags(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(chat, "_resolve_cli", lambda name: f"/bin/{name}")

    cfg = chat.handle_set_chat_config(
        chat.ChatConfigUpdate(provider="codex_cli", model="gpt-5.5", effort="high", fast=True)
    )

    assert cfg["provider"] == "codex_cli"
    assert cfg["model"] == "gpt-5.5"
    assert cfg["models"]["codex_cli"] == "gpt-5.5"
    assert cfg["effort"] == "high"
    assert cfg["fast"] is True
    assert cfg["claude_cli"] is True
    assert cfg["codex_cli"] is True


def test_handle_chat_caps_history_before_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}

    def fake_run_claude(path, model, effort, state, messages, skills):
        seen["messages"] = messages
        seen["skills"] = skills
        return {"reply": "ok", "action": None}

    monkeypatch.setattr(chat, "_load_config", lambda: chat.ChatConfig(provider="claude_cli"))
    monkeypatch.setattr(chat, "_resolve_cli", lambda name: f"/bin/{name}")
    monkeypatch.setattr(chat, "_run_claude", fake_run_claude)
    request = ChatRequest(
        messages=[ChatMessage(role="user", content=f"turn {i}") for i in range(chat.MAX_HISTORY + 6)],
        skills=[_skill()],
        provider="claude_cli",
    )

    result = chat.handle_chat(request)

    assert result["reply"] == "ok"
    assert len(seen["messages"]) == chat.MAX_HISTORY
    assert seen["messages"][0].content == "turn 6"
    assert [skill.id for skill in seen["skills"]] == ["fake_policy"]


def test_handle_chat_reports_missing_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(chat, "_load_config", lambda: chat.ChatConfig(provider="claude_cli"))
    monkeypatch.setattr(chat, "_resolve_cli", lambda name: None)

    result = chat.handle_chat(ChatRequest(messages=[_message()], provider="claude_cli"))

    assert result["error"] == "no_cli"
    assert "not found" in result["reply"]


def test_handle_chat_reports_unknown_provider() -> None:
    result = chat.handle_chat(ChatRequest(messages=[_message()], provider="bad_provider"))

    assert result["error"] == "bad_provider"
    assert "Unknown chat provider" in result["reply"]


def test_claude_cli_uses_structured_print_mode_and_returns_run_action(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    def fake_run(cmd, **kwargs):
        calls.append({"cmd": cmd, **kwargs})
        payload = {"reply": "I can run that.", "action": "run_skill", "skill_id": "fake_policy"}
        return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(payload).encode(), stderr=b"")

    monkeypatch.setattr(chat.subprocess, "run", fake_run)

    result = chat._run_claude(
        "/bin/claude",
        "opus",
        "medium",
        "No skill is running.",
        [_message()],
        [_skill()],
    )

    cmd = calls[0]["cmd"]
    assert result["actions"][0] == {
        "type": "run_skill",
        "skill_id": "fake_policy",
        "skill_name": "Fake policy",
        "label": "Fake policy",
        "task": "pick up the block",
    }
    assert cmd[:5] == ["/bin/claude", "--model", "opus", "--effort", "medium"]
    assert "--safe-mode" in cmd
    assert "--no-session-persistence" in cmd
    assert cmd[cmd.index("--tools") + 1] == ""
    assert "--json-schema" in cmd
    assert "-p" in cmd
    assert "fake_policy" in cmd[-1]
    assert calls[0]["stdin"] is subprocess.DEVNULL


def test_claude_cli_returns_stop_action(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(cmd, **kwargs):
        payload = {"reply": "Stopping now.", "action": "stop_skill", "skill_id": ""}
        return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(payload).encode(), stderr=b"")

    monkeypatch.setattr(chat.subprocess, "run", fake_run)

    result = chat._run_claude("/bin/claude", "", "", "A skill is RUNNING.", [_message("stop")], [_skill()])

    assert result["actions"] == [{"type": "stop_skill", "label": "Stop"}]


def test_claude_cli_malformed_output_is_actionable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        chat.subprocess,
        "run",
        lambda cmd, **kwargs: subprocess.CompletedProcess(cmd, 0, stdout=b"not json", stderr=b""),
    )

    result = chat._run_claude("/bin/claude", "", "", "No skill is running.", [_message()], [_skill()])

    assert result["error"] == "bad_output"
    assert "unreadable" in result["reply"]


def test_claude_cli_failure_stderr_is_actionable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        chat.subprocess,
        "run",
        lambda cmd, **kwargs: subprocess.CompletedProcess(cmd, 1, stdout=b"", stderr=b"not authenticated"),
    )

    result = chat._run_claude("/bin/claude", "", "", "No skill is running.", [_message()], [_skill()])

    assert result["error"] == "cli_failed"
    assert "not authenticated" in result["reply"]


def test_claude_cli_timeout_is_actionable(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, timeout=180)

    monkeypatch.setattr(chat.subprocess, "run", fake_run)

    result = chat._run_claude("/bin/claude", "", "", "No skill is running.", [_message()], [_skill()])

    assert result["error"] == "timeout"
    assert "too long" in result["reply"]


def test_codex_cli_uses_documented_exec_flags_and_output_file(
    monkeypatch: pytest.MonkeyPatch,
    isolated_chat_state: Path,
) -> None:
    calls: list[dict[str, Any]] = []

    def fake_run(cmd, **kwargs):
        calls.append({"cmd": cmd, **kwargs})
        out_path = Path(cmd[cmd.index("--output-last-message") + 1])
        payload = {"reply": "Ready to run it.", "action": "run_skill", "skill_id": "fake_policy"}
        out_path.write_text(json.dumps(payload), encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0, stdout=b"", stderr=b"")

    monkeypatch.setattr(chat.subprocess, "run", fake_run)

    result = chat._run_codex(
        "/bin/codex",
        "gpt-5.5",
        "high",
        True,
        "No skill is running.",
        [_message()],
        [_skill()],
    )

    cmd = calls[0]["cmd"]
    assert result["actions"][0]["type"] == "run_skill"
    assert cmd[:5] == ["/bin/codex", "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules"]
    assert "--skip-git-repo-check" in cmd
    assert "read-only" in cmd
    assert cmd[cmd.index("--model") + 1] == "gpt-5.5"
    assert "--config" in cmd
    assert 'model_reasoning_effort="high"' in cmd
    assert 'service_tier="fast"' in cmd
    assert "--enable" in cmd
    assert "fast_mode" in cmd
    assert "--output-schema" in cmd
    assert "--output-last-message" in cmd
    assert cmd[-1] == "-"
    assert b"fake_policy" in calls[0]["input"]
    assert calls[0]["cwd"] == str(isolated_chat_state)


def test_codex_cli_malformed_output_is_actionable(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(cmd, **kwargs):
        out_path = Path(cmd[cmd.index("--output-last-message") + 1])
        out_path.write_text("not json", encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0, stdout=b"", stderr=b"")

    monkeypatch.setattr(chat.subprocess, "run", fake_run)

    result = chat._run_codex("/bin/codex", "", "", False, "No skill is running.", [_message()], [_skill()])

    assert result["error"] == "bad_output"
    assert "unreadable" in result["reply"]


def test_codex_cli_failure_stderr_is_actionable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        chat.subprocess,
        "run",
        lambda cmd, **kwargs: subprocess.CompletedProcess(cmd, 1, stdout=b"", stderr=b"login required"),
    )

    result = chat._run_codex("/bin/codex", "", "", False, "No skill is running.", [_message()], [_skill()])

    assert result["error"] == "cli_failed"
    assert "login required" in result["reply"]


def test_codex_cli_timeout_is_actionable(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, timeout=180)

    monkeypatch.setattr(chat.subprocess, "run", fake_run)

    result = chat._run_codex("/bin/codex", "", "", False, "No skill is running.", [_message()], [_skill()])

    assert result["error"] == "timeout"
    assert "too long" in result["reply"]


def test_prompts_include_only_enabled_skills_supplied_by_frontend() -> None:
    prompt = chat._structured_cli_prompt("No skill is running.", [_message()], [_skill()])

    assert "fake_policy" in prompt
    assert "disabled_policy" not in prompt


def test_structured_actions_builds_navigate_and_validates_route() -> None:
    reply, actions = chat._structured_actions(
        {
            "reply": "Sure.",
            "actions": [
                {"type": "navigate", "route": "/datasets", "label": "Open datasets"},
                {"type": "navigate", "route": "/evil", "label": "Nope"},
            ],
        },
        [_skill()],
    )

    assert reply == "Sure."
    assert actions == [{"type": "navigate", "route": "/datasets", "label": "Open datasets"}]


def test_structured_actions_builds_record_skill_with_prefill() -> None:
    _, actions = chat._structured_actions(
        {
            "reply": "Let's teach it.",
            "actions": [
                {
                    "type": "record_skill",
                    "task": "put the lid on the jar",
                    "dataset": "put-lid-on-jar",
                    "episodes": 30,
                    "label": "Record demonstrations",
                }
            ],
        },
        [],
    )

    assert actions == [
        {
            "type": "record_skill",
            "task": "put the lid on the jar",
            "label": "Record demonstrations",
            "dataset": "put-lid-on-jar",
            "episodes": 30,
        }
    ]


def test_structured_actions_drops_unknown_skill_keeps_others() -> None:
    _, actions = chat._structured_actions(
        {"reply": "ok", "actions": [{"type": "run_skill", "skill_id": "nope"}, {"type": "stop_skill"}]},
        [_skill()],
    )

    assert [a["type"] for a in actions] == ["stop_skill"]


def test_state_block_offers_proactive_buttons_per_context() -> None:
    from lelab.chat import ChatContext

    assert "/robot" in chat._state_block(ChatContext(), running=False)

    uncalibrated = chat._state_block(
        ChatContext(robot_name="bench-bot", robot_ready=False), running=False
    )
    assert "calibrate" in uncalibrated and "/calibration" in uncalibrated

    no_skills = chat._state_block(
        ChatContext(robot_name="bench-bot", robot_ready=True, skill_count=0), running=False
    )
    assert "record" in no_skills.lower()

    untrained = chat._state_block(
        ChatContext(
            robot_name="bench-bot",
            robot_ready=True,
            skill_count=1,
            untrained_datasets=["pick-block"],
        ),
        running=False,
    )
    assert "pick-block" in untrained and "train" in untrained.lower()


def test_app_map_present_in_cli_and_system_prompts() -> None:
    cli = chat._structured_cli_prompt("No skill is running.", [_message()], [_skill()])
    api = chat._system_prompt([_skill()], "No skill is running.")

    assert "/datasets" in cli and "/training" in cli
    assert "/datasets" in api and "record_skill" in api
