import json
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree

import openpyxl
from openpyxl.styles import PatternFill

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tools.update_excel_rates import apply_updates, merge_config, parse_date_value, parse_number  # noqa: E402


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
        ["CDMV", None, None, "WA1", "09-06-26", "10-06-26", "10-06-26", "11-06-26", 160, 70, 80, 90, 100, 120],
        ["CGAV", None, None, "WA1", "09-06-26", "10-06-26", "10-06-26", "11-06-26", 160, 70, 80, 90, 100, 120],
        ["EDAH", None, None, "WA1", "09-06-26", "10-06-26", "10-06-26", "11-06-26", 160, 70, 80, 90, 100, 120],
        ["EDMV", None, None, "WA1", "09-06-26", "10-06-26", "10-06-26", "11-06-26", 160, 70, 80, 90, 100, 120],
        ["IDAH", None, None, "WA1", "09-06-26", "10-06-26", "10-06-26", "11-06-26", 160, 70, 80, 90, 100, 120],
        ["SWAV", None, None, "WA1", "09-06-26", "10-06-26", "10-06-26", "11-06-26", 160, 70, 80, 90, 100, 120],
        ["CDMV", None, None, "WA1", "09-06-26", "10-06-26", "11-06-26", "12-06-26", 160, 90, 80, 90, 100, 120],
        ["EDAH", None, None, "WA1", "09-06-26", "10-06-26", "11-06-26", "12-06-26", 160, 90, 80, 90, 100, 120],
        ["CDMV", None, None, "WA1", "09-06-26", "10-06-26", "25-06-26", "26-06-26", 160, 90, 80, 90, 130, 120],
        ["EDAH", None, None, "WA1", "09-06-26", "10-06-26", "25-06-26", "26-06-26", 160, 90, 80, 90, 130, 120],
    ]
    for row in rows:
        ws.append(row)
    ws["A4"].fill = PatternFill(fill_type="solid", fgColor="1F4E78")
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
    workbook.save(path)


def main():
    example_config = merge_config(json.loads((ROOT / "excel-rate-update.config.example.json").read_text(encoding="utf-8")))
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
        "Krakow Train Station": {"KRDW", "KRGA"},
        "Galeria Krakowska Shopping Mall": {"KRGA"},
        "Krakow Airport (KRK)": {"KRLO", "KRTI"},
        "Lodz Downtown": {"LO1"},
        "Lodz Lublinek Airport (LCJ)": {"LOLO"},
        "Lubin Downtown": {"LU1"},
        "Olsztyn Downtown": {"OL1"},
        "Opole Downtown": {"OP1"},
        "Poznan Downtown": {"PO1"},
        "Poznan Airport (POZ)": {"POLO"},
        "Torun Downtown": {"TO1"},
        "Warsaw West Train Station": {"WA1"},
        "Warsaw Train Station": {"WA2"},
        "Warsaw Chopin Airport (WAW)": {"WALO"},
        "Wroclaw Downtown": {"WR1"},
        "Wroclaw Airport (WRO)": {"WRLO"},
    }
    for location, zones in expected_location_zones.items():
        assert_equal(location_zones.get(location), zones, f"location zone mapping for {location}")

    covered_zones = set().union(*location_zones.values())
    real_zones = workbook_zones(ROOT / "input" / "mm-cars-rental-rates-inclusive-fp.xlsx")
    assert_equal(sorted(real_zones - covered_zones), [], "all real workbook zones are covered by location_zones")

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
                            "reason": "MM Cars Rental jest top1, a top2 jest drozszy o co najmniej 5 PLN/dzien; cel to 1 PLN ponizej top2.",
                            "location": "Warsaw",
                            "start_date": "2026-06-10",
                            "rental_days": 2,
                            "suggested_rate_pln_day": 81,
                            "mm_rate_pln_day": 70,
                            "benchmark_provider": "Flex To Go",
                            "benchmark_rate_pln_day": 82,
                            "scenario_id": "2026-06-10-2",
                        },
                        {
                            "action": "decrease",
                            "recommendation_type": "top1_undercut",
                            "reason": "MM Cars Rental jest top2 i brakuje mniej niz 10 PLN/dzien, zeby zostac top1; cel to 1 PLN ponizej top1.",
                            "location": "Warsaw",
                            "start_date": "2026-06-10",
                            "rental_days": 21,
                            "suggested_rate_pln_day": 80,
                            "mm_rate_pln_day": 120,
                            "benchmark_provider": "Flex To Go",
                            "benchmark_rate_pln_day": 101,
                            "scenario_id": "2026-06-10-21",
                        },
                        {
                            "action": "decrease",
                            "recommendation_type": "top1_undercut",
                            "reason": "MM Cars Rental jest top2 i brakuje mniej niz 10 PLN/dzien, zeby zostac top1; cel to 1 PLN ponizej top1.",
                            "location": "Warsaw",
                            "start_date": "2026-06-11",
                            "rental_days": 2,
                            "suggested_rate_pln_day": 60,
                            "mm_rate_pln_day": 90,
                            "benchmark_provider": "Car24",
                            "benchmark_rate_pln_day": 61,
                            "scenario_id": "2026-06-11-2",
                        },
                        {
                            "action": "decrease",
                            "recommendation_type": "top3_small_decrease",
                            "reason": "Cel top3 wymaga roznicy mniejszej niz 10 PLN/dzien; cel to 1 PLN ponizej top3.",
                            "location": "Warsaw",
                            "start_date": "2026-06-25",
                            "rental_days": 8,
                            "suggested_rate_pln_day": 90,
                            "mm_rate_pln_day": 120,
                            "benchmark_provider": "Kaizen Rent",
                            "benchmark_rate_pln_day": 91,
                            "scenario_id": "2026-06-25-8",
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )

        config = merge_config(
            {
                "location_zones": {"Warsaw": ["WA1"]},
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

        assert_equal(summary["change_count"], 12, "change_count")
        assert_equal(summary["group_price_parity_change_count"], 18, "group_price_parity_change_count")
        assert_equal(summary["import_output"], str(import_output_path), "import output path")
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
        import_ready = openpyxl.load_workbook(import_output_path)
        assert_equal(import_ready.sheetnames, ["Sheet1"], "import-ready workbook sheets")
        import_ready_ws = import_ready["Sheet1"]
        assert_equal(import_ready_ws["J5"].value, 81, "import-ready updated rate")
        assert_equal(import_ready_ws["N5"].value, 100, "import-ready long duration minimum")
        assert_equal(ws.max_row, 14, "main import sheet row count")
        assert_equal(ws["J5"].value, 81, "updated rate")
        assert_equal(ws["J6"].value, 70, "excluded CGAV rate")
        assert_equal(ws["J7"].value, 82, "EDAH adjusted rate")
        assert_equal(ws["J8"].value, 82, "EDMV adjusted rate")
        assert_equal(ws["J9"].value, 81, "IDAH base rate")
        assert_equal(ws["J10"].value, 70, "excluded SWAV rate")
        assert_equal(ws["I7"].value, 161, "EDAH parity-only duration 1 rate")
        assert_equal(ws["I8"].value, 161, "EDMV parity-only duration 1 rate")
        assert_equal(ws["I9"].value, 160, "IDAH parity duration 1 base rate")
        assert_equal(ws["K7"].value, 81, "EDAH parity-only duration 3-4 rate")
        assert_equal(ws["K8"].value, 81, "EDMV parity-only duration 3-4 rate")
        assert_equal(ws["N5"].value, 100, "long duration minimum")
        assert_equal(ws["N7"].value, 101, "long duration minimum with EDAH adjustment")
        assert_equal(ws["N8"].value, 101, "long duration minimum with EDMV adjustment")
        assert_equal(ws["N9"].value, 100, "long duration minimum with IDAH base rate")
        assert_equal(ws["J11"].value, 70, "global minimum")
        assert_equal(ws["J12"].value, 71, "global minimum with EDAH adjustment")
        assert_equal(ws["M13"].value, 115, "seasonal duration minimum")
        assert_equal(ws["M14"].value, 116, "seasonal duration minimum with EDAH adjustment")
        assert_equal(ws["H5"].value, ws["G5"].value, "pickup end normalized for CDMV")
        assert_equal(ws["H6"].value, ws["G6"].value, "pickup end normalized for excluded CGAV")
        for row in range(5, 15):
            assert_equal(ws.cell(row, 6).value, ws.cell(row, 8).value, f"booking end equals pickup end in row {row}")
        assert_not_equal(rgb(ws["J5"]), "C6EFCE", "increase color uses dynamic scale")
        assert_equal(rgb(ws["J5"]), "A9D18E", "increase color uses a stepped green scale")
        assert_not_equal(rgb(ws["J11"]), rgb(ws["M13"]), "larger decrease uses a stronger red")
        assert ws["J5"].comment is not None
        assert_equal(
            ws["J5"].comment.text,
            "Poprzednia stawka: 70 PLN\nNowa stawka: 81 PLN\nZmiana: +11 PLN",
            "short Sheet1 comment",
        )
        assert ws["J7"].comment is not None
        assert_equal(
            ws["J7"].comment.text,
            "Poprzednia stawka: 70 PLN\nNowa stawka: 82 PLN\nZmiana: +12 PLN",
            "short adjusted Sheet1 comment",
        )
        assert "brutto/dzien" not in ws["N5"].comment.text
        assert ws["J6"].comment is None
        assert_equal(changed_ws["A1"].value, "Legenda", "changed sheet legend title")
        assert_equal(changed_ws["A2"].value, "Top1 gap", "top1 legend label")
        assert "co najmniej 5 PLN" in changed_ws["B2"].value
        assert_equal(rgb(changed_ws["A2"]), "9DC3E6", "top1 legend color")
        assert_equal(changed_ws["A3"].value, "Male obnizenie top3", "top3 legend label")
        assert_equal(rgb(changed_ws["A3"]), "FFC7CE", "top3 legend color")
        assert_equal(changed_ws["A4"].value, "Przebicie top1", "top1 undercut legend label")
        assert_equal(rgb(changed_ws["A4"]), "F4B183", "top1 undercut legend color")
        assert_equal(changed_ws["A5"].value, "Floor i kolory stawek", "floor legend label")
        assert "Floor cenowy" in changed_ws["B5"].value
        assert_equal(changed_ws["O10"].value, "Komentarz zmiany", "changed sheet comment header")
        assert_equal(changed_ws.max_row, 14, "changed sheet row count")
        assert_equal(changed_ws["A11"].value, "CDMV, EDAH, EDMV, IDAH", "first changed group set")
        assert "Powod rekomendacji: MM Cars Rental jest na 1 miejscu" in changed_ws["O11"].value
        assert "co najmniej 5 PLN" in changed_ws["O11"].value
        assert "Co pozwoli osiagnac: utrzymanie top1" in changed_ws["O11"].value
        assert "Poprzednia stawka: 70 PLN" in changed_ws["O11"].value
        assert "Nowa stawka: 81 PLN" in changed_ws["O11"].value
        assert "Zmiana: +11 PLN" in changed_ws["O11"].value
        assert "EDAH: 82 PLN" not in changed_ws["O11"].value
        assert "EDMV: 82 PLN" not in changed_ws["O11"].value
        assert "brutto/dzien" not in changed_ws["O11"].value
        assert "Lokalizacja" not in changed_ws["O11"].value
        assert "Data odbioru" not in changed_ws["O11"].value
        assert "Duration" not in changed_ws["O11"].value
        assert "Korekta grupy" not in changed_ws["O11"].value
        assert "Komorka" not in changed_ws["O11"].value
        assert "Scenario" not in changed_ws["O11"].value
        assert "Zastosowane minimum" not in changed_ws["O11"].value
        assert_equal(changed_ws["J11"].value, 81, "grouped base rate cell")
        assert "Co pozwoli osiagnac: top3" in changed_ws["O14"].value
        assert "Zastosowane minimum" not in changed_ws["O14"].value
        assert "Minimum sezonowe" not in changed_ws["O14"].value
        assert_equal(rgb(changed_ws["O11"]), "9DC3E6", "top1 gap row is blue")
        assert_equal(rgb(changed_ws["O12"]), "F4B183", "top1 undercut row is orange")
        assert_equal(rgb(changed_ws["O14"]), "FFC7CE", "top3 small decrease row is red")
        assert changed_ws["O11"].comment is not None
        for row in range(1, changed_ws.max_row + 1):
            for col in range(1, 15):
                assert changed_ws.cell(row, col).comment is None
        changed_groups = {changed_ws.cell(row, 1).value for row in range(11, changed_ws.max_row + 1)}
        assert "CGAV" not in ",".join(changed_groups)
        assert "SWAV" not in ",".join(changed_groups)
        assert_equal(review_ws["A1"].value, "Akceptacja?", "review header")
        assert_equal(review_ws["B1"].value, "Status", "review status header")
        assert_equal(review_ws.max_row, 5, "review row count")
        assert_equal(review_ws["D2"].value, "Warsaw", "review location")
        assert_equal(review_ws["F2"].value, "CDMV, EDAH, EDMV, IDAH", "review grouped groups")
        assert review_ws["B2"].value in {"Gotowe", "Gotowe z uwaga", "Sprawdz"}
        assert "korekta grupy" in review_ws["C2"].value or review_ws["C2"].value == "OK"
        validation_rows = {
            validation_ws.cell(row, 1).value: validation_ws.cell(row, 2).value
            for row in range(2, validation_ws.max_row + 1)
        }
        assert_equal(validation_rows["Booking end date = Pickup end date"], "OK", "booking date validation")
        assert_equal(validation_rows["Pickup end date = Pickup start date"], "OK", "pickup date validation")
        assert_equal(validation_rows["Puste stawki w kolumnach duration"], "OK", "blank rate validation")
        assert_equal(validation_rows["Zmienione stawki ponizej floor cenowego"], "OK", "floor validation")

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
                            "reason": "MM Cars Rental jest top1, a top2 jest drozszy o co najmniej 5 PLN/dzien; cel to 1 PLN ponizej top2.",
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
            config=merge_config({"location_zones": {"Warsaw": ["WA1"]}}),
            cli_groups=None,
            dry_run=False,
        )
        assert_equal(dedup_summary["change_count"], 2, "deduplicated change count")
        dedup_updated = openpyxl.load_workbook(dedup_output_path)
        dedup_changed_ws = dedup_updated["Changed Positions"]
        assert_equal(dedup_changed_ws.max_row, 11, "deduplicated changed sheet row count")
        assert_equal(dedup_changed_ws["A11"].value, "CDMV, MDMR", "deduplicated group list")
        assert_equal(dedup_changed_ws["J11"].value, 81, "deduplicated changed rate cell")
        assert "70 PLN; 70 PLN" not in dedup_changed_ws["O11"].value
        assert "81 PLN; 81 PLN" not in dedup_changed_ws["O11"].value
        assert "+11 PLN; +11 PLN" not in dedup_changed_ws["O11"].value

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
                ["CDMV", None, None, "WA1", "09-06-26", "10-06-26", "10-06-26", "12-06-26", 160, 70, 80, 90, 100, 120],
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
                            "reason": "MM Cars Rental jest top1, a top2 jest drozszy o co najmniej 5 PLN/dzien; cel to 1 PLN ponizej top2.",
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
                        "time_zone": "Europe/Warsaw",
                    },
                }
            ),
            cli_groups=None,
            dry_run=False,
        )
        assert_equal(expansion_summary["pickup_date_expansion"]["source_row_count"], 1, "expanded source row count")
        assert_equal(expansion_summary["pickup_date_expansion"]["expanded_row_count"], 2, "expanded row count")
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
        assert_equal(expansion_ws["I6"].value, 160, "duration 1 rate does not update a different pickup date")
        assert_equal(expansion_ws["J6"].value, 70, "duration 2 rate does not update a different pickup date")

        real_workbook_path = ROOT / "input" / "mm-cars-rental-rates-inclusive-fp.xlsx"
        real_recommendations_path = tmpdir / "real-recommendations.json"
        real_output_path = tmpdir / "real-rates-updated.xlsx"
        real_before = openpyxl.load_workbook(real_workbook_path)
        real_ws = real_before["Sheet1"]
        before_snapshot = header_rows_snapshot(real_ws)
        real_target = None
        for row in range(5, real_ws.max_row + 1):
            group = str(real_ws.cell(row, 1).value or "").strip().upper()
            zone = str(real_ws.cell(row, 4).value or "").strip().upper()
            pickup_date = parse_date_value(real_ws.cell(row, 7).value)
            old_rate = parse_number(real_ws.cell(row, 10).value)
            if group == "CDMV" and zone in {"KRDW", "KRGA", "KRLO", "KRTI"} and pickup_date and old_rate is not None:
                real_target = (pickup_date, old_rate)
                break
        if real_target is None:
            raise AssertionError("Real workbook smoke test needs a CDMV Krakow row with a duration 2 rate.")
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

    print("All Excel rate updater tests passed.")


if __name__ == "__main__":
    main()
