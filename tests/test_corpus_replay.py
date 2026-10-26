from __future__ import annotations
import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "corpus-replay.py"
spec = importlib.util.spec_from_file_location("corpus_replay", SCRIPT)
replay = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(replay)

class ReplayInputTest(unittest.TestCase):
    def test_load_rows_filters_by_utc_window_and_requires_timezone(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "queries.jsonl"
            base = {"bot_id":"bot", "dataset":"ds", "query":"q", "ragflow_ids":["r"], "ragflow_latency_ms":12}
            rows = [
                {**base, "ts":"2026-10-20T00:00:00Z"},
                {**base, "ts":"2026-10-21T12:00:00+00:00"},
                {**base, "ts":"2026-10-22T00:00:00Z"},
            ]
            path.write_text("".join(json.dumps(row)+"\n" for row in rows))
            got = replay.load_rows(path, datetime(2026,10,21,tzinfo=timezone.utc), datetime(2026,10,22,tzinfo=timezone.utc))
            self.assertEqual(len(got), 1)
            self.assertEqual(got[0]["ts"], "2026-10-21T12:00:00+00:00")

    def test_overlap_metrics_and_empty_rates_are_explicit(self):
        live = [{"ragflow_ids":["a","b"], "ragflow_latency_ms":10}, {"ragflow_ids":[], "ragflow_latency_ms":30}]
        module = [{"ragflow_ids":["a","b"], "module_ids":["b","z"], "module_latency_ms":12}, {"ragflow_ids":[], "module_ids":[], "module_latency_ms":16}]
        report = replay.aggregate(live, module, "fixture", {"since":"a", "until":"b"})
        self.assertEqual(report["metrics"]["top5_overlap_mean_ids"], 0.5)
        self.assertEqual(report["metrics"]["ragflow_empty_rate"], 0.5)
        self.assertEqual(report["metrics"]["module_empty_rate"], 0.5)
        self.assertEqual(report["metrics"]["module_p95_ms"], 15.8)
        self.assertEqual(report["golden_set"]["status"], "not_run")

    def test_rejects_unzoned_timestamp(self):
        with self.assertRaisesRegex(ValueError, "timezone"):
            replay.parse_time("2026-10-21T00:00:00")

if __name__ == "__main__":
    unittest.main()
