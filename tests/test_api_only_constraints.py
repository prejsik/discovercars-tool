import copy
import json
import sys
import tempfile
import unittest
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from tools import update_excel_rates as engine
from excel_test_fixtures import merge_fixture_config


_UNSET = object()


@contextmanager
def open_readonly_workbook(path):
    workbook = openpyxl.load_workbook(path, data_only=True, read_only=True)
    try:
        yield workbook
    finally:
        workbook.close()


def fresh_ranking():
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


def make_selected_candidate(days, *, location="Warsaw", pickup="2026-12-01", cap=121,
                            source_run_id="run-api-only", action="increase", status="ok"):
    now = datetime.now(timezone.utc).isoformat()
    item = {
        "scenario_id": f"{location}-{pickup}-{days}",
        "location": location,
        "group": "CDMV",
        "start_date": pickup,
        "rental_days": days,
        "currency": "PLN",
        "action": action,
        "recommendation_type": "minimum_fallback",
        "target_rank": None,
        "data_quality_status": status,
        "requires_popularity_verification": False,
        "suggested_rate_pln_day": cap if action != "hold" else None,
        "maximum_import_rate_pln_day": cap,
        "site_cap_rate_pln_day": cap,
        "site_target_rate_pln_day": cap if action != "hold" else None,
        "predicted_site_rate_pln_day": cap if action != "hold" else None,
        "benchmark_provider": "Budget",
        "benchmark_rate_pln_day": 150,
        "mm_provider": "MM Cars Rental",
        "mm_rate_pln_day": 100,
        "recommended_ranking": fresh_ranking(),
        "broker_markup_multiplier": 1,
        "broker_markup_amount_pln_day": 0,
        "source_generated_at": now,
        "source_run_id": source_run_id,
        "source_validation_status": "dom_recommendation_verified",
        "dom_verification_status": "confirmed",
        "dom_verified_at": now,
        "dom_verification_reasons": [],
    }
    if action == "hold":
        item.update(maximum_import_rate_pln_day=None, site_cap_rate_pln_day=None)
    return item


def make_api_only_constraint(days, *, location="Warsaw", pickup="2026-12-01", cap=125,
                             source_run_id="run-api-only", **changes):
    item = {
        "scenario_id": f"api-{location}-{pickup}-{days}",
        "location": location,
        "group": "CDMV",
        "start_date": pickup,
        "rental_days": days,
        "currency": "PLN",
        "action": "hold",
        "recommendation_type": "api_constraint_only",
        "target_rank": None,
        "data_quality_status": "api_constraint_only",
        "verification_scope": "api_only_constraint",
        "requires_popularity_verification": False,
        "suggested_rate_pln_day": None,
        "maximum_import_rate_pln_day": cap,
        "site_cap_rate_pln_day": None,
        "site_target_rate_pln_day": None,
        "predicted_site_rate_pln_day": None,
        "api_recommendation_type": "minimum_fallback",
        "api_requires_popularity_verification": True,
        "source_validation_status": "api_unverified",
        "benchmark_provider": "Budget",
        "benchmark_rate_pln_day": 150,
        "mm_provider": "MM Cars Rental",
        "mm_rate_pln_day": 100,
        "source_generated_at": datetime.now(timezone.utc).isoformat(),
        "source_run_id": source_run_id,
    }
    item.update(changes)
    return item


def make_api_only_decisions(*, location="Warsaw", pickup="2026-12-01", selected_cap=121,
                            api_cap=125, source_run_id="run-api-only"):
    items = [
        make_selected_candidate(day, location=location, pickup=pickup, cap=selected_cap,
                                source_run_id=source_run_id)
        for day in (8, 10, 13, 14)
    ]
    items.extend(
        make_api_only_constraint(day, location=location, pickup=pickup, cap=api_cap,
                                 source_run_id=source_run_id)
        for day in (9, 11, 12)
    )
    return items


class ApiOnlyConstraintFixture:
    """Reusable small 8-20 workbook and pricing fixture for Python/JS integration tests."""

    def __init__(self, root, *, api_days=(9, 11, 12), fallback_enabled=True,
                 location_zones=None, group_price_parity=None):
        self.root = Path(root)
        self.rules_path = self.root / "pricing-rules.json"
        self.write_rules(api_days=api_days, fallback_enabled=fallback_enabled)
        self.config = merge_fixture_config({
            "pricing_rules_file": str(self.rules_path),
            "baseline_manifest_file": "",
            "location_zones": location_zones or {"Warsaw": ["WA1"], "Gdansk": ["WALO"]},
            "apply_groups": ["CDMV", "EDMV", "PDAH"],
            "excluded_groups": ["PDAH"],
            "group_price_parity": group_price_parity or {
                "enabled": True,
                "base_groups": ["CDMV"],
                "premium_adjustments_pln_day": {"EDMV": 1},
            },
            "minimum_rates": {
                "global_min_pln_day": 0,
                "scoped_overrides": [],
                "zone_overrides_pln_day": {},
                "bands": [],
            },
            "protected_rate_periods": [],
            "city_top1_airport_cap": {"enabled": False},
            "normalize_pickup_end_to_start": False,
        })
        self.workbook_path = self.root / "source.xlsx"

    def write_rules(self, *, api_days=_UNSET, fallback_enabled=True,
                    group_floors=None, zone_floors=None):
        pricing = {
            "bestAvailableRank": True,
            "recommendedFallbackToMinimum": fallback_enabled,
            "mandatoryGroupFloorsPlnDay": group_floors or {},
            "mandatoryZoneFloorsPlnDay": zone_floors or {},
        }
        if api_days is not _UNSET:
            pricing["apiOnlyConstraintRentalDays"] = api_days
        self.rules_path.write_text(json.dumps({"pricing": pricing}), encoding="utf-8")

    def write_workbook(self, rows=None):
        if rows is None:
            rows = [("CDMV", "WA1", "2026-12-01", 100)]
        workbook = openpyxl.Workbook()
        ws = workbook.active
        ws.title = "Sheet1"
        ws.append(["Rental rates"])
        ws.append([None] * 8 + [8])
        ws.append([None] * 8 + [20])
        ws.append(["Group", "Description", "Rate code", "Zone", "Booking start date", "Booking end date",
                   "Pickup start date", "Pickup end date", "Per day"])
        for group, zone, pickup, rate in rows:
            ws.append([group, None, None, zone, pickup, pickup, pickup, pickup, rate])
        workbook.save(self.workbook_path)
        workbook.close()

    def apply(self, decisions, *, name="case", config=None):
        recommendations_path = self.root / f"{name}-recommendations.json"
        output_path = self.root / f"{name}-review.xlsx"
        import_path = self.root / f"{name}-import.xlsx"
        recommendations_path.write_text(json.dumps({"decisions": decisions}, allow_nan=True), encoding="utf-8")
        summary = engine.apply_updates(
            self.workbook_path, recommendations_path, output_path, config or self.config, None, False,
            import_output_path=import_path,
        )
        return summary, output_path, import_path


class ApiOnlyConstraintTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.fixture = ApiOnlyConstraintFixture(self.temp.name)

    def test_city_cap_uses_retained_airport_rate_after_api_band_block(self):
        for airport_floor in (None, 110):
            with self.subTest(airport_floor=airport_floor):
                fixture = self.fixture
                fixture.config['location_zones'] = {'City': ['WA1'], 'Airport': ['WALO']}
                fixture.config['city_top1_airport_cap'] = {
                    'enabled': True, 'max_multiplier': 1.3,
                    'recommendation_types': ['force_top1_undercut'],
                }
                fixture.config['city_zone_airport_zones'] = {'WA1': ['WALO']}
                fixture.write_workbook([(group, zone, '2026-12-01', 100 + (group == 'EDMV'))
                                        for zone in ('WA1', 'WALO') for group in ('CDMV', 'EDMV')])
                rules = json.loads(fixture.rules_path.read_text())
                rules['pricing']['mandatoryScopedFloorsPlnDay'] = ([] if airport_floor is None else [{
                    'zones': ['WALO'], 'groups': ['CDMV', 'EDMV'],
                    'minDays': 8, 'maxDays': 20, 'minimumRatePlnDay': airport_floor,
                    'startDate': '2026-12-01', 'endDate': '2026-12-01', 'overrideProtected': False,
                }])
                fixture.rules_path.write_text(json.dumps(rules))
                decisions = make_api_only_decisions(location='Airport', selected_cap=121, api_cap=120.5)
                for day in range(8, 15):
                    item = make_selected_candidate(day, location='City', cap=200)
                    item.update(recommendation_type='force_top1_undercut', target_rank=1,
                                benchmark_rate_pln_day=201)
                    decisions.append(item)
                original = fixture.workbook_path.read_bytes()
                summary, review, imported = fixture.apply(decisions, name='blocked-airport')
                expected_airport = airport_floor or 100
                # Premium parity leaves a shared base cap of 1.3 * floor - 1 when
                # the independent scoped floor sets both airport classes to 110.
                expected_city = 142 if airport_floor else 130
                for path in (review, imported):
                    with open_readonly_workbook(path) as book:
                        rates = {(row[3], row[0]): row[8]
                                 for row in book['Sheet1'].iter_rows(min_row=5, values_only=True)}
                    self.assertEqual(rates['WALO', 'CDMV'], expected_airport)
                    self.assertEqual(rates['WA1', 'CDMV'], expected_city)
                    self.assertLessEqual(rates['WA1', 'EDMV'], rates['WALO', 'EDMV'] * 1.3)
                self.assertEqual(summary['city_top1_airport_cap_violation_count'], 0)
                self.assertEqual(summary['city_top1_airport_cap_ignored_count'], 0)
                self.assertEqual(summary['skipped_target_count'], 1)
                city_changes = [item for item in summary['changes'] if item['zone'] == 'WA1']
                self.assertEqual(city_changes[0]['airport_reference_rate'], expected_airport)
                dry_run = engine.apply_updates(fixture.workbook_path,
                    fixture.root / 'blocked-airport-recommendations.json', None, fixture.config, None, True)
                self.assertEqual([(c['cell'], c['new_rate']) for c in dry_run['changes']],
                                 [(c['cell'], c['new_rate']) for c in summary['changes']])
                self.assertEqual(fixture.workbook_path.read_bytes(), original)

    def test_config_helper_defaults_and_strictly_validates_allowed_days(self):
        self.fixture.write_rules(api_days=_UNSET)
        self.assertEqual(engine.get_api_only_constraint_rental_days(self.fixture.config), set())
        self.fixture.write_rules(api_days=[])
        self.assertEqual(engine.get_api_only_constraint_rental_days(self.fixture.config), set())
        self.fixture.write_rules(api_days=[9, 11, 12])
        self.assertEqual(engine.get_api_only_constraint_rental_days(self.fixture.config), {9, 11, 12})

        for value in ([9, 9], [8], [9.0], [True], "9,11,12", None):
            with self.subTest(value=value):
                self.fixture.write_rules(api_days=value)
                with self.assertRaises(ValueError):
                    engine.get_api_only_constraint_rental_days(self.fixture.config)

    def test_valid_references_preserve_full_coverage_and_update_review_and_import_outputs(self):
        self.fixture.write_workbook([
            ("CDMV", "WA1", "2026-12-01", 100),
            ("EDMV", "WA1", "2026-12-01", 101),
            ("PDAH", "WA1", "2026-12-01", 100),
        ])
        summary, review_path, import_path = self.fixture.apply(make_api_only_decisions(api_cap=121), name="valid")

        for output_path in (review_path, import_path):
            with open_readonly_workbook(output_path) as workbook:
                ws = workbook["Sheet1"]
                self.assertEqual(ws["I5"].value, 120)
                self.assertEqual(ws["I6"].value, 121)
                self.assertEqual(ws["I7"].value, 100)
        market_changes = [item for item in summary["changes"] if item["recommendation_type"] == "minimum_fallback"]
        self.assertTrue(market_changes)
        self.assertEqual(market_changes[0]["covered_duration_days"], list(range(8, 15)))
        self.assertEqual(market_changes[0]["source_active_count"], 4)
        self.assertEqual(market_changes[0]["source_decision_count"], 7)
        self.assertTrue(all(item["target_achievable"] for item in market_changes))

    def test_api_references_accept_trusted_complete_dom_source_aliases(self):
        for source_status in ("dom_fallback", "dom_only", "api_dom_conflict_dom_used"):
            with self.subTest(source_status=source_status):
                decisions = make_api_only_decisions()
                for item in decisions:
                    if item["recommendation_type"] == "api_constraint_only":
                        item["source_validation_status"] = source_status
                targets, skipped = engine.build_targets(
                    decisions, {day: (9, "8-20", 8, 20) for day in range(8, 21)}, self.fixture.config
                )
                self.assertTrue(targets)
                self.assertFalse(skipped)

    def test_cached_dom_status_and_all_trusted_source_aliases_satisfy_selected_evidence(self):
        for source_status in (
            "dom_confirmed", "api_dom_conflict_dom_used", "dom_fallback", "dom_only",
            "dom_recommendation_verified",
        ):
            with self.subTest(source_status=source_status):
                decisions = make_api_only_decisions()
                for item in decisions:
                    if item["recommendation_type"] != "api_constraint_only":
                        item["source_validation_status"] = source_status
                        item["dom_verification_status"] = "confirmed_existing_dom"
                targets, skipped = engine.build_targets(
                    decisions, {day: (9, "8-20", 8, 20) for day in range(8, 21)}, self.fixture.config
                )
                self.assertTrue(targets)
                self.assertFalse(skipped)

    def test_all_dom_replacement_days_still_require_exact_once_coverage_and_one_run(self):
        decisions = [make_selected_candidate(day, cap=119 if day == 9 else 121) for day in range(8, 15)]
        for item in decisions:
            item["dom_verification_status"] = "confirmed_existing_dom"
        columns = {day: (9, "8-20", 8, 20) for day in range(8, 21)}

        targets, skipped = engine.build_targets(decisions, columns, self.fixture.config)
        self.assertEqual(sum(len(items) for dates in targets.values() for items in dates.values()), 1)
        self.assertFalse(skipped)
        self.fixture.write_workbook([
            ("CDMV", "WA1", "2026-12-01", 100),
            ("EDMV", "WA1", "2026-12-01", 101),
        ])
        summary, review_path, import_path = self.fixture.apply(decisions, name="cached-all-dom")
        for output_path in (review_path, import_path):
            with open_readonly_workbook(output_path) as workbook:
                self.assertEqual(workbook["Sheet1"]["I5"].value, 118)
                self.assertEqual(workbook["Sheet1"]["I6"].value, 119)
        self.assertEqual(summary["change_count"], 2)

        duplicate = decisions + [copy.deepcopy(decisions[1])]
        mixed_run = copy.deepcopy(decisions)
        mixed_run[3]["source_run_id"] = "another-run"
        for label, invalid in (("duplicate", duplicate), ("mixed run", mixed_run)):
            with self.subTest(case=label):
                invalid_targets, invalid_skips = engine.build_targets(invalid, columns, self.fixture.config)
                self.assertEqual(sum(len(items) for dates in invalid_targets.values() for items in dates.values()), 0)
                self.assertTrue(invalid_skips)

    def test_fresh_dom_decision_can_replace_configured_api_reference_without_audit_marker(self):
        for repair_day in (9, 11, 12):
            with self.subTest(repair_day=repair_day):
                self.fixture.write_workbook([
                    ("CDMV", "WA1", "2026-12-01", 100),
                    ("EDMV", "WA1", "2026-12-01", 101),
                ])
                decisions = make_api_only_decisions(selected_cap=121, api_cap=121)
                decisions = [item for item in decisions if not (
                    item["rental_days"] == repair_day and item["recommendation_type"] == "api_constraint_only"
                )]
                decisions.append(make_selected_candidate(repair_day, cap=119, source_run_id="run-api-only"))
                decisions[-1]["dom_verification_status"] = "confirmed_existing_dom"

                summary, review_path, import_path = self.fixture.apply(
                    decisions, name=f"fresh-dom-replacement-{repair_day}"
                )

                for output_path in (review_path, import_path):
                    with open_readonly_workbook(output_path) as workbook:
                        ws = workbook["Sheet1"]
                        self.assertEqual(ws["I5"].value, 118)
                        self.assertEqual(ws["I6"].value, 119)
                self.assertEqual(summary["change_count"], 2)

    def test_stale_untrusted_or_cross_run_dom_replacement_preserves_shared_band(self):
        mutations = {
            "stale DOM proof": lambda item: item.update(
                dom_verified_at=(datetime.now(timezone.utc) - timedelta(hours=13)).isoformat()
            ),
            "untrusted source": lambda item: item.update(source_validation_status="api_dom_conflict_api_used"),
            "different run": lambda item: item.update(source_run_id="other-run"),
        }
        for label, mutate in mutations.items():
            with self.subTest(case=label):
                self.fixture.write_workbook([
                    ("CDMV", "WA1", "2026-12-01", 100),
                    ("EDMV", "WA1", "2026-12-01", 101),
                ])
                decisions = make_api_only_decisions(selected_cap=121, api_cap=121)
                decisions = [item for item in decisions if not (
                    item["rental_days"] == 9 and item["recommendation_type"] == "api_constraint_only"
                )]
                replacement = make_selected_candidate(9, cap=119, source_run_id="run-api-only")
                mutate(replacement)
                decisions.append(replacement)

                summary, review_path, import_path = self.fixture.apply(decisions, name=f"invalid-dom-{label}")

                for output_path in (review_path, import_path):
                    with open_readonly_workbook(output_path) as workbook:
                        ws = workbook["Sheet1"]
                        self.assertEqual(ws["I5"].value, 100)
                        self.assertEqual(ws["I6"].value, 101)
                self.assertFalse(any(item["recommendation_type"] == "minimum_fallback"
                                     for item in summary["changes"]))

    def test_dom_replacement_requires_pln_mm_and_competitor_price_evidence(self):
        mutations = {
            "non-PLN currency": lambda item: item.update(currency="EUR"),
            "MM provider mismatch": lambda item: item.update(mm_provider="Budget"),
            "MM used as benchmark": lambda item: item.update(benchmark_provider="MM-Cars Rental"),
            "missing MM rate": lambda item: item.update(mm_rate_pln_day=None),
            "boolean MM rate": lambda item: item.update(mm_rate_pln_day=True),
            "missing competitor rate": lambda item: item.update(benchmark_rate_pln_day=None),
        }
        columns = {day: (9, "8-20", 8, 20) for day in range(8, 21)}
        for label, mutate in mutations.items():
            with self.subTest(case=label):
                decisions = make_api_only_decisions()
                decisions = [item for item in decisions if not (
                    item["rental_days"] == 9 and item["recommendation_type"] == "api_constraint_only"
                )]
                replacement = make_selected_candidate(9, cap=119, source_run_id="run-api-only")
                mutate(replacement)
                decisions.append(replacement)

                targets, skipped = engine.build_targets(decisions, columns, self.fixture.config)

                self.assertEqual(sum(len(items) for dates in targets.values() for items in dates.values()), 0)
                self.assertTrue(skipped)

    def test_pending_dom_repair_with_null_prices_cannot_authorize_export(self):
        self.fixture.write_workbook([
            ("CDMV", "WA1", "2026-12-01", 100),
            ("EDMV", "WA1", "2026-12-01", 101),
        ])
        decisions = make_api_only_decisions()
        pending = copy.deepcopy(next(
            item for item in decisions
            if item["rental_days"] == 9 and item["recommendation_type"] == "api_constraint_only"
        ))
        decisions.remove(next(
            item for item in decisions
            if item["rental_days"] == 9 and item["recommendation_type"] == "api_constraint_only"
        ))
        pending.update(
            action="increase",
            recommendation_type="api_constraint_repair_pending",
            data_quality_status="api_constraint_repair_pending",
            verification_scope="api_constraint_dom_repair",
            requires_dom_constraint_repair=True,
            suggested_rate_pln_day=None,
            maximum_import_rate_pln_day=None,
            site_cap_rate_pln_day=None,
            site_target_rate_pln_day=None,
            predicted_site_rate_pln_day=None,
        )
        decisions.append(pending)

        summary, review_path, import_path = self.fixture.apply(decisions, name="pending-dom-repair")

        for output_path in (review_path, import_path):
            with open_readonly_workbook(output_path) as workbook:
                ws = workbook["Sheet1"]
                self.assertEqual(ws["I5"].value, 100)
                self.assertEqual(ws["I6"].value, 101)
        self.assertFalse(any(item["recommendation_type"] == "minimum_fallback"
                             for item in summary["changes"]))

    def test_lower_api_cap_blocks_only_its_bucket_without_controlling_the_rate(self):
        self.fixture.write_workbook([
            ("CDMV", "WA1", "2026-12-01", 100),
            ("CDMV", "WALO", "2026-12-01", 100),
        ])
        decisions = make_api_only_decisions(location="Warsaw", api_cap=119.99)
        decisions.extend(make_api_only_decisions(location="Gdansk", api_cap=125))
        summary, output_path, _ = self.fixture.apply(decisions, name="lower-cap")

        with open_readonly_workbook(output_path) as workbook:
            rows = list(workbook["Sheet1"].iter_rows(min_row=5, values_only=True))
        self.assertEqual(next(row for row in rows if row[3] == "WA1")[8], 100)
        self.assertEqual(next(row for row in rows if row[3] == "WALO")[8], 120)
        self.assertEqual(summary["change_count"], 1)
        self.assertTrue(any("API-only cap" in str(item["details"]) for item in summary["validation"]))

    def test_api_cap_above_final_import_rate_does_not_veto_raw_selected_rate(self):
        self.fixture.write_workbook([("CDMV", "WA1", "2026-12-01", 100)])
        decisions = make_api_only_decisions(selected_cap=121, api_cap=120.50)
        summary, output_path, _ = self.fixture.apply(decisions, name="cap-above-final")

        with open_readonly_workbook(output_path) as workbook:
            self.assertEqual(workbook["Sheet1"]["I5"].value, 120)
        self.assertEqual(summary["change_count"], 1)
        self.assertFalse(any("API-only cap" in str(item["details"]) for item in summary["validation"]))

    def test_city_cap_can_reduce_final_rate_below_api_cap(self):
        self.fixture.config["city_top1_airport_cap"] = {
            "enabled": True,
            "max_multiplier": 1.3,
            "recommendation_types": ["minimum_fallback"],
        }
        self.fixture.config["city_zone_airport_zones"] = {"WA1": ["WALO"]}
        self.fixture.write_workbook([
            ("CDMV", "WA1", "2026-12-01", 100),
            ("CDMV", "WALO", "2026-12-01", 90),
        ])
        decisions = make_api_only_decisions(selected_cap=121, api_cap=120.50)
        summary, output_path, _ = self.fixture.apply(decisions, name="city-cap-final")

        with open_readonly_workbook(output_path) as workbook:
            self.assertEqual(workbook["Sheet1"]["I5"].value, 117)
            self.assertEqual(workbook["Sheet1"]["I6"].value, 90)
        self.assertEqual(summary["city_top1_airport_cap_applied_count"], 1)
        self.assertEqual(summary["change_count"], 1)
        self.assertFalse(any("API-only cap" in str(item["details"]) for item in summary["validation"]))

    def test_api_blocked_city_preserves_baseline_above_airport_cap_without_blocking_other_dates(self):
        self.fixture.config["city_top1_airport_cap"] = {
            "enabled": True, "max_multiplier": 1.3, "recommendation_types": ["minimum_fallback"],
        }
        self.fixture.config["city_zone_airport_zones"] = {"WA1": ["WALO"]}
        self.fixture.write_workbook([
            ("CDMV", "WA1", "2026-12-01", 80),
            ("EDMV", "WA1", "2026-12-01", 80),
            ("PDAH", "WA1", "2026-12-01", 250),
            ("CDMV", "WALO", "2026-12-01", 60),
            ("EDMV", "WALO", "2026-12-01", 60),
            ("CDMV", "WA1", "2026-12-02", 100),
            ("EDMV", "WA1", "2026-12-02", 101),
            ("CDMV", "WALO", "2026-12-02", 100),
            ("EDMV", "WALO", "2026-12-02", 101),
        ])
        original = self.fixture.workbook_path.read_bytes()
        decisions = make_api_only_decisions(api_cap=76)
        decisions += make_api_only_decisions(pickup="2026-12-02", api_cap=150)
        summary, review_path, import_path = self.fixture.apply(decisions, name="preserved-city-over-cap")
        for path in (review_path, import_path):
            with open_readonly_workbook(path) as book:
                ws = book["Sheet1"]
                self.assertEqual(ws['I5'].value, 80)
                self.assertEqual(ws['I6'].value, 80)
                self.assertEqual(ws['I7'].value, 250)
                self.assertEqual(ws['I10'].value, 120)
                self.assertEqual(ws['I11'].value, 121)
        self.assertEqual(summary['city_top1_airport_cap_preserved_count'], 2)
        self.assertEqual(summary['city_top1_airport_cap_violation_count'], 0)
        self.assertEqual(summary['change_count'], 2)
        self.assertTrue(any('API-only cap' in str(item['details']) for item in summary['validation']))
        self.assertFalse(any(item['status'] == 'FAIL' for item in summary['validation']))
        self.assertEqual(self.fixture.workbook_path.read_bytes(), original)

    def test_market_target_holds_above_api_cap_but_independent_mandatory_floor_still_applies(self):
        self.fixture.write_rules(
            api_days=[9, 11, 12],
            group_floors={"CDMV": [{"minDays": 8, "maxDays": 20, "minimumRatePlnDay": 125}]},
        )
        self.fixture.write_workbook([("CDMV", "WA1", "2026-12-01", 100)])
        decisions = make_api_only_decisions(selected_cap=121, api_cap=121)
        summary, output_path, _ = self.fixture.apply(decisions, name="floor-over-cap")

        with open_readonly_workbook(output_path) as workbook:
            self.assertEqual(workbook["Sheet1"]["I5"].value, 125)
        self.assertEqual(summary["mandatory_group_floor_change_count"], 1)
        self.assertFalse(any(item["recommendation_type"] == "minimum_fallback" for item in summary["changes"]))
        self.assertTrue(any("API-only cap" in str(item["details"]) for item in summary["validation"]))

    def test_selected_dom_failure_and_popular_top1_hold_refuse_the_shared_band(self):
        base = make_api_only_decisions()
        failures = []
        failed_dom = copy.deepcopy(base)
        failed_dom[0].update(action="hold", data_quality_status="dom_recommendation_failed",
                             maximum_import_rate_pln_day=None, site_cap_rate_pln_day=None)
        failures.append(("dom-failure", failed_dom))
        mm_top1 = copy.deepcopy(base)
        mm_top1[0].update(action="hold", data_quality_status="popular_top1_preserved",
                          maximum_import_rate_pln_day=None, site_cap_rate_pln_day=None,
                          recommended_ranking={**fresh_ranking(), "top_offer": {
                              "provider_name": "MM Cars Rental", "total_price": 150,
                              "currency": "PLN", "transmission": "automatic",
                          }})
        failures.append(("popular-top1", mm_top1))

        for name, decisions in failures:
            with self.subTest(name=name):
                self.fixture.write_workbook([("CDMV", "WA1", "2026-12-01", 100)])
                summary, output_path, _ = self.fixture.apply(decisions, name=name)
                with open_readonly_workbook(output_path) as workbook:
                    self.assertEqual(workbook["Sheet1"]["I5"].value, 100)
                self.assertFalse(any(item["recommendation_type"] == "minimum_fallback" for item in summary["changes"]))

    def test_invalid_api_reference_only_skips_its_cell_bucket(self):
        self.fixture.write_workbook([
            ("CDMV", "WA1", "2026-12-01", 100),
            ("CDMV", "WALO", "2026-12-01", 100),
        ])
        decisions = make_api_only_decisions(location="Warsaw")
        stale = (datetime.now(timezone.utc) - timedelta(hours=13)).isoformat()
        decisions[4]["source_generated_at"] = stale
        decisions.extend(make_api_only_decisions(location="Gdansk"))
        summary, output_path, _ = self.fixture.apply(decisions, name="invalid-one-bucket")

        with open_readonly_workbook(output_path) as workbook:
            rows = list(workbook["Sheet1"].iter_rows(min_row=5, values_only=True))
        self.assertEqual(next(row for row in rows if row[3] == "WA1")[8], 100)
        self.assertEqual(next(row for row in rows if row[3] == "WALO")[8], 120)
        self.assertEqual(summary["change_count"], 1)

    def test_special_protection_exclusion_premium_floor_and_szlo_rules_remain(self):
        self.fixture.write_rules(
            api_days=[9, 11, 12],
            group_floors={"CDMV": [{"minDays": 8, "maxDays": 20, "minimumRatePlnDay": 90}]},
        )
        self.fixture.config["protected_rate_periods"] = [
            {"start_date": "2026-12-02", "end_date": "2026-12-02"}
        ]
        self.fixture.write_workbook([
            ("CDMV", "WA1", "2026-12-01", 100),
            ("EDMV", "WA1", "2026-12-01", 101),
            ("PDAH", "WA1", "2026-12-01", 100),
            ("CDMV", "WA1", "2026-12-02", 90),
            ("CDMV", "SZLO", "2026-12-01", 80),
            ("FVMD", "SZLO", "2026-12-01", 70),
        ])
        decisions = make_api_only_decisions()
        protected = make_selected_candidate(8, pickup="2026-12-02")
        decisions.append(protected)
        summary, output_path, _ = self.fixture.apply(decisions, name="policy-edges")

        with open_readonly_workbook(output_path) as workbook:
            rows = list(workbook["Sheet1"].iter_rows(min_row=5, values_only=True))
        by_key = {(row[0], row[3], engine.parse_date_value(row[6]).isoformat()): row[8] for row in rows}
        self.assertEqual(by_key[("CDMV", "WA1", "2026-12-01")], 120)
        self.assertEqual(by_key[("EDMV", "WA1", "2026-12-01")], 121)
        self.assertEqual(by_key[("PDAH", "WA1", "2026-12-01")], 100)
        self.assertEqual(by_key[("CDMV", "WA1", "2026-12-02")], 90)
        self.assertEqual(by_key[("CDMV", "SZLO", "2026-12-01")], 90)
        self.assertNotIn(("FVMD", "SZLO", "2026-12-01"), by_key)
        self.assertEqual(summary["mandatory_group_floor_change_count"], 1)
        self.assertEqual(summary["omitted_group_zone_rows"]["removed_row_count"], 1)

    def test_missing_day_duplicates_bad_metadata_tampering_and_bad_caps_block(self):
        valid = make_api_only_decisions()
        corruptions = {
            "missing selected 14": valid[:3] + valid[4:],
            "duplicate selected 8": valid + [copy.deepcopy(valid[0])],
            "duplicate api 9": valid + [copy.deepcopy(valid[4])],
            "wrong api day": valid[:4] + [make_api_only_constraint(15)] + valid[5:],
            "stale": valid[:4] + [make_api_only_constraint(9, source_generated_at=(datetime.now(timezone.utc) - timedelta(hours=13)).isoformat())] + valid[5:],
            "naive timestamp": valid[:4] + [make_api_only_constraint(9, source_generated_at="2026-12-01T00:00:00")] + valid[5:],
            "future timestamp": valid[:4] + [make_api_only_constraint(9, source_generated_at=(datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat())] + valid[5:],
            "boolean cap": valid[:4] + [make_api_only_constraint(9, cap=True)] + valid[5:],
            "nonfinite cap": valid[:4] + [make_api_only_constraint(9, cap=float("nan"))] + valid[5:],
            "missing run id": valid[:4] + [make_api_only_constraint(9, source_run_id=" ")] + valid[5:],
            "run mismatch": valid[:4] + [make_api_only_constraint(9, source_run_id="other-run")] + valid[5:],
            "tampered active": valid[:4] + [make_api_only_constraint(9, action="increase")] + valid[5:],
            "tampered DOM confirmation": valid[:4] + [make_api_only_constraint(9, dom_verification_status="confirmed")] + valid[5:],
            "API conflict used": valid[:4] + [
                make_api_only_constraint(9, source_validation_status="api_dom_conflict_api_used")
            ] + valid[5:],
            "DOM validation failed": valid[:4] + [
                make_api_only_constraint(9, source_validation_status="dom_validation_failed_api_used")
            ] + valid[5:],
            "MM benchmark": valid[:4] + [
                make_api_only_constraint(9, benchmark_provider="MM-Cars Rental")
            ] + valid[5:],
            "ineligible original recommendation": valid[:4] + [
                make_api_only_constraint(9, api_recommendation_type="top1_gap")
            ] + valid[5:],
            "missing currency": valid[:4] + [make_api_only_constraint(9, currency="EUR")] + valid[5:],
            "missing MM": valid[:4] + [make_api_only_constraint(9, mm_provider="Budget")] + valid[5:],
            "missing benchmark": valid[:4] + [make_api_only_constraint(9, benchmark_rate_pln_day=None)] + valid[5:],
        }
        for label, decisions in corruptions.items():
            with self.subTest(corruption=label):
                targets, skipped = engine.build_targets(decisions, {day: (9, "8-20", 8, 20) for day in range(8, 21)}, self.fixture.config)
                self.assertFalse(targets)
                self.assertTrue(skipped)

    def test_disabled_policy_and_ordinary_invalid_holds_still_block(self):
        valid = make_api_only_decisions()
        self.fixture.write_rules(api_days=[9, 11, 12], fallback_enabled=False)
        targets, skipped = engine.build_targets(valid, {day: (9, "8-20", 8, 20) for day in range(8, 21)}, self.fixture.config)
        self.assertFalse(targets)
        self.assertTrue(skipped)

        self.fixture.write_rules(api_days=[9, 11, 12], fallback_enabled=True)
        ordinary_hold = make_selected_candidate(9, action="hold", status="popularity_pending")
        candidates = [item for item in valid if item["rental_days"] != 9] + [ordinary_hold]
        targets, skipped = engine.build_targets(candidates, {day: (9, "8-20", 8, 20) for day in range(8, 21)}, self.fixture.config)
        self.assertFalse(targets)
        self.assertTrue(skipped)

    def test_other_location_cannot_complete_this_locations_shared_cell_coverage(self):
        self.fixture.config["location_zones"]["Warsaw City"] = ["WA1"]
        decisions = make_api_only_decisions()
        decisions = [item for item in decisions if not (item["location"] == "Warsaw" and item["rental_days"] == 14)]
        decisions.append(make_selected_candidate(14, location="Warsaw City"))
        targets, skipped = engine.build_targets(
            decisions, {day: (9, "8-20", 8, 20) for day in range(8, 21)}, self.fixture.config
        )
        self.assertFalse(targets)
        self.assertTrue(skipped)

    def test_enabled_policy_legend_names_configured_api_days_and_full_confirmation_days(self):
        self.fixture.write_rules(api_days=[9, 12])
        legend = engine.get_pricing_hierarchy_legend_text(self.fixture.config)
        self.assertIn("Dla 9,12 dni tylko ograniczenia z API", legend)
        self.assertIn("pelne potwierdzenia 8,10,11,13,14", legend)
        self.assertIn("Odczyt API nie wyznacza sam stawke", legend)


if __name__ == "__main__":
    unittest.main()
