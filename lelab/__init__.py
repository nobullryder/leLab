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
"""LeLab — FastAPI + React web interface around the LeRobot framework."""

import sys

# Windows + Python 3.13 + torch: importing torch calls platform.machine(), which
# routes through platform._win32_ver() -> platform._wmi_query(). That WMI query
# can block for minutes — or hang outright — on busy Windows systems, freezing
# `lelab` at "Starting LeLab ..." before the server ever binds its port (the
# import of lelab.server pulls in lerobot -> torch). platform._win32_ver()
# already falls back to a fast, WMI-free path (sys.getwindowsversion() + the
# registry) when the query raises OSError, so force the query to fail fast.
# This must run before torch/lerobot are imported, which is guaranteed here:
# importing any lelab submodule imports this package first.
if sys.platform == "win32":
    import platform as _platform

    def _wmi_query_fail_fast(*_args, **_kwargs):
        raise OSError("WMI query disabled by LeLab to avoid a torch-import hang on Windows")

    if hasattr(_platform, "_wmi_query"):
        _platform._wmi_query = _wmi_query_fail_fast

from lelab.__version__ import __version__

__all__ = ["__version__"]
