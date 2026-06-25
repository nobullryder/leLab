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

"""Training subprocess patches loaded by Python's sitecustomize hook.

Windows often denies symlink creation unless Developer Mode or elevated
privileges are enabled. LeRobot writes checkpoints successfully and then calls
update_last_checkpoint(), which normally creates a `checkpoints/last` symlink.
If that symlink fails with WinError 1314, training aborts after the checkpoint.

LeLab launches local training with this directory prepended to PYTHONPATH so the
patch applies only to the training subprocess, not to the parent API server.
"""

from __future__ import annotations

import errno
import os
import shutil
from pathlib import Path


def _patch_lerobot_last_checkpoint() -> None:
    try:
        from lerobot.common import train_utils
    except Exception:
        return

    original = train_utils.update_last_checkpoint

    def update_last_checkpoint(checkpoint_dir: Path) -> Path | None:
        checkpoint_dir = Path(checkpoint_dir)
        last_checkpoint_dir = checkpoint_dir.parent / train_utils.LAST_CHECKPOINT_LINK
        try:
            if last_checkpoint_dir.exists() and not last_checkpoint_dir.is_symlink():
                shutil.rmtree(last_checkpoint_dir)
            return original(checkpoint_dir)
        except OSError as exc:
            winerror = getattr(exc, "winerror", None)
            if winerror != 1314 and exc.errno not in {errno.EPERM, errno.EACCES, errno.EEXIST}:
                raise

            if last_checkpoint_dir.exists() or last_checkpoint_dir.is_symlink():
                if last_checkpoint_dir.is_dir() and not last_checkpoint_dir.is_symlink():
                    shutil.rmtree(last_checkpoint_dir)
                else:
                    last_checkpoint_dir.unlink()
            shutil.copytree(checkpoint_dir, last_checkpoint_dir)
            return last_checkpoint_dir

    train_utils.update_last_checkpoint = update_last_checkpoint


if os.name == "nt":
    _patch_lerobot_last_checkpoint()
