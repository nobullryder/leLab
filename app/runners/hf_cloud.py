"""HF Jobs runner — runs a training as an HF Jobs job on HuggingFace's GPUs.

Uses huggingface/lerobot-gpu:latest as the runtime image (lerobot pre-installed).
Tails logs via HfApi.fetch_job_logs and reuses the existing parse_metrics_into
parser since stdout format is identical to a local lerobot run.
"""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from queue import Empty, Queue
from typing import List, Optional

from huggingface_hub import HfApi, get_token

from ..jobs import LogLine, TrainingMetrics, parse_metrics_into
from ..training import TrainingRequest, build_training_command

logger = logging.getLogger(__name__)

LEROBOT_IMAGE = "huggingface/lerobot-gpu:latest"


class HfCloudJobRunner:
    """Run a training as an HF Jobs job. Single-shot — instantiate per job."""

    def __init__(
        self,
        metrics: TrainingMetrics,
        log_file_path: Path,
        flavor: str,
    ) -> None:
        self._metrics = metrics
        self._log_file_path = log_file_path
        self._flavor = flavor
        self._api = HfApi()
        self._hf_job_id: Optional[str] = None
        self._log_queue: "Queue[LogLine]" = Queue()
        self._tail_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._log_file = None  # type: ignore[assignment]
        # Cached terminal status once the job ends; None while live.
        self._terminal_status: Optional[str] = None

    def start(self, job_id: str, config: TrainingRequest, output_dir: str) -> None:
        if self._hf_job_id is not None:
            raise RuntimeError("HfCloudJobRunner already started")

        token = get_token()
        if not token:
            raise RuntimeError(
                "HF token not found. Run 'hf auth login' before launching cloud jobs."
            )

        whoami = self._api.whoami()
        username = whoami.get("name") if isinstance(whoami, dict) else None
        if not username:
            raise RuntimeError("Could not resolve HF username from whoami()")

        # Mutate the config so build_training_command emits the right flags.
        # The mutated config is what gets persisted in JobRecord.config, so
        # the historical record reflects what actually ran.
        config.policy_push_to_hub = True
        # job_id is already a unique slug like "act_dataset_2026-05-04_10-22-03".
        config.policy_repo_id = f"{username}/{job_id}"

        argv = build_training_command(config, output_dir)
        logger.info("Submitting HF Cloud job %s on %s: %s",
                    job_id, self._flavor, " ".join(argv))

        # Open the persistent log sink — same shape as LocalJobRunner.
        self._log_file_path.parent.mkdir(parents=True, exist_ok=True)
        self._log_file = self._log_file_path.open("a", buffering=1)

        job = self._api.run_job(
            image=LEROBOT_IMAGE,
            command=argv,
            flavor=self._flavor,
            environment={"HF_TOKEN": token},
        )
        self._hf_job_id = job.id

        # Log-tailing thread is started in Task 5.

    def stop(self) -> None:
        raise NotImplementedError("filled in Task 5")

    def is_running(self) -> bool:
        raise NotImplementedError("filled in Task 5")

    def returncode(self) -> Optional[int]:
        raise NotImplementedError("filled in Task 5")

    def stream_log_lines(self) -> List[LogLine]:
        out: List[LogLine] = []
        try:
            while True:
                out.append(self._log_queue.get_nowait())
        except Empty:
            pass
        return out

    def hf_job_id(self) -> Optional[str]:
        return self._hf_job_id
