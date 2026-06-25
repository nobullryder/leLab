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

import logging
import re
import shutil
import threading
import time
from datetime import datetime
from typing import Any

from pydantic import BaseModel

from lerobot.configs.dataset import DatasetRecordConfig
from lerobot.datasets import LeRobotDataset
from lerobot.robots.so_follower import SO101FollowerConfig

# Import the main record functionality to reuse it
from lerobot.scripts.lerobot_record import RecordConfig
from lerobot.teleoperators.so_leader import SO101LeaderConfig

from .utils.config import setup_calibration_files, with_lelab_tag
from .utils.devices import safe_disconnect_device

logger = logging.getLogger(__name__)

# Global variables for recording state
recording_active = False
recording_thread: threading.Thread | None = None
recording_events = None  # Events dict for controlling recording session
recording_config = None  # Store recording configuration
recording_start_time = None  # Track when recording started
session_end_elapsed_seconds = None  # Final session duration after the run ends
current_episode = 1  # Track current episode number
saved_episodes = 0  # Track how many episodes have been saved
current_phase = "preparing"  # Track current phase: "preparing", "recording", "resetting", "completed"
phase_start_time = None  # Track when current phase started
last_recording_info: dict[str, Any] | None = (
    None  # Snapshot of the most recently completed dataset (for /dataset-info)
)
# Guards the start path so two concurrent POST /start-recording calls cannot
# both pass the active-flag check.
_state_lock = threading.Lock()

# With the between-takes countdown off, the reset phase waits (effectively)
# forever for the teleoperator to advance manually — LeRobot polls the exit-early
# event, so "Keep it · next episode" / → still advances instantly.
_MANUAL_RESET_TIME_S = 3600


class RecordingRequest(BaseModel):
    leader_port: str
    follower_port: str
    leader_config: str
    follower_config: str
    dataset_repo_id: str
    single_task: str
    num_episodes: int = 5
    episode_time_s: int = 30
    reset_time_s: int = 10
    # When False, the between-takes (reset) phase has no countdown / auto-advance;
    # the teleoperator advances manually. Off by default (set by the frontend).
    reset_countdown: bool = True
    fps: int = 30
    video: bool = True
    push_to_hub: bool = False
    tags: list[str] = []
    private: bool = False
    resume: bool = False
    streaming_encoding: bool = True
    cameras: dict = {}
    test_mode: bool = False  # Skip robot connection for testing


class UploadRequest(BaseModel):
    dataset_repo_id: str
    tags: list[str] = []
    private: bool = False


class DatasetInfoRequest(BaseModel):
    dataset_repo_id: str


class DeleteDatasetRequest(BaseModel):
    dataset_repo_id: str
    # Also delete the dataset repo on the Hugging Face Hub (needs write access).
    delete_hub: bool = False


def _platform_backend():
    """Pin the OpenCV backend per-platform so the index→camera mapping matches
    what the /available-cameras thumbnails were captured with. cv2.CAP_ANY can
    pick different backends across calls on macOS, silently reordering cameras
    between the modal preview and the recording."""
    import platform

    from lerobot.cameras.configs import Cv2Backends

    system = platform.system()
    if system == "Darwin":
        return Cv2Backends.AVFOUNDATION
    if system == "Linux":
        return Cv2Backends.V4L2
    if system == "Windows":
        # DirectShow, matching the order /available-cameras enumerates (via
        # pygrabber) so a camera_index always opens the previewed device.
        return Cv2Backends.DSHOW
    return Cv2Backends.ANY


def _build_camera_configs(cameras: dict, default_backend) -> dict:
    """Convert the frontend camera dict into OpenCVCameraConfig objects.

    `backend` (a Cv2Backends name) and `fourcc` (a 4-char code) are optional per
    camera; when omitted they fall back to `default_backend` and auto-detect.
    """
    from lerobot.cameras.configs import Cv2Backends
    from lerobot.cameras.opencv import OpenCVCameraConfig

    camera_configs: dict = {}
    for camera_name, camera_data in cameras.items():
        if camera_data.get("type") != "opencv":
            logger.warning(
                f"⚠️ CAMERA CONFIG: Unsupported camera type '{camera_data.get('type')}' for {camera_name}"
            )
            continue

        backend_name = camera_data.get("backend")
        backend = Cv2Backends[backend_name] if backend_name else default_backend
        fourcc = camera_data.get("fourcc") or None

        camera_configs[camera_name] = OpenCVCameraConfig(
            index_or_path=camera_data.get("camera_index", 0),
            backend=backend,
            fps=camera_data.get("fps"),
            width=camera_data.get("width"),
            height=camera_data.get("height"),
            fourcc=fourcc,
        )
        logger.info(
            f"✅ CAMERA CONFIG: {camera_name} -> OpenCVCameraConfig("
            f"index={camera_data.get('camera_index')}, backend={backend.name}, "
            f"{camera_data.get('width')}x{camera_data.get('height')}@{camera_data.get('fps')}fps, "
            f"fourcc={fourcc})"
        )
    return camera_configs


def create_record_config(request: RecordingRequest) -> RecordConfig:
    """Create a RecordConfig from the recording request"""
    # Setup calibration files
    leader_config_name, follower_config_name = setup_calibration_files(
        request.leader_config, request.follower_config
    )

    # Convert the frontend camera dict into OpenCVCameraConfig objects. Backend
    # defaults to the platform pin unless the request overrides it per camera.
    camera_configs = _build_camera_configs(request.cameras, _platform_backend())

    # Create robot config
    robot_config = SO101FollowerConfig(
        port=request.follower_port,
        id=follower_config_name,
        cameras=camera_configs,
    )

    # Create teleop config
    teleop_config = SO101LeaderConfig(
        port=request.leader_port,
        id=leader_config_name,
    )

    # Create dataset config
    from pathlib import Path

    from lerobot.utils.constants import HF_LEROBOT_HOME

    dataset_config = DatasetRecordConfig(
        repo_id=request.dataset_repo_id,
        # resume() refuses root=None (it would write into the shared Hub cache),
        # so set the local root explicitly. This is the same location
        # LeRobotDataset.create uses by default, so it's correct for new
        # recordings too.
        root=Path(HF_LEROBOT_HOME) / request.dataset_repo_id,
        single_task=request.single_task,
        num_episodes=request.num_episodes,
        episode_time_s=request.episode_time_s,
        reset_time_s=request.reset_time_s if request.reset_countdown else _MANUAL_RESET_TIME_S,
        fps=request.fps,
        video=request.video,
        push_to_hub=request.push_to_hub,
        # Upstream typing: tags is `list[str] | None`. None when push is off
        # keeps the lerobot default.
        tags=with_lelab_tag(request.tags) if request.push_to_hub else None,
        private=request.private,
        streaming_encoding=request.streaming_encoding,
    )

    # Create the main record config
    record_config = RecordConfig(
        robot=robot_config,
        teleop=teleop_config,
        dataset=dataset_config,
        resume=request.resume,
        display_data=False,  # Don't display data in API mode
        play_sounds=False,  # Don't play sounds in API mode
    )

    return record_config


def handle_start_recording(request: RecordingRequest) -> dict[str, Any]:
    """Handle start recording request by using the existing record() function"""
    global \
        recording_active, \
        recording_thread, \
        recording_events, \
        recording_config, \
        recording_start_time, \
        session_end_elapsed_seconds, \
        current_episode, \
        saved_episodes, \
        current_phase, \
        phase_start_time, \
        last_recording_info

    from . import rollout as _rollout, teleoperate as _teleoperate

    # Claim the active flag under the lock so two concurrent starts can't both
    # pass the precondition check.
    with _state_lock:
        if recording_active:
            return {"success": False, "message": "Recording is already active"}
        if _teleoperate.teleoperation_active:
            return {"success": False, "message": "Teleoperation is currently active. Stop it first."}
        if _rollout.inference_active:
            return {"success": False, "message": "Inference is currently active. Stop it first."}
        recording_active = True
        recording_thread = None
        recording_events = None
        recording_config = None
        recording_start_time = None
        session_end_elapsed_seconds = None
        current_episode = 1
        saved_episodes = 0
        current_phase = "preparing"
        phase_start_time = None
        last_recording_info = None

    try:
        # Sanitize the dataset name so push_to_hub never rejects a finished
        # recording over an invalid character. HF repo names allow only
        # [A-Za-z0-9._-]; everything else becomes "_".
        if request.dataset_repo_id:
            if "/" in request.dataset_repo_id:
                namespace, name = request.dataset_repo_id.split("/", 1)
                name = re.sub(r"[^A-Za-z0-9._-]", "_", name)
                request.dataset_repo_id = f"{namespace}/{name}"
            else:
                request.dataset_repo_id = re.sub(r"[^A-Za-z0-9._-]", "_", request.dataset_repo_id)
        # Stamp the repo_id with a timestamp (matches lerobot-record CLI behavior),
        # so each session lands in a unique directory and the frontend gets the
        # final id back in the response and status payload.
        if not request.resume and request.dataset_repo_id:
            request.dataset_repo_id = f"{request.dataset_repo_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

        logger.info(f"Starting recording for dataset: {request.dataset_repo_id}")
        logger.info(f"Task: {request.single_task}")

        recording_config = request
        recording_events = {
            "exit_early": False,  # Right arrow key -> "Skip to next episode" button
            "stop_recording": False,  # ESC key -> "Stop recording" button
            "rerecord_episode": False,  # Left arrow key -> "Re-record episode" button
        }

        record_config = create_record_config(request)

        def recording_worker():
            global \
                recording_active, \
                recording_start_time, \
                session_end_elapsed_seconds, \
                current_phase, \
                phase_start_time, \
                current_episode, \
                saved_episodes, \
                last_recording_info
            recording_start_time = time.time()
            current_episode = 1
            saved_episodes = 0

            try:
                logger.info(
                    "Recording session started: dataset=%s task=%r episodes=%d",
                    request.dataset_repo_id,
                    request.single_task,
                    request.num_episodes,
                )

                # Give the frontend's camera streams time to release the
                # underlying devices before lerobot tries to open them.
                if request.cameras:
                    logger.info(
                        "Waiting for camera resources to be released (cameras: %s)",
                        list(request.cameras.keys()),
                    )
                    time.sleep(2.0)

                dataset = record_with_web_events(record_config, recording_events)
                logger.info(f"Recording completed successfully. Dataset has {dataset.num_episodes} episodes")
                last_recording_info = {
                    "success": True,
                    "dataset_repo_id": request.dataset_repo_id,
                    "num_episodes": dataset.num_episodes,
                    "single_task": request.single_task,
                    "fps": dataset.fps,
                    "features": list(dataset.features.keys()),
                    "total_frames": dataset.num_frames,
                    "robot_type": getattr(dataset.meta, "robot_type", "Unknown robot"),
                }
            except Exception as e:
                logger.exception("Recording session failed")
                current_phase = "error"
                if recording_start_time:
                    session_end_elapsed_seconds = int(time.time() - recording_start_time)
                last_recording_info = {"success": False, "error": str(e)}
            finally:
                if current_phase != "error":
                    current_phase = "completed"
                if recording_start_time:
                    session_end_elapsed_seconds = int(time.time() - recording_start_time)
                recording_active = False
                recording_start_time = None
                phase_start_time = None
                current_episode = 1
                saved_episodes = 0
                logger.info("Recording session ended")

        recording_thread = threading.Thread(target=recording_worker, name="recording-worker", daemon=True)
        recording_thread.start()

        return {
            "success": True,
            "message": "Recording started successfully",
            "dataset_id": request.dataset_repo_id,
            "num_episodes": request.num_episodes,
        }

    except Exception as e:
        recording_active = False
        logger.error(f"Failed to start recording: {e}")
        return {"success": False, "message": f"Failed to start recording: {str(e)}"}


def handle_stop_recording() -> dict[str, Any]:
    """Handle stop recording request - replaces ESC key"""
    global current_phase, phase_start_time

    if not recording_active or recording_events is None:
        return {"success": False, "message": "No recording session is active"}

    recording_events["stop_recording"] = True
    recording_events["exit_early"] = True
    current_phase = "stopping"
    phase_start_time = None
    logger.info("Stop recording triggered from web interface")
    return {
        "success": True,
        "message": "Recording stop requested successfully",
        "session_ending": True,
    }


def handle_exit_early() -> dict[str, Any]:
    """Handle exit early request - replaces right arrow key"""
    if not recording_active or recording_events is None:
        return {"success": False, "message": "No recording session is active"}
    recording_events["exit_early"] = True
    # Tracking flag that record_loop won't reset, so the worker can tell
    # "user pressed skip" from "control_time_s elapsed naturally".
    recording_events["_exit_early_triggered"] = True
    logger.info("Exit early triggered (current phase: %s)", current_phase)
    phase_name = "recording phase" if current_phase == "recording" else "reset phase"
    return {
        "success": True,
        "message": f"Exit early triggered successfully for {phase_name}",
        "current_phase": current_phase,
        "events_state": dict(recording_events),
    }


def handle_rerecord_episode() -> dict[str, Any]:
    """Handle rerecord episode request - replaces left arrow key"""
    if not recording_active or recording_events is None:
        return {"success": False, "message": "No recording session is active"}
    recording_events["rerecord_episode"] = True
    recording_events["exit_early"] = True
    logger.info("Re-record episode triggered")
    return {
        "success": True,
        "message": "Re-record episode requested successfully",
        "events_state": dict(recording_events),
    }


def handle_recording_status() -> dict[str, Any]:
    """Handle recording status request"""
    # If recording is not active and phase is completed or error, indicate session has ended
    session_ended = not recording_active and current_phase in ["completed", "error"]

    # Log when session has ended to help debug frontend polling
    if session_ended:
        if current_phase == "error":
            logger.info("Recording status requested after session error; frontend should stop polling")
        else:
            logger.info("Recording status requested after session end; frontend should stop polling")

    status = {
        "recording_active": recording_active,
        "current_phase": current_phase,  # "preparing", "recording", "resetting", "completed"
        "session_ended": session_ended,  # New field to indicate session completion
        "available_controls": {
            "stop_recording": recording_active,  # ESC key replacement
            "exit_early": recording_active,  # Right arrow key replacement
            # Redo is offered while recording (abort a bad take) and during the
            # reset review (decide keep-or-redo before the take is saved).
            "rerecord_episode": recording_active and current_phase in ("recording", "resetting"),
        },
        # True once the user has chosen to redo, until the re-record actually
        # starts — so the UI can say "start over" instead of "keep & next".
        "rerecord_pending": bool(recording_events and recording_events.get("rerecord_episode")),
        "message": "Recording session failed with error - check logs"
        if current_phase == "error"
        else (
            "Recording session has ended - stop polling"
            if session_ended
            else "Recording status retrieved successfully"
        ),
    }

    # Always echo the stamped dataset id whenever a config exists, so the frontend
    # can read the actual on-disk repo_id (post stamp) for upload navigation.
    if recording_config:
        status["dataset_repo_id"] = recording_config.dataset_repo_id

    # On failure, surface the actual error so the UI can show (and let the user
    # copy) it, instead of silently ending with a generic "check logs".
    if current_phase == "error" and last_recording_info:
        status["error"] = last_recording_info.get("error")

    # Add episode information if recording is active
    if recording_active and recording_config:
        status["current_episode"] = current_episode
        status["total_episodes"] = recording_config.num_episodes
        status["saved_episodes"] = saved_episodes  # Track completed episodes

        # Add session start time if available
        if recording_start_time:
            status["session_start_time"] = recording_start_time
            status["session_elapsed_seconds"] = int(time.time() - recording_start_time)

        # Add phase timing information
        if phase_start_time:
            status["phase_start_time"] = phase_start_time
            status["phase_elapsed_seconds"] = int(time.time() - phase_start_time)

            # Add phase time limits
            if current_phase == "recording":
                status["phase_time_limit_s"] = recording_config.episode_time_s
            elif current_phase == "resetting":
                # Only advertise a reset time limit when the countdown is on; with
                # it off the frontend shows "advance when ready" instead of a timer.
                status["reset_countdown"] = recording_config.reset_countdown
                if recording_config.reset_countdown:
                    status["phase_time_limit_s"] = recording_config.reset_time_s
    elif session_end_elapsed_seconds is not None:
        status["session_elapsed_seconds"] = session_end_elapsed_seconds

    return status


def _dataset_single_task(meta) -> str:
    """Best-effort human task label. Newer LeRobot stores tasks in ``meta.tasks``
    (a DataFrame indexed by the task string) rather than a ``single_task`` attr."""
    st = getattr(meta, "single_task", None)
    if st:
        return st
    tasks = getattr(meta, "tasks", None)
    if tasks is None:
        return "Unknown task"
    try:
        names = list(getattr(tasks, "index", []))  # DataFrame index = task strings
        if names:
            return str(names[0])
    except Exception:
        pass
    try:
        if isinstance(tasks, dict) and tasks:
            return str(next(iter(tasks)))
        if isinstance(tasks, (list, tuple)) and tasks:
            return str(tasks[0])
    except Exception:
        pass
    return "Unknown task"


def handle_get_dataset_info(request: DatasetInfoRequest) -> dict[str, Any]:
    """Return dataset metadata — from the most recent session if it matches,
    otherwise from the LOCAL metadata only.

    Loads metadata via ``LeRobotDatasetMetadata`` with an explicit local ``root``
    (matching /dataset-episodes), instead of constructing a full ``LeRobotDataset``
    with no root. The full-dataset path could trigger a Hub revision round-trip and
    a heavy decoder/data load, which transiently failed and made opening a dataset
    flaky (it worked on refresh once the cache was warm)."""
    repo_id = request.dataset_repo_id
    if last_recording_info and last_recording_info.get("dataset_repo_id") == repo_id:
        return last_recording_info

    try:
        from pathlib import Path

        from lerobot.datasets.dataset_metadata import LeRobotDatasetMetadata
        from lerobot.utils.constants import HF_LEROBOT_HOME

        root = Path(HF_LEROBOT_HOME) / repo_id
        if not (root / "meta" / "info.json").is_file():
            return {"success": False, "message": f"Dataset {repo_id} not found locally"}

        meta = LeRobotDatasetMetadata(repo_id, root=root)
        return {
            "success": True,
            "dataset_repo_id": repo_id,
            "num_episodes": meta.total_episodes,
            "single_task": _dataset_single_task(meta),
            "fps": meta.fps,
            "features": list(meta.features.keys()),
            "total_frames": meta.total_frames,
            "robot_type": meta.robot_type or "Unknown robot",
        }
    except Exception as e:
        logger.warning(f"Could not load local dataset {repo_id}: {e}")
        return {
            "success": False,
            "message": f"Dataset {repo_id} not found locally",
        }


def handle_delete_dataset(request: DeleteDatasetRequest) -> dict[str, Any]:
    """Remove a recorded dataset's local directory, and optionally its Hub repo."""
    global last_recording_info
    from pathlib import Path

    from lerobot.utils.constants import HF_LEROBOT_HOME

    repo_id = request.dataset_repo_id
    root = Path(HF_LEROBOT_HOME).resolve()
    target = (root / repo_id).resolve()

    # Reject path traversal: target must stay strictly inside HF_LEROBOT_HOME.
    if target == root or root not in target.parents:
        return {"success": False, "message": "Invalid dataset path"}

    local_deleted = False
    if target.exists():
        try:
            shutil.rmtree(target)
            local_deleted = True
        except Exception as e:
            logger.error(f"Failed to delete dataset {repo_id}: {e}")
            return {"success": False, "message": f"Failed to delete dataset: {e}"}
        if last_recording_info and last_recording_info.get("dataset_repo_id") == repo_id:
            last_recording_info = None
        logger.info(f"Deleted dataset directory {target}")

    hub_deleted = False
    hub_error: str | None = None
    if request.delete_hub:
        try:
            from huggingface_hub import delete_repo

            delete_repo(repo_id, repo_type="dataset")
            hub_deleted = True
            logger.info(f"Deleted Hub dataset {repo_id}")
        except Exception as e:
            hub_error = str(e)
            logger.error(f"Failed to delete Hub dataset {repo_id}: {e}")

    if not local_deleted and not request.delete_hub:
        return {"success": False, "message": f"Dataset not found on disk: {repo_id}"}

    message = f"Deleted {repo_id}"
    if request.delete_hub:
        message += f" (Hub: {'deleted' if hub_deleted else f'failed — {hub_error}'})"
    return {
        "success": local_deleted or hub_deleted,
        "message": message,
        "local_deleted": local_deleted,
        "hub_deleted": hub_deleted,
        "hub_error": hub_error,
    }


def handle_upload_dataset(request: UploadRequest) -> dict[str, Any]:
    """Handle dataset upload to HuggingFace Hub"""
    try:
        # Import LeRobotDataset to load and upload the dataset
        from lerobot.datasets import LeRobotDataset

        logger.info(f"Loading dataset {request.dataset_repo_id} for upload")

        # Load the dataset from local storage
        dataset = LeRobotDataset(request.dataset_repo_id)

        logger.info(f"Dataset loaded with {dataset.num_episodes} episodes")
        tags = with_lelab_tag(request.tags)
        logger.info(f"Uploading to HuggingFace Hub with tags: {tags}, private: {request.private}")

        # Upload dataset to HuggingFace Hub
        dataset.push_to_hub(tags=tags, private=request.private)

        logger.info(f"Dataset {request.dataset_repo_id} uploaded successfully to HuggingFace Hub")

        return {
            "success": True,
            "message": f"Dataset {request.dataset_repo_id} uploaded successfully to HuggingFace Hub",
            "dataset_url": f"https://huggingface.co/datasets/{request.dataset_repo_id}",
            "num_episodes": dataset.num_episodes,
        }

    except Exception as e:
        logger.error(f"Error uploading dataset {request.dataset_repo_id}: {e}")
        import traceback

        logger.error(f"Full traceback: {traceback.format_exc()}")

        err_text = str(e).lower()
        looks_like_auth = any(
            m in err_text
            for m in ("401", "you must be authenticated", "authentication required", "huggingfacehub_token")
        )
        if looks_like_auth:
            return {
                "success": False,
                "message": "You're not logged into the Hugging Face Hub. Run `hf auth login` in your terminal, then retry.",
                "docs_url": "https://huggingface.co/docs/huggingface_hub/en/quick-start#authentication",
            }
        return {"success": False, "message": f"Failed to upload dataset: {str(e)}"}


def record_with_web_events(cfg: RecordConfig, web_events: dict) -> LeRobotDataset:
    """
    Implement recording with phase tracking - exactly mirrors original record() function behavior
    """
    import time

    from lerobot.common.control_utils import (
        sanity_check_dataset_name,
        sanity_check_dataset_robot_compatibility,
    )
    from lerobot.datasets import LeRobotDataset, VideoEncodingManager
    from lerobot.processor import make_default_processors
    from lerobot.robots import make_robot_from_config
    from lerobot.scripts.lerobot_record import record_loop
    from lerobot.teleoperators import make_teleoperator_from_config
    from lerobot.utils.feature_utils import hw_to_dataset_features
    from lerobot.utils.utils import log_say

    global current_phase, phase_start_time, current_episode, saved_episodes

    robot = make_robot_from_config(cfg.robot)
    teleop = make_teleoperator_from_config(cfg.teleop) if cfg.teleop is not None else None

    teleop_action_processor, robot_action_processor, robot_observation_processor = make_default_processors()

    action_features = hw_to_dataset_features(robot.action_features, "action", cfg.dataset.video)
    obs_features = hw_to_dataset_features(robot.observation_features, "observation", cfg.dataset.video)
    dataset_features = {**action_features, **obs_features}

    if cfg.resume:
        num_cameras = len(robot.cameras) if hasattr(robot, "cameras") else 0
        dataset = LeRobotDataset.resume(
            cfg.dataset.repo_id,
            root=cfg.dataset.root,
            batch_encoding_size=cfg.dataset.video_encoding_batch_size,
            vcodec=cfg.dataset.vcodec,
            streaming_encoding=cfg.dataset.streaming_encoding,
            encoder_queue_maxsize=cfg.dataset.encoder_queue_maxsize,
            encoder_threads=cfg.dataset.encoder_threads,
            image_writer_processes=cfg.dataset.num_image_writer_processes if num_cameras > 0 else 0,
            image_writer_threads=cfg.dataset.num_image_writer_threads_per_camera * num_cameras
            if num_cameras > 0
            else 0,
        )
        sanity_check_dataset_robot_compatibility(dataset, robot, cfg.dataset.fps, dataset_features)
    else:
        sanity_check_dataset_name(cfg.dataset.repo_id, None)
        dataset = LeRobotDataset.create(
            cfg.dataset.repo_id,
            cfg.dataset.fps,
            root=cfg.dataset.root,
            robot_type=robot.name,
            features=dataset_features,
            use_videos=cfg.dataset.video,
            image_writer_processes=cfg.dataset.num_image_writer_processes,
            image_writer_threads=cfg.dataset.num_image_writer_threads_per_camera * len(robot.cameras),
            batch_encoding_size=cfg.dataset.video_encoding_batch_size,
            vcodec=cfg.dataset.vcodec,
            streaming_encoding=cfg.dataset.streaming_encoding,
            encoder_queue_maxsize=cfg.dataset.encoder_queue_maxsize,
            encoder_threads=cfg.dataset.encoder_threads,
        )

    # 🔧 ROBOT CONNECTION: Connect with enhanced error handling for camera conflicts
    try:
        logger.info("🔧 ROBOT CONNECTION: Attempting to connect robot...")
        robot.connect()
        logger.info("✅ ROBOT CONNECTION: Robot connected successfully")
    except Exception as e:
        msg = str(e)
        low = msg.lower()
        logger.error(f"❌ ROBOT CONNECTION: Failed to connect robot: {msg}")
        if "failed to set capture_" in low or "actual_width" in low or "actual_height" in low:
            # The camera couldn't deliver the configured resolution. This is NOT a
            # resource conflict — point at the real fix.
            logger.error(
                "💡 ROBOT CONNECTION: A camera does not support the configured resolution. "
                "Open the camera settings, click 'Auto' to use the resolution it actually "
                "reports, then start recording again."
            )
        elif "camera" in low or "device" in low or "busy" in low:
            logger.error("💡 ROBOT CONNECTION: Camera connection failure - likely camera resource conflict")
            logger.error(
                "💡 ROBOT CONNECTION: Make sure frontend camera streams are released before recording"
            )
        raise

    if teleop is not None:
        try:
            logger.info("🔧 TELEOP CONNECTION: Attempting to connect teleoperator...")
            teleop.connect()
            logger.info("✅ TELEOP CONNECTION: Teleoperator connected successfully")
        except Exception as e:
            logger.error(f"❌ TELEOP CONNECTION: Failed to connect teleoperator: {e}")
            raise

    # Ensure calibration is properly loaded and applied to the devices
    logger.info("Applying calibration to devices")

    # Write calibration to motors' memory (similar to teleoperation code)
    if hasattr(robot, "bus") and robot.calibration is not None:
        try:
            logger.info("Writing robot calibration to motors...")
            robot.bus.write_calibration(robot.calibration)
            logger.info("Robot calibration applied successfully")
        except Exception as e:
            logger.error(f"Error writing robot calibration: {e}")
    else:
        logger.warning("Robot bus or calibration not available - calibration may not be applied")

    if teleop is not None and hasattr(teleop, "bus") and teleop.calibration is not None:
        try:
            logger.info("Writing teleop calibration to motors...")
            teleop.bus.write_calibration(teleop.calibration)
            logger.info("Teleop calibration applied successfully")
        except Exception as e:
            logger.error(f"Error writing teleop calibration: {e}")
    else:
        logger.warning("Teleop bus or calibration not available - calibration may not be applied")

    # Start with episode 1 - but track it properly
    current_episode = 1
    saved_episodes = 0  # Track how many episodes we've actually saved

    try:
        with VideoEncodingManager(dataset):
            while saved_episodes < cfg.dataset.num_episodes and not web_events["stop_recording"]:
                # RECORDING PHASE - with dataset (matches lerobot-record).
                current_phase = "recording"
                phase_start_time = time.time()
                logger.info(f"Starting recording phase for episode {current_episode}")
                logger.info(f"Events state at start of recording phase: {web_events}")

                log_say(f"Recording episode {current_episode}", cfg.play_sounds)

                record_loop(
                    robot=robot,
                    events=web_events,
                    fps=cfg.dataset.fps,
                    teleop_action_processor=teleop_action_processor,
                    robot_action_processor=robot_action_processor,
                    robot_observation_processor=robot_observation_processor,
                    teleop=teleop,
                    dataset=dataset,
                    control_time_s=cfg.dataset.episode_time_s,
                    single_task=cfg.dataset.single_task,
                    display_data=cfg.display_data,
                )

                logger.info(f"Recording phase completed - events state: {web_events}")

                if not web_events["stop_recording"] and (
                    saved_episodes < cfg.dataset.num_episodes - 1 or web_events["rerecord_episode"]
                ):
                    # RESET PHASE - without dataset (matches lerobot-record).
                    current_phase = "resetting"
                    phase_start_time = time.time()
                    logger.info(f"Starting reset phase for episode {current_episode}")
                    logger.info(f"Events state at start of reset phase: {web_events}")

                    log_say("Reset the environment", cfg.play_sounds)

                    record_loop(
                        robot=robot,
                        events=web_events,
                        fps=cfg.dataset.fps,
                        teleop_action_processor=teleop_action_processor,
                        robot_action_processor=robot_action_processor,
                        robot_observation_processor=robot_observation_processor,
                        teleop=teleop,
                        # No dataset during reset: the robot can be moved without
                        # writing frames into the episode buffer.
                        control_time_s=cfg.dataset.reset_time_s,
                        single_task=cfg.dataset.single_task,
                        display_data=cfg.display_data,
                    )

                    logger.info(f"Reset phase completed - events state: {web_events}")

                if web_events["rerecord_episode"]:
                    log_say("Re-record episode", cfg.play_sounds)
                    logger.info(f"Re-recording episode {current_episode} without saving buffered frames")
                    web_events["rerecord_episode"] = False
                    web_events["exit_early"] = False
                    dataset.clear_episode_buffer()
                    continue

                logger.info(f"Saving episode {current_episode}...")
                dataset.save_episode()
                logger.info(f"Episode {current_episode} saved successfully")

                saved_episodes += 1
                current_episode += 1

        # Recording completed
        current_phase = "completed"
        phase_start_time = None
        logger.info("Recording session completed")
        log_say("Stop recording", cfg.play_sounds, blocking=True)
    finally:
        dataset.finalize()
        safe_disconnect_device(robot, logger, context="recording cleanup")
        safe_disconnect_device(teleop, logger, context="recording cleanup")

    if cfg.dataset.push_to_hub:
        dataset.push_to_hub(tags=cfg.dataset.tags, private=cfg.dataset.private)

    log_say("Exiting", cfg.play_sounds)
    return dataset
