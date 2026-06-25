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
"""Tests for the dataset-detail routes (sync status, episode listing, video).

No hardware and no real LeRobot dataset: fake on-disk files + a fake meta object.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pandas as pd
import pytest
from fastapi.testclient import TestClient
from huggingface_hub.errors import RepositoryNotFoundError


def _make_local_dataset(root: Path, repo_id: str, files: dict[str, bytes]) -> Path:
    ds = root / repo_id
    for rel, content in files.items():
        p = ds / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(content)
    return ds


class _Sibling:
    def __init__(self, rfilename: str, size: int) -> None:
        self.rfilename = rfilename
        self.size = size


def _fake_api(siblings: list[_Sibling] | None, raises: Exception | None = None) -> MagicMock:
    api = MagicMock()
    if raises is not None:
        api.dataset_info.side_effect = raises
    else:
        info = MagicMock()
        info.siblings = siblings
        api.dataset_info.return_value = info
    return api


def _make_three_episode_dataset(root: Path, repo_id: str) -> Path:
    from lerobot.datasets.dataset_metadata import CODEBASE_VERSION
    from lerobot.datasets.feature_utils import create_empty_dataset_info
    from lerobot.datasets.io_utils import write_info

    ds = root / repo_id
    ds.mkdir(parents=True)
    features = {
        "observation.state": {"dtype": "float32", "shape": (2,), "names": ["x", "y"]},
        "observation.images.front": {
            "dtype": "video",
            "shape": (4, 4, 3),
            "names": ["height", "width", "channel"],
        },
    }
    info = create_empty_dataset_info(
        CODEBASE_VERSION,
        fps=30,
        features=features,
        use_videos=True,
        robot_type="so101_follower",
    )
    info.total_episodes = 3
    info.total_frames = 90
    info.total_tasks = 1
    info.splits = {"train": "0:3"}
    write_info(info, ds)

    tasks = pd.DataFrame({"task_index": [0]}, index=pd.Index(["Pick a cube"], name="task"))
    tasks.to_parquet(ds / "meta" / "tasks.parquet")

    episodes = []
    for idx in range(3):
        video = ds / "videos" / "observation.images.front" / "chunk-000" / f"file-{idx:03d}.mp4"
        video.parent.mkdir(parents=True, exist_ok=True)
        video.write_bytes(f"fake-video-{idx}".encode())
        episodes.append(
            {
                "episode_index": idx,
                "tasks": ["Pick a cube"],
                "length": 30,
                "data/chunk_index": 0,
                "data/file_index": 0,
                "dataset_from_index": idx * 30,
                "dataset_to_index": (idx + 1) * 30,
                "meta/episodes/chunk_index": 0,
                "meta/episodes/file_index": 0,
                "videos/observation.images.front/chunk_index": 0,
                "videos/observation.images.front/file_index": idx,
                "videos/observation.images.front/from_timestamp": 0.0,
                "videos/observation.images.front/to_timestamp": 1.0,
            }
        )
    ep_path = ds / "meta" / "episodes" / "chunk-000" / "file-000.parquet"
    ep_path.parent.mkdir(parents=True)
    pd.DataFrame(episodes).to_parquet(ep_path, index=False)

    rows = []
    for ep in range(3):
        for frame in range(30):
            global_index = ep * 30 + frame
            rows.append(
                {
                    "index": global_index,
                    "episode_index": ep,
                    "frame_index": frame,
                    "timestamp": frame / 30,
                    "task_index": 0,
                    "observation.state": [float(ep), float(frame)],
                    "observation.images.front": None,
                }
            )
    data_path = ds / "data" / "chunk-000" / "file-000.parquet"
    data_path.parent.mkdir(parents=True)
    pd.DataFrame(rows).to_parquet(data_path, index=False)
    return ds


# --- sync status -----------------------------------------------------------
def test_sync_status_synced(client: TestClient, tmp_path: Path, monkeypatch) -> None:
    import lelab.dataset_detail as dd

    root = tmp_path / "lerobot"
    monkeypatch.setattr(dd, "HF_LEROBOT_HOME", root)
    _make_local_dataset(
        root,
        "u/synced",
        {
            "data/chunk-000/file-000.parquet": b"abc",
            "videos/observation.images.cam/chunk-000/file-000.mp4": b"xyz",
            "meta/info.json": b"{}",
        },
    )
    siblings = [
        _Sibling("data/chunk-000/file-000.parquet", 3),
        _Sibling("videos/observation.images.cam/chunk-000/file-000.mp4", 3),
        _Sibling("meta/info.json", 2),
        _Sibling("README.md", 100),  # ignored: not a sync prefix
    ]
    monkeypatch.setattr(dd, "shared_hf_api", lambda: _fake_api(siblings))

    body = client.post("/dataset-sync-status", json={"dataset_repo_id": "u/synced"}).json()
    assert body["on_hub"] is True
    assert body["needs_sync"] is False
    assert body["local_files"] == 3
    assert body["hub_files"] == 3


def test_sync_status_needs_sync(client: TestClient, tmp_path: Path, monkeypatch) -> None:
    import lelab.dataset_detail as dd

    root = tmp_path / "lerobot"
    monkeypatch.setattr(dd, "HF_LEROBOT_HOME", root)
    _make_local_dataset(
        root,
        "u/dirty",
        {"data/chunk-000/file-000.parquet": b"abcde", "meta/info.json": b"{}"},
    )
    siblings = [
        _Sibling("data/chunk-000/file-000.parquet", 3),  # size differs -> dirty
        _Sibling("meta/info.json", 2),
    ]
    monkeypatch.setattr(dd, "shared_hf_api", lambda: _fake_api(siblings))

    body = client.post("/dataset-sync-status", json={"dataset_repo_id": "u/dirty"}).json()
    assert body["on_hub"] is True
    assert body["needs_sync"] is True


def test_sync_status_not_on_hub(client: TestClient, tmp_path: Path, monkeypatch) -> None:
    import lelab.dataset_detail as dd

    root = tmp_path / "lerobot"
    monkeypatch.setattr(dd, "HF_LEROBOT_HOME", root)
    _make_local_dataset(root, "u/localonly", {"meta/info.json": b"{}"})
    response = httpx.Response(404, request=httpx.Request("GET", "https://huggingface.co"))
    not_found = RepositoryNotFoundError("nope", response=response)
    monkeypatch.setattr(dd, "shared_hf_api", lambda: _fake_api(None, raises=not_found))

    body = client.post("/dataset-sync-status", json={"dataset_repo_id": "u/localonly"}).json()
    assert body["on_hub"] is False
    assert body["needs_sync"] is True
    assert body["local_files"] == 1
    assert body["hub_files"] == 0


# --- episode listing -------------------------------------------------------
def test_list_episodes(client: TestClient, tmp_path: Path, monkeypatch) -> None:
    import lelab.dataset_detail as dd

    root = tmp_path / "lerobot"
    monkeypatch.setattr(dd, "HF_LEROBOT_HOME", root)
    _make_three_episode_dataset(root, "u/ds")

    body = client.post("/dataset-episodes", json={"dataset_repo_id": "u/ds"}).json()
    assert body["success"] is True
    assert body["fps"] == 30
    assert body["cameras"] == ["observation.images.front"]
    assert body["total"] == 3
    assert body["offset"] == 0
    assert body["limit"] is None
    assert body["has_more"] is False
    assert len(body["episodes"]) == 3
    ep0 = body["episodes"][0]
    assert ep0["index"] == 0
    assert ep0["frames"] == 30
    assert ep0["duration_s"] == 1.0
    assert ep0["cameras"] == ["observation.images.front"]
    # Each episode carries its [from, to] segment per camera (not the whole file).
    assert ep0["views"] == [{"camera": "observation.images.front", "from": 0.0, "to": 1.0}]
    assert body["episodes"][1]["duration_s"] == 1.0
    assert body["episodes"][1]["views"][0] == {
        "camera": "observation.images.front",
        "from": 0.0,
        "to": 1.0,
    }


def test_list_episodes_supports_paging(client: TestClient, tmp_path: Path, monkeypatch) -> None:
    import lelab.dataset_detail as dd

    root = tmp_path / "lerobot"
    monkeypatch.setattr(dd, "HF_LEROBOT_HOME", root)
    _make_three_episode_dataset(root, "u/ds")

    page = client.post(
        "/dataset-episodes", json={"dataset_repo_id": "u/ds", "offset": 1, "limit": 1}
    ).json()
    assert page["success"] is True
    assert page["total"] == 3
    assert page["offset"] == 1
    assert page["limit"] == 1
    assert page["has_more"] is True
    assert [ep["index"] for ep in page["episodes"]] == [1]

    last_page = client.post(
        "/dataset-episodes", json={"dataset_repo_id": "u/ds", "offset": 2, "limit": 2}
    ).json()
    assert last_page["success"] is True
    assert last_page["total"] == 3
    assert last_page["has_more"] is False
    assert [ep["index"] for ep in last_page["episodes"]] == [2]


def test_import_dataset_downloads_into_cache(client: TestClient, tmp_path: Path, monkeypatch) -> None:
    import lelab.dataset_detail as dd

    root = tmp_path / "lerobot"
    monkeypatch.setattr(dd, "HF_LEROBOT_HOME", root)
    called = {}

    def fake_snapshot(repo_id, repo_type=None, local_dir=None):
        called["repo_id"] = repo_id
        called["repo_type"] = repo_type
        called["local_dir"] = local_dir
        return local_dir

    monkeypatch.setattr("huggingface_hub.snapshot_download", fake_snapshot)

    body = client.post("/import-dataset", json={"dataset_repo_id": "u/hubset"}).json()
    assert body["success"] is True
    assert called["repo_id"] == "u/hubset"
    assert called["repo_type"] == "dataset"
    assert called["local_dir"].endswith("hubset")


def test_list_episodes_missing_dataset(client: TestClient, monkeypatch) -> None:
    import lelab.dataset_detail as dd

    def _missing(_repo_id):
        raise FileNotFoundError("no local dataset")

    monkeypatch.setattr(dd, "_load_meta", _missing)
    body = client.post("/dataset-episodes", json={"dataset_repo_id": "u/gone"}).json()
    assert body["success"] is False
    assert body["episodes"] == []


def test_load_meta_uses_valid_imports(tmp_path: Path, monkeypatch) -> None:
    """A missing dataset must raise FileNotFoundError — not ImportError from a
    stale internal LeRobot import path (regression: load_episodes moved modules)."""
    import lelab.dataset_detail as dd

    monkeypatch.setattr(dd, "HF_LEROBOT_HOME", tmp_path)
    with pytest.raises(FileNotFoundError):
        dd._load_meta("u/does-not-exist")


def test_dataset_single_task_resolves_from_tasks() -> None:
    from lelab.record import _dataset_single_task

    class TasksDF:  # mimics meta.tasks (DataFrame indexed by task string)
        index = ["Move an item", "Other"]

    assert _dataset_single_task(type("M", (), {"tasks": TasksDF()})()) == "Move an item"
    assert _dataset_single_task(type("M", (), {"single_task": "pick up"})()) == "pick up"
    assert _dataset_single_task(type("M", (), {})()) == "Unknown task"


# --- episode video ---------------------------------------------------------
def test_episode_video_full_and_range(client: TestClient, tmp_path: Path, monkeypatch) -> None:
    import lelab.server as server

    mp4 = tmp_path / "ep.mp4"
    payload = bytes(range(256)) * 4  # 1024 bytes
    mp4.write_bytes(payload)
    monkeypatch.setattr(server, "resolve_episode_video", lambda repo_id, episode, camera: mp4)

    params = {"repo_id": "u/ds", "episode": 0, "camera": "observation.images.front"}

    full = client.get("/dataset-episode-video", params=params)
    assert full.status_code == 200
    assert full.headers["accept-ranges"] == "bytes"
    assert full.content == payload

    partial = client.get("/dataset-episode-video", params=params, headers={"Range": "bytes=0-99"})
    assert partial.status_code == 206
    assert partial.headers["content-range"] == f"bytes 0-99/{len(payload)}"
    assert partial.headers["accept-ranges"] == "bytes"
    assert partial.content == payload[:100]


def test_episode_video_404_when_missing(client: TestClient, monkeypatch) -> None:
    import lelab.server as server

    def _raise(*_a, **_k):
        raise FileNotFoundError("nope")

    monkeypatch.setattr(server, "resolve_episode_video", _raise)
    r = client.get(
        "/dataset-episode-video",
        params={"repo_id": "u/x", "episode": 9, "camera": "c"},
    )
    assert r.status_code == 404


# --- episode delete --------------------------------------------------------
def test_delete_episode_rewrites_middle_episode_and_training_selection(
    client: TestClient, tmp_path: Path, monkeypatch
) -> None:
    import lelab.dataset_detail as dd
    import lerobot.utils.constants as constants
    from lelab.train import TrainingRequest, build_training_command

    root = tmp_path / "lerobot"
    monkeypatch.setattr(dd, "HF_LEROBOT_HOME", root)
    monkeypatch.setattr(constants, "HF_LEROBOT_HOME", root)
    ds = _make_three_episode_dataset(root, "u/clean")

    body = client.post("/delete-episode", json={"dataset_repo_id": "u/clean", "episode_index": 1}).json()
    assert body["success"] is True
    assert body["deleted_episode"] == 1
    assert body["num_episodes"] == 2
    assert body["total_frames"] == 60

    info = client.post("/dataset-info", json={"dataset_repo_id": "u/clean"}).json()
    assert info["success"] is True
    assert info["num_episodes"] == 2
    assert info["total_frames"] == 60

    episodes = client.post("/dataset-episodes", json={"dataset_repo_id": "u/clean"}).json()
    assert episodes["success"] is True
    assert [ep["index"] for ep in episodes["episodes"]] == [0, 1]
    assert [ep["frames"] for ep in episodes["episodes"]] == [30, 30]

    data = pd.read_parquet(ds / "data" / "chunk-000" / "file-000.parquet")
    assert data["episode_index"].tolist() == [0] * 30 + [1] * 30
    assert data["index"].tolist() == list(range(60))
    assert data.groupby("episode_index")["frame_index"].apply(list).to_dict() == {
        0: list(range(30)),
        1: list(range(30)),
    }
    assert list(data[data["episode_index"] == 1]["observation.state"].iloc[0]) == [2.0, 0.0]

    ep_meta = pd.read_parquet(ds / "meta" / "episodes" / "chunk-000" / "file-000.parquet")
    assert ep_meta["episode_index"].tolist() == [0, 1]
    assert ep_meta["dataset_from_index"].tolist() == [0, 30]
    assert ep_meta["dataset_to_index"].tolist() == [30, 60]
    assert ep_meta["videos/observation.images.front/file_index"].tolist() == [0, 1]

    assert not (ds / "videos" / "observation.images.front" / "chunk-000" / "file-002.mp4").exists()
    assert (ds / "videos" / "observation.images.front" / "chunk-000" / "file-000.mp4").read_bytes() == b"fake-video-0"
    assert (ds / "videos" / "observation.images.front" / "chunk-000" / "file-001.mp4").read_bytes() == b"fake-video-2"

    video = client.get(
        "/dataset-episode-video",
        params={"repo_id": "u/clean", "episode": 1, "camera": "observation.images.front"},
    )
    assert video.status_code == 200
    assert video.content == b"fake-video-2"

    cmd = build_training_command(
        TrainingRequest(dataset_repo_id="u/clean", dataset_episodes=[0, 1], policy_type="fake_policy"),
        output_dir="/tmp/fake-policy",
        python_executable="python",
    )
    idx = cmd.index("--dataset.episodes")
    assert cmd[idx + 1 : idx + 3] == ["0", "1"]
    assert "2" not in cmd[idx + 1 : idx + 3]


def test_delete_episode_rejects_bad_inputs_without_mutation(
    client: TestClient, tmp_path: Path, monkeypatch
) -> None:
    import lelab.dataset_detail as dd
    import lerobot.utils.constants as constants

    root = tmp_path / "lerobot"
    monkeypatch.setattr(dd, "HF_LEROBOT_HOME", root)
    monkeypatch.setattr(constants, "HF_LEROBOT_HOME", root)
    ds = _make_three_episode_dataset(root, "u/clean")
    before = (ds / "meta" / "info.json").read_bytes()

    out_of_range = client.post(
        "/delete-episode", json={"dataset_repo_id": "u/clean", "episode_index": 9}
    ).json()
    assert out_of_range["success"] is False
    assert (ds / "meta" / "info.json").read_bytes() == before

    traversal = client.post(
        "/delete-episode", json={"dataset_repo_id": "../outside", "episode_index": 0}
    ).json()
    assert traversal["success"] is False
    assert not (root.parent / "outside").exists()


def test_episode_stats_reshaped_for_aggregate_with_image_features() -> None:
    """Regression: episode stats from the parquet come back as object arrays with
    image stats flattened to (C,). aggregate_stats needs (C,1,1) float for any
    feature whose key contains "image" and (1,) for count, so deleting an episode
    from a dataset *with cameras* used to crash. _episode_stats must reshape/cast."""
    import numpy as np

    from lelab.dataset_detail import _episode_stats
    from lerobot.datasets.compute_stats import aggregate_stats

    def _row(count: int) -> dict:
        # dtype=object mirrors how pandas/pyarrow hands these back from parquet.
        return {
            "stats/observation.images.front/min": np.array([0.0, 0.1, 0.2], dtype=object),
            "stats/observation.images.front/max": np.array([0.9, 0.8, 1.0], dtype=object),
            "stats/observation.images.front/mean": np.array([0.5, 0.4, 0.6], dtype=object),
            "stats/observation.images.front/std": np.array([0.1, 0.1, 0.1], dtype=object),
            "stats/observation.images.front/count": np.array([count], dtype=object),
            "stats/observation.state/min": np.array([0.0, 0.0], dtype=object),
            "stats/observation.state/max": np.array([1.0, 1.0], dtype=object),
            "stats/observation.state/mean": np.array([0.5, 0.5], dtype=object),
            "stats/observation.state/std": np.array([0.1, 0.1], dtype=object),
            "stats/observation.state/count": np.array([count], dtype=object),
        }

    s = _episode_stats(_row(30))
    assert s["observation.images.front"]["min"].shape == (3, 1, 1)
    assert s["observation.images.front"]["min"].dtype == np.float64
    assert s["observation.images.front"]["count"].shape == (1,)
    assert s["observation.state"]["mean"].shape == (2,)

    # Would raise (shape, then sqrt-on-object) without the reshape + float cast.
    agg = aggregate_stats([_episode_stats(_row(30)), _episode_stats(_row(20))])
    assert agg["observation.images.front"]["mean"].shape == (3, 1, 1)
    assert agg["observation.state"]["mean"].shape == (2,)


def test_retry_io_retries_on_transient_lock_then_succeeds() -> None:
    from lelab.dataset_detail import _retry_io

    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise PermissionError("WinError 32: file in use")
        return "ok"

    assert _retry_io(flaky, attempts=5, delay=0) == "ok"
    assert calls["n"] == 3


def test_retry_io_reraises_after_exhausting_attempts() -> None:
    from lelab.dataset_detail import _retry_io

    def always_locked():
        raise PermissionError("WinError 32")

    with pytest.raises(PermissionError):
        _retry_io(always_locked, attempts=2, delay=0)
