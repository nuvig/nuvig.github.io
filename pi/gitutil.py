#!/usr/bin/env python3
"""Git housekeeping for the Pi publisher (exporter.py).

It publishes to a branch kept at a single amended commit. That keeps the
*remote* tiny, but locally every `commit --amend` orphans the previous
commit's blobs — and the reflog pins them, so nothing is ever reclaimed.
With ~33 MB of day-files rewritten hourly the export clone grew to 5.7 GB of
.git against 301 MB of actual data before this existed.

maintain() expires the reflog every run (cheap: a few small files) and does a
full prune + repack at most once per `interval_s`, because repacking a few
hundred MB is real write volume on an SD card and hourly repacking would cost
gigabytes of card wear per day.
"""

import os
import subprocess
import time

DEFAULT_INTERVAL_S = 6 * 3600
STAMP = "kanp-last-gc"          # written inside .git/


def _git(repo_dir, *args, check=True):
    return subprocess.run(
        ["git", "-C", repo_dir, *args],
        capture_output=True, text=True, check=check,
    )


def dir_size_mb(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total / 1e6


def maintain(repo_dir, log=print, interval_s=DEFAULT_INTERVAL_S):
    """Drop unreachable objects left behind by amend + force-push.

    Always expires the reflog so old commits stop being reachable; runs the
    (more expensive) prune/repack only once per interval_s. Returns True if a
    full collection ran. Never raises — housekeeping must not fail a publish.
    """
    git_dir = os.path.join(repo_dir, ".git")
    if not os.path.isdir(git_dir):
        return False
    try:
        _git(repo_dir, "reflog", "expire", "--expire=now", "--all", check=False)

        stamp = os.path.join(git_dir, STAMP)
        try:
            due = time.time() - os.path.getmtime(stamp) >= interval_s
        except OSError:
            due = True                      # never collected
        if not due:
            return False

        before = dir_size_mb(git_dir)
        r = _git(repo_dir, "gc", "--prune=now", "--quiet", check=False)
        if r.returncode != 0:
            log(f"git gc failed (non-fatal): {r.stderr.strip().splitlines()[-1:]}")
            return False
        after = dir_size_mb(git_dir)
        with open(stamp, "w") as f:
            f.write(str(int(time.time())))
        log(f"git gc: .git {before:.0f} MB -> {after:.0f} MB "
            f"({max(0, before - after):.0f} MB reclaimed)")
        return True
    except OSError as e:
        log(f"git housekeeping skipped: {e}")
        return False
