import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from tools import update_excel_rates as engine
from excel_test_fixtures import merge_fixture_config


def recommended_ranking(provider="Budget", **changes):
    return {
        "status": "confirmed",
        "sort": "Recommended",
        "transmission": "automatic",
        "top_offer": {
            "provider_name": provider,
            "total_price": 150,
            "currency": "PLN",
            "transmission": "automatic",
        },
        "observed_at": datetime.now(timezone.utc).isoformat(),
        **changes,
    }


def fallback_item(days, *, rate=51, recommendation_type="minimum_fallback", rank=None,
                  status="ok", ranking=None, action="decrease", markup=True):
    item = {
        "location": "Test location",
        "start_date": "2026-11-03",
        "rental_days": days,
        "action": action,
        "recommendation_type": recommendation_type,
        "target_rank": rank,
        "suggested_rate_pln_day": rate if action != "hold" else None,
        "maximum_import_rate_pln_day": rate if action != "hold" else None,
        "data_quality_status": status,
        "recommended_ranking": ranking,
        "benchmark_provider": "Budget",
        "benchmark_rate_pln_day": 110,
        "mm_rate_pln_day": 120,
    }
    if markup:
        item.update(broker_markup_multiplier=1.2, broker_markup_amount_pln_day=5)
    return item


class PricePopularityMinimumTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.pricing_path = self.root / "pricing.json"
        self.pricing_path.write_text('{"pricing": {}}', encoding="utf-8")
        self.config = merge_fixture_config({
            "pricing_rules_file": str(self.pricing_path),
            "location_zones": {"Test location": ["WA1", "SZLO"]},
            "minimum_rates": {
                "global_min_pln_day": 50,
                "zone_overrides_pln_day": {"SZLO": 150},
                "bands": [],
            },
            "duration_band_evidence_max_days": {},
            "city_top1_airport_cap": {"enabled": False},
            "protected_rate_periods": [],
        })
        self.duration_columns = {
            3: (9, "3-4", 3, 4),
            4: (9, "3-4", 3, 4),
        }

    def paired_fallbacks(self, **kwargs):
        return [
            fallback_item(days, ranking=recommended_ranking(), **kwargs)
            for days in (3, 4)
        ]

    def test_confirmed_fallback_uses_floor_after_reserve_and_reports_no_rank_goal(self):
        targets, skipped = engine.build_targets(
            self.paired_fallbacks(), self.duration_columns, self.config
        )

        self.assertFalse(skipped)
        target = targets["WA1"][datetime.fromisoformat("2026-11-03").date()][0]
        self.assertEqual(target["recommendation_type"], "minimum_fallback")
        self.assertIsNone(target["target_rank"])
        self.assertEqual(target["suggested_rate_pln_day"], 51)
        self.assertEqual(target["site_cap_rate_pln_day"], 66.2)
        self.assertEqual(
            [item["maximum_import_rate_pln_day"] for item in target["constraint_items"]],
            [51, 51],
        )
        base_rate, suggested_rate, minimum_rate, _ = engine.calculate_target_base_rate(
            target, 120, self.config
        )
        self.assertEqual((base_rate, suggested_rate, minimum_rate), (50, 50, 50))

        self.assertEqual(engine.get_recommendation_label_pl(target), "Fallback do minimum ceny")
        reason = engine.get_recommendation_reason_pl(target)
        outcome = engine.get_recommendation_outcome_pl(target)
        comment = engine.build_rate_comment({
            **target,
            "old_rate": 120,
            "new_rate": 50,
            "delta": -70,
        }).text
        self.assertIn("minimum", reason.lower())
        self.assertIn("bez celu rankingowego", outcome.lower())
        self.assertIn("fallback do minimum", comment.lower())
        self.assertNotIn("top1 przy cenie", f"{reason} {outcome} {comment}".lower())

    def test_invalid_or_stale_recommended_evidence_blocks_the_entire_bucket(self):
        stale = (datetime.now(timezone.utc) - timedelta(hours=13)).isoformat()
        future = (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat()
        corruptions = {
            "missing": None,
            "failed": {**recommended_ranking(), "status": "failed"},
            "wrong sort": {**recommended_ranking(), "sort": "Price"},
            "manual sort": {**recommended_ranking(), "transmission": "manual"},
            "manual offer": recommended_ranking(top_offer={
                "provider_name": "Budget", "total_price": 150, "currency": "PLN", "transmission": "manual",
            }),
            "non-PLN": recommended_ranking(top_offer={
                "provider_name": "Budget", "total_price": 150, "currency": "EUR", "transmission": "automatic",
            }),
            "MM first": recommended_ranking("MM Cars Rental"),
            "MM rating suffix": recommended_ranking("MM Cars Rental (rating 9.2)"),
            "MM punctuation suffix": recommended_ranking("Prestige MM-Cars Rental Sp. z o.o."),
            "stale": {**recommended_ranking(), "observed_at": stale},
            "future": {**recommended_ranking(), "observed_at": future},
            "invalid price": recommended_ranking(top_offer={
                "provider_name": "Budget", "total_price": 0, "currency": "PLN", "transmission": "automatic",
            }),
            "boolean price": recommended_ranking(top_offer={
                "provider_name": "Budget", "total_price": True, "currency": "PLN", "transmission": "automatic",
            }),
            "string price": recommended_ranking(top_offer={
                "provider_name": "Budget", "total_price": "150", "currency": "PLN", "transmission": "automatic",
            }),
            "missing provider": recommended_ranking(top_offer={
                "provider_name": " ", "total_price": 150, "currency": "PLN", "transmission": "automatic",
            }),
            "numeric provider": recommended_ranking(top_offer={
                "provider_name": 123, "total_price": 150, "currency": "PLN", "transmission": "automatic",
            }),
        }
        for label, evidence in corruptions.items():
            with self.subTest(evidence=label):
                candidates = [fallback_item(days, ranking=evidence) for days in (3, 4)]
                targets, skipped = engine.build_targets(candidates, self.duration_columns, self.config)
                self.assertFalse(targets)
                self.assertTrue(skipped)

    def test_pending_and_preserved_popular_top1_candidates_hold_shared_bucket(self):
        pending = [
            fallback_item(days, status="popularity_pending", ranking=recommended_ranking())
            for days in (3, 4)
        ]
        targets, skipped = engine.build_targets(pending, self.duration_columns, self.config)
        self.assertFalse(targets)
        self.assertTrue(skipped)

        mixed = [
            fallback_item(3, ranking=recommended_ranking()),
            fallback_item(
                4,
                action="hold",
                recommendation_type="force_top1_maintain",
                rank=1,
                status="popular_top1_preserved",
                ranking=recommended_ranking("MM Cars Rental"),
                markup=False,
            ),
        ]
        targets, skipped = engine.build_targets(mixed, self.duration_columns, self.config)
        self.assertFalse(targets)
        self.assertTrue(skipped)

    def test_mixed_top1_and_fallback_duration_bucket_is_unranked_fallback(self):
        candidates = [
            fallback_item(
                3,
                rate=51,
                recommendation_type="force_top1_maintain",
                rank=1,
                ranking=None,
            ),
            fallback_item(4, rate=61, ranking=recommended_ranking()),
        ]
        targets, skipped = engine.build_targets(candidates, self.duration_columns, self.config)

        self.assertFalse(skipped)
        target = targets["WA1"][datetime.fromisoformat("2026-11-03").date()][0]
        self.assertEqual(target["recommendation_type"], "minimum_fallback")
        self.assertIsNone(target["target_rank"])
        self.assertEqual(target["suggested_rate_pln_day"], 51)
        self.assertEqual(target["recommended_ranking"]["top_offer"]["provider_name"], "Budget")

    def test_workbook_preserves_protected_and_disallowed_rows_and_higher_szlo_floor(self):
        self.config.update(
            apply_groups=["CDMV", "PDAH"],
            excluded_groups=["PDAH"],
            protected_rate_periods=[{"start_date": "2026-11-04", "end_date": "2026-11-04"}],
            normalize_pickup_end_to_start=False,
        )
        self.config["minimum_rates"]["global_min_pln_day"] = 50
        self.config["minimum_rates"]["zone_overrides_pln_day"] = {"SZLO": 150}

        workbook = openpyxl.Workbook()
        ws = workbook.active
        ws.title = "Sheet1"
        ws.append(["Rental rates"])
        ws.append([None] * 8 + [3])
        ws.append([None] * 8 + [4])
        ws.append(["Group", "Description", "Rate code", "Zone", "Booking start date", "Booking end date",
                   "Pickup start date", "Pickup end date", "Per day"])
        for group, zone, pickup in (
            ("CDMV", "WA1", "2026-11-03"),
            ("PDAH", "WA1", "2026-11-03"),
            ("CFAV", "WA1", "2026-11-03"),
            ("CDMV", "WA1", "2026-11-04"),
            ("CDMV", "SZLO", "2026-11-03"),
        ):
            ws.append([group, None, None, zone, pickup, pickup, pickup, pickup, 120])
        source = self.root / "source.xlsx"
        workbook.save(source)
        workbook.close()

        recommendations = self.root / "recommendations.json"
        decisions = [
            fallback_item(days, ranking=recommended_ranking("Recommended First"))
            for days in (3, 4)
        ]
        recommendations.write_text(json.dumps({"decisions": decisions}), encoding="utf-8")
        output = self.root / "review.xlsx"
        summary = engine.apply_updates(source, recommendations, output, self.config, None, False)

        result = openpyxl.load_workbook(output)
        rows = list(result["Sheet1"].iter_rows(min_row=5, values_only=True))
        comment = result["Sheet1"]["I5"].comment.text
        result.close()
        self.assertEqual([row[8] for row in rows], [50, 120, 120, 120, 150])
        self.assertIn("Recommended First jest pierwszy w sortowaniu Recommended", comment)
        self.assertNotIn("Budget jest pierwszy w sortowaniu Recommended", comment)
        self.assertTrue(all(row["status"] != "FAIL" for row in summary["validation"]))


if __name__ == "__main__":
    unittest.main()
