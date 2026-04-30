import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from scripts.passk import build_attempts, build_harness_attempts, compute_passk, unbiased_estimate
from scripts.summarize_passk import required_test_passed, statuses_from_logs, statuses_from_output


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

    def test_instance_id_fallback_only_when_unambiguous(self):
        single = build_attempts([{"instance_id": "a", "prefix": "a-1", "attempt_index": 1}], {"a": True})
        self.assertTrue(single["a"][0]["resolved"])

        multiple = build_attempts(
            [
                {"instance_id": "a", "prefix": "a-1", "attempt_index": 1},
                {"instance_id": "a", "prefix": "a-2", "attempt_index": 2},
            ],
            {"a": True},
        )
        self.assertIsNone(multiple["a"][0]["resolved"])
        self.assertIsNone(multiple["a"][1]["resolved"])

    def test_harness_attempts_are_separate(self):
        predictions = [
            {"harness": "claude-code", "instance_id": "a", "prefix": "claude-a-1", "attempt_index": 1},
            {"harness": "codex", "instance_id": "a", "prefix": "codex-a-1", "attempt_index": 1},
        ]
        groups = build_harness_attempts(predictions, {"claude-a-1": False, "codex-a-1": True})
        self.assertEqual(compute_passk(groups["claude-code"], [1])["pass_at_k"]["1"], 0.0)
        self.assertEqual(compute_passk(groups["codex"], [1])["pass_at_k"]["1"], 1.0)

    def test_output_status_aliases_parameterized_tests(self):
        statuses = statuses_from_output(
            {
                "tests": [
                    {
                        "name": "test/units/utils/test_vars.py::TestVariableUtils::test_merge_hash_non_recursive_and_list_append_rp[param]",
                        "status": "PASSED",
                    }
                ]
            }
        )
        self.assertTrue(
            required_test_passed(
                "test/units/utils/test_vars.py::TestVariableUtils::test_merge_hash_non_recursive_and_list_append_rp",
                statuses,
            )
        )

    def test_log_statuses_normalize_ansi_and_xdist_glued_lines(self):
        with TemporaryDirectory() as tmpdir:
            stdout = Path(tmpdir) / "stdout.log"
            stdout.write_text(
                "[gw4]\x1b[36m [ 93%] \x1b[0m\x1b[32mPASSED\x1b[0m "
                "test/units/utils/test_vars.py::TestVariableUtils::test_merge_hash_non_recursive_and_list_append_rp"
                "[g[gw8]\x1b[36m [100%] \x1b[0m\x1b[32mPASSED\x1b[0m "
                "test/units/utils/test_vars.py::TestVariableUtils::test_merge_hash_non_recursive_and_list_replace\n",
                encoding="utf-8",
            )
            statuses = statuses_from_logs(stdout)
        self.assertTrue(
            required_test_passed(
                "test/units/utils/test_vars.py::TestVariableUtils::test_merge_hash_non_recursive_and_list_append_rp",
                statuses,
            )
        )
        self.assertTrue(
            required_test_passed(
                "test/units/utils/test_vars.py::TestVariableUtils::test_merge_hash_non_recursive_and_list_replace",
                statuses,
            )
        )

    def test_log_statuses_use_all_passed_summary_when_node_count_matches(self):
        with TemporaryDirectory() as tmpdir:
            stdout = Path(tmpdir) / "stdout.log"
            stdout.write_text(
                "test/units/utils/test_vars.py::TestVariableUtils::test_one\n"
                "test/units/utils/test_vars.py::TestVariableUtils::test_two\n"
                "[gw0] [ 50%] PASSED test/units/utils/test_vars.py::TestVariableUtils::test_one"
                "[gw1] [100%] PASSED test/units/utils/test_vars.py::TestVariableUtils::test_one\n"
                "============================= 2 passed in 1.23s ==============================\n",
                encoding="utf-8",
            )
            statuses = statuses_from_logs(stdout)
        self.assertTrue(required_test_passed("test/units/utils/test_vars.py::TestVariableUtils::test_one", statuses))
        self.assertTrue(required_test_passed("test/units/utils/test_vars.py::TestVariableUtils::test_two", statuses))


if __name__ == "__main__":
    unittest.main()
