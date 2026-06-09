import json
import sys
import tempfile
from pathlib import Path

import openpyxl

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
    ws.append(["CDMV", None, None, "WA1", "09-06-26", "10-06-26", "10-06-26", "10-06-26", 160, 70, 80])
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
                "apply_groups": ["CDMV"],
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

        assert_equal(summary["change_count"], 1, "change_count")
        updated = openpyxl.load_workbook(output_path)
        ws = updated["Sheet1"]
        assert_equal(ws["J5"].value, 80, "updated rate")
        assert str(ws["J5"].fill.fgColor.rgb).endswith("C6EFCE")
        assert "Change Log" in updated.sheetnames
        assert_equal(updated["Change Log"]["A2"].value, "increase", "change log action")

    print("All Excel rate updater tests passed.")


if __name__ == "__main__":
    main()
