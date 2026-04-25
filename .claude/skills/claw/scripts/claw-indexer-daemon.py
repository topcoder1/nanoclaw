#!/usr/bin/env python3
"""
claw-indexer-daemon — background filesystem watcher for the second-brain.

Reads ~/.claw/repos.yaml, watches every tracked repo path, and triggers
`claw sync --code` whenever a file under one of those paths changes.

Two modes, picked at startup:

1. fswatch mode — preferred. Spawns `fswatch -o --batch-marker -l 5` over
   all repo roots so we get one event per debounced batch (5s window).
   Each batch triggers a single sync; the content-hash incremental sync
   (v1.3a) makes the work cheap.

2. Polling mode — fallback when `fswatch` isn't on PATH. Runs `claw sync`
   every POLL_INTERVAL_SECS. Higher latency but zero dependencies.

Designed to run under launchctl as `com.claw.code-indexer`. Stays out of
the nanoclaw process tree on purpose: nanoclaw restarts on every code
change; the indexer should be stable.
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Resolve sibling `claw` script regardless of how this daemon was invoked.
_HERE = Path(__file__).resolve().parent
_CLAW = _HERE / "claw"

# Polling fallback interval. Five minutes is a tolerable latency floor when
# fswatch is missing — the user can install fswatch to drop it to seconds.
POLL_INTERVAL_SECS = 300

# Debounce window passed to fswatch. Edits saved within this many seconds
# of each other coalesce into one event, so a multi-file save (e.g. a
# refactor) triggers a single sync instead of a thundering herd.
FSWATCH_BATCH_SECS = 5

_REPOS_YAML = Path.home() / ".claw" / "repos.yaml"

_running = True


def _log(msg: str) -> None:
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    print(f"[{ts}] {msg}", flush=True)


def _on_signal(signum, _frame):  # noqa: ARG001
    global _running
    _running = False
    _log(f"received signal {signum}, shutting down")


def _load_paths() -> list[Path]:
    if not _REPOS_YAML.exists():
        _log(f"FATAL: {_REPOS_YAML} not found — nothing to watch")
        sys.exit(2)
    try:
        import yaml  # type: ignore
    except ImportError:
        _log("FATAL: PyYAML required (`pip3 install pyyaml`)")
        sys.exit(2)
    cfg = yaml.safe_load(_REPOS_YAML.read_text()) or {}
    out: list[Path] = []
    for r in cfg.get("repos", []) or []:
        if not r.get("tracked", True):
            continue
        path = r.get("path")
        if not path:
            continue
        p = Path(os.path.expanduser(path)).resolve()
        if p.is_dir():
            out.append(p)
    return out


def _run_sync() -> None:
    if not _CLAW.exists():
        _log(f"WARN: claw script missing at {_CLAW}, skipping sync")
        return
    started = time.monotonic()
    try:
        # `--code` so source files are kept in sync, not just docs.
        # `--no-embed` keeps the daemon-triggered loop fast; embeddings run
        # the next time the user invokes `claw sync` directly or via cron.
        # (The daemon's job is "make brain.db and FTS5 fresh"; semantic
        # backfill is a separate concern.)
        result = subprocess.run(
            [sys.executable, str(_CLAW), "sync", "--code", "--no-embed"],
            capture_output=True, text=True, check=False,
        )
        elapsed = time.monotonic() - started
        last_line = (result.stderr.strip().splitlines() or [""])[-1]
        if result.returncode != 0:
            _log(f"sync FAILED ({elapsed:.1f}s): rc={result.returncode} "
                 f"err={last_line[:300]}")
        else:
            _log(f"sync ok ({elapsed:.1f}s): {last_line[:200]}")
    except Exception as exc:  # pragma: no cover — guard the watcher loop
        _log(f"sync EXCEPTION: {exc!r}")


def _run_fswatch_mode(paths: list[Path]) -> None:
    """Block on `fswatch`, syncing once per debounced batch.

    Uses `--batch-marker` so each debounce window emits a single empty line
    we can use as a sync trigger. Without it we'd resync per-file."""
    args = [
        "fswatch",
        "--latency", str(FSWATCH_BATCH_SECS),
        "--batch-marker=__BATCH__",
        "--one-per-batch",  # collapse rapid bursts inside the latency window
        "--recursive",
        # Keep traffic light: ignore noisy directories most edits don't care
        # about. Patterns are POSIX extended regex (-E).
        "-E",
        "--exclude", r"(^|/)(\.git|node_modules|\.venv|__pycache__|dist|build|\.next|\.claude|coverage)(/|$)",
        *map(str, paths),
    ]
    _log(f"fswatch mode: watching {len(paths)} paths "
         f"(latency {FSWATCH_BATCH_SECS}s)")
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, text=True)
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            if not _running:
                break
            # We only care that *something* changed in this batch — the
            # incremental sync figures out which file via content_hash.
            if line.strip() == "__BATCH__" or line.strip():
                # Drain any trailing same-batch lines fswatch already buffered
                # before invoking the (relatively slow) sync.
                _run_sync()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def _run_polling_mode(paths: list[Path]) -> None:
    _log(f"polling mode (no fswatch): syncing every {POLL_INTERVAL_SECS}s "
         f"across {len(paths)} repos. Install fswatch for low-latency mode.")
    while _running:
        _run_sync()
        # Sleep in 1s slices so SIGTERM is handled promptly.
        for _ in range(POLL_INTERVAL_SECS):
            if not _running:
                return
            time.sleep(1)


def main() -> int:
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    paths = _load_paths()
    if not paths:
        _log("FATAL: no tracked repo paths found in repos.yaml")
        return 2

    # Initial sync at startup so a freshly-loaded daemon catches up on any
    # changes that landed while it was down.
    _log("startup sync...")
    _run_sync()

    if shutil.which("fswatch"):
        _run_fswatch_mode(paths)
    else:
        _run_polling_mode(paths)

    _log("daemon stopped cleanly")
    return 0


if __name__ == "__main__":
    sys.exit(main())
