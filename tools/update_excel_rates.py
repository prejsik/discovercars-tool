#!/usr/bin/env python3
"""Update MM Cars Rental rate workbook from scraper pricing recommendations."""

from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path
from typing import Any

try:
    import openpyxl
    from openpyxl.styles import Font, PatternFill
except ImportError as exc:  # pragma: no cover - runtime environment guard
    raise SystemExit("Missing dependency: openpyxl. Install it with: pip install openpyxl") from exc


DEFAULT_CONFIG = {
    "worksheet": "Sheet1",
    "header_row": 4,
    "data_start_row": 5,
    "duration_min_row": 2,
    "duration_max_row": 3,
    "columns": {
        "group": 1,
        "zone": 4,
        "pickup_start_date": 7,
        "pickup_end_date": 8,
        "rate_start": 9,
    },
    "location_zones": {},
    "apply_groups": [],
    "min_excel_change_pln_day": 0.01,
    "change_log_sheet": "Change Log",
    "replace_change_log": True,
    "colors": {
        "increase": "C6EFCE",
        "decrease": "FFC7CE",
        "hold": "D9EAF7",
        "limited": "FCE4D6",
    },
}


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def merge_config(raw: dict[str, Any] | None) -> dict[str, Any]:
    raw = raw or {}
    merged = json.loads(json.dumps(DEFAULT_CONFIG))
    for key, value in raw.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key].update(value)
        else:
            merged[key] = value
    return merged


def parse_date_value(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value

    text = str(value).strip()
    if not text:
        return None
    if "T" in text:
        text = text.split("T", 1)[0]

    for fmt in ("%Y-%m-%d", "%d-%m-%y", "%d-%m-%Y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def parse_number(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    text = str(value).strip().replace(" ", "").replace(",", ".")
    if not text:
        return None
    try:
        parsed = float(text)
    except ValueError:
        return None
    return parsed if math.isfinite(parsed) else None


def normalize_key(value: Any) -> str:
    return str(value or "").strip().lower()


def normalize_code(value: Any) -> str:
    return str(value or "").strip().upper()


def get_duration_columns(ws: Any, config: dict[str, Any]) -> dict[int, tuple[int, str]]:
    min_row = int(config["duration_min_row"])
    max_row = int(config["duration_max_row"])
    rate_start = int(config["columns"]["rate_start"])
    duration_columns: dict[int, tuple[int, str]] = {}

    for col in range(rate_start, ws.max_column + 1):
        min_days = parse_number(ws.cell(min_row, col).value)
        max_days = parse_number(ws.cell(max_row, col).value)
        if min_days is None or max_days is None:
            continue

        left = int(min_days)
        right = int(max_days)
        label = str(left) if left == right else f"{left}-{right}"
        for duration in range(left, right + 1):
            duration_columns[duration] = (col, label)

    return duration_columns


def load_recommendation_items(path: Path) -> list[dict[str, Any]]:
    payload = load_json(path)
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and isinstance(payload.get("recommendations"), list):
        return payload["recommendations"]
    raise ValueError("Recommendations file must be a list or an object with a 'recommendations' list.")


def resolve_apply_groups(config: dict[str, Any], cli_groups: str | None) -> set[str] | str:
    raw_groups: Any = cli_groups if cli_groups is not None else config.get("apply_groups")
    if isinstance(raw_groups, str):
        if raw_groups.strip().lower() == "all":
            return "all"
        values = [item.strip() for item in raw_groups.split(",")]
    else:
        values = [str(item).strip() for item in raw_groups or []]

    groups = {normalize_code(item) for item in values if str(item).strip()}
    if not groups:
        raise ValueError("Set apply_groups to an explicit list of car groups, or pass --groups=all intentionally.")
    return groups


def group_is_allowed(group: Any, allowed_groups: set[str] | str) -> bool:
    return allowed_groups == "all" or normalize_code(group) in allowed_groups


def build_targets(
    recommendations: list[dict[str, Any]],
    duration_columns: dict[int, tuple[int, str]],
    config: dict[str, Any],
) -> tuple[dict[str, dict[date, list[dict[str, Any]]]], list[dict[str, Any]]]:
    location_zones = {
        normalize_key(location): [normalize_code(zone) for zone in zones]
        for location, zones in (config.get("location_zones") or {}).items()
    }
    targets: dict[str, dict[date, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    skipped: list[dict[str, Any]] = []

    for item in recommendations:
        if item.get("action") not in {"increase", "decrease"}:
            continue

        suggested_rate = parse_number(item.get("suggested_rate_pln_day"))
        rental_days = parse_number(item.get("rental_days"))
        target_date = parse_date_value(item.get("start_date") or item.get("pickup_date"))
        location = normalize_key(item.get("location"))
        zones = location_zones.get(location, [])

        if suggested_rate is None or rental_days is None or target_date is None or not zones:
            skipped.append({**item, "skip_reason": "Missing suggested rate, rental days, start date, or location zone mapping."})
            continue

        duration = int(rental_days)
        duration_column = duration_columns.get(duration)
        if not duration_column:
            skipped.append({**item, "skip_reason": f"No Excel duration column for {duration} days."})
            continue

        col, duration_band = duration_column
        for zone in zones:
            targets[zone][target_date].append({
                **item,
                "zone": zone,
                "target_date": target_date,
                "rate_col": col,
                "duration_band": duration_band,
                "suggested_rate_pln_day": suggested_rate,
            })

    return targets, skipped


def find_targets_for_row(
    targets_by_date: dict[date, list[dict[str, Any]]],
    pickup_start: date | None,
    pickup_end: date | None,
) -> list[dict[str, Any]]:
    if pickup_start is None and pickup_end is None:
        return []
    if pickup_end is None:
        pickup_end = pickup_start
    if pickup_start is None:
        pickup_start = pickup_end

    if pickup_start == pickup_end:
        return targets_by_date.get(pickup_start, [])

    matched: list[dict[str, Any]] = []
    for target_date, items in targets_by_date.items():
        if pickup_start <= target_date <= pickup_end:
            matched.extend(items)
    return matched


def apply_updates(
    workbook_path: Path,
    recommendations_path: Path,
    output_path: Path | None,
    config: dict[str, Any],
    cli_groups: str | None,
    dry_run: bool,
) -> dict[str, Any]:
    allowed_groups = resolve_apply_groups(config, cli_groups)
    recommendations = load_recommendation_items(recommendations_path)

    workbook = openpyxl.load_workbook(workbook_path)
    sheet_name = config.get("worksheet") or workbook.sheetnames[0]
    if sheet_name not in workbook.sheetnames:
        raise ValueError(f"Worksheet '{sheet_name}' not found. Available sheets: {', '.join(workbook.sheetnames)}")
    ws = workbook[sheet_name]

    duration_columns = get_duration_columns(ws, config)
    targets, skipped_targets = build_targets(recommendations, duration_columns, config)
    columns = config["columns"]
    data_start_row = int(config["data_start_row"])
    min_change = float(config.get("min_excel_change_pln_day", 0.01))
    fills = {
        action: PatternFill(fill_type="solid", fgColor=str(color).replace("#", ""))
        for action, color in (config.get("colors") or {}).items()
    }

    changes: list[dict[str, Any]] = []

    for row in range(data_start_row, ws.max_row + 1):
        zone = normalize_code(ws.cell(row, int(columns["zone"])).value)
        if zone not in targets:
            continue

        group = ws.cell(row, int(columns["group"])).value
        if not group_is_allowed(group, allowed_groups):
            continue

        pickup_start = parse_date_value(ws.cell(row, int(columns["pickup_start_date"])).value)
        pickup_end = parse_date_value(ws.cell(row, int(columns["pickup_end_date"])).value)
        row_targets = find_targets_for_row(targets[zone], pickup_start, pickup_end)
        if not row_targets:
            continue

        for target in row_targets:
            cell = ws.cell(row, int(target["rate_col"]))
            old_rate = parse_number(cell.value)
            new_rate = float(target["suggested_rate_pln_day"])
            if old_rate is not None and abs(new_rate - old_rate) < min_change:
                continue

            if not dry_run:
                cell.value = int(new_rate) if float(new_rate).is_integer() else round(new_rate, 2)
                cell.fill = fills.get(target["action"], fills.get("hold", PatternFill()))

            changes.append({
                "action": target["action"],
                "reason": target.get("reason", ""),
                "location": target.get("location", ""),
                "zone": zone,
                "group": normalize_code(group),
                "pickup_date": target["target_date"].isoformat(),
                "duration_days": target.get("rental_days"),
                "duration_band": target["duration_band"],
                "cell": cell.coordinate,
                "old_rate": old_rate,
                "new_rate": new_rate,
                "delta": None if old_rate is None else round(new_rate - old_rate, 2),
                "mm_rate": target.get("mm_rate_pln_day"),
                "benchmark_provider": target.get("benchmark_provider", ""),
                "benchmark_rate": target.get("benchmark_rate_pln_day"),
                "scenario_id": target.get("scenario_id", ""),
            })

    if not dry_run:
        write_change_log(workbook, config, changes, skipped_targets)
        if output_path is None:
            raise ValueError("Output path is required unless --dry-run is used.")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        workbook.save(output_path)

    return {
        "workbook": str(workbook_path),
        "output": str(output_path) if output_path else None,
        "dry_run": dry_run,
        "change_count": len(changes),
        "skipped_target_count": len(skipped_targets),
        "changes": changes[:100],
    }


def write_change_log(workbook: Any, config: dict[str, Any], changes: list[dict[str, Any]], skipped: list[dict[str, Any]]) -> None:
    sheet_name = config.get("change_log_sheet") or "Change Log"
    if sheet_name in workbook.sheetnames and config.get("replace_change_log", True):
        workbook.remove(workbook[sheet_name])
    ws = workbook.create_sheet(sheet_name)

    headers = [
        "action",
        "reason",
        "location",
        "zone",
        "group",
        "pickup_date",
        "duration_days",
        "duration_band",
        "cell",
        "old_rate",
        "new_rate",
        "delta",
        "mm_rate",
        "benchmark_provider",
        "benchmark_rate",
        "scenario_id",
    ]
    ws.append(headers)
    for change in changes:
        ws.append([change.get(header) for header in headers])

    if skipped:
        ws.append([])
        ws.append(["Skipped targets"])
        skipped_headers = ["location", "scenario_id", "rental_days", "suggested_rate_pln_day", "skip_reason"]
        ws.append(skipped_headers)
        for item in skipped:
            ws.append([item.get(header) for header in skipped_headers])

    header_fill = PatternFill(fill_type="solid", fgColor="1F4E78")
    header_font = Font(color="FFFFFF", bold=True)
    for cell in ws[1]:
        cell.fill = header_fill
        cell.font = header_font
    ws.freeze_panes = "A2"
    for col in range(1, len(headers) + 1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(col)].width = 18
    ws.column_dimensions["B"].width = 64


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Update rental-rate Excel workbook from pricing recommendations.")
    parser.add_argument("--workbook", required=True, help="Input .xlsx workbook path.")
    parser.add_argument("--recommendations", required=True, help="pricing-recommendations.json path.")
    parser.add_argument("--config", required=True, help="Excel rate update config JSON path.")
    parser.add_argument("--output", help="Output .xlsx path.")
    parser.add_argument("--groups", help="Comma-separated car groups to update, or 'all'. Overrides config apply_groups.")
    parser.add_argument("--dry-run", action="store_true", help="Calculate matching changes without saving an .xlsx file.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = merge_config(load_json(Path(args.config)))
    summary = apply_updates(
        workbook_path=Path(args.workbook),
        recommendations_path=Path(args.recommendations),
        output_path=Path(args.output) if args.output else None,
        config=config,
        cli_groups=args.groups,
        dry_run=args.dry_run,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
