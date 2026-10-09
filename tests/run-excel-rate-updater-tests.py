import json
import sys
import tempfile
import zipfile
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path
from xml.etree import ElementTree
from zoneinfo import ZoneInfo

import openpyxl
from openpyxl.comments import Comment
from openpyxl.styles import PatternFill

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tools.update_excel_rates import (  # noqa: E402
    add_calendar_months,
    apply_updates,
    build_change_statistics,
    build_targets,
    build_validation_rows,
    calculate_target_base_rate,
    get_duration_columns,
    get_delta_fill,
    get_import_row_limit,
    expand_pickup_date_rows,
    get_minimum_rate,
    get_floor_legend_text,
    highlight_excluded_group_rates,
    load_baseline_confirmation,
    load_config,
    merge_config,
    parse_date_value,
    parse_number,
    seed_missing_zones,
    target_matches_recommendation_types,
)


def assert_equal(actual, expected, message):
    if actual != expected:
        raise AssertionError(f"{message}: expected {expected!r}, got {actual!r}")


def assert_not_equal(actual, expected, message):
    if actual == expected:
        raise AssertionError(f"{message}: expected value different than {expected!r}")


def rgb(cell):
    return str(cell.fill.fgColor.rgb)[-6:]


def header_rows_snapshot(ws, rows=4):
    return {
        "row_heights": [ws.row_dimensions[row].height for row in range(1, rows + 1)],
        "merged_ranges": sorted(str(item) for item in ws.merged_cells.ranges),
        "cells": [
            [
                (
                    ws.cell(row, col).value,
                    str(ws.cell(row, col)._style),
                    ws.cell(row, col).number_format,
                )
                for col in range(1, ws.max_column + 1)
            ]
            for row in range(1, rows + 1)
        ],
    }


def workbook_zones(path):
    namespace = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    zones = set()
    with zipfile.ZipFile(path) as archive:
        shared_strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            shared_root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in shared_root.findall("x:si", namespace):
                shared_strings.append("".join(text.text or "" for text in item.findall(".//x:t", namespace)))

        sheet_root = ElementTree.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        for row in sheet_root.findall(".//x:sheetData/x:row", namespace):
            if int(row.attrib.get("r", "0")) < 5:
                continue
            for cell in row.findall("x:c", namespace):
                reference = cell.attrib.get("r", "")
                column = "".join(char for char in reference if char.isalpha())
                if column != "D":
                    continue
                value_node = cell.find("x:v", namespace)
                if value_node is None or value_node.text is None:
                    continue
                value = value_node.text
                if cell.attrib.get("t") == "s":
                    value = shared_strings[int(value)]
                if str(value).strip():
                    zones.add(str(value).strip().upper())
    return zones


def build_workbook(path):
    workbook = openpyxl.Workbook()
    ws = workbook.active
    ws.title = "Sheet1"
    ws.append(["Rental rates for packages: INCLUSIVE FP"])
    ws.append(["Min days", None, None, None, "Date format:", None, None, None, 1, 2, 3, 5, 8, 21])
    ws.append(["Max days", None, None, None, "dd-MM-yy", None, None, None, 1, 2, 4, 7, 20, 35])
    ws.append([
        "Group",
        "Description",
        "Rate code",
        "Zone",
        "Booking start date",
        "Booking end date",
        "Pickup start date",
        "Pickup end date",
        "Per day",
        "Per day",
        "Per day",
        "Per day",
        "Per day",
        "Per day",
    ])
    rows = [
        ["CDMV", None, None, "WA1", "09-07-26", "10-07-26", "10-07-26", "11-07-26", 160, 70, 80, 90, 100, 120],
        ["CGAV", None, None, "WA1", "09-07-26", "10-07-26", "10-07-26", "11-07-26", 160, 70, 80, 90, 100, 120],
        ["CWAV", None, None, "WA1", "09-07-26", "10-07-26", "10-07-26", "11-07-26", 160, 70, 80, 90, 100, 120],
        ["EDMV", None, None, "WA1", "09-07-26", "10-07-26", "10-07-26", "11-07-26", 160, 70, 80, 90, 100, 120],
        ["FVMD", None, None, "WA1", "09-07-26", "10-07-26", "10-07-26", "11-07-26", 160, 70, 80, 90, 100, 120],
        ["SWAV", None, None, "WA1", "09-07-26", "10-07-26", "10-07-26", "11-07-26", 160, 70, 80, 90, 100, 120],
        ["CDMV", None, None, "WA1", "09-07-26", "10-07-26", "11-07-26", "12-07-26", 160, 90, 80, 90, 100, 120],
        ["EDMV", None, None, "WA1", "09-07-26", "10-07-26", "11-07-26", "12-07-26", 160, 90, 80, 90, 100, 120],
        ["CDMV", None, None, "WA1", "09-07-26", "10-07-26", "25-07-26", "26-07-26", 160, 90, 80, 90, 130, 120],
        ["EDMV", None, None, "WA1", "09-07-26", "10-07-26", "25-07-26", "26-07-26", 160, 90, 80, 90, 130, 120],
    ]
    for row in rows:
        ws.append(row)
    ws["A4"].fill = PatternFill(fill_type="solid", fgColor="1F4E78")
    ws.freeze_panes = "I5"
    workbook.save(path)


def build_minimal_workbook(path, rows):
    workbook = openpyxl.Workbook()
    ws = workbook.active
    ws.title = "Sheet1"
    ws.append(["Rental rates for packages: INCLUSIVE FP"])
    ws.append(["Min days", None, None, None, "Date format:", None, None, None, 1, 2, 3, 5, 8, 21])
    ws.append(["Max days", None, None, None, "dd-MM-yy", None, None, None, 1, 2, 4, 7, 20, 35])
    ws.append([
        "Group",
        "Description",
        "Rate code",
        "Zone",
        "Booking start date",
        "Booking end date",
        "Pickup start date",
        "Pickup end date",
        "Per day",
        "Per day",
        "Per day",
        "Per day",
        "Per day",
        "Per day",
    ])
    for row in rows:
        ws.append(row)
    ws.freeze_panes = "I5"
    workbook.save(path)


def main():
    for retired_rule in ("fixed_rate_groups", "mirrored_rate_groups", "competitor_evidence_sheet"):
        try:
            merge_config({retired_rule: {"CFAV": 200} if retired_rule.endswith("groups") else "Evidence"})
        except ValueError as error:
            assert retired_rule in str(error)
        else:
            raise AssertionError(f"Obsolete rule {retired_rule} must not silently override baseline rates or reports.")

    assert_equal(add_calendar_months(date(2026, 8, 27), 4), date(2026, 12, 27), "four-month pickup horizon")
    assert_equal(add_calendar_months(date(2026, 10, 31), 4), date(2027, 2, 28), "month-end pickup horizon")
    assert_equal(
        build_change_statistics([
            {"delta": 10},
            {"delta": 20},
            {"delta": -5},
            {"delta": -15},
            {"delta": 0},
            {"delta": None},
        ]),
        {
            "increase_count": 2,
            "decrease_count": 2,
            "average_increase_pln_day": 15.0,
            "average_decrease_pln_day": -10.0,
        },
        "change statistics use every non-zero applied delta",
    )

    warning_fill = get_delta_fill(
        {"new_rate": 59, "delta": -10},
        merge_config({"changed_rate_warning": {"below_pln_day": 60, "color": "FFF2CC"}}),
    )
    assert_equal(str(warning_fill.fgColor.rgb)[-6:], "FFF2CC", "changed rate below warning threshold fill")

    example_config = load_config(ROOT / "excel-rate-update.config.example.json")
    import runpy
    runpy.run_path(str(ROOT / "tests/run-priority-fallback-tests.py"))
    for zone in ("KRLO", "KRTI", "KRDW", "KRGA", "WALO"):
        for group in ("CDMV", "CGAV", "CWAV", "CWMR", "EDAV", "EDMV", "PDAV", "PDAH", "FVMD"):
            for low, high in ((1, 1), (2, 2), (3, 4), (5, 7), (8, 20), (21, 35)):
                target = {"zone": zone, "group": group, "target_date": date(2026, 9, 28), "duration_min_days": low, "duration_max_days": high}
                scoped = zone in {"KRLO", "KRTI"} and group in {"CDMV", "CGAV", "CWAV", "CWMR", "EDAV", "EDMV"} and (low, high) in {(2, 2), (3, 4)}
                long_band = (low, high) == (8, 20) and group in {"CDMV", "CGAV", "CWAV", "CWMR", "EDAV", "EDMV"}
                expected = 40 if long_band else 30 if scoped else 50 if zone == "WALO" else 39
                if group == "PDAH" and (low, high) == (21, 35):
                    expected = 170
                assert_equal(get_minimum_rate(target, example_config)[0], expected, f"scoped floor {zone}/{group}/{low}-{high}")
    assert "Wyjatek nadrzedny" in get_floor_legend_text(example_config)
    assert_equal(
        example_config["excluded_groups"],
        ["FVMD", "SWAV", "CFAV", "PDAH", "PDAV"],
        "excluded and unchanged groups",
    )
    assert_equal(example_config["max_import_rows"], None, "broker import row limit disabled")
    assert_equal(get_import_row_limit({"max_import_rows": 30000}), 30000, "explicit import row limit")
    assert_equal(
        example_config["excluded_group_highlights"],
        {"SWAV": 150},
        "current highlight-only groups",
    )
    assert_equal(
        example_config["group_price_parity"]["base_groups"],
        ["CDMV", "CGAV", "CWAV", "CWMR"],
        "current base parity groups",
    )
    assert_equal(
        example_config["group_price_parity"]["premium_adjustments_pln_day"],
        {"EDAV": 1, "EDMV": 1},
        "current premium groups",
    )
    assert_equal(
        example_config["group_rate_adjustments_pln_day"],
        {"EDAV": 1, "EDMV": 1},
        "current group recommendation adjustments",
    )
    assert_equal(
        example_config["protected_rate_periods"],
        [
            {"start_date": "2026-10-31", "end_date": "2026-11-01"},
            {"start_date": "2026-12-15", "end_date": "2027-01-10"},
        ],
        "holiday rate protection periods",
    )
    assert_equal(example_config["city_top1_airport_cap"]["max_multiplier"], 1.3, "city-airport cap")
    assert_equal(example_config["max_recommendation_duration_days"], 20, "maximum recommendation duration")
    september_floor, _ = get_minimum_rate(
        {"target_date": date(2026, 9, 1), "duration_min_days": 1, "duration_max_days": 35},
        example_config,
    )
    assert_equal(september_floor, 50, "floor from September 2026")
    for zone in ("KRDW", "KRGA", "KRLO", "KRTI"):
        target = {"zone": zone, "target_date": date(2026, 9, 20), "rental_days": 2,
                  "duration_min_days": 2, "duration_max_days": 2, "suggested_rate_pln_day": 30}
        assert_equal(get_minimum_rate(target, example_config)[0], 39, f"Krakow floor for {zone}")
        assert_equal(calculate_target_base_rate(target, 90, example_config)[0], 39, f"Krakow update clamped for {zone}")
        assert_equal(get_minimum_rate({**target, "zone": "WALO"}, example_config)[0], 50, "other cities keep their floor")
    floor_legend = get_floor_legend_text(example_config)
    assert "39 PLN" in floor_legend and "KRLO" in floor_legend and "KRTI" in floor_legend
    august_gap_floor, _ = get_minimum_rate(
        {"target_date": date(2026, 8, 31), "duration_min_days": 1, "duration_max_days": 35},
        example_config,
    )
    assert_equal(august_gap_floor, 0, "no period floor on 31 August 2026")
    baseline_manifest = json.loads((ROOT / "input" / "baseline-manifest.json").read_text(encoding="utf-8"))
    baseline_confirmation = load_baseline_confirmation(example_config, baseline_manifest["workbook_sha256"])
    assert_equal(baseline_confirmation["status"], baseline_manifest["status"], "baseline status matches manifest")
    assert_equal(
        baseline_confirmation["calibration_eligible"],
        baseline_manifest["status"] in {"confirmed_imported", "verified_live"},
        "only imported baseline is eligible for calibration",
    )
    city_cap_types = {"top1_gap", "force_top1_maintain"}
    assert target_matches_recommendation_types({"recommendation_type": "top1_gap"}, city_cap_types)
    assert target_matches_recommendation_types({"recommendation_type": "force_top1_maintain"}, city_cap_types)
    assert not target_matches_recommendation_types({"recommendation_type": "top1_undercut"}, city_cap_types)

    duration_targets, duration_skipped = build_targets(
        [{
            "action": "decrease",
            "recommendation_type": "top1_undercut",
            "location": "Warsaw Train Station",
            "start_date": "2026-09-20",
            "rental_days": 21,
            "suggested_rate_pln_day": 80,
        }],
        {21: (14, "21-35", 21, 35)},
        example_config,
    )
    assert_equal(bool(duration_targets), False, "duration 21 target is blocked")
    assert_equal(len(duration_skipped), 1, "duration 21 skip count")
    assert "Maximum recommendation duration is 20 days" in duration_skipped[0]["skip_reason"]

    with tempfile.TemporaryDirectory() as temporary_dir:
        temporary_path = Path(temporary_dir)

        highlight_path = temporary_path / "highlight-count.xlsx"
        build_workbook(highlight_path)
        highlight_book = openpyxl.load_workbook(highlight_path)
        highlight_ws = highlight_book["Sheet1"]
        highlight_config = merge_config({})
        highlight_durations = get_duration_columns(highlight_ws, highlight_config)
        highlight_rates = [highlight_ws.cell(10, col).value for col in range(9, 15)]
        for dry_run in (True, False):
            highlighted = highlight_excluded_group_rates(
                highlight_ws, 10, highlight_config, highlight_durations, dry_run,
                scoped_rate_cols={10, 11, 12},
            )
            assert_equal(highlighted, 3, "highlight count uses cells, not rental days")
            for col in range(9, 15):
                assert_equal(
                    highlight_ws.cell(10, col).fill.fill_type,
                    "solid" if not dry_run and col in {10, 11, 12} else None,
                    f"highlight scope and dry-run for column {col}",
                )
        assert_equal(
            [highlight_ws.cell(10, col).value for col in range(9, 15)],
            highlight_rates, "highlighting preserves baseline rates",
        )
        highlight_book.close()


        frozen_workbook_path = temporary_path / "frozen-groups.xlsx"
        frozen_recommendations_path = temporary_path / "frozen-groups-recommendations.json"
        frozen_output_path = temporary_path / "frozen-groups-output.xlsx"
        frozen_group_rates = {
            "CDMV": [100, 101, 102, 103, 104, 105],
            "CGAV": [90, 91, 92, 93, 94, 95],
            "CWAV": [110, 111, 112, 113, 114, 115],
            "CWMR": [120, 121, 122, 123, 124, 125],
            "EDMV": [130, 131, 132, 133, 134, 135],
            "CFAV": [140, 141, 142, 143, 144, 145],
            "EDAV": [150, 151, 152, 153, 154, 155],
            "PDAH": [160, 161, 162, 163, 164, 170],
            "FVMD": [260, 261, 262, 263, 264, 265],
            "PDAV": [400, 350, 300, 290, 260, 250],
        }
        build_minimal_workbook(
            frozen_workbook_path,
            [
                [group, None, None, "WA1", "09-06-26", "20-06-26", "20-06-26", "20-06-26", *rates]
                for group, rates in frozen_group_rates.items()
            ],
        )
        frozen_recommendations_path.write_text(
            json.dumps({
                "recommendations": [{
                    "action": "increase",
                    "recommendation_type": "top1_gap",
                    "location": "Warsaw Test",
                    "start_date": "2026-06-20",
                    "rental_days": 2,
                    "suggested_rate_pln_day": 222,
                    "benchmark_rate_pln_day": 223,
                }]
            }),
            encoding="utf-8",
        )
        frozen_config = merge_config({
            "excluded_groups": example_config["excluded_groups"],
            "group_rate_adjustments_pln_day": example_config["group_rate_adjustments_pln_day"],
            "group_price_parity": example_config["group_price_parity"],
            "location_zones": {"Warsaw Test": ["WA1"]},
            "pickup_date_expansion": {"enabled": False},
            "city_top1_airport_cap": {"enabled": False},
        })
        frozen_summary = apply_updates(
            workbook_path=frozen_workbook_path,
            recommendations_path=frozen_recommendations_path,
            output_path=frozen_output_path,
            config=frozen_config,
            cli_groups=None,
            dry_run=False,
        )
        frozen_book = openpyxl.load_workbook(frozen_output_path)
        frozen_ws = frozen_book["Sheet1"]
        frozen_rows = {
            str(frozen_ws.cell(row, 1).value or "").strip().upper(): row
            for row in range(5, frozen_ws.max_row + 1)
        }
        for group in ("CDMV", "CGAV", "CWAV", "CWMR"):
            assert_equal(frozen_ws.cell(frozen_rows[group], 10).value, 222, f"{group} follows the recommendation")
        assert_equal(frozen_ws.cell(frozen_rows["EDMV"], 10).value, 223, "EDMV premium remains active")
        assert_equal(frozen_ws.cell(frozen_rows["EDAV"], 10).value, 223, "EDAV has the same premium rate as EDMV")
        for group in ("CFAV", "PDAH", "FVMD", "PDAV"):
            row = frozen_rows[group]
            assert_equal(
                [frozen_ws.cell(row, col).value for col in range(9, 15)],
                frozen_group_rates[group],
                f"{group} remains unchanged from baseline",
            )
        assert not ({"CFAV", "PDAH", "FVMD", "PDAV"} & {str(change["group"]) for change in frozen_summary["changes"]})
        for group in ("EDAV", "EDMV"):
            row = frozen_rows[group]
            assert_equal(
                [frozen_ws.cell(row, col).value for col in (9, 11, 12, 13, 14)],
                [frozen_group_rates[group][index] for index in (0, 2, 3, 4, 5)],
                f"{group} keeps all rate columns outside the recommendation scope",
            )
        frozen_book.close()

        scoped_path = temporary_path / "scoped-floor.xlsx"
        scoped_json = temporary_path / "scoped-floor.json"
        scoped_output = temporary_path / "scoped-floor-output.xlsx"
        scoped_groups = ["CDMV", "CGAV", "CWAV", "CWMR", "EDAV", "EDMV", "PDAV", "PDAH"]
        build_minimal_workbook(scoped_path, [
            [group, None, None, zone, "09-06-26", "28-09-26", "28-09-26", "28-09-26", *([100] * 6)]
            for zone in ("KRLO", "KRTI") for group in scoped_groups
        ])
        scoped_json.write_text(json.dumps({"recommendations": [
            {"action": "decrease", "recommendation_type": "top3_small_decrease", "location": "Krakow Test", "start_date": "2026-09-28", "rental_days": days, "suggested_rate_pln_day": 20, "benchmark_rate_pln_day": 21}
            for days in (2, 3, 4)
        ]}), encoding="utf-8")
        scoped_config = merge_config({
            "minimum_rates": example_config["minimum_rates"],
            "excluded_groups": example_config["excluded_groups"],
            "group_price_parity": example_config["group_price_parity"],
            "group_rate_adjustments_pln_day": example_config["group_rate_adjustments_pln_day"],
            "location_zones": {"Krakow Test": ["KRLO", "KRTI"]},
            "pickup_date_expansion": {"enabled": False},
            "city_top1_airport_cap": {"enabled": False},
        })
        apply_updates(scoped_path, scoped_json, scoped_output, scoped_config, cli_groups=None, dry_run=False)
        scoped_book = openpyxl.load_workbook(scoped_output)
        for row in scoped_book["Sheet1"].iter_rows(min_row=5, values_only=True):
            expected = 100 if row[0] in {"PDAV", "PDAH"} else 31 if row[0] in {"EDAV", "EDMV"} else 30
            assert_equal(row[9:11], (expected, expected), f"scoped applied floor {row[0]}/{row[3]}")
            assert_equal((row[8], *row[11:14]), (100, 100, 100, 170 if row[0] == "PDAH" else 100), "unaffected bands except approved PDAH minimum")
        scoped_book.close()

        priority_payload = json.loads(scoped_json.read_text())
        for item in priority_payload["recommendations"]:
            item["priority_rule_id"] = "all-locations-autumn-2026-short"
            item["recommendation_type"] = "force_top1_undercut"
        scoped_json.write_text(json.dumps(priority_payload), encoding="utf-8")
        priority_summary = apply_updates(scoped_path, scoped_json, scoped_output, scoped_config, cli_groups=None, dry_run=False)
        priority_book = openpyxl.load_workbook(scoped_output)
        for row in priority_book["Sheet1"].iter_rows(min_row=5, values_only=True):
            expected = 100 if row[0] in {"PDAV", "PDAH"} else 31 if row[0] in {"EDAV", "EDMV"} else 30
            assert_equal(row[9:11], (expected, expected), f"priority floor and EDAV/EDMV parity {row[0]}/{row[3]}")
            assert_equal((row[8], *row[11:14]), (100, 100, 100, 170 if row[0] == "PDAH" else 100), "priority leaves other bands unchanged except PDAH minimum")
        assert not any(v["status"] == "FAIL" for v in priority_summary["validation"])
        priority_book.close()

        build_minimal_workbook(scoped_path, [
            [group, None, None, zone, "09-06-26", "25-10-26", "25-10-26", "25-10-26", *([100] * 6)]
            for zone in ("KRLO", "WA1", "TO1") for group in scoped_groups
        ])
        scoped_config["location_zones"] = {"Priority Test": ["KRLO", "WA1", "TO1"]}
        scoped_config["city_top1_airport_cap"] = example_config["city_top1_airport_cap"]
        scoped_config["city_zone_airport_zones"] = {"WA1": ["WALO"]}
        scoped_json.write_text(json.dumps({"recommendations": [
            {"priority_rule_id": "all-locations-autumn-2026-short" if days <= 4 else "all-locations-autumn-2026-week",
             "action": "decrease", "recommendation_type": "force_top1_undercut", "location": "Priority Test",
             "start_date": "2026-10-25", "rental_days": days, "suggested_rate_pln_day": 20, "benchmark_rate_pln_day": 21}
            for days in range(2, 8)
        ]}), encoding="utf-8")
        all_city_summary = apply_updates(scoped_path, scoped_json, scoped_output, scoped_config, cli_groups=None, dry_run=False)
        all_city_book = openpyxl.load_workbook(scoped_output)
        for row in all_city_book["Sheet1"].iter_rows(min_row=5, values_only=True):
            expected = (100, 100, 100) if row[0] in {"PDAV", "PDAH"} else (31, 31, 41) if row[0] in {"EDAV", "EDMV"} else (30, 30, 40)
            assert_equal(row[9:12], expected, f"all-city short/week floors {row[0]}/{row[3]}")
            assert_equal((row[8], *row[12:14]), (100, 100, 170 if row[0] == "PDAH" else 100), "no market changes for 1 or 8+ days; PDAH minimum remains active")
        assert not any(v["status"] == "FAIL" for v in all_city_summary["validation"])
        all_city_book.close()

        holiday_workbook_path = temporary_path / "holiday-protection.xlsx"
        holiday_recommendations_path = temporary_path / "holiday-protection-recommendations.json"
        holiday_output_path = temporary_path / "holiday-protection-output.xlsx"
        holiday_dates = [
            "30-10-26",
            "31-10-26",
            "01-11-26",
            "02-11-26",
            "14-12-26",
            "15-12-26",
            "10-01-27",
            "11-01-27",
        ]
        holiday_group_rates = {
            "CDMV": [100, 101, 102, 103, 104, 105],
            "CGAV": [90, 91, 92, 93, 94, 95],
            "CWAV": [110, 111, 112, 113, 114, 115],
            "CWMR": [120, 121, 122, 123, 124, 125],
            "EDMV": [130, 131, 132, 133, 134, 135],
            "EDAV": [140, 141, 142, 143, 144, 145],
            "CFAV": [150, 151, 152, 153, 154, 155],
            "PDAH": [160, 161, 162, 163, 164, 165],
        }
        build_minimal_workbook(
            holiday_workbook_path,
            [
                [group, None, None, "WA1", "09-06-26", pickup_date, pickup_date, pickup_date, *rates]
                for pickup_date in holiday_dates
                for group, rates in holiday_group_rates.items()
            ],
        )
        holiday_recommendations = [
            {
                "action": "increase",
                "recommendation_type": "top1_gap",
                "location": "Warsaw Test",
                "start_date": parse_date_value(pickup_date).isoformat(),
                "rental_days": 2,
                "suggested_rate_pln_day": 222,
                "benchmark_rate_pln_day": 223,
            }
            for pickup_date in holiday_dates
        ]
        holiday_recommendations_path.write_text(
            json.dumps({"recommendations": holiday_recommendations}),
            encoding="utf-8",
        )
        holiday_config = merge_config({
            "excluded_groups": example_config["excluded_groups"],
            "group_rate_adjustments_pln_day": example_config["group_rate_adjustments_pln_day"],
            "group_price_parity": example_config["group_price_parity"],
            "protected_rate_periods": example_config["protected_rate_periods"],
            "location_zones": {"Warsaw Test": ["WA1"]},
            "pickup_date_expansion": {"enabled": False},
        })
        holiday_summary = apply_updates(
            workbook_path=holiday_workbook_path,
            recommendations_path=holiday_recommendations_path,
            output_path=holiday_output_path,
            config=holiday_config,
            cli_groups=None,
            dry_run=False,
        )
        assert_equal(holiday_summary["skipped_target_count"], 4, "four holiday recommendations skipped")
        holiday_book = openpyxl.load_workbook(holiday_output_path)
        holiday_ws = holiday_book["Sheet1"]
        holiday_rows = {
            (
                str(holiday_ws.cell(row, 1).value or "").strip().upper(),
                parse_date_value(holiday_ws.cell(row, 7).value),
            ): row
            for row in range(5, holiday_ws.max_row + 1)
        }
        protected_dates = {
            date(2026, 10, 31),
            date(2026, 11, 1),
            date(2026, 12, 15),
            date(2027, 1, 10),
        }
        for pickup_date in protected_dates:
            for group, original_rates in holiday_group_rates.items():
                row = holiday_rows[(group, pickup_date)]
                assert_equal(
                    [holiday_ws.cell(row, col).value for col in range(9, 15)],
                    original_rates,
                    f"protected holiday rates for {group}/{pickup_date.isoformat()}",
                )
        unprotected_dates = {
            date(2026, 10, 30),
            date(2026, 11, 2),
            date(2026, 12, 14),
            date(2027, 1, 11),
        }
        for pickup_date in unprotected_dates:
            for group, expected_rate in (("CDMV", 222), ("CGAV", 222), ("CWAV", 222), ("CWMR", 222), ("EDAV", 223), ("EDMV", 223)):
                row = holiday_rows[(group, pickup_date)]
                assert_equal(holiday_ws.cell(row, 10).value, expected_rate, f"unprotected rate for {group}/{pickup_date.isoformat()}")
            for group in ("CFAV", "PDAH"):
                row = holiday_rows[(group, pickup_date)]
                assert_equal(
                    [holiday_ws.cell(row, col).value for col in range(9, 15)],
                    holiday_group_rates[group][:5] + [170] if group == "PDAH" else holiday_group_rates[group],
                    f"frozen rates outside holidays for {group}/{pickup_date.isoformat()}",
                )
        holiday_book.close()

        pending_manifest = {
            "schema_version": 1,
            "status": "prepared",
            "workbook_sha256": baseline_manifest["workbook_sha256"],
        }
        (temporary_path / "baseline.json").write_text(json.dumps(pending_manifest), encoding="utf-8")
        pending_config = merge_config({"baseline_manifest_file": "baseline.json"})
        pending_config["_config_dir"] = str(temporary_path)
        try:
            load_baseline_confirmation(pending_config, baseline_manifest["workbook_sha256"])
        except ValueError as error:
            assert "not confirmed as imported" in str(error)
        else:
            raise AssertionError("prepared baseline should not be accepted")

        extension_manifest = {
            **pending_manifest,
            "status": "user_approved_extension",
            "approved_by": "user",
            "approved_at": "2026-10-03",
            "source_baseline": {
                "status": "confirmed_imported",
                "workbook_sha256": "a" * 64,
            },
            "zone_additions": {"SZLO": "LOLO", "SZO1": "LOLO", "SZ1": "LOLO"},
        }
        (temporary_path / "baseline.json").write_text(json.dumps(extension_manifest), encoding="utf-8")
        extension = load_baseline_confirmation(pending_config, baseline_manifest["workbook_sha256"])
        assert_equal(extension["confirmed"], False, "approved additions are not yet confirmed imported")
        assert_equal(extension["recommendation_eligible"], True, "explicitly approved additions support recommendations")
        assert_equal(extension["calibration_eligible"], False, "approved additions cannot calibrate broker markup")
        assert_equal(extension["zone_additions"], extension_manifest["zone_additions"], "approved zone provenance")
        assert_equal(extension["source_baseline"], extension_manifest["source_baseline"], "imported source provenance survives")

        for missing_field in ("approved_by", "approved_at", "source_baseline", "zone_additions"):
            incomplete_extension = {key: value for key, value in extension_manifest.items() if key != missing_field}
            (temporary_path / "baseline.json").write_text(json.dumps(incomplete_extension), encoding="utf-8")
            try:
                load_baseline_confirmation(pending_config, baseline_manifest["workbook_sha256"])
            except ValueError as error:
                assert "explicit user approval" in str(error)
            else:
                raise AssertionError(f"extension without {missing_field} should not be accepted")

        for invalid_source in (
            {"status": "prepared", "workbook_sha256": "a" * 64},
            {"status": "confirmed_imported", "workbook_sha256": "not-a-hash"},
            "not-a-source-object",
        ):
            (temporary_path / "baseline.json").write_text(
                json.dumps({**extension_manifest, "source_baseline": invalid_source}), encoding="utf-8"
            )
            try:
                load_baseline_confirmation(pending_config, baseline_manifest["workbook_sha256"])
            except ValueError as error:
                assert "explicit user approval" in str(error)
            else:
                raise AssertionError("extension with invalid imported source provenance should not be accepted")

        (temporary_path / "baseline.json").write_text(json.dumps(extension_manifest), encoding="utf-8")
        try:
            load_baseline_confirmation(pending_config, "b" * 64)
        except ValueError as error:
            assert "does not match" in str(error)
        else:
            raise AssertionError("approved extension with a mismatched workbook must be rejected")

    location_zones = {
        str(location): {str(zone).upper() for zone in zones}
        for location, zones in example_config["location_zones"].items()
    }
    expected_location_zones = {
        "Bydgoszcz Airport (BZG)": {"BYLO"},
        "Gdansk Downtown": {"GD1"},
        "Gdansk Airport (GDN)": {"GDLO"},
        "Katowice Downtown": {"KA1"},
        "Katowice Airport (KTW)": {"KALO"},
        "Krakow Train Station": {"KRDW"},
        "Galeria Krakowska Shopping Mall": {"KRGA"},
        "Krakow Airport (KRK)": {"KRLO", "KRTI"},
        "Lodz Downtown": {"LO1"},
        "Lodz Lublinek Airport (LCJ)": {"LOLO"},
        "Lubin Downtown": {"LU1"},
        "Olsztyn Downtown": {"OL1"},
        "Opole Downtown": {"OP1"},
        "Poznan Downtown": {"PO1"},
        "Poznan Airport (POZ)": {"POLO"},
        "Szczecin Goleniow Airport (SZZ)": {"SZLO"},
        "Szczecin Downtown": {"SZO1"},
        "Szczecin Train Station": {"SZ1"},
        "Torun Downtown": {"TO1"},
        "Warsaw West Train Station": {"WA1"},
        "Warsaw Train Station": {"WA2"},
        "Warsaw Chopin Airport (WAW)": {"WALO"},
        "Wroclaw Downtown": {"WR1"},
        "Wroclaw Train Station": {"WR2"},
        "Wroclaw Airport (WRO)": {"WRLO"},
    }
    for location, zones in expected_location_zones.items():
        assert_equal(location_zones.get(location), zones, f"location zone mapping for {location}")
    assert_equal(example_config["city_zone_airport_zones"]["WA1"], ["WALO"], "Warsaw West city-airport mapping")
    assert_equal(example_config["city_zone_airport_zones"]["WA2"], ["WALO"], "Warsaw city-airport mapping")
    assert_equal(example_config["city_zone_airport_zones"]["KRDW"], ["KRLO"], "Krakow station-airport mapping")
    assert_equal(example_config["city_zone_airport_zones"]["KRGA"], ["KRLO"], "Krakow gallery-airport mapping")
    assert "KRTI" not in example_config["city_zone_airport_zones"]
    assert_equal(example_config["city_zone_airport_zones"]["WR2"], ["WRLO"], "Wroclaw station-airport mapping")
    assert_equal(example_config["city_zone_airport_zones"]["SZO1"], ["SZLO"], "Szczecin downtown-airport mapping")
    assert_equal(example_config["city_zone_airport_zones"]["SZ1"], ["SZLO"], "Szczecin station-airport mapping")
    assert_equal(example_config["zone_seeds"], {"WR2": "WR1", "SZLO": "LOLO", "SZO1": "LOLO", "SZ1": "LOLO"}, "approved initial baseline sources")

    class MeasuredSeedWorksheet(openpyxl.worksheet.worksheet.Worksheet):
        dimension_reads = 0

        @property
        def max_row(self):
            self.dimension_reads += 1
            return super().max_row

        @property
        def max_column(self):
            self.dimension_reads += 1
            return super().max_column

    szczecin_book = openpyxl.Workbook()
    szczecin_ws = MeasuredSeedWorksheet(szczecin_book)
    for _ in range(4):
        szczecin_ws.append(["header"])
    for group in ("CDMV", "EDAV", "PDAH", "CFAV"):
        szczecin_ws.append([group, None, None, "LOLO", "27-04-26", "03-10-26", "03-10-26", "03-10-26", 150, 99, 90, 80, 100, 120])
    szczecin_ws["J5"].fill = PatternFill(fill_type="solid", fgColor="FF0000")
    szczecin_ws.row_dimensions[5].hidden = True
    header_rows_snapshot(szczecin_ws)
    szczecin_header = header_rows_snapshot(szczecin_ws)
    szczecin_source = list(szczecin_ws.values)
    szczecin_ws.dimension_reads = 0
    szczecin_seeding = seed_missing_zones(szczecin_ws, example_config)
    assert szczecin_ws.dimension_reads <= 3, "seeding must not rescan all worksheet dimensions for each copied row"
    assert_equal(szczecin_seeding["seeded_row_count"], 12, "all three Szczecin points receive all source classes, including hidden rows")
    assert_equal(header_rows_snapshot(szczecin_ws), szczecin_header, "Szczecin seeding preserves headers")
    assert_equal(list(szczecin_ws.values)[:8], szczecin_source, "Szczecin seeding does not alter old zones")
    for zone, first_row in (("SZLO", 9), ("SZO1", 13), ("SZ1", 17)):
        for offset in range(4):
            expected = list(szczecin_source[4 + offset])
            expected[3] = zone
            assert_equal([szczecin_ws.cell(first_row + offset, col).value for col in range(1, 15)], expected, "Szczecin rates exactly match LOLO")
        assert_equal(szczecin_ws.cell(first_row, 10)._style, szczecin_ws["J5"]._style, "Szczecin retains source formatting")
    szczecin_ws["J9"] = 88
    szczecin_ws["J13"] = 77
    szczecin_ws["J17"] = 66
    assert_equal(seed_missing_zones(szczecin_ws, example_config)["seeded_row_count"], 0, "existing Szczecin points are never reseeded")
    assert_equal(szczecin_ws["J9"].value, 88, "Szczecin airport prices remain independent")
    assert_equal(szczecin_ws["J13"].value, 77, "Szczecin downtown prices remain independent")
    assert_equal(szczecin_ws["J17"].value, 66, "Szczecin station prices remain independent")
    szczecin_book.close()

    with tempfile.TemporaryDirectory() as directory:
        folder = Path(directory)
        source = folder / "szczecin-baseline.xlsx"
        build_minimal_workbook(source, [
            [group, None, None, "LOLO", "27-04-26", "03-10-26", "03-10-26", "03-10-26"] + [150] * 6
            for group in ("CDMV", "CGAV", "CWAV", "CWMR", "EDAV", "EDMV", "PDAH", "CFAV", "SWAV")
        ])
        recommendations = folder / "szczecin-recommendations.json"
        recommendations.write_text(json.dumps({"recommendations": [{
            "action": "decrease", "recommendation_type": "force_top1_undercut",
            "location": location, "start_date": "2026-10-03", "rental_days": 2,
            "suggested_rate_pln_day": rate, "benchmark_rate_pln_day": rate + 61, "target_rank": 1,
            "broker_markup_model": "fixed_amount", "broker_markup_amount_pln_day": 60,
            "broker_markup_multiplier": 1,
        } for location, rate in (("Szczecin Goleniow Airport (SZZ)", 70), ("Szczecin Downtown", 120), ("Szczecin Train Station", 80))]}), encoding="utf-8")
        config = {**example_config, "baseline_manifest_file": "", "pickup_date_expansion": {"enabled": False}}
        output = folder / "szczecin-updated.xlsx"
        import_output = folder / "szczecin-import.xlsx"
        summary = apply_updates(source, recommendations, output, config, None, False, import_output_path=import_output)
        updated = openpyxl.load_workbook(output)
        imported = openpyxl.load_workbook(import_output)
        prices = {(row[0], row[3]): row[9] for row in updated["Sheet1"].iter_rows(min_row=5, values_only=True)}
        for zone, base_rate in (("SZLO", 150), ("SZO1", 119), ("SZ1", 79)):
            for group in ("CDMV", "CGAV", "CWAV", "CWMR"):
                assert_equal(prices[(group, zone)], base_rate, "Szczecin recommendations match only the correct zone")
            for group in ("EDAV", "EDMV"):
                assert_equal(prices[(group, zone)], base_rate + 1, "Szczecin premium parity is preserved")
            for group in ("PDAH", "CFAV", "SWAV"):
                assert_equal(prices[(group, zone)], 150, "Szczecin excluded class keeps its copied rate")
        assert prices[("CDMV", "SZO1")] <= prices[("CDMV", "SZLO")] * 1.3, "Szczecin downtown top1 rate stays within 130 percent of the floor-aware airport rate"
        for row in updated["Sheet1"].iter_rows(min_row=5, values_only=True):
            assert_equal(row[8], 300 if row[3] == "SZLO" else 150,
                         "the permanent airport floor covers one-day rates without changing other points")
        for group in ("CDMV", "CGAV", "CWAV", "CWMR", "EDAV", "EDMV", "PDAH", "CFAV", "SWAV"):
            assert_equal(prices[(group, "LOLO")], 150, "new recommendations never alter the old source zone")
        assert_equal(summary["zone_seeding"]["seeded_row_count"], 27, "all three new points appear in the audit")
        assert_equal(imported.sheetnames, ["Sheet1"], "Szczecin import remains Sheet1-only")
        assert_equal(list(imported["Sheet1"].values), list(updated["Sheet1"].values), "import and recommendations have identical rate rows")
        assert_equal(imported["Sheet1"].freeze_panes, None, "Szczecin import has no frozen panes")
        updated.close()
        imported.close()

    seed_book = openpyxl.Workbook()
    seed_ws = seed_book.active
    for _ in range(4):
        seed_ws.append(["header"])
    for group in ("CDMV", "PDAH", "EDAV"):
        for pickup in ("30-09-26", "01-10-26"):
            seed_ws.append([group, None, None, "WR1", "27-04-26", pickup, pickup, pickup, 150, 31, 32, 40, 100, 200])
    seed_ws["J5"].fill = PatternFill(fill_type="solid", fgColor="FF0000")
    seed_ws.row_dimensions[5].hidden = True
    original_rows = list(seed_ws.values)
    header_rows_snapshot(seed_ws)
    original_header = header_rows_snapshot(seed_ws)
    seed_summary = seed_missing_zones(seed_ws, example_config)
    assert_equal(seed_summary["seeded_row_count"], 6, "all station classes and dates are seeded")
    assert_equal(header_rows_snapshot(seed_ws), original_header, "seeding preserves headers")
    assert_equal(list(seed_ws.values)[:10], original_rows, "seeding does not alter source rows")
    for source_row, station_row in zip(range(5, 11), range(11, 17)):
        expected = list(original_rows[source_row - 1])
        expected[3] = "WR2"
        assert_equal([seed_ws.cell(station_row, col).value for col in range(1, 15)], expected, "station rates exactly match source")
    assert_equal(seed_ws["J11"]._style, seed_ws["J5"]._style, "seed retains source style")
    seed_ws["J11"] = 77
    assert_equal(seed_missing_zones(seed_ws, example_config)["seeded_row_count"], 0, "existing station is not reseeded")
    assert_equal(seed_ws["J11"].value, 77, "existing station prices survive")
    assert_equal(seed_ws["J5"].value, 31, "station prices are independent of downtown")
    seed_book.close()

    range_book = openpyxl.Workbook()
    range_ws = range_book.active
    for _ in range(4):
        range_ws.append(["header"])
    range_ws.append(["CDMV", None, None, "WR1", "27-04-26", "30-09-26", "30-09-26", "30-09-26"] + [100] * 6)
    range_config = {**example_config, "pickup_date_expansion": {
        "enabled": True, "start_date": "2026-09-30", "rolling_days": 100,
        "months_ahead": 4, "drop_rows_before_start_date": True, "drop_rows_after_end_date": True,
    }}
    seed_missing_zones(range_ws, range_config)
    range_summary = expand_pickup_date_rows(range_ws, range_config)
    dates = {parse_date_value(range_ws.cell(row, 7).value) for row in range(5, range_ws.max_row + 1)}
    assert_equal(len(dates), 100, "exactly 100 pickup days")
    assert_equal(min(dates), date(2026, 9, 30), "100-day horizon includes its start")
    assert_equal(max(dates), date(2027, 1, 7), "100-day horizon ends at start plus 99 days")
    assert_equal(range_ws.max_row, 204, "every zone retains all 100 dates")
    assert_equal(range_summary["end_date"], "2027-01-07", "shared recommendation/import date limit")
    for invalid_days in (True, 0, -1, 100.0, "100"):
        invalid_config = {**range_config, "pickup_date_expansion": {**range_config["pickup_date_expansion"], "rolling_days": invalid_days}}
        try:
            expand_pickup_date_rows(range_ws, invalid_config)
        except ValueError as error:
            assert "positive integer" in str(error)
        else:
            raise AssertionError(f"Invalid rolling day count accepted: {invalid_days!r}")
    assert_equal(range_ws.max_row, 204, "invalid horizon never modifies the worksheet")
    range_book.close()

    with tempfile.TemporaryDirectory() as directory:
        folder = Path(directory)
        source = folder / "station-baseline.xlsx"
        build_minimal_workbook(source, [
            [group, None, None, zone, "27-04-26", "01-10-26", "01-10-26", "01-10-26"] + [100] * 6
            for zone in ("WR1", "WRLO") for group in ("CDMV", "EDMV", "PDAH")
        ])
        station_recs = folder / "station-recommendations.json"
        station_recs.write_text(json.dumps({"recommendations": [{
            "action": "decrease", "recommendation_type": "force_top1_undercut",
            "location": "Wroclaw Train Station", "start_date": "2026-10-01", "rental_days": 2,
            "suggested_rate_pln_day": 70, "benchmark_rate_pln_day": 98, "target_rank": 1,
            "broker_markup_model": "fixed_amount", "broker_markup_amount_pln_day": 26,
            "broker_markup_multiplier": 1,
        }]}), encoding="utf-8")
        station_config = {**example_config, "baseline_manifest_file": "", "pickup_date_expansion": {"enabled": False}}
        output = folder / "station-updated.xlsx"
        station_summary = apply_updates(source, station_recs, output, station_config, None, False)
        updated = openpyxl.load_workbook(output)
        prices = {(row[0], row[3]): row[9] for row in updated["Sheet1"].iter_rows(min_row=5, values_only=True)}
        assert_equal(prices[("CDMV", "WR2")], 69, "station recommendation reaches its own seeded zone")
        assert_equal(prices[("EDMV", "WR2")], 70, "station preserves premium rule")
        assert_equal(prices[("PDAH", "WR2")], 100, "excluded station class remains unchanged")
        assert_equal(prices[("CDMV", "WR1")], 100, "station recommendation does not affect downtown")
        assert_equal(station_summary["zone_seeding"]["seeded_row_count"], 3, "zone seeding appears in audit summary")
        updated.close()

    covered_zones = set().union(*location_zones.values())
    real_zones = workbook_zones(ROOT / "input" / "mm-cars-rental-rates-inclusive-fp.xlsx")
    assert_equal(sorted(set(example_config["zone_location_labels"]) - covered_zones), [],
                 "all registered zones are covered by location_zones")
    unmapped_source_zones = real_zones - covered_zones

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        workbook_path = tmpdir / "rates.xlsx"
        recommendations_path = tmpdir / "pricing-recommendations.json"
        output_path = tmpdir / "rates-updated.xlsx"
        import_output_path = tmpdir / "rates-import-ready.xlsx"
        build_workbook(workbook_path)

        recommendations_path.write_text(
            json.dumps(
                {
                    "recommendations": [
                        {
                            "action": "increase",
                            "recommendation_type": "top1_gap",
                            "reason": "MM Cars Rental jest top1, a top2 jest drozszy o co najmniej 10 PLN/dzien; cel to 1 PLN ponizej top2.",
                            "location": "Warsaw",
                            "start_date": "2026-07-10",
                            "rental_days": 2,
                            "suggested_rate_pln_day": 81,
                            "mm_rate_pln_day": 70,
                            "benchmark_provider": "Flex To Go",
                            "benchmark_rate_pln_day": 82,
                            "scenario_id": "2026-07-10-2",
                        },
                        {
                            "action": "decrease",
                            "recommendation_type": "top1_undercut",
                            "reason": "MM Cars Rental jest top2 i brakuje mniej niz 10 PLN/dzien, zeby zostac top1; cel to 1 PLN ponizej top1.",
                            "location": "Warsaw",
                            "start_date": "2026-07-10",
                            "rental_days": 21,
                            "suggested_rate_pln_day": 80,
                            "mm_rate_pln_day": 120,
                            "benchmark_provider": "Flex To Go",
                            "benchmark_rate_pln_day": 101,
                            "scenario_id": "2026-07-10-21",
                        },
                        {
                            "action": "decrease",
                            "recommendation_type": "top1_undercut",
                            "reason": "MM Cars Rental jest top2 i brakuje mniej niz 10 PLN/dzien, zeby zostac top1; cel to 1 PLN ponizej top1.",
                            "location": "Warsaw",
                            "start_date": "2026-07-11",
                            "rental_days": 2,
                            "suggested_rate_pln_day": 60,
                            "mm_rate_pln_day": 90,
                            "benchmark_provider": "Car24",
                            "benchmark_rate_pln_day": 61,
                            "scenario_id": "2026-07-11-2",
                        },
                        {
                            "action": "decrease",
                            "recommendation_type": "top3_small_decrease",
                            "reason": "Cel top3 wymaga roznicy mniejszej niz 10 PLN/dzien; cel to 1 PLN ponizej top3.",
                            "location": "Warsaw",
                            "start_date": "2026-07-25",
                            "rental_days": 8,
                            "suggested_rate_pln_day": 90,
                            "mm_rate_pln_day": 120,
                            "benchmark_provider": "Kaizen Rent",
                            "benchmark_rate_pln_day": 91,
                            "scenario_id": "2026-07-25-8",
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )

        config = merge_config(
            {
                "location_zones": {"Warsaw": ["WA1"]},
                "max_recommendation_duration_days": 35,
                "duration_band_evidence_max_days": None,
                "minimum_rates": {"scoped_overrides": []},
            }
        )

        summary = apply_updates(
            workbook_path=workbook_path,
            recommendations_path=recommendations_path,
            output_path=output_path,
            config=config,
            cli_groups=None,
            dry_run=False,
            import_output_path=import_output_path,
        )

        limited_output_path = tmpdir / "rates-over-limit.xlsx"
        limited_import_path = tmpdir / "rates-import-over-limit.xlsx"
        try:
            apply_updates(
                workbook_path=workbook_path,
                recommendations_path=recommendations_path,
                output_path=limited_output_path,
                config=merge_config({
                    "location_zones": {"Warsaw": ["WA1"]},
                    "max_recommendation_duration_days": 35,
                    "max_import_rows": 13,
                }),
                cli_groups=None,
                dry_run=False,
                import_output_path=limited_import_path,
            )
            raise AssertionError("workbook above the broker row limit should fail")
        except ValueError as error:
            assert "row limit exceeded" in str(error)
        assert_equal(limited_output_path.exists(), False, "over-limit recommendation workbook is not saved")
        assert_equal(limited_import_path.exists(), False, "over-limit import workbook is not saved")

        assert_equal(summary["change_count"], 12, "change_count")
        assert_equal(summary["group_price_parity_change_count"], 0, "group_price_parity_change_count")
        assert_equal(summary["group_price_parity_scope_count"], 4, "group_price_parity_scope_count")
        assert_equal(summary["import_output"], str(import_output_path), "import output path")
        assert_equal(summary["max_import_rows"], None, "summary import row limit disabled")
        assert_equal(summary["import_row_count"], 14, "summary import row count")
        assert_equal(
            summary["recommendation_date_scope"],
            {"start_date": "2026-07-10", "end_date": "2026-07-25", "date_count": 3},
            "summary recommendation date scope",
        )
        assert_equal(summary["normalized_pickup_end_count"], 10, "normalized_pickup_end_count")
        assert_equal(summary["synced_booking_end_count"], 4, "synced_booking_end_count")
        updated = openpyxl.load_workbook(output_path)
        ws = updated["Sheet1"]
        changed_ws = updated["Changed Positions"]
        assert_equal(
            updated.sheetnames,
            ["Sheet1", "Changed Positions", "Recommendations Review", "Validation"],
            "workbook sheets",
        )
        assert str(ws["A4"].fill.fgColor.rgb).endswith("1F4E78")
        review_ws = updated["Recommendations Review"]
        validation_ws = updated["Validation"]
        assert_equal(
            [tuple("" if value is None else value for value in row)
             for row in validation_ws.iter_rows(min_row=2, values_only=True)],
            [(item["check"], item["status"], item["issue_count"], item["details"])
             for item in summary["validation"]],
            "validation sheet matches the checks returned in the summary",
        )
        import_ready = openpyxl.load_workbook(import_output_path)
        for book in (updated, import_ready):
            for sheet in book.worksheets:
                assert_equal(sheet.freeze_panes, None, f"no frozen panes in {sheet.title}")
        assert_equal(import_ready.sheetnames, ["Sheet1"], "import-ready workbook sheets")
        import_ready_ws = import_ready["Sheet1"]
        assert_equal(import_ready_ws["J5"].value, 81, "import-ready updated rate")
        assert_equal(import_ready_ws["N5"].value, 100, "import-ready long duration minimum")
        assert_equal(ws.max_row, 14, "main import sheet row count")
        assert_equal(ws["J5"].value, 81, "updated rate")
        assert_equal(ws["J6"].value, ws["J7"].value, "CGAV rate equals CWAV")
        assert_equal(ws["N6"].value, ws["N7"].value, "CGAV long-duration rate equals CWAV")
        assert_equal(ws["J7"].value, 81, "CWAV parity rate")
        assert_equal(ws["J8"].value, 82, "EDMV adjusted rate")
        assert_equal(ws["J9"].value, 70, "excluded FVMD rate")
        assert_equal(ws["J10"].value, 70, "excluded SWAV rate")
        assert_equal(ws["I7"].value, 160, "CWAV duration 1 rate outside recommendations is unchanged")
        assert_equal(ws["I8"].value, 160, "EDMV duration 1 rate outside recommendations is unchanged")
        assert_equal(ws["I9"].value, 160, "excluded FVMD duration 1 rate")
        assert_equal(ws["K7"].value, 80, "CWAV duration 3-4 rate outside recommendations is unchanged")
        assert_equal(ws["K8"].value, 80, "EDMV duration 3-4 rate outside recommendations is unchanged")
        assert_equal(ws["N5"].value, 100, "long duration minimum")
        assert_equal(ws["N7"].value, 100, "long duration minimum for CWAV")
        assert_equal(ws["N8"].value, 101, "long duration minimum with EDMV adjustment")
        assert_equal(ws["N9"].value, 120, "excluded FVMD long duration rate")
        assert_equal(ws["J11"].value, 70, "global minimum")
        assert_equal(ws["J12"].value, 71, "global minimum with EDMV adjustment")
        assert_equal(ws["M13"].value, 115, "seasonal duration minimum")
        assert_equal(ws["M14"].value, 116, "seasonal duration minimum with EDMV adjustment")
        assert_equal(ws["H5"].value, ws["G5"].value, "pickup end normalized for CDMV")
        assert_equal(ws["H6"].value, ws["G6"].value, "pickup end normalized for CGAV")
        for row in range(5, 15):
            assert_equal(ws.cell(row, 6).value, ws.cell(row, 8).value, f"booking end equals pickup end in row {row}")
        assert_not_equal(rgb(ws["J5"]), "C6EFCE", "increase color uses dynamic scale")
        assert_equal(rgb(ws["J5"]), "A9D18E", "increase color uses a stepped green scale")
        assert_not_equal(rgb(ws["J11"]), rgb(ws["M13"]), "larger decrease uses a stronger red")
        assert ws["J5"].comment is not None
        assert_equal(
            ws["J5"].comment.text,
            "Poprzednia stawka: 70 PLN\nNowa stawka: 81 PLN\nZmiana: +11 PLN\nCel na stronie: 81 PLN\nPrognoza na stronie: 81 PLN",
            "short Sheet1 comment",
        )
        assert ws["J8"].comment is not None
        assert_equal(
            ws["J8"].comment.text,
            "Poprzednia stawka: 70 PLN\nNowa stawka: 82 PLN\nZmiana: +12 PLN\nCel na stronie: 81 PLN\nPrognoza na stronie: 82 PLN\nCel rankingowy: wymaga kontroli",
            "short adjusted Sheet1 comment",
        )
        assert "brutto/dzien" not in ws["N5"].comment.text
        assert ws["J6"].comment is not None
        assert_equal(changed_ws["A1"].value, "Legenda", "changed sheet legend title")
        assert_equal(changed_ws["A2"].value, "Top1 gap", "top1 legend label")
        assert "co najmniej 10 PLN" in changed_ws["B2"].value
        assert_equal(rgb(changed_ws["A2"]), "9DC3E6", "top1 legend color")
        assert_equal(changed_ws["A3"].value, "Male obnizenie top3", "top3 legend label")
        assert_equal(rgb(changed_ws["A3"]), "FFC7CE", "top3 legend color")
        assert_equal(changed_ws["A4"].value, "Przebicie top1", "top1 undercut legend label")
        assert_equal(rgb(changed_ws["A4"]), "F4B183", "top1 undercut legend color")
        assert_equal(changed_ws["A5"].value, "Hierarchia i scalanie", "pricing hierarchy and duration aggregation legend label")
        assert_equal(changed_ws["A6"].value, "Kontrola celu", "target verification legend label")
        assert_equal(changed_ws["A9"].value, "Floor cenowy", "floor legend label")
        assert "Floor cenowy" in changed_ws["B9"].value
        assert_equal(changed_ws["O15"].value, "Komentarz zmiany", "changed sheet comment header")
        assert_equal(changed_ws.max_row, 20, "changed sheet row count")
        assert_equal(changed_ws["A16"].value, "CDMV, CGAV, CWAV", "first changed group set")
        assert "Powod rekomendacji: MM Cars Rental jest na 1 miejscu" in changed_ws["O16"].value
        assert "co najmniej 10 PLN" in changed_ws["O16"].value
        assert "Co pozwoli osiagnac: utrzymanie top1" in changed_ws["O16"].value
        assert "Poprzednia stawka: 70 PLN" in changed_ws["O16"].value
        assert "Nowa stawka: 81 PLN" in changed_ws["O16"].value
        assert "Zmiana: +11 PLN" in changed_ws["O16"].value
        assert "EDMV: 82 PLN" not in changed_ws["O16"].value
        assert "brutto/dzien" not in changed_ws["O16"].value
        assert "Lokalizacja" not in changed_ws["O16"].value
        assert "Data odbioru" not in changed_ws["O16"].value
        assert "Duration" not in changed_ws["O16"].value
        assert "Korekta grupy" not in changed_ws["O16"].value
        assert "Komorka" not in changed_ws["O16"].value
        assert "Scenario" not in changed_ws["O16"].value
        assert "Zastosowane minimum" not in changed_ws["O16"].value
        assert_equal(changed_ws["J16"].value, 81, "grouped base rate cell")
        assert "Co pozwoli osiagnac: cel rankingowy nie jest gwarantowany" in changed_ws["O20"].value
        assert "Zastosowane minimum" not in changed_ws["O20"].value
        assert "Minimum sezonowe" not in changed_ws["O20"].value
        assert_equal(rgb(changed_ws["O16"]), "9DC3E6", "top1 gap row is blue")
        assert_equal(rgb(changed_ws["O17"]), "F4B183", "top1 undercut row is orange")
        assert_equal(rgb(changed_ws["O20"]), "FFC7CE", "top3 small decrease row is red")
        assert changed_ws["O16"].comment is not None
        for row in range(1, changed_ws.max_row + 1):
            for col in range(1, 15):
                assert changed_ws.cell(row, col).comment is None
        changed_groups = {changed_ws.cell(row, 1).value for row in range(16, changed_ws.max_row + 1)}
        assert "CGAV" in ",".join(changed_groups)
        assert "FVMD" not in ",".join(changed_groups)
        assert "SWAV" not in ",".join(changed_groups)
        assert_equal(review_ws["A1"].value, "Akceptacja?", "review header")
        assert_equal(review_ws["B1"].value, "Status", "review status header")
        assert_equal(review_ws.max_row, 6, "review row count")
        assert_equal(review_ws["D2"].value, "Warsaw", "review location")
        assert_equal(review_ws["F2"].value, "CDMV, CGAV, CWAV", "review grouped groups")
        assert review_ws["B2"].value in {"Gotowe", "Gotowe z uwaga", "Sprawdz"}
        assert review_ws["C2"].value == "OK"
        validation_rows = {
            validation_ws.cell(row, 1).value: validation_ws.cell(row, 2).value
            for row in range(2, validation_ws.max_row + 1)
        }
        assert_equal(validation_rows["Booking end date = Pickup end date"], "OK", "booking date validation")
        assert_equal(validation_rows["Pickup end date = Pickup start date"], "OK", "pickup date validation")
        assert_equal(validation_rows["Puste stawki w kolumnach duration"], "OK", "blank rate validation")
        assert_equal(validation_rows["Zmienione stawki ponizej floor cenowego"], "OK", "floor validation")
        parity_validation = build_validation_rows(
            ws,
            config,
            get_duration_columns(ws, config),
            [{"recommendation_type": "group_parity", "cell": "J5"}],
            [],
            {},
        )
        parity_validation_by_name = {row[0]: row for row in parity_validation}
        assert_equal(
            parity_validation_by_name["Zmienione rekomendacje bez ceny benchmarku"][2],
            0,
            "group parity does not require a competitor benchmark",
        )

        exact_location_workbook_path = tmpdir / "exact-location-rates.xlsx"
        exact_location_recommendations_path = tmpdir / "exact-location-recommendations.json"
        exact_location_output_path = tmpdir / "exact-location-rates-updated.xlsx"
        build_minimal_workbook(
            exact_location_workbook_path,
            [
                ["CDMV", None, None, "WA1", "09-06-26", "20-06-26", "20-06-26", "20-06-26", 160, 70, 80, 90, 100, 120],
                ["CDMV", None, None, "WA2", "09-06-26", "20-06-26", "20-06-26", "20-06-26", 160, 70, 80, 90, 100, 120],
            ],
        )
        exact_location_recommendations_path.write_text(
            json.dumps(
                {
                    "recommendations": [
                        {
                            "action": "increase",
                            "recommendation_type": "top1_gap",
                            "location": "Warsaw West Train Station",
                            "start_date": "2026-06-20",
                            "rental_days": 2,
                            "suggested_rate_pln_day": 90,
                            "mm_rate_pln_day": 70,
                            "benchmark_provider": "GO Rental Cars",
                            "benchmark_rate_pln_day": 91,
                            "scenario_id": "exact-location-2026-06-20-2",
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        exact_location_summary = apply_updates(
            workbook_path=exact_location_workbook_path,
            recommendations_path=exact_location_recommendations_path,
            output_path=exact_location_output_path,
            config=merge_config(
                {
                    "location_zones": example_config["location_zones"],
                    "pickup_date_expansion": {"enabled": False},
                }
            ),
            cli_groups=None,
            dry_run=False,
        )
        exact_location_updated = openpyxl.load_workbook(exact_location_output_path)
        exact_location_ws = exact_location_updated["Sheet1"]
        assert_equal(exact_location_summary["change_count"], 1, "exact location updates only one zone")
        assert_equal(exact_location_ws["J5"].value, 90, "WA1 exact location update")
        assert_equal(exact_location_ws["J6"].value, 70, "WA2 is not changed by WA1 exact location")

        dedup_workbook_path = tmpdir / "dedup-rates.xlsx"
        dedup_recommendations_path = tmpdir / "dedup-recommendations.json"
        dedup_output_path = tmpdir / "dedup-rates-updated.xlsx"
        build_minimal_workbook(
            dedup_workbook_path,
            [
                ["CDMV", None, None, "WA1", "09-06-26", "10-06-26", "10-06-26", "11-06-26", 160, 70, 80, 90, 100, 120],
                ["MDMR", None, None, "WA1", "09-06-26", "10-06-26", "10-06-26", "11-06-26", 160, 70, 80, 90, 100, 120],
            ],
        )
        dedup_recommendations_path.write_text(
            json.dumps(
                {
                    "recommendations": [
                        {
                            "action": "increase",
                            "recommendation_type": "top1_gap",
                            "reason": "MM Cars Rental jest top1, a top2 jest drozszy o co najmniej 10 PLN/dzien; cel to 1 PLN ponizej top2.",
                            "location": "Warsaw",
                            "start_date": "2026-06-10",
                            "rental_days": 2,
                            "suggested_rate_pln_day": 81,
                            "mm_rate_pln_day": 70,
                            "benchmark_provider": "Flex To Go",
                            "benchmark_rate_pln_day": 82,
                            "scenario_id": "dedup-2026-06-10-2",
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        dedup_summary = apply_updates(
            workbook_path=dedup_workbook_path,
            recommendations_path=dedup_recommendations_path,
            output_path=dedup_output_path,
            config=merge_config({"apply_groups": ["CDMV", "MDMR"], "location_zones": {"Warsaw": ["WA1"]}}),
            cli_groups=None,
            dry_run=False,
        )
        assert_equal(dedup_summary["change_count"], 2, "deduplicated change count")
        dedup_updated = openpyxl.load_workbook(dedup_output_path)
        dedup_changed_ws = dedup_updated["Changed Positions"]
        assert_equal(dedup_changed_ws.max_row, 16, "deduplicated changed sheet row count")
        assert_equal(dedup_changed_ws["A16"].value, "CDMV, MDMR", "deduplicated group list")
        assert_equal(dedup_changed_ws["J16"].value, 81, "deduplicated changed rate cell")
        assert "70 PLN; 70 PLN" not in dedup_changed_ws["O16"].value
        assert "81 PLN; 81 PLN" not in dedup_changed_ws["O16"].value
        assert "+11 PLN; +11 PLN" not in dedup_changed_ws["O16"].value

        accepted_only_workbook_path = tmpdir / "accepted-only-rates.xlsx"
        accepted_only_recommendations_path = tmpdir / "accepted-only-recommendations.json"
        accepted_only_output_path = tmpdir / "accepted-only-rates-updated.xlsx"
        build_minimal_workbook(
            accepted_only_workbook_path,
            [
                ["CDMV", None, None, "WA1", "09-06-26", "10-06-26", "10-06-26", "11-06-26", 160, 70, 80, 90, 100, 120],
            ],
        )
        accepted_only_recommendations_path.write_text(
            json.dumps(
                {
                    "recommendations": [
                        {
                            "action": "increase",
                            "accepted": True,
                            "location": "Warsaw",
                            "start_date": "2026-06-10",
                            "rental_days": 2,
                            "suggested_rate_pln_day": 85,
                        },
                        {
                            "action": "increase",
                            "accepted": False,
                            "location": "Warsaw",
                            "start_date": "2026-06-10",
                            "rental_days": 3,
                            "suggested_rate_pln_day": 95,
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        accepted_only_summary = apply_updates(
            workbook_path=accepted_only_workbook_path,
            recommendations_path=accepted_only_recommendations_path,
            output_path=accepted_only_output_path,
            config=merge_config({"location_zones": {"Warsaw": ["WA1"]}}),
            cli_groups=None,
            dry_run=False,
            accepted_only=True,
        )
        assert_equal(accepted_only_summary["accepted_target_count"], 1, "accepted-only target count")
        assert_equal(accepted_only_summary["filtered_unaccepted_target_count"], 1, "filtered target count")
        accepted_only_updated = openpyxl.load_workbook(accepted_only_output_path)
        accepted_only_ws = accepted_only_updated["Sheet1"]
        assert_equal(accepted_only_ws["J5"].value, 85, "accepted recommendation applied")
        assert_equal(accepted_only_ws["K5"].value, 80, "unaccepted recommendation skipped")

        acceptance_review_path = tmpdir / "acceptance-review.xlsx"
        acceptance_review = openpyxl.Workbook()
        acceptance_review_ws = acceptance_review.active
        acceptance_review_ws.title = "Recommendations Review"
        acceptance_review_ws.append(["Akceptacja?", "Lokalizacja", "Data odbioru", "Przedzial duration", "ID scenariusza"])
        acceptance_review_ws.append(["YES", "Warsaw", "2026-06-10", "2", ""])
        acceptance_review.save(acceptance_review_path)

        acceptance_workbook_path = tmpdir / "acceptance-rates.xlsx"
        acceptance_recommendations_path = tmpdir / "acceptance-recommendations.json"
        acceptance_output_path = tmpdir / "acceptance-rates-updated.xlsx"
        build_minimal_workbook(
            acceptance_workbook_path,
            [
                ["CDMV", None, None, "WA1", "09-06-26", "10-06-26", "10-06-26", "11-06-26", 160, 70, 80, 90, 100, 120],
            ],
        )
        acceptance_recommendations_path.write_text(
            json.dumps(
                {
                    "recommendations": [
                        {
                            "action": "increase",
                            "location": "Warsaw",
                            "start_date": "2026-06-10",
                            "rental_days": 2,
                            "suggested_rate_pln_day": 86,
                        },
                        {
                            "action": "increase",
                            "location": "Warsaw",
                            "start_date": "2026-06-10",
                            "rental_days": 3,
                            "suggested_rate_pln_day": 96,
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        acceptance_summary = apply_updates(
            workbook_path=acceptance_workbook_path,
            recommendations_path=acceptance_recommendations_path,
            output_path=acceptance_output_path,
            config=merge_config({"location_zones": {"Warsaw": ["WA1"]}}),
            cli_groups=None,
            dry_run=False,
            accepted_only=True,
            acceptance_workbook_path=acceptance_review_path,
        )
        assert_equal(acceptance_summary["accepted_target_count"], 1, "acceptance workbook target count")
        acceptance_updated = openpyxl.load_workbook(acceptance_output_path)
        acceptance_ws = acceptance_updated["Sheet1"]
        assert_equal(acceptance_ws["J5"].value, 86, "acceptance workbook recommendation applied")
        assert_equal(acceptance_ws["K5"].value, 80, "non-accepted workbook recommendation skipped")

        expansion_workbook_path = tmpdir / "expansion-rates.xlsx"
        expansion_recommendations_path = tmpdir / "expansion-recommendations.json"
        expansion_output_path = tmpdir / "expansion-rates-updated.xlsx"
        build_minimal_workbook(
            expansion_workbook_path,
            [
                ["CDMV", None, None, "WA1", "09-06-26", "10-06-26", "10-06-26", "10-06-26", 155, 65, 75, 85, 95, 115],
                ["CDMV", None, None, "WA1", "09-06-26", "10-06-26", "10-06-26", "12-06-26", 160, 70, 80, 90, 100, 120],
                ["CDMV", None, None, "WA1", "09-06-26", "13-06-26", "13-06-26", "13-06-26", 165, 75, 85, 95, 105, 125],
            ],
        )
        expansion_before = openpyxl.load_workbook(expansion_workbook_path)
        expansion_before_snapshot = header_rows_snapshot(expansion_before["Sheet1"])
        expansion_recommendations_path.write_text(
            json.dumps(
                {
                    "recommendations": [
                        {
                            "action": "decrease",
                            "recommendation_type": "top1_undercut",
                            "reason": "MM Cars Rental jest top2 i brakuje mniej niz 10 PLN/dzien, zeby zostac top1; cel to 1 PLN ponizej top1.",
                            "location": "Warsaw",
                            "start_date": "2026-06-11",
                            "rental_days": 1,
                            "suggested_rate_pln_day": 75,
                            "mm_rate_pln_day": 160,
                            "benchmark_provider": "Car24",
                            "benchmark_rate_pln_day": 76,
                            "scenario_id": "expansion-2026-06-11-1",
                        },
                        {
                            "action": "increase",
                            "recommendation_type": "top1_gap",
                            "reason": "MM Cars Rental jest top1, a top2 jest drozszy o co najmniej 10 PLN/dzien; cel to 1 PLN ponizej top2.",
                            "location": "Warsaw",
                            "start_date": "2026-06-11",
                            "rental_days": 2,
                            "suggested_rate_pln_day": 81,
                            "mm_rate_pln_day": 70,
                            "benchmark_provider": "Flex To Go",
                            "benchmark_rate_pln_day": 82,
                            "scenario_id": "expansion-2026-06-11-2",
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        expansion_summary = apply_updates(
            workbook_path=expansion_workbook_path,
            recommendations_path=expansion_recommendations_path,
            output_path=expansion_output_path,
            config=merge_config(
                {
                    "location_zones": {"Warsaw": ["WA1"]},
                    "normalize_pickup_end_to_start": False,
                    "pickup_date_expansion": {
                        "enabled": True,
                        "start_date": "2026-06-11",
                        "end_date": "2026-06-12",
                        "drop_rows_before_start_date": True,
                        "drop_rows_after_end_date": True,
                        "time_zone": "Europe/Warsaw",
                    },
                }
            ),
            cli_groups=None,
            dry_run=False,
        )
        assert_equal(expansion_summary["pickup_date_expansion"]["source_row_count"], 1, "expanded source row count")
        assert_equal(expansion_summary["pickup_date_expansion"]["expanded_row_count"], 2, "expanded row count")
        assert_equal(expansion_summary["pickup_date_expansion"]["preserved_out_of_range_row_count"], 0, "preserved source row count")
        assert_equal(expansion_summary["pickup_date_expansion"]["dropped_before_start_row_count"], 2, "past row count")
        assert_equal(expansion_summary["pickup_date_expansion"]["dropped_after_end_row_count"], 1, "future row count")
        assert_equal(expansion_summary["pickup_date_expansion"]["output_row_count"], 2, "full output row count")
        assert_equal(expansion_summary["normalized_pickup_end_count"], 0, "expansion disables pickup end normalization")
        assert_equal(expansion_summary["synced_booking_end_count"], 2, "expanded booking end sync count")
        assert_equal(expansion_summary["change_count"], 2, "expanded duration-specific change count")
        expansion_updated = openpyxl.load_workbook(expansion_output_path)
        expansion_ws = expansion_updated["Sheet1"]
        expansion_after_snapshot = header_rows_snapshot(expansion_ws)
        assert_equal(expansion_after_snapshot, expansion_before_snapshot, "expanded Sheet1 rows 1-4 values and formatting")
        assert_equal(expansion_ws.max_row, 6, "expanded Sheet1 row count")
        assert_equal(expansion_ws["G5"].value, "11-06-26", "first expanded pickup date")
        assert_equal(expansion_ws["H5"].value, "11-06-26", "first expanded pickup end")
        assert_equal(expansion_ws["F5"].value, expansion_ws["H5"].value, "first expanded booking end")
        assert_equal(expansion_ws["G6"].value, "12-06-26", "second expanded pickup date")
        assert_equal(expansion_ws["H6"].value, "12-06-26", "second expanded pickup end")
        assert_equal(expansion_ws["F6"].value, expansion_ws["H6"].value, "unchanged date booking end")
        assert_equal(expansion_ws["I5"].value, 75, "duration 1 rate update")
        assert_equal(expansion_ws["J5"].value, 81, "duration 2 rate update on the same pickup date row")
        assert_equal(expansion_ws["I6"].value, 165, "duration 1 rate does not update a different pickup date")
        assert_equal(expansion_ws["J6"].value, 75, "duration 2 rate does not update a different pickup date")

        partial_range_workbook_path = tmpdir / "partial-range-rates.xlsx"
        partial_range_recommendations_path = tmpdir / "partial-range-recommendations.json"
        partial_range_output_path = tmpdir / "partial-range-updated.xlsx"
        partial_range_recommendations_path.write_text(json.dumps({"recommendations": []}), encoding="utf-8")
        build_minimal_workbook(
            partial_range_workbook_path,
            [["CDMV", None, None, "WA1", "09-06-26", "11-06-26", "11-06-26", "11-06-26", 155, 65, 75, 85, 95, 115]],
        )
        partial_range_summary = apply_updates(
            workbook_path=partial_range_workbook_path,
            recommendations_path=partial_range_recommendations_path,
            output_path=partial_range_output_path,
            config=merge_config(
                {
                    "pickup_date_expansion": {
                        "enabled": True,
                        "start_date": "2026-06-11",
                        "end_date": "2026-06-12",
                        "drop_rows_before_start_date": True,
                        "drop_rows_after_end_date": True,
                        "time_zone": "Europe/Warsaw",
                    },
                }
            ),
            cli_groups=None,
            dry_run=False,
        )
        assert_equal(
            partial_range_summary["pickup_date_expansion"]["appended_horizon_row_count"],
            1,
            "partial source range is extended through configured end date",
        )
        partial_range_ws = openpyxl.load_workbook(partial_range_output_path)["Sheet1"]
        assert_equal(partial_range_ws.max_row, 6, "partial source range output row count")
        assert_equal(partial_range_ws["G6"].value, "12-06-26", "partial source range final pickup date")
        assert_equal(partial_range_ws["J6"].value, 65, "partial source range carries the latest rate forward")

        internal_gap_workbook_path = tmpdir / "internal-gap-rates.xlsx"
        internal_gap_output_path = tmpdir / "internal-gap-updated.xlsx"
        build_minimal_workbook(
            internal_gap_workbook_path,
            [
                ["CDMV", None, None, "WA1", "09-06-26", "11-06-26", "11-06-26", "11-06-26", 155, 65, 75, 85, 95, 115],
                ["CDMV", None, None, "WA1", "09-06-26", "13-06-26", "13-06-26", "13-06-26", 165, 75, 85, 95, 105, 125],
            ],
        )
        apply_updates(
            workbook_path=internal_gap_workbook_path,
            recommendations_path=partial_range_recommendations_path,
            output_path=internal_gap_output_path,
            config=merge_config(
                {
                    "pickup_date_expansion": {
                        "enabled": True,
                        "start_date": "2026-06-11",
                        "end_date": "2026-06-14",
                        "drop_rows_before_start_date": True,
                        "drop_rows_after_end_date": True,
                        "time_zone": "Europe/Warsaw",
                    },
                }
            ),
            cli_groups=None,
            dry_run=False,
        )
        internal_gap_ws = openpyxl.load_workbook(internal_gap_output_path)["Sheet1"]
        assert_equal(
            [internal_gap_ws.cell(row, 7).value for row in range(5, internal_gap_ws.max_row + 1)],
            ["11-06-26", "13-06-26", "14-06-26"],
            "internal source gaps are preserved while the horizon is extended",
        )

        aggregate_workbook_path = tmpdir / "aggregate-duration-rates.xlsx"
        aggregate_recommendations_path = tmpdir / "aggregate-duration-recommendations.json"
        aggregate_output_path = tmpdir / "aggregate-duration-updated.xlsx"
        build_minimal_workbook(
            aggregate_workbook_path,
            [["CDMV", None, None, "WA1", "14-07-26", "15-07-26", "15-07-26", "15-07-26", 160, 100, 100, 100, 100, 120]],
        )
        aggregate_recommendations_path.write_text(
            json.dumps(
                {
                    "decisions": [
                        {
                            "action": "increase",
                            "recommendation_type": "top1_gap",
                            "location": "Warsaw",
                            "start_date": "2026-07-15",
                            "rental_days": 3,
                            "suggested_rate_pln_day": 120,
                            "maximum_import_rate_pln_day": 120,
                            "site_cap_rate_pln_day": 120,
                            "broker_markup_multiplier": 1,
                            "data_quality_status": "ok",
                        },
                        {
                            "action": "decrease",
                            "recommendation_type": "top1_undercut",
                            "location": "Warsaw",
                            "start_date": "2026-07-15",
                            "rental_days": 4,
                            "suggested_rate_pln_day": 80,
                            "maximum_import_rate_pln_day": 80,
                            "site_cap_rate_pln_day": 80,
                            "broker_markup_multiplier": 1,
                            "data_quality_status": "ok",
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        aggregate_summary = apply_updates(
            workbook_path=aggregate_workbook_path,
            recommendations_path=aggregate_recommendations_path,
            output_path=aggregate_output_path,
            config=merge_config({"location_zones": {"Warsaw": ["WA1"]}}),
            cli_groups=None,
            dry_run=False,
        )
        aggregate_ws = openpyxl.load_workbook(aggregate_output_path)["Sheet1"]
        assert_equal(aggregate_ws["K5"].value, 80, "duration band uses the most restrictive recommendation")
        assert_equal(aggregate_summary["change_count"], 1, "duration band writes one cell once")
        assert_equal(aggregate_summary["changes"][0]["source_decision_count"], 2, "duration band source count")
        assert_equal(aggregate_summary["changes"][0]["aggregation_conflict"], True, "duration band conflict flag")

        partial_workbook_path = tmpdir / "partial-duration-rates.xlsx"
        partial_recommendations_path = tmpdir / "partial-duration-recommendations.json"
        partial_output_path = tmpdir / "partial-duration-updated.xlsx"
        build_minimal_workbook(
            partial_workbook_path,
            [["CDMV", None, None, "WA1", "14-09-26", "15-09-26", "15-09-26", "15-09-26", 160, 100, 100, 100, 100, 120]],
        )
        partial_recommendations_path.write_text(
            json.dumps(
                {
                    "decisions": [{
                        "action": "increase",
                        "recommendation_type": "top1_gap",
                        "location": "Warsaw",
                        "start_date": "2026-09-15",
                        "rental_days": 8,
                        "suggested_rate_pln_day": 150,
                        "maximum_import_rate_pln_day": 150,
                        "site_cap_rate_pln_day": 150,
                        "broker_markup_multiplier": 1,
                        "data_quality_status": "ok",
                    }]
                }
            ),
            encoding="utf-8",
        )
        partial_summary = apply_updates(
            workbook_path=partial_workbook_path,
            recommendations_path=partial_recommendations_path,
            output_path=partial_output_path,
            config=merge_config({"location_zones": {"Warsaw": ["WA1"]}}),
            cli_groups=None,
            dry_run=False,
        )
        partial_ws = openpyxl.load_workbook(partial_output_path)["Sheet1"]
        assert_equal(partial_ws["M5"].value, 100, "incomplete duration band does not raise the current rate")
        assert_equal(partial_summary["change_count"], 0, "incomplete duration band increase is skipped")
        assert_equal(partial_summary["skipped_target_count"], 1, "incomplete duration band is reported")

        force_top1_workbook_path = tmpdir / "force-top1-rates.xlsx"
        force_top1_recommendations_path = tmpdir / "force-top1-recommendations.json"
        force_top1_output_path = tmpdir / "force-top1-updated.xlsx"
        build_minimal_workbook(
            force_top1_workbook_path,
            [
                ["CDMV", None, None, "WA1", "14-09-26", "15-09-26", "15-09-26", "15-09-26", 160, 100, 100, 100, 100, 120],
                ["EDMV", None, None, "WA1", "14-09-26", "15-09-26", "15-09-26", "15-09-26", 160, 101, 100, 100, 100, 120],
            ],
        )
        force_top1_recommendations_path.write_text(
            json.dumps(
                {
                    "decisions": [{
                        "action": "decrease",
                        "recommendation_type": "force_top1_undercut",
                        "location": "Warsaw",
                        "start_date": "2026-09-15",
                        "rental_days": 2,
                        "suggested_rate_pln_day": 80,
                        "site_cap_rate_pln_day": 80,
                        "broker_markup_multiplier": 1,
                        "data_quality_status": "ok",
                    }]
                }
            ),
            encoding="utf-8",
        )
        force_top1_summary = apply_updates(
            workbook_path=force_top1_workbook_path,
            recommendations_path=force_top1_recommendations_path,
            output_path=force_top1_output_path,
            config=merge_config({"location_zones": {"Warsaw": ["WA1"]}}),
            cli_groups=None,
            dry_run=False,
        )
        force_top1_ws = openpyxl.load_workbook(force_top1_output_path)["Sheet1"]
        assert_equal(force_top1_ws["J5"].value, 79, "force top1 reserves premium adjustment in base rate")
        assert_equal(force_top1_ws["J6"].value, 80, "force top1 keeps EDMV below the site cap")
        assert all(
            change["target_achievable"]
            for change in force_top1_summary["changes"]
            if change["recommendation_type"] != "group_parity"
        )

        city_cap_workbook_path = tmpdir / "city-cap-rates.xlsx"
        city_cap_recommendations_path = tmpdir / "city-cap-recommendations.json"
        city_cap_output_path = tmpdir / "city-cap-updated.xlsx"
        parity_groups = ["CDMV", "CWAV", "CWMR", "EDMV"]
        city_cap_rows = []
        for zone, base_rate in (("WA1", 90), ("WALO", 100)):
            for group in parity_groups:
                adjustment = 1 if group == "EDMV" else 0
                city_cap_rows.append([
                    group,
                    None,
                    None,
                    zone,
                    "14-09-26",
                    "15-09-26",
                    "15-09-26",
                    "15-09-26",
                    160,
                    base_rate + adjustment,
                    100,
                    100,
                    100,
                    120,
                ])
        build_minimal_workbook(city_cap_workbook_path, city_cap_rows)
        city_cap_recommendations_path.write_text(
            json.dumps({
                "decisions": [{
                    "action": "increase",
                    "recommendation_type": "top1_gap",
                    "location": "Warsaw Train Station",
                    "start_date": "2026-09-15",
                    "rental_days": 2,
                    "suggested_rate_pln_day": 150,
                    "maximum_import_rate_pln_day": 150,
                    "site_cap_rate_pln_day": 150,
                    "broker_markup_multiplier": 1,
                    "benchmark_provider": "Car24",
                    "benchmark_rate_pln_day": 151,
                    "mm_rate_pln_day": 90,
                    "data_quality_status": "ok",
                }]
            }),
            encoding="utf-8",
        )
        city_cap_summary = apply_updates(
            workbook_path=city_cap_workbook_path,
            recommendations_path=city_cap_recommendations_path,
            output_path=city_cap_output_path,
            config=merge_config({
                "location_zones": {"Warsaw Train Station": ["WA1"]},
                "city_zone_airport_zones": {"WA1": ["WALO"]},
                "zone_location_labels": {"WALO": "Warsaw Chopin Airport (WAW)"},
            }),
            cli_groups=None,
            dry_run=False,
        )
        city_cap_workbook = openpyxl.load_workbook(city_cap_output_path)
        city_cap_ws = city_cap_workbook["Sheet1"]
        for offset, group in enumerate(parity_groups, start=5):
            expected_rate = 131 if group == "EDMV" else 130
            assert_equal(city_cap_ws.cell(offset, 10).value, expected_rate, f"city cap rate for {group}")
        for offset, group in enumerate(parity_groups, start=5 + len(parity_groups)):
            expected_rate = 101 if group == "EDMV" else 100
            assert_equal(city_cap_ws.cell(offset, 10).value, expected_rate, f"unchanged airport rate for {group}")
        assert_equal(city_cap_summary["city_top1_airport_cap_scope_count"], 1, "city cap scope count")
        assert_equal(city_cap_summary["city_top1_airport_cap_applied_count"], 4, "city cap applied count")
        assert_equal(city_cap_summary["city_top1_airport_cap_violation_count"], 0, "city cap violations")
        assert "max 130% ceny lotniskowej" in city_cap_ws["J5"].comment.text
        assert_equal(city_cap_workbook["Changed Positions"]["A10"].value, "Limit miasto vs lotnisko", "city cap legend")
        assert "maksymalnie 130%" in city_cap_workbook["Changed Positions"]["B10"].value

        permission_cap_rows = [list(row) for row in city_cap_rows]
        for row in permission_cap_rows:
            if row[3] == "WA1" and row[0] != "CDMV":
                row[9] = 250
        unknown_city_row = list(permission_cap_rows[0])
        unknown_city_row[0], unknown_city_row[9] = "ZZAV", 500
        permission_cap_rows.append(unknown_city_row)
        permission_cap_source = tmpdir / "city-cap-permissions-source.xlsx"
        permission_cap_output = tmpdir / "city-cap-permissions-output.xlsx"
        build_minimal_workbook(permission_cap_source, permission_cap_rows)
        permission_cap_summary = apply_updates(
            workbook_path=permission_cap_source,
            recommendations_path=city_cap_recommendations_path,
            output_path=permission_cap_output,
            config=merge_config({
                "location_zones": {"Warsaw Train Station": ["WA1"]},
                "city_zone_airport_zones": {"WA1": ["WALO"]},
            }),
            cli_groups="CDMV",
            dry_run=False,
        )
        assert_equal(permission_cap_summary["change_count"], 1, "cap validation respects CLI group selection")
        permission_cap_book = openpyxl.load_workbook(permission_cap_output)
        for row_number, original in enumerate(permission_cap_rows, start=5):
            expected = 130 if original[0] == "CDMV" and original[3] == "WA1" else original[9]
            assert_equal(permission_cap_book["Sheet1"].cell(row_number, 10).value, expected, "unselected and unknown city rates preserved")
        permission_cap_book.close()

        city_cap_out_of_scope_output_path = tmpdir / "city-cap-out-of-scope.xlsx"
        city_cap_out_of_scope_summary = apply_updates(
            workbook_path=city_cap_workbook_path,
            recommendations_path=city_cap_recommendations_path,
            output_path=city_cap_out_of_scope_output_path,
            config=merge_config({
                "location_zones": {"Warsaw Train Station": ["WA1"]},
                "city_zone_airport_zones": {"WA1": ["WALO"]},
                "pickup_date_expansion": {
                    "enabled": True,
                    "start_date": "2026-09-16",
                    "end_date": "2026-09-16",
                    "drop_rows_before_start_date": True,
                    "drop_rows_after_end_date": True,
                    "time_zone": "Europe/Warsaw",
                },
            }),
            cli_groups=None,
            dry_run=False,
        )
        assert_equal(
            city_cap_out_of_scope_summary["recommendation_out_of_pickup_range_count"],
            1,
            "out-of-range recommendation count",
        )
        assert_equal(city_cap_out_of_scope_summary["city_top1_airport_cap_scope_count"], 0, "out-of-range city cap scope")
        city_cap_out_of_scope_ws = openpyxl.load_workbook(city_cap_out_of_scope_output_path)["Sheet1"]
        assert_equal(
            {parse_date_value(city_cap_out_of_scope_ws.cell(row, 7).value) for row in range(5, city_cap_out_of_scope_ws.max_row + 1)},
            {date(2026, 9, 16)},
            "out-of-range recommendations do not restore removed dates",
        )

        conflict_rows = [list(row) for row in city_cap_rows]
        conflict_rows[1][9] = 112
        for row in conflict_rows:
            if row[3] == "WALO":
                row[10] = 150
        conflict_source = tmpdir / "city-cap-conflict-source.xlsx"
        build_minimal_workbook(conflict_source, conflict_rows)
        conflict_source_book = openpyxl.load_workbook(conflict_source)
        conflict_source_book["Sheet1"]["J5"].fill = PatternFill(fill_type="solid", fgColor="FFF2CC")
        conflict_source_book["Sheet1"]["J5"].comment = Comment("Original baseline note", "Baseline")
        conflict_source_book.save(conflict_source)
        conflict_source_book.close()
        conflict_recommendations = tmpdir / "city-cap-conflict-recommendations.json"
        conflict_decisions = json.loads(city_cap_recommendations_path.read_text())["decisions"]
        conflict_decisions += [
            {**conflict_decisions[0], "rental_days": days, "suggested_rate_pln_day": 140,
             "maximum_import_rate_pln_day": 140, "site_cap_rate_pln_day": 141}
            for days in (3, 4)
        ]
        conflict_recommendations.write_text(json.dumps({"decisions": conflict_decisions}), encoding="utf-8")
        conflict_output = tmpdir / "city-cap-floor-conflict.xlsx"
        conflict_import = tmpdir / "city-cap-floor-conflict-import.xlsx"
        conflict_config = merge_config({
            "location_zones": {"Warsaw Train Station": ["WA1"]},
            "city_zone_airport_zones": {"WA1": ["WALO"]},
            "minimum_rates": {"global_min_pln_day": 131},
        })
        conflict_summary = apply_updates(
            workbook_path=conflict_source,
            recommendations_path=conflict_recommendations,
            output_path=conflict_output,
            import_output_path=conflict_import,
            config=conflict_config,
            cli_groups=None,
            dry_run=False,
        )
        assert_equal(conflict_summary["city_top1_airport_cap_conflict_count"], 1, "conflict counted per band, not per class")
        assert_equal(conflict_summary["skipped_target_count"], 1, "conflict is a skipped recommendation")
        conflict = conflict_summary["city_top1_airport_cap_conflicts"][0]
        assert_equal(conflict["zone"], "WA1", "conflict location")
        assert "131" in conflict["skip_reason"] and "130" in conflict["skip_reason"]
        assert_equal(conflict_summary["city_top1_airport_cap_violation_count"], 0, "unchanged conflicts excluded from changed-rate validation")
        for path in (conflict_output, conflict_import):
            book = openpyxl.load_workbook(path)
            sheet = book["Sheet1"]
            assert_equal(sheet.max_row, 12, "all original rate rows preserved")
            assert_equal(rgb(sheet["J5"]), "FFF2CC", "skipped cell keeps its baseline fill")
            assert_equal(sheet["J5"].comment.text, "Original baseline note", "skipped cell has no misleading new recommendation comment")
            for row_number, original in enumerate(conflict_rows, start=5):
                assert_equal(sheet.cell(row_number, 10).value, original[9], "conflict preserves original rates despite unequal class prices")
                expected = 141 if original[0] == "EDMV" else 140
                if original[3] == "WA1":
                    assert_equal(sheet.cell(row_number, 11).value, expected, "unaffected duration band still updated")
            if path == conflict_import:
                assert_equal(book.sheetnames, ["Sheet1"], "clean import contains only Sheet1")
            else:
                review = book["Recommendations Review"]
                assert any(
                    review.cell(row, 2).value == "Sprawdz"
                    and "131" in str(review.cell(row, 3).value)
                    for row in range(2, review.max_row + 1)
                ), "conflict visible in recommendations review"
            book.close()
        dry_conflict_summary = apply_updates(
            workbook_path=conflict_source,
            recommendations_path=conflict_recommendations,
            output_path=None,
            config=conflict_config,
            cli_groups=None,
            dry_run=True,
        )
        assert_equal(dry_conflict_summary["city_top1_airport_cap_conflict_count"], 1, "dry-run also reports conflicts")
        assert all(change["cell"][0] != "J" for change in dry_conflict_summary["changes"])

        premium_conflict_config = merge_config({
            "location_zones": {"Warsaw Train Station": ["WA1"]},
            "city_zone_airport_zones": {"WA1": ["WALO"]},
            "minimum_rates": {"scoped_overrides": [{
                "zones": ["WA1"], "groups": ["EDMV"],
                "min_days": 2, "max_days": 2, "min_pln_day": 131,
            }]},
        })
        premium_conflict_output = tmpdir / "city-cap-premium-conflict.xlsx"
        premium_conflict_summary = apply_updates(
            workbook_path=conflict_source,
            recommendations_path=city_cap_recommendations_path,
            output_path=premium_conflict_output,
            config=premium_conflict_config,
            cli_groups=None,
            dry_run=False,
        )
        assert_equal(premium_conflict_summary["city_top1_airport_cap_conflict_count"], 1, "late premium class conflict detected before base classes are written")
        premium_conflict_book = openpyxl.load_workbook(premium_conflict_output)
        for row_number, original in enumerate(conflict_rows, start=5):
            assert_equal(premium_conflict_book["Sheet1"].cell(row_number, 10).value, original[9], "premium-only conflict preserves the whole parity family")
        premium_conflict_book.close()

        selected_conflict_output = tmpdir / "city-cap-selected-no-conflict.xlsx"
        selected_conflict_summary = apply_updates(
            workbook_path=conflict_source,
            recommendations_path=city_cap_recommendations_path,
            output_path=selected_conflict_output,
            config=premium_conflict_config,
            cli_groups="CDMV",
            dry_run=False,
        )
        assert_equal(selected_conflict_summary["city_top1_airport_cap_conflict_count"], 0, "unselected premium class cannot block an allowed base-class change")
        selected_conflict_book = openpyxl.load_workbook(selected_conflict_output)
        assert_equal(selected_conflict_book["Sheet1"]["J5"].value, 130, "selected base class respects airport cap")
        assert_equal(selected_conflict_book["Sheet1"]["J8"].value, 91, "unselected premium price preserved")
        selected_conflict_book.close()

        independent_rows = [list(row) for row in conflict_rows]
        independent_rows.append(["MDMR", None, None, "WA1", "14-09-26", "15-09-26",
                                 "15-09-26", "15-09-26", 160, 90, 100, 100, 100, 120])
        independent_source = tmpdir / "city-cap-independent-class.xlsx"
        build_minimal_workbook(independent_source, independent_rows)
        for conflict_group, expected_base, expected_premium, expected_independent in (
            ("EDMV", 90, 91, 130),
            ("MDMR", 130, 131, 90),
        ):
            independent_output = tmpdir / f"city-cap-independent-{conflict_group}.xlsx"
            independent_config = merge_config({
                "apply_groups": ["CDMV", "EDMV", "MDMR"],
                "location_zones": {"Warsaw Train Station": ["WA1"]},
                "city_zone_airport_zones": {"WA1": ["WALO"]},
                "minimum_rates": {"scoped_overrides": [{
                    "zones": ["WA1"], "groups": [conflict_group],
                    "min_days": 2, "max_days": 2, "min_pln_day": 131,
                }]},
            })
            independent_summary = apply_updates(
                workbook_path=independent_source,
                recommendations_path=city_cap_recommendations_path,
                output_path=independent_output,
                config=independent_config,
                cli_groups=None,
                dry_run=False,
            )
            independent_book = openpyxl.load_workbook(independent_output)
            assert_equal(independent_book["Sheet1"]["J5"].value, expected_base, "parity family unaffected by an independent-class conflict")
            assert_equal(independent_book["Sheet1"]["J8"].value, expected_premium, "premium follows selected parity family only")
            assert_equal(independent_book["Sheet1"]["J13"].value, expected_independent, "independent class unaffected by a parity-family conflict")
            assert_equal(independent_summary["city_top1_airport_cap_conflict_count"], 1, "independent class conflict counted")
            independent_book.close()

        city_only_workbook_path = tmpdir / "city-cap-missing-airport.xlsx"
        build_minimal_workbook(city_only_workbook_path, city_cap_rows[:len(parity_groups)])
        try:
            apply_updates(
                workbook_path=city_only_workbook_path,
                recommendations_path=city_cap_recommendations_path,
                output_path=tmpdir / "city-cap-missing-airport-output.xlsx",
                config=merge_config({
                    "location_zones": {"Warsaw Train Station": ["WA1"]},
                    "city_zone_airport_zones": {"WA1": ["WALO"]},
                }),
                cli_groups=None,
                dry_run=False,
            )
            raise AssertionError("missing airport reference should block the workbook")
        except ValueError as error:
            assert "Missing airport rate required" in str(error)

        expired_config = merge_config(
            {
                "location_zones": {"Warsaw": ["WA1"]},
                "pickup_date_expansion": {
                    "enabled": True,
                    "start_date": "2027-02-01",
                    "end_date": "2027-01-31",
                    "time_zone": "Europe/Warsaw",
                },
            }
        )
        try:
            apply_updates(
                workbook_path=aggregate_workbook_path,
                recommendations_path=aggregate_recommendations_path,
                output_path=tmpdir / "expired-output.xlsx",
                config=expired_config,
                cli_groups=None,
                dry_run=False,
            )
            raise AssertionError("expired pickup range should fail before modifying Sheet1")
        except ValueError as error:
            assert "Sheet1 was not modified" in str(error)

        real_workbook_path = ROOT / "input" / "mm-cars-rental-rates-inclusive-fp.xlsx"
        real_recommendations_path = tmpdir / "real-recommendations.json"
        real_output_path = tmpdir / "real-rates-updated.xlsx"
        real_before = openpyxl.load_workbook(real_workbook_path)
        real_ws = real_before["Sheet1"]
        before_snapshot = header_rows_snapshot(real_ws)
        expected_pickup_start = datetime.now(ZoneInfo("Europe/Warsaw")).date()
        expected_pickup_end = expected_pickup_start + timedelta(days=99)
        frozen_groups = {"CFAV", "PDAH", "PDAV", "FVMD", "SWAV"}
        frozen_source_rates = {}
        unmapped_source_rates = {}
        real_target = None
        for row in range(5, real_ws.max_row + 1):
            group = str(real_ws.cell(row, 1).value or "").strip().upper()
            zone = str(real_ws.cell(row, 4).value or "").strip().upper()
            pickup_date = parse_date_value(real_ws.cell(row, 7).value)
            old_rate = parse_number(real_ws.cell(row, 10).value)
            if zone in unmapped_source_zones and pickup_date is not None:
                end_date = parse_date_value(real_ws.cell(row, 8).value) or pickup_date
                unmapped_source_rates.setdefault((group, zone), []).append((
                    pickup_date, end_date, tuple(real_ws.cell(row, col).value for col in range(9, 15)),
                ))
            if group in frozen_groups and pickup_date and expected_pickup_start <= pickup_date <= expected_pickup_end:
                frozen_source_rates[(group, zone, pickup_date)] = tuple(
                    real_ws.cell(row, col).value for col in range(9, 15)
                )
            if group == "CDMV" and zone in {"KRDW", "KRGA", "KRLO", "KRTI"} and pickup_date and old_rate is not None:
                real_target = (pickup_date, old_rate)
        if real_target is None:
            raise AssertionError("Real workbook smoke test needs a CDMV Krakow row with a duration 2 rate.")
        for group in frozen_groups:
            assert any(key[0] == group for key in frozen_source_rates), f"Real workbook needs baseline rows for {group}."
        real_before.close()
        expected_unmapped_rows = Counter()
        for (group, zone), source_rates in unmapped_source_rates.items():
            for offset in range(100):
                pickup_date = expected_pickup_start + timedelta(days=offset)
                matching_rates = [rates for low, high, rates in source_rates if low <= pickup_date <= high]
                if not matching_rates:
                    matching_rates = [max(enumerate(source_rates), key=lambda item: (item[1][0], item[0]))[1][2]]
                for rates in matching_rates:
                    expected_unmapped_rows[(group, zone, pickup_date, rates)] += 1
        real_pickup_date, real_old_rate = real_target
        real_recommendations_path.write_text(
            json.dumps(
                {
                    "recommendations": [
                        {
                            "action": "increase",
                            "recommendation_type": "top1_undercut",
                            "reason": "MM Cars Rental jest top2 i brakuje mniej niz 10 PLN/dzien, zeby zostac top1; cel to 1 PLN ponizej top1.",
                            "location": "Krakow",
                            "start_date": real_pickup_date.isoformat(),
                            "rental_days": 2,
                            "suggested_rate_pln_day": real_old_rate + 10,
                            "mm_rate_pln_day": real_old_rate,
                            "benchmark_provider": "Car24",
                            "benchmark_rate_pln_day": real_old_rate + 11,
                            "scenario_id": f"real-template-{real_pickup_date.isoformat()}-2",
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )

        real_summary = apply_updates(
            workbook_path=real_workbook_path,
            recommendations_path=real_recommendations_path,
            output_path=real_output_path,
            config=merge_config({"location_zones": {"Krakow": ["KRDW", "KRGA", "KRLO", "KRTI"]}}),
            cli_groups=None,
            dry_run=False,
        )
        assert real_summary["change_count"] > 0
        real_after = openpyxl.load_workbook(real_output_path)
        after_snapshot = header_rows_snapshot(real_after["Sheet1"])
        assert_equal(after_snapshot, before_snapshot, "Sheet1 rows 1-4 values and formatting")

        baseline_real_recommendations_path = tmpdir / "baseline-real-recommendations.json"
        baseline_real_output_path = tmpdir / "baseline-real-recommendations.xlsx"
        baseline_real_import_path = tmpdir / "baseline-real-import.xlsx"
        baseline_real_recommendations_path.write_text(json.dumps({"recommendations": []}), encoding="utf-8")
        baseline_real_summary = apply_updates(
            workbook_path=real_workbook_path,
            recommendations_path=baseline_real_recommendations_path,
            output_path=baseline_real_output_path,
            config=load_config(ROOT / "excel-rate-update.config.example.json"),
            cli_groups=None,
            dry_run=False,
            import_output_path=baseline_real_import_path,
        )
        assert_equal(baseline_real_summary["change_count"], baseline_real_summary["mandatory_zone_floor_change_count"]
                     + baseline_real_summary["mandatory_group_floor_change_count"],
                     "empty recommendations only enforce approved zone and class minima without market changes")
        assert_equal(baseline_real_summary["change_statistics"]["decrease_count"], 0,
                     "mandatory floor correction never lowers baseline prices")
        for output_file in (baseline_real_output_path, baseline_real_import_path):
            baseline_real_workbook = openpyxl.load_workbook(output_file, read_only=True)
            baseline_real_ws = baseline_real_workbook["Sheet1"]
            pickup_dates = []
            frozen_output_rates = {}
            unmapped_output_rows = Counter()
            for values in baseline_real_ws.iter_rows(min_row=5, min_col=1, max_col=14, values_only=True):
                group = str(values[0] or "").strip().upper()
                zone = str(values[3] or "").strip().upper()
                pickup_date = parse_date_value(values[6])
                if pickup_date is not None:
                    pickup_dates.append(pickup_date)
                if group in frozen_groups and pickup_date is not None:
                    frozen_output_rates[(group, zone, pickup_date)] = tuple(values[8:14])
                if zone in unmapped_source_zones:
                    unmapped_output_rows[(group, zone, pickup_date, tuple(values[8:14]))] += 1
            baseline_real_workbook.close()
            assert_equal(unmapped_output_rows, expected_unmapped_rows,
                         "all unmapped baseline classes, zones, 100 pickup dates, rates and row multiplicities retained")
            assert_equal(baseline_real_summary["max_import_rows"], None, "real workbook has no row limit")
            assert_equal(baseline_real_ws.max_row, baseline_real_summary["import_row_count"], "all generated rows exported")
            assert_equal(min(pickup_dates), expected_pickup_start, "real workbook pickup start")
            assert_equal(max(pickup_dates), expected_pickup_end, "real workbook pickup end")
            for key, expected_rates in frozen_source_rates.items():
                protected = (date(2026, 10, 31) <= key[2] <= date(2026, 11, 1)
                             or date(2026, 12, 15) <= key[2] <= date(2027, 1, 10))
                if key[1] == "SZLO" and not protected:
                    expected_rates = tuple(max(rate, minimum) for rate, minimum in
                                           zip(expected_rates, (300, 150, 130, 110, 90, 90)))
                if key[0] == "PDAH" and not protected:
                    expected_rates = (*expected_rates[:5], max(expected_rates[5], 170))
                if key[0] == "FVMD" and date(2026, 12, 15) <= key[2] <= date(2027, 1, 5):
                    expected_rates = tuple(max(rate, minimum) for rate, minimum in
                                           zip(expected_rates, (1000, 700, 600, 500, 500, 400)))
                assert_equal(frozen_output_rates.get(key), expected_rates, f"real frozen baseline rates for {key}")

    print("All Excel rate updater tests passed.")


if __name__ == "__main__":
    main()
