"""pass@k aggregation helpers."""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any


def attempt_from_prefix(prefix: str) -> int | None:
    import re

    match = re.search(r"attempt[-_](\d+)", prefix)
    return int(match.group(1)) if match else None


def unbiased_estimate(n: int, c: int, k: int) -> float:
    if n < k:
        raise ValueError("n must be >= k")
    if c == 0:
        return 0.0
    if n - c < k:
        return 1.0
    return 1.0 - math.comb(n - c, k) / math.comb(n, k)


def build_attempts(predictions: list[dict[str, Any]], official: dict[str, bool]) -> dict[str, list[dict[str, Any]]]:
    by_instance: dict[str, list[dict[str, Any]]] = defaultdict(list)
    prediction_count_by_instance: dict[str, int] = defaultdict(int)
    for prediction in predictions:
        prediction_count_by_instance[str(prediction["instance_id"])] += 1
    for idx, prediction in enumerate(predictions):
        prefix = str(prediction.get("prefix") or "")
        instance_id = str(prediction["instance_id"])
        attempt_index = prediction.get("attempt_index")
        if attempt_index is None:
            attempt_index = attempt_from_prefix(prefix) or idx + 1
        resolved = official.get(prefix)
        if resolved is None and prediction_count_by_instance[instance_id] == 1:
            resolved = official.get(instance_id)
        by_instance[instance_id].append(
            {
                "prefix": prefix,
                "attempt_index": int(attempt_index),
                "resolved": resolved,
                "eval_missing": resolved is None,
                "harness": prediction.get("harness"),
                "generation_failed": bool(prediction.get("generation_failed")),
                "sdk_error": prediction.get("sdk_error"),
            }
        )
    for attempts in by_instance.values():
        attempts.sort(key=lambda item: (item["attempt_index"], str(item.get("prefix") or "")))
    return by_instance


def build_harness_attempts(predictions: list[dict[str, Any]], official: dict[str, bool]) -> dict[str, dict[str, list[dict[str, Any]]]]:
    by_harness: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for prediction in predictions:
        by_harness[str(prediction.get("harness") or "unknown")].append(prediction)
    return {harness: build_attempts(items, official) for harness, items in sorted(by_harness.items())}


def compute_passk(by_instance: dict[str, list[dict[str, Any]]], requested_k: list[int]) -> dict[str, Any]:
    total = len(by_instance)
    metrics: dict[str, Any] = {"total_instances": total, "instances": by_instance, "pass_at_k": {}, "unbiased_pass_at_k": {}}
    for k in sorted(set(requested_k)):
        solved = 0
        unbiased_sum = 0.0
        unbiased_count = 0
        for attempts in by_instance.values():
            first_k = attempts[:k]
            if any(item["resolved"] is True for item in first_k):
                solved += 1
            n = len(attempts)
            c = sum(1 for item in attempts if item["resolved"] is True)
            if n >= k:
                unbiased_count += 1
                unbiased_sum += unbiased_estimate(n, c, k)
        metrics["pass_at_k"][str(k)] = solved / total if total else 0.0
        metrics["unbiased_pass_at_k"][str(k)] = unbiased_sum / unbiased_count if unbiased_count else None
    metrics["missing_eval_attempts"] = sum(1 for attempts in by_instance.values() for item in attempts if item["eval_missing"])
    return metrics
