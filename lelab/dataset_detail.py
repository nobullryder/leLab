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

"""Dataset detail backend: Hub sync status, per-episode listing, and Range-aware
per-episode video streaming.

Every on-disk path is resolved through the LeRobot dataset/meta API and then
guarded to stay strictly inside the dataset's own directory — we never hand-build
``data/chunk-*`` / ``videos/...`` layouts (those drift between pinned LeRobot SHAs).
"""

import contextlib
import gc
import logging
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any

from fastapi.responses import FileResponse, Response, StreamingResponse
from huggingface_hub.errors import RepositoryNotFoundError
from pydantic import BaseModel, Field

from lerobot.utils.constants import HF_LEROBOT_HOME

from .record import DatasetInfoRequest
from .utils.hf_auth import shared_hf_api

logger = logging.getLogger(__name__)

# File prefixes that make up a dataset's syncable content.
_SYNC_PREFIXES = ("data/", "videos/", "meta/")


class DeleteEpisodeRequest(BaseModel):
    dataset_repo_id: str
    episode_index: int = Field(ge=0)


class DatasetEpisodesRequest(BaseModel):
    dataset_repo_id: str
    offset: int = Field(default=0, ge=0)
    limit: int | None = Field(default=None, ge=1, le=200)


def _dataset_root(repo_id: str) -> Path:
    """Absolute dataset directory, guarded to stay strictly inside HF_LEROBOT_HOME.

    Raises ValueError on any path-traversal attempt.
    """
    root = Path(HF_LEROBOT_HOME).resolve()
    target = (root / repo_id).resolve()
    if target == root or root not in target.parents:
        raise ValueError("Invalid dataset path")
    return target


# ---------------------------------------------------------------------------
# Sync status
# ---------------------------------------------------------------------------
def _local_manifest(root: Path) -> dict[str, int]:
    """{relative posix path: size} for every file under data/ videos/ meta/."""
    manifest: dict[str, int] = {}
    for prefix in _SYNC_PREFIXES:
        base = root / prefix.rstrip("/")
        if not base.is_dir():
            continue
        for path in base.rglob("*"):
            if path.is_file():
                manifest[path.relative_to(root).as_posix()] = path.stat().st_size
    return manifest


def handle_dataset_sync_status(request: DatasetInfoRequest) -> dict[str, Any]:
    """Detect unsynced local changes by diffing the local file manifest vs the Hub's."""
    repo_id = request.dataset_repo_id
    try:
        local_root = _dataset_root(repo_id)
    except ValueError:
        return {"on_hub": False, "needs_sync": False, "local_files": 0, "hub_files": 0}

    local = _local_manifest(local_root) if local_root.exists() else {}

    api = shared_hf_api()
    try:
        info = api.dataset_info(repo_id, files_metadata=True)
    except RepositoryNotFoundError:
        return {"on_hub": False, "needs_sync": bool(local), "local_files": len(local), "hub_files": 0}
    except Exception as e:  # network / auth — treat as "not confirmed on hub"
        logger.warning(f"Hub sync check failed for {repo_id}: {e}")
        return {
            "on_hub": False,
            "needs_sync": bool(local),
            "local_files": len(local),
            "hub_files": 0,
            "error": str(e),
        }

    hub = {s.rfilename: s.size for s in info.siblings if s.rfilename.startswith(_SYNC_PREFIXES)}
    return {
        "on_hub": True,
        "needs_sync": local != hub,
        "local_files": len(local),
        "hub_files": len(hub),
    }


# ---------------------------------------------------------------------------
# Episode listing
# ---------------------------------------------------------------------------
def _load_meta(repo_id: str):
    """Load a LOCAL dataset's metadata via the LeRobot meta API (no Hub download).

    ``LeRobotDatasetMetadata.__init__`` populates ``meta.episodes`` itself, so we
    don't reach into LeRobot's internals to (re)load them.
    """
    from lerobot.datasets.dataset_metadata import LeRobotDatasetMetadata

    root = _dataset_root(repo_id)
    if not (root / "meta" / "info.json").is_file():
        raise FileNotFoundError(f"No local dataset at {root}")
    return LeRobotDatasetMetadata(repo_id, root=root)


def _episode_length(meta, idx: int) -> int:
    """Per-episode frame count; tolerant of scalar vs single-element array storage."""
    ep = meta.episodes[idx]
    length = ep["length"]
    if isinstance(length, (list, tuple)):
        length = length[0]
    try:
        return int(length)
    except (TypeError, ValueError):
        return 0


def _ts(ep, cam: str, which: str) -> float:
    """Scalar from/to video timestamp for one episode's camera segment.

    Episodes share a (possibly multi-episode) video file, so each carries the
    [from, to] window inside it; the player clips to that window.
    """
    v = ep.get(f"videos/{cam}/{which}_timestamp")
    if isinstance(v, (list, tuple)):
        v = v[0] if v else None
    try:
        return round(float(v), 3)
    except (TypeError, ValueError):
        return 0.0


def handle_list_episodes(request: DatasetEpisodesRequest) -> dict[str, Any]:
    """List a local dataset's episodes with frame counts, durations, and per-camera
    video segments (so the player shows only that episode, not the whole file)."""
    repo_id = request.dataset_repo_id
    try:
        from lerobot.datasets.io_utils import load_info

        root = _dataset_root(repo_id)
        if not (root / "meta" / "info.json").is_file():
            raise FileNotFoundError(f"No local dataset at {root}")
        info = load_info(root)
        episode_rows = _read_episode_rows(root).to_dict("records")
    except (ValueError, FileNotFoundError) as e:
        return {
            "success": False,
            "message": str(e),
            "episodes": [],
            "cameras": [],
            "fps": 0,
            "total": 0,
            "offset": request.offset,
            "limit": request.limit,
            "has_more": False,
        }

    fps = int(info.fps) if info.fps else 0
    cameras = [key for key, feature in info.features.items() if feature.get("dtype") == "video"]
    sorted_rows = sorted(episode_rows, key=lambda row: int(row["episode_index"]))
    total = len(sorted_rows)
    if request.limit is None:
        page_rows = sorted_rows[request.offset :]
    else:
        page_rows = sorted_rows[request.offset : request.offset + request.limit]

    episodes = []
    for ep in page_rows:
        i = int(ep["episode_index"])
        frames = int(ep["length"])
        views = [
            {"camera": cam, "from": _ts(ep, cam, "from"), "to": _ts(ep, cam, "to")}
            for cam in cameras
        ]
        episodes.append(
            {
                "index": i,
                "frames": frames,
                "duration_s": round(frames / fps, 2) if fps else 0.0,
                "cameras": cameras,
                "views": views,
            }
        )
    returned_until = request.offset + len(page_rows)
    return {
        "success": True,
        "episodes": episodes,
        "cameras": cameras,
        "fps": fps,
        "total": total,
        "offset": request.offset,
        "limit": request.limit,
        "has_more": returned_until < total,
    }


# ---------------------------------------------------------------------------
# Episode delete / rewrite
# ---------------------------------------------------------------------------
def _guard_child(root: Path, path: Path) -> Path:
    resolved = path.resolve()
    if resolved != root and root not in resolved.parents:
        raise ValueError("Invalid dataset path")
    return resolved


def _read_episode_rows(root: Path):
    import pandas as pd

    episode_paths = sorted((root / "meta" / "episodes").glob("chunk-*/*.parquet"))
    if not episode_paths:
        raise FileNotFoundError("Dataset has no episode metadata")
    frames = [pd.read_parquet(path) for path in episode_paths]
    episodes = pd.concat(frames, ignore_index=True)
    if "episode_index" not in episodes.columns:
        raise ValueError("Episode metadata is missing episode_index")
    return episodes.sort_values("episode_index").reset_index(drop=True)


def _read_data_rows(root: Path, data_path_template: str, episodes):
    import pandas as pd

    data_paths: list[Path] = []
    seen: set[Path] = set()
    for row in episodes.to_dict("records"):
        try:
            path = root / data_path_template.format(
                chunk_index=int(row["data/chunk_index"]),
                file_index=int(row["data/file_index"]),
            )
        except KeyError as exc:
            raise ValueError("Episode metadata is missing data file references") from exc
        path = _guard_child(root, path)
        if path not in seen:
            if not path.is_file():
                raise FileNotFoundError(f"Missing data parquet: {path}")
            seen.add(path)
            data_paths.append(path)
    return pd.concat([pd.read_parquet(path) for path in data_paths], ignore_index=True)


def _write_parquet(df, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        df = df.convert_dtypes(dtype_backend="pyarrow")
    except TypeError:
        df = df.convert_dtypes()
    df.to_parquet(path, index=False)


def _copy_or_clip_video(
    source: Path,
    dest: Path,
    *,
    start_s: float,
    end_s: float,
    must_clip: bool,
) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not must_clip:
        shutil.copy2(source, dest)
        return

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError(
            "Deleting this episode requires clipping a shared video file, but ffmpeg was not found."
        )
    duration = max(0.0, end_s - start_s)
    if duration <= 0:
        raise ValueError("Episode video segment has an invalid duration")
    tmp = dest.with_suffix(dest.suffix + ".tmp.mp4")
    cmd = [
        ffmpeg,
        "-y",
        "-ss",
        f"{start_s:.6f}",
        "-t",
        f"{duration:.6f}",
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-an",
        "-c",
        "copy",
        str(tmp),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=False)
    if result.returncode != 0:
        if tmp.exists():
            tmp.unlink()
        raise RuntimeError(f"ffmpeg failed while clipping episode video: {result.stderr.strip()}")
    tmp.replace(dest)


def _is_missing(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, float):
        return value != value
    try:
        import numpy as np

        arr = np.asarray(value)
        if arr.size != 1:
            return False
        return bool(np.isnan(arr.reshape(-1)[0]))
    except (TypeError, ValueError):
        return False


def _episode_stats(row: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Per-episode stats from the episode parquet, reshaped to what
    ``aggregate_stats`` expects.

    LeRobot flattens stats when writing the episode parquet, so image/video
    per-channel stats read back as ``(C,)`` and ``count`` as a scalar — but
    ``aggregate_stats`` requires ``(C, 1, 1)`` for any feature whose key contains
    "image" (every key but ``count``) and ``(1,)`` for ``count``. Restore those
    shapes here, or the rewrite raises a shape error on any dataset with cameras.
    """
    import numpy as np

    stats: dict[str, dict[str, Any]] = {}
    for key, value in row.items():
        if not key.startswith("stats/") or _is_missing(value):
            continue
        try:
            _, feature_key, stat_key = key.split("/", 2)
        except ValueError:
            continue
        # Cast to float64 — parquet hands these back as object arrays, which
        # break the float ufuncs (np.sqrt) inside aggregate_stats.
        arr = np.asarray(value, dtype=np.float64)
        if stat_key == "count":
            arr = arr.reshape(-1)[:1]  # (1,)
        elif "image" in feature_key:
            arr = arr.reshape(-1, 1, 1)  # (C, 1, 1) per channel
        else:
            arr = arr.reshape(-1)  # (D,) vector features
        stats.setdefault(feature_key, {})[stat_key] = arr
    return stats


def _rewrite_stats(temp_root: Path, kept_rows: list[dict[str, Any]]) -> None:
    from lerobot.datasets.compute_stats import aggregate_stats
    from lerobot.datasets.io_utils import write_stats

    stats_list = [stats for row in kept_rows if (stats := _episode_stats(row))]
    stats_path = temp_root / "meta" / "stats.json"
    if not stats_list:
        if stats_path.exists():
            stats_path.unlink()
        return
    write_stats(aggregate_stats(stats_list), temp_root)


def _rewrite_dataset_copy(temp_root: Path, original_root: Path, episode_index: int) -> dict[str, Any]:
    from lerobot.datasets.io_utils import load_info, write_info

    info = load_info(temp_root)
    video_keys = [key for key, feature in info.features.items() if feature.get("dtype") == "video"]
    episodes = _read_episode_rows(original_root)
    if episode_index not in {int(v) for v in episodes["episode_index"].tolist()}:
        raise IndexError(f"Episode {episode_index} out of range")
    if len(episodes) <= 1:
        raise ValueError("Cannot delete the only episode; delete the dataset instead.")

    data_rows = _read_data_rows(original_root, info.data_path, episodes)
    kept_old_indexes = [
        int(v) for v in episodes["episode_index"].tolist() if int(v) != episode_index
    ]
    old_to_new = {old: new for new, old in enumerate(kept_old_indexes)}

    # Rewrite mutable dataset content from scratch inside the already-copied temp tree.
    for rel in ("data", "videos", "meta/episodes"):
        target = temp_root / rel
        if target.exists():
            shutil.rmtree(target)

    data_rows = data_rows[data_rows["episode_index"] != episode_index].copy()
    data_rows["episode_index"] = data_rows["episode_index"].map(old_to_new).astype("int64")
    data_rows = data_rows.sort_values(["episode_index", "frame_index", "index"], ignore_index=True)
    data_rows["index"] = range(len(data_rows))
    if "frame_index" in data_rows.columns:
        data_rows["frame_index"] = data_rows.groupby("episode_index").cumcount()
    data_path = temp_root / info.data_path.format(chunk_index=0, file_index=0)
    _write_parquet(data_rows, data_path)

    source_counts: dict[tuple[str, Path], int] = {}
    for row in episodes.to_dict("records"):
        for video_key in video_keys:
            source = original_root / info.video_path.format(
                video_key=video_key,
                chunk_index=int(row[f"videos/{video_key}/chunk_index"]),
                file_index=int(row[f"videos/{video_key}/file_index"]),
            )
            source = _guard_child(original_root, source)
            source_counts[(video_key, source)] = source_counts.get((video_key, source), 0) + 1

    kept_rows: list[dict[str, Any]] = []
    running_frames = 0
    for old_index in kept_old_indexes:
        row = episodes[episodes["episode_index"] == old_index].iloc[0].to_dict()
        new_index = old_to_new[old_index]
        length = int(row["length"])
        row["episode_index"] = new_index
        row["dataset_from_index"] = running_frames
        row["dataset_to_index"] = running_frames + length
        row["data/chunk_index"] = 0
        row["data/file_index"] = 0
        row["meta/episodes/chunk_index"] = 0
        row["meta/episodes/file_index"] = 0
        running_frames += length

        for video_key in video_keys:
            source = original_root / info.video_path.format(
                video_key=video_key,
                chunk_index=int(row[f"videos/{video_key}/chunk_index"]),
                file_index=int(row[f"videos/{video_key}/file_index"]),
            )
            source = _guard_child(original_root, source)
            if not source.is_file():
                raise FileNotFoundError(f"Missing video file: {source}")

            start_s = float(row.get(f"videos/{video_key}/from_timestamp", 0.0) or 0.0)
            end_s = float(row.get(f"videos/{video_key}/to_timestamp", 0.0) or 0.0)
            must_clip = source_counts[(video_key, source)] > 1 or start_s > 0.001
            dest = temp_root / info.video_path.format(
                video_key=video_key, chunk_index=0, file_index=new_index
            )
            _copy_or_clip_video(source, dest, start_s=start_s, end_s=end_s, must_clip=must_clip)
            row[f"videos/{video_key}/chunk_index"] = 0
            row[f"videos/{video_key}/file_index"] = new_index
            if end_s > start_s:
                row[f"videos/{video_key}/from_timestamp"] = 0.0
                row[f"videos/{video_key}/to_timestamp"] = round(end_s - start_s, 3)

        kept_rows.append(row)

    import pandas as pd

    episodes_out = pd.DataFrame(kept_rows)
    _write_parquet(episodes_out, temp_root / "meta" / "episodes" / "chunk-000" / "file-000.parquet")

    info.total_episodes = len(kept_rows)
    info.total_frames = int(running_frames)
    info.splits = {"train": f"0:{len(kept_rows)}"}
    write_info(info, temp_root)
    _rewrite_stats(temp_root, kept_rows)

    return {
        "deleted_episode": episode_index,
        "num_episodes": len(kept_rows),
        "total_frames": int(running_frames),
    }


def _retry_io(fn, *, attempts: int = 30, delay: float = 0.2):
    """Retry a filesystem op that briefly fails because a file is still locked.

    On Windows a video just served to the player can keep the .mp4 open for a
    moment after the HTTP response ends, so swapping/removing it raises
    ``PermissionError`` (WinError 32). Retry with a GC + short backoff so the
    handle has time to release.
    """
    import time

    for attempt in range(attempts):
        try:
            return fn()
        except PermissionError:
            if attempt == attempts - 1:
                raise
            gc.collect()
            time.sleep(delay)


def _copy_path(src: Path, dest: Path) -> None:
    if src.is_dir():
        shutil.copytree(src, dest)
    elif src.is_file():
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)


def _remove_path(path: Path) -> None:
    def _do() -> None:
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()

    _retry_io(_do)


def _replace_mutable_dataset_paths(root: Path, temp_root: Path, backup_root: Path) -> None:
    mutable = [
        Path("data"),
        Path("videos"),
        Path("meta") / "episodes",
        Path("meta") / "info.json",
        Path("meta") / "stats.json",
    ]
    backup_root.mkdir(parents=True, exist_ok=False)
    replaced: list[Path] = []
    try:
        for rel in mutable:
            src = root / rel
            backup = backup_root / rel
            new_src = temp_root / rel
            if src.exists():
                _copy_path(src, backup)
            _remove_path(src)
            if new_src.exists():
                _copy_path(new_src, src)
            replaced.append(rel)
    except Exception:
        for rel in reversed(replaced):
            src = root / rel
            backup = backup_root / rel
            with contextlib.suppress(Exception):
                _remove_path(src)
            if backup.exists():
                _copy_path(backup, src)
        raise
    finally:
        shutil.rmtree(backup_root, ignore_errors=True)


def delete_episode_from_local_dataset(repo_id: str, episode_index: int) -> dict[str, Any]:
    root = _dataset_root(repo_id)
    if not (root / "meta" / "info.json").is_file():
        raise FileNotFoundError(f"Dataset {repo_id} not found locally")

    suffix = uuid.uuid4().hex[:10]
    temp_root = root.with_name(f".{root.name}.delete-episode-{suffix}")
    backup_root = root.with_name(f".{root.name}.backup-{suffix}")

    try:
        shutil.copytree(root, temp_root)
        result = _rewrite_dataset_copy(temp_root, root, episode_index)
        gc.collect()
        try:
            _retry_io(lambda: root.rename(backup_root))
        except OSError as exc:
            logger.info("Dataset root swap failed; replacing mutable paths instead: %s", exc)
            _replace_mutable_dataset_paths(root, temp_root, backup_root)
            return result
        try:
            temp_root.rename(root)
        except Exception:
            if root.exists():
                shutil.rmtree(root)
            backup_root.rename(root)
            raise
        shutil.rmtree(backup_root)
        return result
    finally:
        if temp_root.exists():
            shutil.rmtree(temp_root, ignore_errors=True)


def handle_delete_episode(request: DeleteEpisodeRequest) -> dict[str, Any]:
    try:
        result = delete_episode_from_local_dataset(request.dataset_repo_id, request.episode_index)
    except (ValueError, IndexError, FileNotFoundError) as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        logger.exception("Failed to delete episode")
        return {"success": False, "message": f"Failed to delete episode: {e}"}
    return {"success": True, "message": "Episode deleted", **result}


# ---------------------------------------------------------------------------
# Episode video streaming
# ---------------------------------------------------------------------------
def resolve_episode_video(repo_id: str, episode: int, camera: str) -> Path:
    """Absolute, guarded path to one episode's MP4, resolved from local metadata."""
    from lerobot.datasets.io_utils import load_info

    root = _dataset_root(repo_id)
    info = load_info(root)
    video_keys = [key for key, feature in info.features.items() if feature.get("dtype") == "video"]
    if camera not in video_keys:
        raise FileNotFoundError(f"Unknown camera {camera!r}")
    episodes = _read_episode_rows(root)
    if episode < 0 or episode not in {int(v) for v in episodes["episode_index"].tolist()}:
        raise FileNotFoundError(f"Episode {episode} out of range")

    row = episodes[episodes["episode_index"] == episode].iloc[0].to_dict()
    rel = info.video_path.format(
        video_key=camera,
        chunk_index=int(row[f"videos/{camera}/chunk_index"]),
        file_index=int(row[f"videos/{camera}/file_index"]),
    )
    abs_path = (root / rel).resolve()
    if root not in abs_path.parents:
        raise ValueError("Invalid video path")
    if not abs_path.is_file():
        raise FileNotFoundError(f"Video missing: {abs_path}")
    return abs_path


def range_response(path: Path, range_header: str | None):
    """Serve an MP4, honoring a single HTTP Range request (206 + Content-Range)."""
    size = path.stat().st_size
    headers = {"Accept-Ranges": "bytes"}

    if not range_header or not range_header.startswith("bytes="):
        return FileResponse(str(path), media_type="video/mp4", headers=headers)

    first = range_header.removeprefix("bytes=").split(",")[0].strip()
    start_s, _, end_s = first.partition("-")
    try:
        start = int(start_s) if start_s else 0
        end = int(end_s) if end_s else size - 1
    except ValueError:
        return FileResponse(str(path), media_type="video/mp4", headers=headers)

    start = max(0, start)
    end = min(end, size - 1)
    if start > end:
        return Response(status_code=416, headers={**headers, "Content-Range": f"bytes */{size}"})

    length = end - start + 1

    def _iter(chunk: int = 64 * 1024):
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                data = f.read(min(chunk, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data

    return StreamingResponse(
        _iter(),
        status_code=206,
        media_type="video/mp4",
        headers={
            **headers,
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(length),
        },
    )


# ---------------------------------------------------------------------------
# Import a Hub dataset into the local cache
# ---------------------------------------------------------------------------
def handle_import_dataset(request: DatasetInfoRequest) -> dict[str, Any]:
    """Download a Hub dataset into the local LeRobot cache so it can be opened and
    its episodes played in-app. Blocking — large datasets take a while."""
    from huggingface_hub import snapshot_download

    repo_id = request.dataset_repo_id
    try:
        local_root = _dataset_root(repo_id)
    except ValueError:
        return {"success": False, "message": "Invalid dataset id"}

    try:
        snapshot_download(repo_id, repo_type="dataset", local_dir=str(local_root))
    except Exception as e:
        logger.error(f"Import failed for {repo_id}: {e}")
        return {"success": False, "message": f"Import failed: {e}"}

    return {"success": True, "message": f"Imported {repo_id}"}
