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
"""Tests for lelab.record — request schemas and handler entry points."""

from __future__ import annotations

from types import SimpleNamespace

import pytest


def test_recording_request_rejects_missing_required_fields() -> None:
    from pydantic import ValidationError

    from lelab.record import RecordingRequest

    with pytest.raises(ValidationError):
        RecordingRequest()


def test_recording_status_handler_exposes_state_fields() -> None:
    from lelab.record import handle_recording_status

    result = handle_recording_status()
    assert isinstance(result, dict)
    # Pinning the exact keys so a rename in handle_recording_status surfaces here.
    assert "recording_active" in result
    assert "current_phase" in result
    assert "session_ended" in result
    assert "available_controls" in result


def test_handle_stop_recording_when_idle_returns_dict(tmp_lerobot_home) -> None:
    from lelab.record import handle_stop_recording

    result = handle_stop_recording()
    assert isinstance(result, dict)


def test_create_record_config_pins_dshow_on_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    """On Windows, recording must use the DSHOW backend so a camera_index opens
    the same device /available-cameras enumerated (via pygrabber, DSHOW order).
    """
    import lelab.record as record
    from lerobot.cameras.configs import Cv2Backends

    monkeypatch.setattr("platform.system", lambda: "Windows")
    monkeypatch.setattr(record, "setup_calibration_files", lambda leader, follower: ("leader", "follower"))

    request = record.RecordingRequest(
        leader_port="COM_LEADER",
        follower_port="COM_FOLLOWER",
        leader_config="leader",
        follower_config="follower",
        dataset_repo_id="user/dataset",
        single_task="pick up the cube",
        cameras={"wrist": {"type": "opencv", "camera_index": 0, "width": 640, "height": 480, "fps": 30}},
    )

    config = record.create_record_config(request)
    assert config.robot.cameras["wrist"].backend == Cv2Backends.DSHOW


def test_create_record_config_reset_countdown_off_disables_auto_advance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With the between-takes countdown off, reset_time_s is set very high so the
    reset phase waits for a manual advance; on, it uses the requested value."""
    import lelab.record as record

    monkeypatch.setattr(
        record, "setup_calibration_files", lambda leader, follower: ("leader", "follower")
    )

    def _req(reset_countdown: bool) -> record.RecordingRequest:
        return record.RecordingRequest(
            leader_port="L",
            follower_port="F",
            leader_config="leader",
            follower_config="follower",
            dataset_repo_id="user/ds",
            single_task="task",
            reset_time_s=15,
            reset_countdown=reset_countdown,
        )

    assert record.create_record_config(_req(True)).dataset.reset_time_s == 15
    assert record.create_record_config(_req(False)).dataset.reset_time_s == record._MANUAL_RESET_TIME_S


def test_delete_dataset_with_delete_hub_calls_delete_repo(monkeypatch: pytest.MonkeyPatch) -> None:
    """delete_hub=True deletes the Hub repo (repo_type='dataset'); local-only delete
    (default) never touches the Hub."""
    import lelab.record as record

    calls: list[tuple] = []

    def fake_delete_repo(repo_id, repo_type=None):
        calls.append((repo_id, repo_type))

    monkeypatch.setattr("huggingface_hub.delete_repo", fake_delete_repo)

    # Hub-only delete (no local copy on this machine) still calls delete_repo.
    res = record.handle_delete_dataset(
        record.DeleteDatasetRequest(dataset_repo_id="u/hub-only-xyz-test", delete_hub=True)
    )
    assert res["success"] is True
    assert res["hub_deleted"] is True
    assert calls == [("u/hub-only-xyz-test", "dataset")]

    # Default (no delete_hub) does not touch the Hub.
    calls.clear()
    record.handle_delete_dataset(
        record.DeleteDatasetRequest(dataset_repo_id="u/another-missing-xyz-test")
    )
    assert calls == []


def test_build_camera_configs_uses_default_backend_when_unset() -> None:
    from lelab.record import _build_camera_configs
    from lerobot.cameras.configs import Cv2Backends

    cameras = {"cam": {"type": "opencv", "camera_index": 0, "width": 640, "height": 480, "fps": 30}}
    configs = _build_camera_configs(cameras, Cv2Backends.AVFOUNDATION)

    assert configs["cam"].backend == Cv2Backends.AVFOUNDATION
    assert configs["cam"].fourcc is None
    assert configs["cam"].index_or_path == 0


def test_build_camera_configs_passes_fourcc_through() -> None:
    from lelab.record import _build_camera_configs
    from lerobot.cameras.configs import Cv2Backends

    cameras = {"cam": {"type": "opencv", "camera_index": 0, "fourcc": "MJPG"}}
    configs = _build_camera_configs(cameras, Cv2Backends.ANY)

    assert configs["cam"].fourcc == "MJPG"


def test_build_camera_configs_explicit_backend_overrides_default() -> None:
    from lelab.record import _build_camera_configs
    from lerobot.cameras.configs import Cv2Backends

    cameras = {"cam": {"type": "opencv", "camera_index": 0, "backend": "V4L2"}}
    configs = _build_camera_configs(cameras, Cv2Backends.AVFOUNDATION)

    assert configs["cam"].backend == Cv2Backends.V4L2


def test_build_camera_configs_invalid_backend_raises() -> None:
    from lelab.record import _build_camera_configs
    from lerobot.cameras.configs import Cv2Backends

    cameras = {"cam": {"type": "opencv", "camera_index": 0, "backend": "NOPE"}}
    with pytest.raises(KeyError):
        _build_camera_configs(cameras, Cv2Backends.ANY)


def test_build_camera_configs_skips_non_opencv_type() -> None:
    from lelab.record import _build_camera_configs
    from lerobot.cameras.configs import Cv2Backends

    cameras = {"cam": {"type": "realsense", "camera_index": 0}}
    configs = _build_camera_configs(cameras, Cv2Backends.ANY)

    assert configs == {}


def test_record_with_web_events_saves_episodes_after_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    import lelab.record as record

    loop_calls: list[tuple[str, int]] = []

    class FakeDataset:
        last: FakeDataset | None = None

        def __init__(self) -> None:
            self.fps = 30
            self.features = {}
            self.saved = 0
            self.cleared = 0
            self.finalized = False
            FakeDataset.last = self

        @classmethod
        def create(cls, *args, **kwargs):
            return cls()

        def save_episode(self) -> None:
            self.saved += 1

        def clear_episode_buffer(self) -> None:
            self.cleared += 1

        def finalize(self) -> None:
            self.finalized = True

    class FakeEncodingManager:
        def __init__(self, dataset) -> None:
            self.dataset = dataset

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb) -> bool:
            return False

    class FakeRobot:
        name = "fake_robot"
        action_features = {}
        observation_features = {}
        cameras = {}
        calibration = None

        def __init__(self) -> None:
            self.connected = False

        def connect(self) -> None:
            self.connected = True

        def disconnect(self) -> None:
            self.connected = False

    class FakeTeleop(FakeRobot):
        pass

    def fake_record_loop(*, dataset=None, control_time_s, **kwargs) -> None:
        loop_calls.append(("record" if dataset is not None else "reset", control_time_s))

    monkeypatch.setattr("lerobot.datasets.LeRobotDataset", FakeDataset)
    monkeypatch.setattr("lerobot.datasets.VideoEncodingManager", FakeEncodingManager)
    monkeypatch.setattr("lerobot.robots.make_robot_from_config", lambda cfg: FakeRobot())
    monkeypatch.setattr("lerobot.teleoperators.make_teleoperator_from_config", lambda cfg: FakeTeleop())
    monkeypatch.setattr("lerobot.processor.make_default_processors", lambda: (lambda x: x, lambda x: x, lambda x: x))
    monkeypatch.setattr("lerobot.utils.feature_utils.hw_to_dataset_features", lambda *args, **kwargs: {})
    monkeypatch.setattr("lerobot.common.control_utils.sanity_check_dataset_name", lambda *args, **kwargs: None)
    monkeypatch.setattr("lerobot.scripts.lerobot_record.record_loop", fake_record_loop)
    monkeypatch.setattr("lerobot.utils.utils.log_say", lambda *args, **kwargs: None)

    cfg = SimpleNamespace(
        robot=SimpleNamespace(),
        teleop=SimpleNamespace(),
        resume=False,
        display_data=False,
        play_sounds=False,
        dataset=SimpleNamespace(
            repo_id="user/test_dataset",
            fps=30,
            root=None,
            video=False,
            num_episodes=2,
            episode_time_s=7,
            reset_time_s=3,
            single_task="pick",
            push_to_hub=False,
            tags=[],
            private=False,
            video_encoding_batch_size=1,
            vcodec="auto",
            streaming_encoding=True,
            encoder_queue_maxsize=1,
            encoder_threads=1,
            num_image_writer_processes=0,
            num_image_writer_threads_per_camera=0,
        ),
    )

    dataset = record.record_with_web_events(
        cfg,
        {"exit_early": False, "stop_recording": False, "rerecord_episode": False},
    )

    assert loop_calls == [("record", 7), ("reset", 3), ("record", 7)]
    assert dataset.saved == 2
    assert dataset.cleared == 0
    assert dataset.finalized is True


def test_create_record_config_sets_explicit_root_for_resume(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """resume() refuses root=None (it would write into the shared Hub cache), so
    create_record_config must pin the dataset root to the standard local path —
    otherwise 'record more takes' (resume) crashes before recording starts."""
    from pathlib import Path

    import lelab.record as record
    from lerobot.utils.constants import HF_LEROBOT_HOME

    monkeypatch.setattr(
        record, "setup_calibration_files", lambda leader, follower: ("leader", "follower")
    )

    request = record.RecordingRequest(
        leader_port="L",
        follower_port="F",
        leader_config="leader",
        follower_config="follower",
        dataset_repo_id="user/move-an-item",
        single_task="task",
        resume=True,
    )
    config = record.create_record_config(request)
    assert config.dataset.root is not None
    assert Path(config.dataset.root) == Path(HF_LEROBOT_HOME) / "user/move-an-item"


def test_recording_status_surfaces_error_on_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """A failed session must report the real error in the status so the UI can
    show (and let the user copy) it, not just bounce away silently."""
    import lelab.record as record

    monkeypatch.setattr(record, "recording_active", False)
    monkeypatch.setattr(record, "current_phase", "error")
    monkeypatch.setattr(record, "last_recording_info", {"success": False, "error": "boom: no root"})

    status = record.handle_recording_status()
    assert status["session_ended"] is True
    assert status["current_phase"] == "error"
    assert status["error"] == "boom: no root"
