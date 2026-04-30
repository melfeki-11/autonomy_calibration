#!/usr/bin/env python3
"""Install/update the official SWE-bench Pro evaluator checkout."""

from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor" / "SWE-bench_Pro-os"
REPO = "https://github.com/swe-bench/SWE-bench_Pro-os.git"


def main() -> None:
    VENDOR.parent.mkdir(parents=True, exist_ok=True)
    if (VENDOR / ".git").exists():
        subprocess.check_call(["git", "fetch", "--depth", "1", "origin", "main"], cwd=VENDOR)
        subprocess.check_call(["git", "checkout", "main"], cwd=VENDOR)
        subprocess.check_call(["git", "pull", "--ff-only"], cwd=VENDOR)
    else:
        subprocess.check_call(["git", "clone", "--depth", "1", REPO, str(VENDOR)])
    print(VENDOR)


if __name__ == "__main__":
    main()
