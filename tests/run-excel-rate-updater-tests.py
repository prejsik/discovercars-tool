import json
import sys
import tempfile
from pathlib import Path

import openpyxl
from openpyxl.styles import PatternFill

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tools.update_excel_rates import apply_updates, merge_config  # noqa: E402


def assert_equal(actual, expected, message):
    if actual != expected:
        raise AssertionError(f"{message}: expected {expected!r}, got {actual!r}")


def build_workbook(path):
    workbook = openpyxl.Workbook()
    ws = workbook.active
    ws.title = "Sheet1"
    ws.append(["Rental rates for packages: INCLUSIVE FP"])
    ws.append(["Min days", None, None, None, "Date format:", None, None, None, 1, 2, 3])
    ws.append(["Max days", None, None, None, "dd-MM-yy", None, None, None, 1, 2, 4])
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
    ])
    rows = [
        ["CDMV", None, None, "WA1", "09-06-26", "10-06-26", "10-06-26", "11-06-26", 160, 70, 80],
        ["CGAV", None, None, "WA1", "09-06-26", "10-06-26", "10-06-26", "11-06-26", 160, 70, 80],
        ["EDAH", None, None, "WA1", "09-06-26", "10-06-26", "10-06-26", "11-06-26", 160, 70, 80],
        ["ADMV", None, None, "WA1", "09-06-26", "10-06-26", "10-06-26", "11-06-26", 160, 70, 80],
        ["SWAV", None, None, "WA1", "09-06-26", "10-06-26", "10-06-26", "11-06-26", 160, 70, 80],
    ]
    for row in rows:
        ws.append(row)
    ws["A4"].fill = PatternFill(fill_type="solid", fgColor="1F4E78")
    workbook.save(path)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        workbook_path = tmpdir / "rates.xlsx"
        recommendations_path = tmpdir / "pricing-recommendations.json"
        output_path = tmpdir / "rates-updated.xlsx"
        build_workbook(workbook_path)

        recommendations_path.write_text(
            json.dumps(
                {
                    "recommendations": [
                        {
                            "action": "increase",
                            "reason": "MM Cars Rental is top1 and top2 is at least 10 PLN/day higher.",
                            "location": "Warsaw",
                            "start_date": "2026-06-10",
                            "rental_days": 2,
                            "suggested_rate_pln_day": 80,
                            "mm_rate_pln_day": 70,
                            "benchmark_provider": "Flex To Go",
                            "benchmark_rate_pln_day": 82,
                            "scenario_id": "2026-06-10-2",
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
        )

        assert_equal(summary["change_count"], 3, "change_count")
        assert_equal(summary["normalized_pickup_end_count"], 5, "normalized_pickup_end_count")
        updated = openpyxl.load_workbook(output_path)
        ws = updated["Sheet1"]
        assert_equal(updated.sheetnames, ["Sheet1"], "workbook sheets")
        assert str(ws["A4"].fill.fgColor.rgb).endswith("1F4E78")
        assert_equal(ws["J5"].value, 80, "updated rate")
        assert_equal(ws["J6"].value, 70, "excluded CGAV rate")
        assert_equal(ws["J7"].value, 81, "EDAH adjusted rate")
        assert_equal(ws["J8"].value, 81, "ADMV adjusted rate")
        assert_equal(ws["J9"].value, 70, "excluded SWAV rate")
        assert_equal(ws["H5"].value, ws["G5"].value, "pickup end normalized for CDMV")
        assert_equal(ws["H6"].value, ws["G6"].value, "pickup end normalized for excluded CGAV")
        assert str(ws["J5"].fill.fgColor.rgb).endswith("C6EFCE")
        assert str(ws["J7"].fill.fgColor.rgb).endswith("C6EFCE")
        assert str(ws["J8"].fill.fgColor.rgb).endswith("C6EFCE")
        assert ws["J5"].comment is not None
        assert "Previous rate: 70 PLN/day" in ws["J5"].comment.text
        assert "New rate: 80 PLN/day" in ws["J5"].comment.text
        assert ws["J7"].comment is not None
        assert "Previous rate: 70 PLN/day" in ws["J7"].comment.text
        assert "New rate: 81 PLN/day" in ws["J7"].comment.text
        assert "Group adjustment: +1 PLN/day" in ws["J7"].comment.text
        assert ws["J6"].comment is None

    print("All Excel rate updater tests passed.")


if __name__ == "__main__":
    main()
