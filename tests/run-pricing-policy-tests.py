import json
import sys
import tempfile
import unittest
from pathlib import Path

import openpyxl
from openpyxl.comments import Comment
from openpyxl.styles import PatternFill

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tools.update_excel_rates import apply_updates, get_review_status, merge_config  # noqa: E402


ALLOWED = ["CDMV", "CGAV", "CWAV", "CWMR", "EDAV", "EDMV"]
FROZEN = ["CFAV", "PDAH", "PDAV", "FVMD", "SWAV", "MDMR"]


class PricingPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = merge_config({
            "pricing_rules_file": str(ROOT / "pricing-rules.config.example.json"),
            "location_zones": {"City": ["WA1"]},
            "city_zone_airport_zones": {"WA1": ["WALO"]},
            "protected_rate_periods": [
                {"start_date": "2026-10-31", "end_date": "2026-11-02"},
                {"start_date": "2026-12-15", "end_date": "2027-01-10"},
            ],
            "minimum_rates": {"global_min_pln_day": 50, "bands": []},
        })

    def workbook(self, pickups=("2026-10-01",), airport_rate=40, city_rate=60):
        path = self.root / "baseline.xlsx"
        book = openpyxl.Workbook()
        sheet = book.active
        sheet.title = "Sheet1"
        sheet.append(["Rental rates for packages: INCLUSIVE POA"])
        sheet.append([None] * 8 + [1, 2, 3, 5, 8, 21])
        sheet.append([None] * 8 + [1, 2, 4, 7, 20, 35])
        sheet.append(["Group", "Description", "Rate code", "Zone", "Booking start date",
                      "Booking end date", "Pickup start date", "Pickup end date"] + ["Per day"] * 6)
        for pickup in pickups:
            for zone, rate in (("WA1", city_rate), ("WALO", airport_rate)):
                for group in ALLOWED + FROZEN:
                    adjustment = 1 if group in {"EDAV", "EDMV"} else 0
                    sheet.append([group, None, None, zone, pickup, pickup, pickup, pickup]
                                 + [rate + adjustment] * 6)
        sheet.freeze_panes = "I5"
        sheet["J5"].fill = PatternFill(fill_type="solid", fgColor="FFF2CC")
        sheet["J5"].comment = Comment("Baseline note", "Baseline")
        inherited = book.create_sheet("Inherited Notes")
        inherited["A1"] = "Keep inherited content"
        inherited.freeze_panes = "B3"
        book.save(path)
        book.close()
        return path

    def decision(self, days=2, pickup="2026-10-01", suggested=70, priority=False, **extra):
        return {
            "action": "increase",
            "recommendation_type": "force_top1_undercut" if priority else "top1_gap",
            "priority_rule_id": ("all-locations-autumn-2026-short" if days <= 4
                                 else "all-locations-autumn-2026-week") if priority else None,
            "location": "City", "start_date": pickup, "rental_days": days,
            "suggested_rate_pln_day": suggested, "maximum_import_rate_pln_day": suggested,
            "site_cap_rate_pln_day": suggested, "benchmark_rate_pln_day": suggested + 1,
            "mm_rate_pln_day": 60, "data_quality_status": "ok", "target_rank": 1,
            "scenario_id": f"{pickup}-{days}", **extra,
        }

    def run_updates(self, decisions, source=None, config=None):
        recommendations = self.root / "recommendations.json"
        recommendations.write_text(json.dumps({"decisions": decisions}), encoding="utf-8")
        output = self.root / "review.xlsx"
        import_output = self.root / "import.xlsx"
        summary = apply_updates(
            source or self.workbook(), recommendations, output, config or self.config,
            cli_groups=None, dry_run=False, import_output_path=import_output,
        )
        return summary, output, import_output

    def rates(self, path, column):
        book = openpyxl.load_workbook(path)
        try:
            return {(row[0].value, row[3].value, row[6].value): row[column - 1].value
                    for row in book["Sheet1"].iter_rows(min_row=5)}
        finally:
            book.close()

    def test_priority_wins_city_cap_and_normal_floor_for_all_priority_bands(self):
        for days, column, expected in (([2], 10, 30), ([3, 4], 11, 30), ([5, 6, 7], 12, 40)):
            with self.subTest(days=days):
                source = self.workbook(airport_rate=10, city_rate=35)
                decisions = [self.decision(day, suggested=29, priority=True, action="decrease") for day in days]
                summary, output, _ = self.run_updates(decisions, source)
                self.assertEqual(summary["city_top1_airport_cap_scope_count"], 0)
                self.assertEqual(summary["city_top1_airport_cap_conflict_count"], 0)
                prices = self.rates(output, column)
                for group in ALLOWED:
                    self.assertEqual(prices[group, "WA1", "2026-10-01"], expected + (group in {"EDAV", "EDMV"}))

    def test_normal_cap_floor_conflict_preserves_affected_baseline_and_exports_rest(self):
        config = merge_config({**self.config, "minimum_rates": {
            "global_min_pln_day": 50, "bands": [],
            "scoped_overrides": [{"zones": ["WA1"], "groups": ALLOWED,
                                  "min_days": 2, "max_days": 2, "min_pln_day": 53}],
        }})
        summary, output, import_output = self.run_updates([self.decision(day) for day in (2, 3, 4)], config=config)
        self.assertEqual(summary["city_top1_airport_cap_conflict_count"], 1)
        self.assertEqual(summary["city_top1_airport_cap_violation_count"], 0)
        for path in (output, import_output):
            prices = self.rates(path, 10)
            remaining = self.rates(path, 11)
            for group in ALLOWED:
                adjustment = group in {"EDAV", "EDMV"}
                self.assertEqual(prices[group, "WA1", "2026-10-01"], 60 + adjustment)
                self.assertEqual(remaining[group, "WA1", "2026-10-01"], 52 + adjustment)
            book = openpyxl.load_workbook(path)
            self.assertEqual(book["Sheet1"]["J5"].fill.fgColor.rgb[-6:], "FFF2CC")
            self.assertEqual(book["Sheet1"]["J5"].comment.text, "Baseline note")
            book.close()

    def test_priority_expires_after_october_25_and_normal_cap_resumes(self):
        source = self.workbook(pickups=("2026-10-25", "2026-10-26"))
        summary, output, _ = self.run_updates([
            self.decision(pickup="2026-10-25", suggested=80, priority=True),
            self.decision(pickup="2026-10-26", suggested=80),
        ], source)
        prices = self.rates(output, 10)
        self.assertEqual(prices["CDMV", "WA1", "2026-10-25"], 79)
        self.assertEqual(prices["CDMV", "WA1", "2026-10-26"], 52)
        self.assertEqual(summary["city_top1_airport_cap_scope_count"], 1)

    def test_stale_priority_id_does_not_disable_normal_cap(self):
        source = self.workbook(pickups=("2026-10-26",), airport_rate=60)
        summary, output, _ = self.run_updates([self.decision(pickup="2026-10-26", priority=True)], source)
        self.assertEqual(summary["city_top1_airport_cap_scope_count"], 1)
        self.assertEqual(self.rates(output, 10)["CDMV", "WA1", "2026-10-26"], 60)

    def test_holidays_protect_all_rates_even_with_priority_tag(self):
        pickups = ("2026-10-31", "2026-11-02", "2026-12-15", "2027-01-10")
        source = self.workbook(pickups=pickups)
        before = {column: self.rates(source, column) for column in range(9, 15)}
        summary, output, import_output = self.run_updates([
            self.decision(pickup=pickup, priority=True, suggested=20, action="decrease") for pickup in pickups
        ], source)
        self.assertEqual(summary["change_count"], 0)
        for path in (output, import_output):
            for column in range(9, 15):
                self.assertEqual(self.rates(path, column), before[column])

    def test_premium_plus_one_and_excluded_classes_stay_frozen(self):
        source = self.workbook(city_rate=45)
        before = {column: self.rates(source, column) for column in range(9, 15)}
        _, output, import_output = self.run_updates([self.decision(suggested=50, priority=True)], source)
        for path in (output, import_output):
            prices = self.rates(path, 10)
            for group in ALLOWED:
                self.assertEqual(prices[group, "WA1", "2026-10-01"], 49 + (group in {"EDAV", "EDMV"}))
            for column in range(9, 15):
                prices = self.rates(path, column)
                for key, rate in before[column].items():
                    if key[0] in FROZEN or key[1] == "WALO" or column != 10:
                        self.assertEqual(prices[key], rate)

    def test_approved_8_to_14_evidence_is_not_missing_required_15_to_20(self):
        summary, output, _ = self.run_updates([
            self.decision(day, suggested=45, site_cap_rate_pln_day=50, action="decrease") for day in range(8, 15)
        ])
        incomplete = next(row for row in summary["validation"] if row["check"] == "Niepelne pokrycie przedzialu duration")
        self.assertEqual(incomplete["issue_count"], 0)
        self.assertEqual(summary["skipped_target_count"], 0)
        self.assertEqual(self.rates(output, 13)["CDMV", "WA1", "2026-10-01"], 45)
        book = openpyxl.load_workbook(output)
        for row in book["Recommendations Review"].iter_rows(min_row=2, values_only=True):
            self.assertNotEqual(row[1], "Sprawdz")
            self.assertNotIn("brak danych dla duration", row[2])
        book.close()

    def test_missing_required_14_day_evidence_blocks_whole_8_to_20_band(self):
        summary, output, _ = self.run_updates([self.decision(day, suggested=45, action="decrease") for day in range(8, 14)])
        self.assertEqual(summary["change_count"], 0)
        skipped = next(row for row in summary["validation"] if row["check"] == "Pominiete rekomendacje")
        self.assertIn("lacks scenarios for 14", skipped["details"])
        self.assertEqual(self.rates(output, 13)["EDAV", "WA1", "2026-10-01"], 61)

    def test_invalid_evidence_is_not_an_expected_floor_rank_limit(self):
        decisions = [self.decision(day, suggested=45, action="decrease") for day in range(8, 15)]
        decisions[0]["data_quality_status"] = "missing_mm_rate"
        summary, output, _ = self.run_updates(decisions)
        self.assertEqual(summary["change_count"], 0)
        skipped = next(row for row in summary["validation"] if row["check"] == "Pominiete rekomendacje")
        self.assertIn("missing or invalid constraint data", skipped["details"])
        self.assertEqual(self.rates(output, 13)["CDMV", "WA1", "2026-10-01"], 60)

    def test_expected_floor_and_premium_rank_limits_are_notes_not_bad_evidence(self):
        config = merge_config({**self.config, "city_top1_airport_cap": {"enabled": False}})
        summary, output, _ = self.run_updates([self.decision(suggested=45, action="decrease")], config=config)
        self.assertTrue(all(not change["target_achievable"] for change in summary["changes"]))
        book = openpyxl.load_workbook(output)
        rows = list(book["Recommendations Review"].iter_rows(min_row=2, values_only=True))
        self.assertTrue(rows)
        for row in rows:
            self.assertEqual(row[1], "Gotowe z uwaga")
            self.assertIn("oczekiwane ograniczenie", row[2])
        book.close()
        change = dict(summary["changes"][0], ranking_limit_reason="", benchmark_rate=None)
        self.assertEqual(get_review_status([change]), "Sprawdz")

    def test_premium_only_rank_limit_is_not_reported_as_missing_evidence(self):
        config = merge_config({**self.config, "minimum_rates": {"global_min_pln_day": 0, "bands": []},
                               "city_top1_airport_cap": {"enabled": False}})
        summary, _, _ = self.run_updates([self.decision(suggested=55, action="decrease")], config=config)
        base = next(change for change in summary["changes"] if change["group"] == "CDMV")
        premium = next(change for change in summary["changes"] if change["group"] == "EDAV")
        self.assertTrue(base["target_achievable"])
        self.assertFalse(premium["target_achievable"])
        self.assertEqual(premium["ranking_limit_reason"], "premium")
        self.assertEqual(get_review_status([premium]), "Gotowe z uwaga")

    def test_floor_aware_top2_fallback_is_explicit_in_review(self):
        source = self.workbook(city_rate=45)
        _, output, _ = self.run_updates([
            self.decision(suggested=50, priority=True, target_rank=2, recommendation_type="priority_top3")
        ], source)
        book = openpyxl.load_workbook(output)
        for row in book["Recommendations Review"].iter_rows(min_row=2, values_only=True):
            self.assertEqual(row[1], "Gotowe z uwaga")
            self.assertIn("top2", row[2])
            self.assertIn("oczekiwane ograniczenie", row[2])
        book.close()

    def test_generated_legend_exposes_active_hierarchy_priority_and_protection(self):
        _, output, _ = self.run_updates([])
        book = openpyxl.load_workbook(output)
        self.assertEqual(book["Changed Positions"]["A5"].value, "Hierarchia i scalanie")
        self.assertGreater(book["Changed Positions"].row_dimensions[5].height or 15, 100)
        legend = " ".join(str(cell.value or "") for row in book["Changed Positions"] for cell in row)
        for required in ("Hierarchia", "nadrzedny", "2026-10-25", "2-2", "3-4", "5-7",
                         "30 PLN", "40 PLN", "2026-10-31", "2027-01-10", "EDAV=baza+1", *ALLOWED):
            self.assertIn(required, legend)
        book.close()

    def test_freeze_cleanup_keeps_unfrozen_selections_and_split_views(self):
        source = self.workbook()
        book = openpyxl.load_workbook(source)
        sheet = book.create_sheet("Unfrozen view")
        sheet.sheet_view.selection[0].activeCell = "D7"
        sheet.sheet_view.selection[0].sqref = "D7"
        split = book.create_sheet("Split view")
        split.sheet_view.pane = openpyxl.worksheet.views.Pane(state="split", xSplit=2000)
        book.save(source)
        book.close()
        _, output, _ = self.run_updates([], source)
        book = openpyxl.load_workbook(output)
        self.assertEqual(book["Unfrozen view"].sheet_view.selection[0].activeCell, "D7")
        self.assertEqual(book["Split view"].sheet_view.pane.state, "split")
        book.close()

    def test_config_cannot_reverse_approved_priority_over_city_cap(self):
        rules = json.loads((ROOT / "pricing-rules.config.example.json").read_text(encoding="utf-8"))
        rules["pricing"]["pricingPolicy"] = {
            "precedence": ["protected_dates", "class_allowlist", "required_evidence", "city_airport_cap",
                           "priority_top1", "scoped_floor", "zone_floor", "seasonal_floor", "ranking_target", "premium_parity"],
            "normalFloorCapConflict": "preserve_baseline",
        }
        path = self.root / "invalid-hierarchy.json"
        path.write_text(json.dumps(rules), encoding="utf-8")
        config = {**self.config, "pricing_rules_file": str(path)}
        with self.assertRaisesRegex(ValueError, "pricingPolicy"):
            self.run_updates([self.decision(priority=True)], config=config)

    def test_both_outputs_clear_inherited_and_generated_frozen_panes(self):
        source = self.workbook()
        _, output, import_output = self.run_updates([self.decision(priority=True)], source)
        for path in (output, import_output):
            book = openpyxl.load_workbook(path)
            for sheet in book:
                self.assertIsNone(sheet.freeze_panes, f"{path.name}/{sheet.title}")
                self.assertFalse(any(pane.state in {"frozen", "frozenSplit"}
                                     for view in sheet.views.sheetView for pane in [view.pane] if pane))
            if path == output:
                self.assertEqual(book["Inherited Notes"]["A1"].value, "Keep inherited content")
            else:
                self.assertEqual(book.sheetnames, ["Sheet1"])
            book.close()
        original = openpyxl.load_workbook(source)
        self.assertEqual(original["Sheet1"].freeze_panes, "I5")
        original.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
