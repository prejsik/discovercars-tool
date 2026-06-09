#!/usr/bin/env python3
"""Update MM Cars Rental rate workbook from scraper pricing recommendations."""

from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from copy import copy
from datetime import date, datetime
from pathlib import Path
from typing import Any

try:
    import openpyxl
    from openpyxl.comments import Comment
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
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
    "apply_groups": "all",
    "excluded_groups": ["CGAV", "IDAH", "SFAV", "SWAV"],
    "group_rate_adjustments_pln_day": {
        "EDAH": 1,
        "ADMV": 1,
    },
    "normalize_pickup_end_to_start": True,
    "changed_positions_sheet": "Changed Positions",
    "minimum_rates": {
        "global_min_pln_day": 70,
        "long_duration_min_days": 21,
        "long_duration_min_pln_day": 100,
        "season_start": "2026-06-25",
        "season_end": "2026-08-31",
        "season_duration_column_min_days": 8,
        "season_min_pln_day": 115,
    },
    "delta_color_scale": {
        "max_delta_pln_day": 30,
        "increase_light": "E2F0D9",
        "increase_dark": "00B050",
        "decrease_light": "F4CCCC",
        "decrease_dark": "C00000",
    },
    "delta_color_steps": {
        "thresholds_pln_day": [5, 10, 15, 20],
        "increase": ["E2F0D9", "C6E0B4", "A9D18E", "70AD47", "00B050"],
        "decrease": ["F4CCCC", "F8B4B4", "EA9999", "E06666", "C00000"],
    },
    "recommendation_colors": {
        "top1_gap": "9DC3E6",
        "top3_small_decrease": "FFC7CE",
    },
    "min_excel_change_pln_day": 0.01,
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


def get_duration_columns(ws: Any, config: dict[str, Any]) -> dict[int, tuple[int, str, int, int]]:
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
            duration_columns[duration] = (col, label, left, right)

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


def group_is_excluded(group: Any, config: dict[str, Any]) -> bool:
    excluded = {normalize_code(item) for item in config.get("excluded_groups", [])}
    return normalize_code(group) in excluded


def get_group_rate_adjustment(group: Any, config: dict[str, Any]) -> float:
    adjustments = {
        normalize_code(key): parse_number(value) or 0
        for key, value in (config.get("group_rate_adjustments_pln_day") or {}).items()
    }
    return float(adjustments.get(normalize_code(group), 0))


def classify_actual_action(old_rate: float | None, new_rate: float, fallback_action: str) -> str:
    if old_rate is None:
        return fallback_action
    if new_rate > old_rate:
        return "increase"
    if new_rate < old_rate:
        return "decrease"
    return "hold"


def format_rate_for_comment(value: float | None) -> str:
    if value is None:
        return "puste"
    if float(value).is_integer():
        return str(int(value))
    return f"{value:.2f}"


def format_delta_for_comment(value: float | None) -> str:
    formatted = format_rate_for_comment(value)
    if value is not None and value > 0:
        return f"+{formatted}"
    return formatted


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def parse_hex_color(value: Any) -> tuple[int, int, int]:
    text = str(value or "").strip().replace("#", "")
    if len(text) == 8:
        text = text[-6:]
    if len(text) != 6:
        text = "FFFFFF"
    return int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16)


def interpolate_color(light: Any, dark: Any, ratio: float) -> str:
    start = parse_hex_color(light)
    end = parse_hex_color(dark)
    ratio = clamp(ratio, 0, 1)
    return "".join(f"{round(start[index] + (end[index] - start[index]) * ratio):02X}" for index in range(3))


def get_delta_fill(change: dict[str, Any], config: dict[str, Any]) -> PatternFill:
    delta = parse_number(change.get("delta"))
    if delta is None or delta == 0:
        color = (config.get("colors") or {}).get("hold", "D9EAF7")
        return PatternFill(fill_type="solid", fgColor=str(color).replace("#", ""))

    steps = config.get("delta_color_steps") or {}
    palette = steps.get("increase" if delta > 0 else "decrease") or []
    thresholds = [parse_number(item) for item in (steps.get("thresholds_pln_day") or [])]
    thresholds = [item for item in thresholds if item is not None]
    if palette:
        color_index = 0
        for threshold in thresholds:
            if abs(delta) > threshold:
                color_index += 1
        color = palette[min(color_index, len(palette) - 1)]
        return PatternFill(fill_type="solid", fgColor=str(color).replace("#", ""))

    scale = config.get("delta_color_scale") or {}
    max_delta = parse_number(scale.get("max_delta_pln_day")) or 30
    ratio = abs(delta) / max_delta
    if delta > 0:
        color = interpolate_color(scale.get("increase_light", "E2F0D9"), scale.get("increase_dark", "00B050"), ratio)
    else:
        color = interpolate_color(scale.get("decrease_light", "F4CCCC"), scale.get("decrease_dark", "C00000"), ratio)
    return PatternFill(fill_type="solid", fgColor=color)


def get_recommendation_fill(change: dict[str, Any], config: dict[str, Any]) -> PatternFill | None:
    recommendation_type = change.get("recommendation_type")
    color = (config.get("recommendation_colors") or {}).get(recommendation_type)
    if not color:
        return None
    return PatternFill(fill_type="solid", fgColor=str(color).replace("#", ""))


def get_recommendation_reason_pl(change: dict[str, Any]) -> str:
    recommendation_type = change.get("recommendation_type")
    benchmark_provider = change.get("benchmark_provider") or "konkurent"
    benchmark_rate = format_rate_for_comment(parse_number(change.get("benchmark_rate")))
    if recommendation_type == "top1_gap":
        return (
            "MM Cars Rental jest na 1 miejscu, a druga oferta jest drozsza o ponad "
            "5 PLN/dzien. Cel jest ustawiony 1 PLN ponizej benchmarku "
            f"{benchmark_provider} ({benchmark_rate} PLN)."
        )
    if recommendation_type == "top3_small_decrease":
        return (
            "Cel top3 wymaga roznicy mniejszej niz 10 PLN/dzien. "
            f"Benchmark: {benchmark_provider} ({benchmark_rate} PLN)."
        )
    if recommendation_type == "top1_undercut":
        return (
            "MM Cars Rental nie jest na 1 miejscu. Cel jest ustawiony 1 PLN ponizej "
            f"benchmarku {benchmark_provider} ({benchmark_rate} PLN)."
        )
    return str(change.get("reason") or "")


def get_recommendation_outcome_pl(change: dict[str, Any]) -> str:
    recommendation_type = change.get("recommendation_type")
    if recommendation_type == "top1_gap":
        return "utrzymanie top1 przy cenie 1 PLN ponizej top2."
    if recommendation_type == "top3_small_decrease":
        return "top3 przy cenie 1 PLN ponizej top3."
    if recommendation_type == "top1_undercut":
        return "top1 przy cenie 1 PLN ponizej obecnego top1."
    return ""


def get_minimum_rate(target: dict[str, Any], config: dict[str, Any]) -> tuple[float, str]:
    rules = config.get("minimum_rates") or {}
    minimum = parse_number(rules.get("global_min_pln_day")) or 0
    reason = f"Minimum globalne: {format_rate_for_comment(minimum)} PLN brutto/dzien." if minimum else ""

    duration = int(parse_number(target.get("rental_days")) or 0)
    duration_min = int(parse_number(target.get("duration_min_days")) or duration)
    long_duration_min_days = int(parse_number(rules.get("long_duration_min_days")) or 21)
    long_duration_min_rate = parse_number(rules.get("long_duration_min_pln_day"))
    if long_duration_min_rate is not None and duration >= long_duration_min_days and long_duration_min_rate > minimum:
        minimum = long_duration_min_rate
        reason = f"Minimum dla duration od {long_duration_min_days} dni: {format_rate_for_comment(minimum)} PLN brutto/dzien."

    target_date = target.get("target_date")
    season_start = parse_date_value(rules.get("season_start"))
    season_end = parse_date_value(rules.get("season_end"))
    season_column_min_days = int(parse_number(rules.get("season_duration_column_min_days")) or 8)
    season_min_rate = parse_number(rules.get("season_min_pln_day"))
    if (
        isinstance(target_date, date)
        and season_start is not None
        and season_end is not None
        and season_start <= target_date <= season_end
        and duration_min >= season_column_min_days
        and season_min_rate is not None
        and season_min_rate > minimum
    ):
        minimum = season_min_rate
        reason = (
            f"Minimum sezonowe {season_start.isoformat()} - {season_end.isoformat()} "
            f"dla kolumn od {season_column_min_days} dni: {format_rate_for_comment(minimum)} PLN brutto/dzien."
        )

    return minimum, reason


def format_for_changed_positions(value: str) -> str:
    return (
        str(value or "")
        .replace(" PLN brutto/dzien", " PLN")
        .replace(" brutto/dzien", "")
        .replace("/dzien", "")
    )


def build_rate_comment(change: dict[str, Any]) -> Comment:
    lines = [
        f"Poprzednia stawka: {format_rate_for_comment(change.get('old_rate'))} PLN",
        f"Nowa stawka: {format_rate_for_comment(change.get('new_rate'))} PLN",
        f"Zmiana: {format_delta_for_comment(change.get('delta'))} PLN",
    ]
    return Comment("\n".join(lines), "Codex")


def format_grouped_rates(changes: list[dict[str, Any]], field: str) -> str:
    display_changes = get_display_changes_for_changed_positions(changes)
    if len(display_changes) == 1:
        return f"{format_rate_for_comment(display_changes[0].get(field))} PLN"
    return "; ".join(f"{format_rate_for_comment(change.get(field))} PLN" for change in display_changes)


def format_grouped_deltas(changes: list[dict[str, Any]]) -> str:
    display_changes = get_display_changes_for_changed_positions(changes)
    if len(display_changes) == 1:
        return f"{format_delta_for_comment(display_changes[0].get('delta'))} PLN"
    return "; ".join(f"{format_delta_for_comment(change.get('delta'))} PLN" for change in display_changes)


def get_display_changes_for_changed_positions(changes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    base_changes = [
        change
        for change in changes
        if not parse_number(change.get("group_adjustment_pln_day"))
    ]
    return base_changes or changes


def build_change_explanation(changes: list[dict[str, Any]]) -> str:
    change = changes[0]
    lines = [
        f"Poprzednia stawka: {format_grouped_rates(changes, 'old_rate')}",
        f"Nowa stawka: {format_grouped_rates(changes, 'new_rate')}",
        f"Zmiana: {format_grouped_deltas(changes)}",
        f"Powod rekomendacji: {format_for_changed_positions(get_recommendation_reason_pl(change))}",
    ]
    outcome = get_recommendation_outcome_pl(change)
    if outcome:
        lines.append(f"Co pozwoli osiagnac: {outcome}")
    benchmark_provider = change.get("benchmark_provider")
    benchmark_rate = parse_number(change.get("benchmark_rate"))
    if benchmark_provider or benchmark_rate is not None:
        lines.append(
            f"Benchmark: {benchmark_provider or 'n/a'} "
            f"{format_rate_for_comment(benchmark_rate)} PLN"
        )
    return "\n".join(lines)


def get_changed_positions_group_key(change: dict[str, Any]) -> tuple[Any, ...]:
    return (
        change.get("recommendation_type"),
        change.get("recommendation_action"),
        change.get("location"),
        change.get("zone"),
        change.get("pickup_date"),
        change.get("duration_band"),
        change.get("benchmark_provider"),
        change.get("benchmark_rate"),
        change.get("minimum_reason"),
    )


def group_changes_for_changed_positions(changes: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    grouped: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    for change in changes:
        grouped.setdefault(get_changed_positions_group_key(change), []).append(change)
    return list(grouped.values())


def get_strongest_delta_change(changes: list[dict[str, Any]]) -> dict[str, Any]:
    display_changes = get_display_changes_for_changed_positions(changes)
    return max(display_changes, key=lambda change: abs(parse_number(change.get("delta")) or 0))


def get_grouped_rate_summary(changes: list[dict[str, Any]]) -> Any:
    display_changes = get_display_changes_for_changed_positions(changes)
    if len(display_changes) == 1:
        new_rate = display_changes[0].get("new_rate")
        return int(new_rate) if isinstance(new_rate, float) and float(new_rate).is_integer() else new_rate
    return "\n".join(f"{format_rate_for_comment(change.get('new_rate'))} PLN" for change in display_changes)


def copy_cell(source_cell: Any, target_cell: Any) -> None:
    target_cell.value = source_cell.value
    if source_cell.has_style:
        target_cell._style = copy(source_cell._style)
    if source_cell.hyperlink:
        target_cell._hyperlink = copy(source_cell.hyperlink)


def write_changed_positions_sheet(
    workbook: Any,
    source_ws: Any,
    config: dict[str, Any],
    changes: list[dict[str, Any]],
) -> None:
    sheet_name = str(config.get("changed_positions_sheet") or "").strip()
    if not sheet_name or not changes:
        return
    if sheet_name == source_ws.title:
        raise ValueError("changed_positions_sheet must be different from the import worksheet name.")

    if sheet_name in workbook.sheetnames:
        del workbook[sheet_name]

    header_row = int(config["header_row"])
    legend_rows = 6
    header_start_row = legend_rows + 1
    changed_groups = group_changes_for_changed_positions(changes)
    comment_col = 15
    source_col_count = comment_col - 1
    target_ws = workbook.create_sheet(sheet_name, workbook.index(source_ws) + 1)

    for col in range(1, comment_col + 1):
        letter = get_column_letter(col)
        source_width = source_ws.column_dimensions[letter].width
        if source_width:
            target_ws.column_dimensions[letter].width = source_width
    target_ws.column_dimensions["A"].width = 22
    target_ws.column_dimensions["B"].width = 70
    target_ws.column_dimensions[get_column_letter(comment_col)].width = 80

    target_ws["A1"] = "Legenda"
    target_ws["A1"].font = Font(bold=True)
    legend_items = [
        ("9DC3E6", "top1_gap", "MM Cars Rental jest top1, a top2 jest drozszy o ponad 5 PLN/dzien; cel jest 1 PLN ponizej top2."),
        ("FFC7CE", "top3_small_decrease", "Cel top3 wymaga roznicy mniejszej niz 10 PLN; cel jest 1 PLN ponizej top3."),
        ("00B050", "zielony w stawce", "zmiana dodatnia; mocniejszy kolor oznacza wieksza zmiane."),
        ("C00000", "czerwony w stawce", "zmiana ujemna; mocniejszy kolor oznacza wieksza zmiane."),
    ]
    for row, (color, label, description) in enumerate(legend_items, start=2):
        target_ws.cell(row, 1).value = label
        target_ws.cell(row, 1).fill = PatternFill(fill_type="solid", fgColor=color)
        target_ws.cell(row, 1).font = Font(bold=True)
        target_ws.cell(row, 2).value = description
        target_ws.cell(row, 2).alignment = Alignment(wrap_text=True, vertical="top")

    for row in range(1, header_row + 1):
        target_row = header_start_row + row - 1
        target_ws.row_dimensions[target_row].height = source_ws.row_dimensions[row].height
        for col in range(1, source_col_count + 1):
            copy_cell(source_ws.cell(row, col), target_ws.cell(target_row, col))

    target_header_row = header_start_row + header_row - 1
    data_start_row = target_header_row + 1
    target_ws.cell(target_header_row, comment_col).value = "Komentarz zmiany"
    target_ws.freeze_panes = f"A{data_start_row}"

    for index, grouped_changes in enumerate(changed_groups, start=data_start_row):
        change = grouped_changes[0]
        source_row = source_ws[change["cell"]].row
        target_ws.row_dimensions[index].height = source_ws.row_dimensions[source_row].height
        recommendation_fill = get_recommendation_fill(change, config)
        for col in range(1, source_col_count + 1):
            copy_cell(source_ws.cell(source_row, col), target_ws.cell(index, col))
            if recommendation_fill:
                target_ws.cell(index, col).fill = copy(recommendation_fill)

        target_ws.cell(index, 1).value = ", ".join(change["group"] for change in grouped_changes)
        target_ws.cell(index, 1).alignment = Alignment(wrap_text=True, vertical="top")
        changed_rate_col = source_ws[change["cell"]].column
        rate_cell = target_ws.cell(index, changed_rate_col)
        rate_cell.value = get_grouped_rate_summary(grouped_changes)
        rate_cell.fill = get_delta_fill(get_strongest_delta_change(grouped_changes), config)
        rate_cell.alignment = Alignment(wrap_text=True, vertical="top")

        explanation = build_change_explanation(grouped_changes)
        comment_cell = target_ws.cell(index, comment_col)
        comment_cell.value = explanation
        comment_cell.comment = Comment(explanation, "Codex")
        comment_cell.alignment = Alignment(wrap_text=True, vertical="top")
        if recommendation_fill:
            comment_cell.fill = copy(recommendation_fill)


def build_targets(
    recommendations: list[dict[str, Any]],
    duration_columns: dict[int, tuple[int, str, int, int]],
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

        col, duration_band, duration_min_days, duration_max_days = duration_column
        for zone in zones:
            targets[zone][target_date].append({
                **item,
                "zone": zone,
                "target_date": target_date,
                "rate_col": col,
                "duration_band": duration_band,
                "duration_min_days": duration_min_days,
                "duration_max_days": duration_max_days,
                "suggested_rate_pln_day": suggested_rate,
            })

    return targets, skipped


def find_targets_for_row(
    targets_by_date: dict[date, list[dict[str, Any]]],
    pickup_start: date | None,
) -> list[dict[str, Any]]:
    if pickup_start is None:
        return []
    return targets_by_date.get(pickup_start, [])


def maybe_normalize_pickup_end_date(ws: Any, row: int, columns: dict[str, Any], dry_run: bool) -> bool:
    start_cell = ws.cell(row, int(columns["pickup_start_date"]))
    end_cell = ws.cell(row, int(columns["pickup_end_date"]))
    if start_cell.value in (None, ""):
        return False
    if end_cell.value == start_cell.value:
        return False

    start_date = parse_date_value(start_cell.value)
    end_date = parse_date_value(end_cell.value)
    if start_date is not None and end_date == start_date and str(end_cell.value) == str(start_cell.value):
        return False

    if not dry_run:
        end_cell.value = start_cell.value
        end_cell.number_format = start_cell.number_format
    return True


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
    changes: list[dict[str, Any]] = []
    normalized_pickup_end_count = 0

    for row in range(data_start_row, ws.max_row + 1):
        if config.get("normalize_pickup_end_to_start", True):
            if maybe_normalize_pickup_end_date(ws, row, columns, dry_run):
                normalized_pickup_end_count += 1

        zone = normalize_code(ws.cell(row, int(columns["zone"])).value)
        if zone not in targets:
            continue

        group = ws.cell(row, int(columns["group"])).value
        if group_is_excluded(group, config):
            continue

        if not group_is_allowed(group, allowed_groups):
            continue

        pickup_start = parse_date_value(ws.cell(row, int(columns["pickup_start_date"])).value)
        row_targets = find_targets_for_row(targets[zone], pickup_start)
        if not row_targets:
            continue

        for target in row_targets:
            cell = ws.cell(row, int(target["rate_col"]))
            old_rate = parse_number(cell.value)
            group_adjustment = get_group_rate_adjustment(group, config)
            minimum_rate, minimum_reason = get_minimum_rate(target, config)
            suggested_rate = float(target["suggested_rate_pln_day"])
            base_rate = max(suggested_rate, minimum_rate)
            new_rate = base_rate + group_adjustment
            if old_rate is not None and abs(new_rate - old_rate) < min_change:
                continue

            actual_action = classify_actual_action(old_rate, new_rate, str(target["action"]))
            change = {
                "action": actual_action,
                "recommendation_action": target["action"],
                "recommendation_type": target.get("recommendation_type", ""),
                "reason": target.get("reason", ""),
                "location": target.get("location", ""),
                "zone": zone,
                "group": normalize_code(group),
                "pickup_date": target["target_date"].isoformat(),
                "duration_days": target.get("rental_days"),
                "duration_band": target["duration_band"],
                "duration_min_days": target.get("duration_min_days"),
                "duration_max_days": target.get("duration_max_days"),
                "cell": cell.coordinate,
                "old_rate": old_rate,
                "new_rate": new_rate,
                "delta": None if old_rate is None else round(new_rate - old_rate, 2),
                "suggested_rate_before_minimum": suggested_rate,
                "minimum_rate_pln_day": minimum_rate,
                "minimum_reason": minimum_reason if base_rate > suggested_rate else "",
                "group_adjustment_pln_day": group_adjustment,
                "mm_rate": target.get("mm_rate_pln_day"),
                "benchmark_provider": target.get("benchmark_provider", ""),
                "benchmark_rate": target.get("benchmark_rate_pln_day"),
                "scenario_id": target.get("scenario_id", ""),
            }

            if not dry_run:
                cell.value = int(new_rate) if float(new_rate).is_integer() else round(new_rate, 2)
                cell.fill = get_delta_fill(change, config)
                cell.comment = build_rate_comment(change)

            changes.append(change)

    if not dry_run:
        if output_path is None:
            raise ValueError("Output path is required unless --dry-run is used.")
        write_changed_positions_sheet(workbook, ws, config, changes)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        workbook.save(output_path)

    return {
        "workbook": str(workbook_path),
        "output": str(output_path) if output_path else None,
        "dry_run": dry_run,
        "change_count": len(changes),
        "normalized_pickup_end_count": normalized_pickup_end_count,
        "skipped_target_count": len(skipped_targets),
        "changes": changes[:100],
    }


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
