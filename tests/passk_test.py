import unittest

from scripts.passk import build_attempts, compute_passk, unbiased_estimate


class PassKTest(unittest.TestCase):
    def test_unbiased_formula(self):
        self.assertEqual(unbiased_estimate(3, 0, 2), 0.0)
        self.assertEqual(unbiased_estimate(3, 2, 2), 1.0)
        self.assertAlmostEqual(unbiased_estimate(4, 1, 2), 0.5)

    def test_all_failures(self):
        predictions = [{"instance_id": "a", "prefix": f"a-{i}", "attempt_index": i} for i in range(1, 4)]
        attempts = build_attempts(predictions, {p["prefix"]: False for p in predictions})
        metrics = compute_passk(attempts, [1, 2, 3])
        self.assertEqual(metrics["pass_at_k"], {"1": 0.0, "2": 0.0, "3": 0.0})

    def test_success_only_after_first_k(self):
        predictions = [{"instance_id": "a", "prefix": f"a-{i}", "attempt_index": i} for i in range(1, 4)]
        attempts = build_attempts(predictions, {"a-1": False, "a-2": False, "a-3": True})
        metrics = compute_passk(attempts, [1, 2, 3])
        self.assertEqual(metrics["pass_at_k"]["1"], 0.0)
        self.assertEqual(metrics["pass_at_k"]["2"], 0.0)
        self.assertEqual(metrics["pass_at_k"]["3"], 1.0)
        self.assertAlmostEqual(metrics["unbiased_pass_at_k"]["2"], 2 / 3)


    def test_one_success_in_first_k(self):
        predictions = [{"instance_id": "a", "prefix": f"a-{i}", "attempt_index": i} for i in range(1, 4)]
        attempts = build_attempts(predictions, {"a-1": False, "a-2": True, "a-3": False})
        metrics = compute_passk(attempts, [1, 2])
        self.assertEqual(metrics["pass_at_k"]["1"], 0.0)
        self.assertEqual(metrics["pass_at_k"]["2"], 1.0)
        self.assertAlmostEqual(metrics["unbiased_pass_at_k"]["2"], 2 / 3)

    def test_multiple_successes_with_n_greater_than_k(self):
        predictions = [{"instance_id": "a", "prefix": f"a-{i}", "attempt_index": i} for i in range(1, 5)]
        attempts = build_attempts(predictions, {"a-1": True, "a-2": False, "a-3": True, "a-4": False})
        metrics = compute_passk(attempts, [2, 3])
        self.assertEqual(metrics["pass_at_k"]["2"], 1.0)
        self.assertEqual(metrics["pass_at_k"]["3"], 1.0)
        self.assertAlmostEqual(metrics["unbiased_pass_at_k"]["2"], 5 / 6)
        self.assertEqual(metrics["unbiased_pass_at_k"]["3"], 1.0)

    def test_multiple_instances(self):
        predictions = [
            {"instance_id": "a", "prefix": "a-1", "attempt_index": 1},
            {"instance_id": "a", "prefix": "a-2", "attempt_index": 2},
            {"instance_id": "b", "prefix": "b-1", "attempt_index": 1},
            {"instance_id": "b", "prefix": "b-2", "attempt_index": 2},
        ]
        attempts = build_attempts(predictions, {"a-1": False, "a-2": True, "b-1": False, "b-2": False})
        metrics = compute_passk(attempts, [1, 2])
        self.assertEqual(metrics["pass_at_k"]["1"], 0.0)
        self.assertEqual(metrics["pass_at_k"]["2"], 0.5)
        self.assertEqual(metrics["unbiased_pass_at_k"]["2"], 0.5)

    def test_missing_eval_records_are_marked(self):
        attempts = build_attempts([{"instance_id": "a", "prefix": "a-1", "attempt_index": 1}], {})
        self.assertIsNone(attempts["a"][0]["resolved"])
        self.assertTrue(attempts["a"][0]["eval_missing"])


if __name__ == "__main__":
    unittest.main()
