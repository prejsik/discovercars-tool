import copy
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from tools import update_excel_rates as engine
from tools.plan_recommendation_verification import plan_recommendations


def pending_decision(scenario_id, location, start_date, days=2, group="CDMV", rate=51):
    return {
        "scenario_id": scenario_id,
        "location": location,
        "start_date": start_date,
        "rental_days": days,
        "group": group,
        "action": "increase",
        "recommendation_action": "increase",
        "recommendation_type": "minimum_fallback",
        "target_rank": None,
        "suggested_rate_pln_day": rate,
        "maximum_import_rate_pln_day": rate,
        "site_cap_rate_pln_day": rate,
        "site_target_rate_pln_day": rate,
        "predicted_site_rate_pln_day": rate,
        "data_quality_status": "popularity_pending",
        "requires_popularity_verification": True,
        "broker_markup_multiplier": 1,
        "broker_markup_amount_pln_day": 0,
        "benchmark_provider": "Budget",
        "benchmark_rate_pln_day": 120,
        "mm_rate_pln_day": 40,
    }


def confirmed_ranking():
    return {
        "status": "confirmed",
        "sort": "Recommended",
        "transmission": "automatic",
        "top_offer": {
            "provider_name": "Budget",
            "total_price": 150,
            "currency": "PLN",
            "transmission": "automatic",
        },
        "observed_at": datetime.now(timezone.utc).isoformat(),
    }


class RecommendationVerificationPlanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.rules_path = self.root / "pricing.json"
        self.rules_path.write_text(json.dumps({"pricing": {
            "mandatoryGroupFloorsPlnDay": {
                "CDMV": [{"minDays": 3, "maxDays": 4, "minimumRatePlnDay": 90}],
            },
        }}), encoding="utf-8")
        self.config_path = self.root / "config.json"
        self.config = {
            "location_registry_file": "",
            "baseline_manifest_file": "",
            "pricing_rules_file": str(self.rules_path),
            "location_zones": {
                "Main location": ["WA1"],
                "Excluded location": ["WALO"],
                "Omitted location": ["WALO"],
                "Seeded location": ["WASE"],
                "Multi-zone location": ["WALO", "WA1"],
            },
            "apply_groups": ["CDMV", "CGAV", "PDAH"],
            "excluded_groups": ["PDAH"],
            "omitted_group_zones": {"WALO": ["CGAV"]},
            "zone_seeds": {"WASE": "WA1"},
            "protected_rate_periods": [{"start_date": "2026-11-04", "end_date": "2026-11-04"}],
            "pickup_date_expansion": {"enabled": True, "mode": "source_ranges"},
            "minimum_rates": {"global_min_pln_day": 50, "bands": []},
            "normalize_pickup_end_to_start": False,
        }
        self.config_path.write_text(json.dumps(self.config), encoding="utf-8")
        self.workbook_path = self.root / "source.xlsx"
        self.write_workbook(self.workbook_path)

    @staticmethod
    def write_workbook(path):
        book = openpyxl.Workbook()
        ws = book.active
        ws.title = "Sheet1"
        ws.append(["Rental rates"])
        ws.append([None] * 8 + [2, 3])
        ws.append([None] * 8 + [2, 4])
        ws.append(["Group", "Description", "Rate code", "Zone", "Booking start date", "Booking end date",
                   "Pickup start date", "Pickup end date", "Per day", "Per day"])
        rows = [
            ("CDMV", "WA1", "2026-11-03", "2026-11-06", 50, 60),
            ("PDAH", "WA1", "2026-11-03", "2026-11-06", 20, 30),
            ("PDAH", "WALO", "2026-11-03", "2026-11-06", 25, 35),
            ("CGAV", "WALO", "2026-11-03", "2026-11-06", 40, 50),
            ("CFAV", "WALO", "2026-11-03", "2026-11-06", 70, 80),
        ]
        for group, zone, start, end, short_rate, long_rate in rows:
            ws.append([group, None, None, zone, start, end, start, end, short_rate, long_rate])
        book.save(path)
        book.close()

    def decisions(self):
        return [
            pending_decision("near-floor", "Main location", "2026-11-03", group="PDAH", rate=51),
            pending_decision("protected", "Main location", "2026-11-04"),
            pending_decision("excluded-only", "Excluded location", "2026-11-03", group="PDAH"),
            pending_decision("omitted-only", "Omitted location", "2026-11-03", group="CGAV"),
            pending_decision("no-date-row", "Main location", "2026-11-10"),
            pending_decision("no-duration-column", "Main location", "2026-11-03", days=15),
            pending_decision("seeded-zone", "Seeded location", "2026-11-03"),
            pending_decision("multi-zone", "Multi-zone location", "2026-11-03"),
        ]

    def payload(self):
        decisions = self.decisions()
        return {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "recommendation_count": len(decisions),
            "skipped_count": 2,
            "decisions": decisions,
            "recommendations": copy.deepcopy(decisions),
        }

    def test_only_proven_excel_irrelevance_is_held_and_both_arrays_keep_count_semantics(self):
        payload = self.payload()
        original = copy.deepcopy(payload)
        planned, summary = plan_recommendations(self.workbook_path, self.config_path, payload)

        self.assertEqual(payload, original)
        self.assertEqual(len(planned["decisions"]), len(original["decisions"]))
        self.assertEqual(len(planned["recommendations"]), len(original["recommendations"]))
        self.assertEqual(planned["recommendation_count"], 3)
        self.assertEqual(planned["skipped_count"], 2)
        self.assertEqual(summary["pending_active_count"], 8)
        self.assertEqual(summary["pruned_count"], 5)
        self.assertEqual(summary["dom_candidate_count_after"], 3)

        decisions = {item["scenario_id"]: item for item in planned["decisions"]}
        expected_active = {"near-floor", "seeded-zone", "multi-zone"}
        self.assertEqual({key for key, item in decisions.items() if item["action"] != "hold"}, expected_active)
        for scenario_id in {"protected", "excluded-only", "omitted-only", "no-date-row", "no-duration-column"}:
            item = decisions[scenario_id]
            self.assertEqual(item["action"], "hold")
            self.assertEqual(item["data_quality_status"], "excel_ineligible")
            self.assertFalse(item["requires_popularity_verification"])
            self.assertTrue(item["verification_plan_reason"])
            self.assertNotIn("dom_verification_status", item)
            self.assertIsNone(item["site_target_rate_pln_day"])
            self.assertIsNone(item["predicted_site_rate_pln_day"])
        self.assertEqual(decisions["near-floor"]["suggested_rate_pln_day"], 51)

        recommendations = {item["scenario_id"]: item for item in planned["recommendations"]}
        self.assertEqual(recommendations, decisions)
        self.assertEqual(recommendations["protected"]["action"], "hold")
        self.assertEqual(recommendations["near-floor"]["action"], "increase")

    def test_source_ranges_plan_preserves_final_excel_and_near_floor_can_later_increase(self):
        source_before = self.workbook_path.read_bytes()
        original = self.payload()
        planned, _ = plan_recommendations(self.workbook_path, self.config_path, original)
        self.assertEqual(self.workbook_path.read_bytes(), source_before)

        def simulate_later_dom_result(payload):
            result = copy.deepcopy(payload)
            by_id = {item["scenario_id"]: item for item in result["decisions"]}
            for item in by_id.values():
                if item["action"] == "hold":
                    continue
                item["data_quality_status"] = "ok"
                item["requires_popularity_verification"] = False
                item["recommended_ranking"] = confirmed_ranking()
                if item["scenario_id"] in {"near-floor", "seeded-zone", "multi-zone"}:
                    item["suggested_rate_pln_day"] = 81
                    item["maximum_import_rate_pln_day"] = 81
                    item["site_cap_rate_pln_day"] = 81
            for recommendation in result.get("recommendations", []):
                decision = by_id[recommendation["scenario_id"]]
                recommendation.update(decision)
            return result

        config = engine.load_config(self.config_path)
        outputs = []
        for name, payload in (("unplanned", original), ("planned", planned)):
            rec_path = self.root / f"{name}-recommendations.json"
            rec_path.write_text(json.dumps(simulate_later_dom_result(payload)), encoding="utf-8")
            output_path = self.root / f"{name}-rates.xlsx"
            summary = engine.apply_updates(self.workbook_path, rec_path, output_path, config, None, False)
            self.assertTrue(all(row["status"] != "FAIL" for row in summary["validation"]))
            book = openpyxl.load_workbook(output_path, data_only=True, read_only=True)
            outputs.append(list(book["Sheet1"].iter_rows(values_only=True)))
            book.close()

        self.assertEqual(outputs[0], outputs[1])
        main_day = next(row for row in outputs[1] if row[0] == "CDMV" and row[3] == "WA1"
                        and engine.parse_date_value(row[6]).isoformat() == "2026-11-03")
        self.assertEqual(main_day[8], 80)
        self.assertEqual(main_day[9], 90)
        protected_day = next(row for row in outputs[1] if row[0] == "CDMV" and row[3] == "WA1"
                             and engine.parse_date_value(row[6]).isoformat() == "2026-11-04")
        self.assertEqual((protected_day[8], protected_day[9]), (50, 60))
        excluded = next(row for row in outputs[1] if row[0] == "PDAH" and row[3] == "WALO")
        self.assertEqual((excluded[8], excluded[9]), (25, 35))

    def test_window_expansion_is_conservatively_retained_when_date_rows_are_uncertain(self):
        self.config["pickup_date_expansion"] = {
            "enabled": True,
            "mode": "window",
            "start_date": "2026-11-01",
            "end_date": "2026-11-30",
        }
        self.config_path.write_text(json.dumps(self.config), encoding="utf-8")
        planned, summary = plan_recommendations(
            self.workbook_path,
            self.config_path,
            {"decisions": [pending_decision("uncertain-window", "Main location", "2026-11-10")]},
        )
        self.assertEqual(planned["decisions"][0]["action"], "increase")
        self.assertEqual(summary["pruned_count"], 0)
        self.assertEqual(summary["conservative_retained_count"], 1)

    def test_repeated_scenario_id_only_holds_the_matching_location(self):
        decisions = [
            pending_decision("shared-id", "Main location", "2026-11-03"),
            pending_decision("shared-id", "Excluded location", "2026-11-03"),
        ]
        planned, _ = plan_recommendations(
            self.workbook_path,
            self.config_path,
            {"recommendation_count": 2, "decisions": decisions, "recommendations": copy.deepcopy(decisions)},
        )

        statuses = {
            item["location"]: item["action"]
            for item in planned["decisions"]
        }
        recommendation_statuses = {
            item["location"]: item["action"]
            for item in planned["recommendations"]
        }
        self.assertEqual(statuses["Main location"], "increase")
        self.assertEqual(statuses["Excluded location"], "hold")
        self.assertEqual(recommendation_statuses, statuses)

    def test_missing_suggested_rate_stays_pending_for_live_rebuild(self):
        candidate = pending_decision("repairable-rate", "Main location", "2026-11-03")
        candidate["suggested_rate_pln_day"] = None
        planned, summary = plan_recommendations(
            self.workbook_path,
            self.config_path,
            {"decisions": [candidate]},
        )

        self.assertEqual(planned["decisions"][0]["action"], "increase")
        self.assertTrue(planned["decisions"][0]["requires_popularity_verification"])
        self.assertEqual(planned["decisions"][0]["data_quality_status"], "popularity_pending")
        self.assertEqual(summary["pruned_count"], 0)
        self.assertEqual(summary["conservative_retained_count"], 1)

    def test_chained_zone_seeds_fail_open_instead_of_pruning(self):
        self.config["zone_seeds"] = {"WASE": "WA1", "WAX": "WASE"}
        self.config["location_zones"]["Chained seed location"] = ["WAX"]
        self.config_path.write_text(json.dumps(self.config), encoding="utf-8")
        payload = {"decisions": [pending_decision("seed-chain", "Chained seed location", "2026-11-03")]}

        with self.assertRaisesRegex(ValueError, "[Cc]hained zone seeds"):
            plan_recommendations(self.workbook_path, self.config_path, payload)

    def test_cli_errors_leave_output_absent_for_main_workflow_fallback(self):
        self.config["protected_rate_periods"] = [{"start_date": "bad", "end_date": "also-bad"}]
        self.config_path.write_text(json.dumps(self.config), encoding="utf-8")
        rec_path = self.root / "input.json"
        rec_path.write_text(json.dumps(self.payload()), encoding="utf-8")
        output_path = self.root / "planned.json"
        result = subprocess.run(
            [sys.executable, str(ROOT / "tools" / "plan_recommendation_verification.py"),
             "--workbook", str(self.workbook_path), "--recommendations", str(rec_path),
             "--config", str(self.config_path), "--output", str(output_path)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output_path.exists())

    def test_cli_refuses_to_use_workbook_as_output(self):
        recommendations_path = self.root / "input.json"
        recommendations_path.write_text(json.dumps(self.payload()), encoding="utf-8")
        workbook_before = self.workbook_path.read_bytes()

        result = subprocess.run(
            [sys.executable, str(ROOT / "tools" / "plan_recommendation_verification.py"),
             "--workbook", str(self.workbook_path), "--recommendations", str(recommendations_path),
             "--config", str(self.config_path), "--output", str(self.workbook_path)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.workbook_path.read_bytes(), workbook_before)

    def test_cli_writes_plan_and_summary_without_changing_workbook(self):
        recommendations_path = self.root / "input.json"
        recommendations_path.write_text(json.dumps(self.payload()), encoding="utf-8")
        output_path = self.root / "planned.json"
        summary_path = self.root / "summary.json"
        workbook_before = self.workbook_path.read_bytes()

        result = subprocess.run(
            [sys.executable, str(ROOT / "tools" / "plan_recommendation_verification.py"),
             "--workbook", str(self.workbook_path), "--recommendations", str(recommendations_path),
             "--config", str(self.config_path), "--output", str(output_path), "--summary", str(summary_path)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(output_path.exists())
        self.assertEqual(json.loads(output_path.read_text(encoding="utf-8"))["recommendation_count"], 3)
        self.assertEqual(json.loads(summary_path.read_text(encoding="utf-8"))["pruned_count"], 5)
        self.assertEqual(self.workbook_path.read_bytes(), workbook_before)
        validation = subprocess.run(
            ["node", str(ROOT / "src" / "validateVerificationPlan.js"), str(recommendations_path), str(output_path)],
            cwd=ROOT, capture_output=True, text=True, check=False,
        )
        self.assertEqual(validation.returncode, 0, validation.stderr)


if __name__ == "__main__":
    unittest.main()
