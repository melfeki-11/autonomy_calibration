#!/usr/bin/env python3
"""Summarize pass@k from official SWE-bench Pro evaluator results."""

from __future__ import annotations

import argparse
import ast
import csv
import json
from pathlib import Path
from typing import Any

from passk import build_attempts, compute_passk

ROOT = Path(__file__).resolve().parents[1]


def load_jsonish(path: Path) -> Any | None:
    try:
        if path.suffix == ".jsonl":
            return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        if path.suffix == ".json":
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return None


def flatten_records(obj: Any) -> list[dict[str, Any]]:
    if isinstance(obj, list):
        return [item for item in obj if isinstance(item, dict)]
    if isinstance(obj, dict):
        records: list[dict[str, Any]] = []
        for key, value in obj.items():
            if isinstance(value, dict):
                merged = dict(value)
                if "instance_id" not in merged:
                    merged["instance_id"] = str(key)
                records.append(merged)
            elif isinstance(value, bool):
                records.append({"prefix": str(key), "resolved": value})
        return records
    return []


def resolved_value(record: dict[str, Any]) -> bool | None:
    for key in ("resolved", "passed", "success", "is_resolved"):
        if key in record:
            return bool(record[key])
    status = str(record.get("status") or record.get("result") or "").lower()
    if status in {"resolved", "pass", "passed", "success", "succeeded"}:
        return True
    if status in {"unresolved", "fail", "failed", "error", "timeout"}:
        return False
    return None


def collect_official_results(run_dir: Path) -> dict[str, bool]:
    results: dict[str, bool] = {}
    official_dir = run_dir / "official-eval"
    for path in sorted(official_dir.rglob("*.json")) + sorted(official_dir.rglob("*.jsonl")):
        parsed = load_jsonish(path)
        if parsed is None:
            continue
        for record in flatten_records(parsed):
            resolved = resolved_value(record)
            if resolved is None:
                continue
            prefix = record.get("prefix") or record.get("prediction_id") or record.get("id")
            instance_id = record.get("instance_id")
            results[str(prefix or instance_id)] = resolved
    return results


def parse_listish(value: Any) -> set[str]:
    if value is None:
        return set()
    if isinstance(value, list):
        return {str(item) for item in value}
    text = str(value)
    if not text.strip():
        return set()
    try:
        parsed = ast.literal_eval(text)
        if isinstance(parsed, list):
            return {str(item) for item in parsed}
    except Exception:
        pass
    return {item.strip() for item in text.split(",") if item.strip()}


def load_raw_samples(samples_path: Path) -> dict[str, dict[str, Any]]:
    if not samples_path.exists():
        return {}
    if samples_path.suffix == ".jsonl":
        rows = load_jsonish(samples_path) or []
        return {str(row["instance_id"]): row for row in rows}
    with samples_path.open("r", encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    return {str(row["instance_id"]): row for row in rows}


def collect_attempt_outputs(run_dir: Path, samples_path: Path) -> dict[str, bool]:
    raw_samples = load_raw_samples(samples_path)
    official_dir = run_dir / "official-eval"
    results: dict[str, bool] = {}
    for output_path in official_dir.glob("*/*_output.json"):
        instance_id = output_path.parent.name
        prefix = output_path.name[: -len("_output.json")]
        sample = raw_samples.get(instance_id)
        parsed = load_jsonish(output_path)
        if not sample or not isinstance(parsed, dict):
            results[prefix] = False
            continue
        tests = parsed.get("tests")
        if not isinstance(tests, list):
            results[prefix] = False
            continue
        passed_tests = {str(test.get("name")) for test in tests if test.get("status") == "PASSED"}
        required = parse_listish(sample.get("fail_to_pass")) | parse_listish(sample.get("pass_to_pass"))
        results[prefix] = required <= passed_tests
    return results


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-dir", type=Path, default=None)
    parser.add_argument("--samples", type=Path, default=ROOT / "data" / "swebench_pro_samples.csv")
    parser.add_argument("--k", type=int, action="append", default=None)
    args = parser.parse_args()

    run_dir = args.run_dir or ROOT / "evals" / args.run_id
    predictions_path = run_dir / "predictions.json"
    if not predictions_path.exists():
        raise SystemExit(f"Missing predictions: {predictions_path}")
    predictions = json.loads(predictions_path.read_text(encoding="utf-8"))
    official = collect_attempt_outputs(run_dir, args.samples) or collect_official_results(run_dir)
    by_instance = build_attempts(predictions, official)
    metrics = compute_passk(by_instance, args.k or [1, 2, 3])
    metrics["run_id"] = args.run_id

    out_json = run_dir / "metrics.json"
    out_md = run_dir / "summary.md"
    out_json.write_text(json.dumps(metrics, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    lines = [f"# {args.run_id}", "", f"Total instances: {metrics['total_instances']}", ""]
    for k, value in metrics["pass_at_k"].items():
        lines.append(f"- pass@{k}: {value:.4f}")
    for k, value in metrics["unbiased_pass_at_k"].items():
        rendered = "missing" if value is None else f"{value:.4f}"
        lines.append(f"- unbiased pass@{k}: {rendered}")
    lines.append("")
    lines.append("Per-instance attempts:")
    for instance_id, attempts in sorted(by_instance.items()):
        status = ", ".join(f"{item['attempt_index']}={'missing' if item['resolved'] is None else item['resolved']}" for item in attempts)
        lines.append(f"- {instance_id}: {status}")
    out_md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(out_json)
    print(out_md)


if __name__ == "__main__":
    main()
