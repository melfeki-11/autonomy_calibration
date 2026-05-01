#!/usr/bin/env python3
"""Summarize pass@k from official SWE-bench Pro evaluator results."""

from __future__ import annotations

import argparse
import ast
import csv
import json
import re
import sys
from pathlib import Path
from typing import Any

try:
    from passk import build_attempts, build_harness_attempts, compute_passk
except ModuleNotFoundError:
    from .passk import build_attempts, build_harness_attempts, compute_passk

ROOT = Path(__file__).resolve().parents[1]
ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
STATUS_RE = re.compile(r"\b(PASSED|FAILED|SKIPPED|ERROR|XPASS|XFAIL)\b\s+(test/[^\s]+)")
TEST_NAME_RE = re.compile(r"\b(test/[^\s]+(?:::[^\s]+)+)")
ALL_PASSED_RE = re.compile(r"\b(\d+) passed in [0-9.]+s\b")
PASSING_STATUSES = {"PASSED", "XPASS"}


def raise_csv_field_limit() -> None:
    limit = sys.maxsize
    while True:
        try:
            csv.field_size_limit(limit)
            return
        except OverflowError:
            limit //= 10


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


def strip_ansi(value: str) -> str:
    return ANSI_RE.sub("", value)


def clean_test_name(value: Any) -> str:
    text = strip_ansi(str(value)).strip()
    text = re.sub(r"\[gw\d+\].*$", "", text).strip()
    return text


def base_test_name(value: Any) -> str:
    text = clean_test_name(value)
    return text.split("[", 1)[0]


def test_aliases(value: Any) -> set[str]:
    clean = clean_test_name(value)
    base = base_test_name(clean)
    return {item for item in (clean, base) if item}


def add_status(statuses: dict[str, str], test_name: Any, status: str) -> None:
    for alias in test_aliases(test_name):
        statuses[alias] = status


def statuses_from_output(parsed: Any) -> dict[str, str]:
    statuses: dict[str, str] = {}
    if not isinstance(parsed, dict) or not isinstance(parsed.get("tests"), list):
        return statuses
    for test in parsed["tests"]:
        if isinstance(test, dict) and test.get("name") and test.get("status"):
            add_status(statuses, test["name"], str(test["status"]))
    return statuses


def scheduled_tests_from_log(text: str) -> list[str]:
    marker = "scheduling tests via"
    if marker not in text:
        return []
    block = text.split(marker, 1)[1]
    block = re.split(r"\n\[gw\d+\]", block, 1)[0]
    tests = []
    for line in block.splitlines():
        line = line.strip()
        if line.startswith("test/"):
            tests.append(base_test_name(line))
    return [name for name in dict.fromkeys(tests) if name]


def statuses_from_logs(*paths: Path) -> dict[str, str]:
    statuses: dict[str, str] = {}
    for path in paths:
        if not path.exists():
            continue
        text = strip_ansi(path.read_text(encoding="utf-8", errors="replace"))
        for match in STATUS_RE.finditer(text):
            add_status(statuses, match.group(2), match.group(1))
        scheduled = scheduled_tests_from_log(text)
        if not scheduled:
            scheduled = [name for name in dict.fromkeys(base_test_name(match.group(1)) for match in TEST_NAME_RE.finditer(text)) if name]
        passed_summary = ALL_PASSED_RE.search(text)
        if passed_summary and int(passed_summary.group(1)) == len(scheduled):
            for test_name in scheduled:
                add_status(statuses, test_name, "PASSED")
    return statuses


def required_test_passed(required: str, statuses: dict[str, str]) -> bool:
    for alias in test_aliases(required):
        if statuses.get(alias) in PASSING_STATUSES:
            return True
    return False


def load_raw_samples(samples_path: Path) -> dict[str, dict[str, Any]]:
    if not samples_path.exists():
        return {}
    if samples_path.suffix == ".jsonl":
        rows = load_jsonish(samples_path) or []
        return {str(row["instance_id"]): row for row in rows}
    raise_csv_field_limit()
    with samples_path.open("r", encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    return {str(row["instance_id"]): row for row in rows}


def collect_attempt_outputs(run_dir: Path, samples_path: Path, predictions_path: Path | None = None) -> dict[str, bool]:
    raw_samples = load_raw_samples(samples_path)
    official_dir = run_dir / "official-eval"
    results: dict[str, bool] = {}
    freshness_floor = predictions_path.stat().st_mtime if predictions_path and predictions_path.exists() else None
    command_path = official_dir / "command.json"
    if command_path.exists():
        command_mtime = command_path.stat().st_mtime
        freshness_floor = command_mtime if freshness_floor is None else max(freshness_floor, command_mtime)
    stale_outputs: list[Path] = []
    for output_path in official_dir.glob("*/*_output.json"):
        if freshness_floor is not None and output_path.stat().st_mtime < freshness_floor:
            stale_outputs.append(output_path)
            continue
        instance_id = output_path.parent.name
        prefix = output_path.name[: -len("_output.json")]
        sample = raw_samples.get(instance_id)
        parsed = load_jsonish(output_path)
        if not sample:
            results[prefix] = False
            continue
        statuses = statuses_from_output(parsed)
        statuses.update(statuses_from_logs(output_path.with_name(f"{prefix}_stdout.log"), output_path.with_name(f"{prefix}_stderr.log")))
        if not statuses:
            results[prefix] = False
            continue
        required = parse_listish(sample.get("fail_to_pass")) | parse_listish(sample.get("pass_to_pass"))
        results[prefix] = all(required_test_passed(test, statuses) for test in required)
    if stale_outputs:
        rendered = "\n".join(f"- {path}" for path in stale_outputs[:10])
        more = "" if len(stale_outputs) <= 10 else f"\n... and {len(stale_outputs) - 10} more"
        raise SystemExit(
            "Stale official evaluator outputs are older than predictions.json or the latest evaluator command. "
            "Rerun evaluation without --reuse-existing or use a fresh RUN_ID.\n"
            f"{rendered}{more}"
        )
    return results


def prediction_key(prediction: dict[str, Any]) -> tuple[str, str, int]:
    return (
        str(prediction.get("harness") or "unknown"),
        str(prediction.get("instance_id") or ""),
        int(prediction.get("attempt_index") or 0),
    )


def predictions_with_failures(run_dir: Path, predictions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = list(predictions)
    seen = {prediction_key(prediction) for prediction in out}
    attempts_index = load_jsonish(run_dir / "attempts-index.json")
    progress = load_jsonish(run_dir / "generation-progress.json")
    failure_sources: list[dict[str, Any]] = []
    for source in (attempts_index, progress):
        if isinstance(source, dict) and isinstance(source.get("failed_jobs"), list):
            failure_sources.extend(item for item in source["failed_jobs"] if isinstance(item, dict))
    run_id = run_dir.name
    if isinstance(attempts_index, dict):
        run_id = str(attempts_index.get("run_id") or run_id)
    for failure in failure_sources:
        harness = str(failure.get("harness") or "unknown")
        instance_id = str(failure.get("instance_id") or "")
        attempt_index = int(failure.get("attempt_index") or 0)
        key = (harness, instance_id, attempt_index)
        if key in seen or not instance_id or attempt_index < 1:
            continue
        out.append(
            {
                "instance_id": instance_id,
                "patch": "",
                "prefix": f"{run_id}__{harness}__{instance_id}__attempt-{attempt_index}",
                "harness": harness,
                "attempt_index": attempt_index,
                "run_id": run_id,
                "sdk_error": failure.get("error"),
                "generation_failed": True,
            }
        )
        seen.add(key)
    return out


def filter_ambiguous_instance_results(predictions: list[dict[str, Any]], official: dict[str, bool]) -> dict[str, bool]:
    counts: dict[str, int] = {}
    for prediction in predictions:
        instance_id = str(prediction.get("instance_id") or "")
        if instance_id:
            counts[instance_id] = counts.get(instance_id, 0) + 1
    ambiguous_instances = {instance_id for instance_id, count in counts.items() if count > 1}
    return {key: value for key, value in official.items() if key not in ambiguous_instances}


def render_metric_lines(metrics: dict[str, Any]) -> list[str]:
    lines: list[str] = [f"Total instances: {metrics['total_instances']}"]
    missing = int(metrics.get("missing_eval_attempts") or 0)
    if missing:
        lines.append(f"Missing eval attempts: {missing}")
    lines.append("")
    for k, value in metrics["pass_at_k"].items():
        lines.append(f"- pass@{k}: {value:.4f}")
    for k, value in metrics["unbiased_pass_at_k"].items():
        rendered = "missing" if value is None else f"{value:.4f}"
        lines.append(f"- unbiased pass@{k}: {rendered}")
    lines.append("")
    lines.append("Per-task attempts:")
    for instance_id, attempts in sorted(metrics["instances"].items()):
        task_success = any(item["resolved"] is True for item in attempts)
        status = ", ".join(f"{item['attempt_index']}={'missing' if item['resolved'] is None else item['resolved']}" for item in attempts)
        lines.append(f"- {instance_id}: success={task_success}; attempts: {status}")
    return lines


def render_result_line(label: str, metrics: dict[str, Any]) -> str:
    pass_parts = [f"pass@{k}={value:.4f}" for k, value in metrics["pass_at_k"].items()]
    unbiased_parts = [
        f"unbiased_pass@{k}={'missing' if value is None else f'{value:.4f}'}"
        for k, value in metrics["unbiased_pass_at_k"].items()
    ]
    missing = int(metrics.get("missing_eval_attempts") or 0)
    return f"- {label}: {', '.join(pass_parts)}; {', '.join(unbiased_parts)}; missing_eval_attempts={missing}"


def render_final_results_lines(metrics: dict[str, Any]) -> list[str]:
    lines = ["## Final Results"]
    if "harnesses" in metrics:
        for harness, harness_metrics in metrics["harnesses"].items():
            lines.append(render_result_line(harness, harness_metrics))
    else:
        lines.append(render_result_line(str(metrics.get("harness") or "overall"), metrics))
    return lines


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
    predictions = predictions_with_failures(run_dir, json.loads(predictions_path.read_text(encoding="utf-8")))
    official = collect_attempt_outputs(run_dir, args.samples, predictions_path)
    if not official:
        official = filter_ambiguous_instance_results(predictions, collect_official_results(run_dir))
    harnesses = sorted({str(prediction.get("harness") or "unknown") for prediction in predictions})
    if len(harnesses) <= 1:
        by_instance = build_attempts(predictions, official)
        metrics = compute_passk(by_instance, args.k or [1, 2, 3])
        metrics["run_id"] = args.run_id
        if harnesses:
            metrics["harness"] = harnesses[0]
    else:
        metrics = {
            "run_id": args.run_id,
            "harnesses": {
                harness: compute_passk(by_instance, args.k or [1, 2, 3])
                for harness, by_instance in build_harness_attempts(predictions, official).items()
            },
        }

    out_json = run_dir / "metrics.json"
    out_md = run_dir / "summary.md"
    out_json.write_text(json.dumps(metrics, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    lines = [f"# {args.run_id}", ""]
    if "harnesses" in metrics:
        for harness, harness_metrics in metrics["harnesses"].items():
            lines.append(f"## {harness}")
            lines.extend(render_metric_lines(harness_metrics))
            lines.append("")
    else:
        lines.extend(render_metric_lines(metrics))
        lines.append("")
    lines.extend(render_final_results_lines(metrics))
    out_md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(out_json)
    print(out_md)


if __name__ == "__main__":
    main()
