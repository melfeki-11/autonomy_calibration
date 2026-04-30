#!/usr/bin/env python3
"""Run the official SWE-bench Pro evaluator against normalized predictions."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def default_eval_workers() -> int:
    if os.getenv("SWEBENCH_EVAL_WORKERS"):
        return int(os.environ["SWEBENCH_EVAL_WORKERS"])
    return min(8, max(1, (os.cpu_count() or 1) // 32))


def docker_env() -> dict[str, str]:
    env = dict(os.environ)
    if env.get("DOCKER_HOST"):
        return env
    try:
        raw = subprocess.check_output(["docker", "context", "inspect"], text=True, stderr=subprocess.DEVNULL)
        context = json.loads(raw)[0]
        endpoint = context.get("Endpoints", {}).get("docker", {}).get("Host")
        if endpoint:
            env["DOCKER_HOST"] = endpoint
    except Exception:
        pass
    return env


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--predictions", type=Path, default=None)
    parser.add_argument("--samples", type=Path, default=ROOT / "data" / "swebench_pro_samples.csv")
    parser.add_argument("--vendor", type=Path, default=ROOT / "vendor" / "SWE-bench_Pro-os")
    parser.add_argument("--dockerhub-username", default="jefzda")
    parser.add_argument("--no-local-docker", action="store_true")
    parser.add_argument("--num-workers", type=int, default=default_eval_workers())
    parser.add_argument("--extra-arg", action="append", default=[])
    args = parser.parse_args()

    run_dir = ROOT / "evals" / args.run_id
    predictions = args.predictions or run_dir / "predictions.json"
    evaluator = args.vendor / "swe_bench_pro_eval.py"
    scripts_dir = args.vendor / "run_scripts"
    if not evaluator.exists():
        raise SystemExit(f"Missing evaluator: {evaluator}. Run scripts/setup_vendor.py first.")
    if not predictions.exists():
        raise SystemExit(f"Missing predictions: {predictions}")
    if not args.samples.exists():
        raise SystemExit(f"Missing sample CSV: {args.samples}")

    out_dir = run_dir / "official-eval"
    out_dir.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable,
        str(evaluator),
        "--raw_sample_path",
        str(args.samples),
        "--patch_path",
        str(predictions),
        "--output_dir",
        str(out_dir),
        "--scripts_dir",
        str(scripts_dir),
        "--dockerhub_username",
        args.dockerhub_username,
        "--num_workers",
        str(args.num_workers),
    ]
    if not args.no_local_docker:
        command.append("--use_local_docker")
    command.extend(args.extra_arg)
    (out_dir / "command.json").write_text(json.dumps(command, indent=2) + "\n", encoding="utf-8")
    with (out_dir / "stdout.log").open("w", encoding="utf-8") as stdout, (out_dir / "stderr.log").open("w", encoding="utf-8") as stderr:
        process = subprocess.run(command, cwd=args.vendor, stdout=stdout, stderr=stderr, env=docker_env() if not args.no_local_docker else None)
    print(f"Official evaluator exited with {process.returncode}")
    print(f"Logs: {out_dir}")
    raise SystemExit(process.returncode)


if __name__ == "__main__":
    main()
