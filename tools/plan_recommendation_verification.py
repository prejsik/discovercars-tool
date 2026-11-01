"""Conservatively remove popularity checks that cannot reach an Excel rate cell."""

from __future__ import annotations

import argparse
import copy
import json
import os
import sys
import tempfile
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Any

import openpyxl

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from tools import update_excel_rates as engine


PENDING_STATUS = "popularity_pending"
PLAN_STATUS = "skipped_excel_irrelevant"


def _is_pending_active(item: Any) -> bool:
    return (
        isinstance(item, dict)
        and item.get("action") in {"increase", "decrease"}
        and item.get("requires_popularity_verification") is True
        and item.get("data_quality_status") == PENDING_STATUS
    )


def _identity(item: dict[str, Any]) -> tuple[Any, ...]:
    pickup_date = engine.parse_date_value(item.get("start_date") or item.get("pickup_date"))
    rental_days = engine.parse_number(item.get("rental_days"))
    dimensions = (
        engine.normalize_key(item.get("location")),
        pickup_date.isoformat() if pickup_date else engine.normalize_key(item.get("start_date") or item.get("pickup_date")),
        str(rental_days) if rental_days is not None else str(item.get("rental_days") or ""),
        engine.normalize_code(item.get("group")),
        str(item.get("action") or ""),
    )
    for field in ("scenario_id", "recommendation_id", "id"):
        value = item.get(field)
        if value is not None and str(value).strip():
            return (field, str(value), *dimensions)
    return ("fallback", *dimensions)


def _recommendation_list(payload: Any) -> tuple[str | None, list[Any]]:
    if isinstance(payload, list):
        return None, payload
    if isinstance(payload, dict):
        if isinstance(payload.get("decisions"), list):
            return "decisions", payload["decisions"]
        if isinstance(payload.get("recommendations"), list):
            return "recommendations", payload["recommendations"]
    raise ValueError("Recommendations must be a list or an object with a decisions or recommendations list.")


def _expansion_mode(config: dict[str, Any]) -> str:
    settings = config.get("pickup_date_expansion") or {}
    if not isinstance(settings, dict):
        raise ValueError("pickup_date_expansion must be an object.")
    if not settings.get("enabled"):
        return "disabled"
    mode = settings.get("mode")
    if mode == "source_ranges":
        return "source_ranges"
    if mode in (None, "window"):
        return "window"
    raise ValueError("Unknown pickup_date_expansion.mode; no verification items were pruned.")


def _item_targets(
    item: dict[str, Any],
    index: int,
    config: dict[str, Any],
    duration_columns: dict[int, tuple[int, str, int, int]],
    protected_periods: list[tuple[date, date]],
) -> tuple[list[dict[str, Any]], str | None]:
    action = item.get("action")
    if action not in {"increase", "decrease"}:
        return [], None

    rental_days = engine.parse_number(item.get("rental_days"))
    target_date = engine.parse_date_value(item.get("start_date") or item.get("pickup_date"))
    location_zones = {
        engine.normalize_key(location): zones
        for location, zones in (config.get("location_zones") or {}).items()
    }
    zones_value = location_zones.get(engine.normalize_key(item.get("location")))
    if zones_value is None:
        zones: list[str] = []
    elif isinstance(zones_value, (list, tuple)):
        zones = [engine.normalize_code(zone) for zone in zones_value]
    else:
        raise ValueError("location_zones entries must be arrays; no verification items were pruned.")

    if rental_days is None:
        return [], "missing_rental_duration"
    if target_date is None:
        return [], "invalid_pickup_date"
    if not zones:
        return [], "no_location_zone_mapping"
    if engine.parse_number(item.get("suggested_rate_pln_day")) is None:
        return [], "missing_suggested_rate"
    if engine.date_is_rate_protected(target_date, protected_periods):
        return [], "protected_date"

    duration = int(rental_days)
    max_duration = int(engine.parse_number(config.get("max_recommendation_duration_days")) or 0)
    if max_duration > 0 and duration > max_duration:
        return [], "maximum_duration_exceeded"
    duration_info = duration_columns.get(duration)
    if not duration_info:
        return [], "no_excel_duration_column"

    col, band, min_days, max_days = duration_info
    targets = []
    for zone in dict.fromkeys(zones):
        target = {
            **item,
            "zone": zone,
            "target_date": target_date,
            "duration_band": band,
            "duration_min_days": min_days,
            "duration_max_days": max_days,
        }
        targets.append({
            "index": index,
            "zone": zone,
            "date": target_date,
            "key": (zone, target_date, col),
            "target": target,
        })
    return targets, None


def _row_can_apply(
    group: str,
    zone: str,
    pickup_start: date | None,
    pickup_end: date | None,
    specs: list[dict[str, Any]],
    mode: str,
    config: dict[str, Any],
    allowed_groups: set[str],
    omitted: set[tuple[str, str]],
) -> set[tuple[str, date, int]]:
    if (group, zone) in omitted or pickup_start is None:
        return set()
    if not engine.group_is_allowed(group, allowed_groups):
        return set()

    matching = set()
    for spec in specs:
        target_date = spec["date"]
        if mode == "source_ranges" and (pickup_end is None or not pickup_start <= target_date <= pickup_end):
            continue
        if mode == "disabled" and pickup_start != target_date:
            continue
        target = engine.target_for_group(spec["target"], group)
        priority = engine.priority_top1_applies(target, group, config)
        if target.get("priority_rule_id") and not priority:
            continue
        if engine.group_is_excluded(group, config) and not priority:
            continue
        matching.add(spec["key"])
    return matching


def _source_range_error(group: str, zone: str, start: date | None, end: date | None) -> bool:
    if not group and not zone and start is None:
        return False
    return not group or not zone or start is None or end is None or start > end


def _scan_excel(
    workbook_path: Path,
    config: dict[str, Any],
    specs: list[dict[str, Any]],
    mode: str,
) -> tuple[set[tuple[str, date, int]], dict[str, int]]:
    workbook = openpyxl.load_workbook(workbook_path, read_only=True, data_only=True)
    try:
        sheet_name = config.get("worksheet") or workbook.sheetnames[0]
        if sheet_name not in workbook.sheetnames:
            raise ValueError(f"Worksheet '{sheet_name}' not found in the baseline workbook.")
        ws = workbook[sheet_name]
        duration_columns = engine.get_duration_columns(ws, config)
        allowed_groups = engine.resolve_apply_groups(config, None)
        omitted = engine.get_omitted_group_zones(config)
        columns = config["columns"]
        group_col = int(columns["group"])
        zone_col = int(columns["zone"])
        start_col = int(columns["pickup_start_date"])
        end_col = int(columns["pickup_end_date"])
        data_start = int(config["data_start_row"])
        max_col = max(int(ws.max_column or 1), group_col, zone_col, start_col, end_col)

        specs_by_zone: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for spec in specs:
            specs_by_zone[spec["zone"]].append(spec)

        zone_seeds = config.get("zone_seeds") or {}
        if not isinstance(zone_seeds, dict):
            raise ValueError("zone_seeds must be an object; no verification items were pruned.")
        seeds_by_source: dict[str, list[str]] = defaultdict(list)
        seed_pairs: dict[str, str] = {}
        for target, source in zone_seeds.items():
            if not isinstance(target, str) or not isinstance(source, str):
                raise ValueError("zone_seeds keys and values must be strings; no verification items were pruned.")
            normalized_target = engine.normalize_code(target)
            normalized_source = engine.normalize_code(source)
            if target != normalized_target or source != normalized_source:
                raise ValueError("zone_seeds must use canonical zone codes; no verification items were pruned.")
            seed_pairs[normalized_target] = normalized_source
            seeds_by_source[normalized_source].append(normalized_target)
        if any(source in seed_pairs for source in seed_pairs.values()):
            raise ValueError("Chained zone seeds are unsupported; no verification items were pruned.")

        zone_counts: dict[str, int] = defaultdict(int)
        eligible: set[tuple[str, date, int]] = set()
        seeded_eligible: dict[str, set[tuple[str, date, int]]] = defaultdict(set)
        seeded_valid_ranges: dict[str, int] = defaultdict(int)
        seeded_invalid_rows: dict[str, int] = {}
        row_count = 0
        valid_source_ranges = 0

        for row_number, values in enumerate(
            ws.iter_rows(min_row=data_start, max_col=max_col, values_only=True),
            start=data_start,
        ):
            row_count += 1
            group = engine.normalize_code(values[group_col - 1] if group_col <= len(values) else None)
            zone = engine.normalize_code(values[zone_col - 1] if zone_col <= len(values) else None)
            pickup_start = engine.parse_date_value(values[start_col - 1] if start_col <= len(values) else None)
            pickup_end = engine.parse_date_value(values[end_col - 1] if end_col <= len(values) else None)
            zone_counts[zone] += 1

            omitted_row = (group, zone) in omitted
            if mode == "source_ranges" and not omitted_row:
                if _source_range_error(group, zone, pickup_start, pickup_end):
                    raise ValueError(f"Invalid source pickup range in row {row_number}; Sheet1 was not modified.")
                if group or zone or pickup_start is not None:
                    valid_source_ranges += 1

            if not omitted_row:
                eligible.update(_row_can_apply(
                    group, zone, pickup_start, pickup_end, specs_by_zone.get(zone, []),
                    mode, config, allowed_groups, omitted,
                ))

            for target_zone in seeds_by_source.get(zone, []):
                if (group, target_zone) in omitted:
                    continue
                if mode == "source_ranges":
                    if _source_range_error(group, target_zone, pickup_start, pickup_end):
                        seeded_invalid_rows.setdefault(target_zone, row_number)
                        continue
                    if group or target_zone or pickup_start is not None:
                        seeded_valid_ranges[target_zone] += 1
                seeded_eligible[target_zone].update(_row_can_apply(
                    group, target_zone, pickup_start, pickup_end, specs_by_zone.get(target_zone, []),
                    mode, config, allowed_groups, omitted,
                ))

        for target_zone, source_zone in seed_pairs.items():
            if zone_counts.get(target_zone, 0) or not zone_counts.get(source_zone, 0):
                continue
            if mode == "source_ranges":
                invalid_row = seeded_invalid_rows.get(target_zone)
                if invalid_row is not None:
                    raise ValueError(f"Invalid source pickup range in row {invalid_row}; Sheet1 was not modified.")
                valid_source_ranges += seeded_valid_ranges.get(target_zone, 0)
            eligible.update(seeded_eligible.get(target_zone, set()))

        if mode == "source_ranges" and valid_source_ranges == 0:
            raise ValueError("No valid source pickup ranges; Sheet1 was not modified.")

        return eligible, {
            "workbook_rows_scanned": row_count,
            "duration_columns_found": len(duration_columns),
            "eligible_excel_buckets": len(eligible),
            "source_ranges_validated": int(mode == "source_ranges"),
        }
    finally:
        workbook.close()


def _hold_for_plan(item: dict[str, Any], reason: str) -> None:
    item["action"] = "hold"
    item["recommendation_action"] = "hold"
    item["suggested_rate_pln_day"] = None
    item["maximum_import_rate_pln_day"] = None
    item["site_cap_rate_pln_day"] = None
    item["site_target_rate_pln_day"] = None
    item["predicted_site_rate_pln_day"] = None
    item["change_pln_day"] = 0
    item["data_quality_status"] = "excel_ineligible"
    item["requires_popularity_verification"] = False
    item["verification_plan_status"] = PLAN_STATUS
    item["verification_plan_reason"] = reason
    item["reason"] = f"Excel update skipped: no eligible rate cell ({reason})."


def plan_recommendations(
    workbook_path: Path | str,
    config_path: Path | str,
    payload: Any,
) -> tuple[Any, dict[str, Any]]:
    result = copy.deepcopy(payload)
    list_key, items = _recommendation_list(result)
    config = engine.load_config(Path(config_path))
    pricing_rules = engine.get_pricing_rules(config)
    config = {**config, "_priority_top1_rules": pricing_rules.get("priorityTop1Rules", [])}
    protected_periods = engine.get_protected_rate_periods(config)
    mode = _expansion_mode(config)

    workbook = openpyxl.load_workbook(workbook_path, read_only=True, data_only=True)
    try:
        sheet_name = config.get("worksheet") or workbook.sheetnames[0]
        if sheet_name not in workbook.sheetnames:
            raise ValueError(f"Worksheet '{sheet_name}' not found in the baseline workbook.")
        duration_columns = engine.get_duration_columns(workbook[sheet_name], config)
    finally:
        workbook.close()

    specs: list[dict[str, Any]] = []
    reason_by_index: dict[int, str] = {}
    conservative_reason_by_index: dict[int, str] = {}
    keys_by_index: dict[int, set[tuple[str, date, int]]] = defaultdict(set)
    for index, item in enumerate(items):
        if not isinstance(item, dict) or item.get("action") not in {"increase", "decrease"}:
            continue
        targets, reason = _item_targets(item, index, config, duration_columns, protected_periods)
        if reason:
            if reason == "missing_suggested_rate":
                conservative_reason_by_index[index] = reason
            else:
                reason_by_index[index] = reason
        for spec in targets:
            specs.append(spec)
            keys_by_index[index].add(spec["key"])

    eligible, scan_stats = _scan_excel(Path(workbook_path), config, specs, mode)
    planned_holds: dict[tuple[Any, ...], list[dict[str, Any]]] = defaultdict(list)
    pending_before = sum(_is_pending_active(item) for item in items)
    pruned_count = 0
    conservative_retained_count = 0
    conservative_retained_reasons: dict[str, int] = defaultdict(int)
    reason_counts: dict[str, int] = defaultdict(int)

    for index, item in enumerate(items):
        if not _is_pending_active(item):
            continue
        conservative_reason = conservative_reason_by_index.get(index)
        if conservative_reason:
            conservative_retained_count += 1
            conservative_retained_reasons[conservative_reason] += 1
            continue
        reason = reason_by_index.get(index)
        if reason is None and not (keys_by_index.get(index, set()) & eligible):
            reason = "no_eligible_excel_cell"
        if reason is not None:
            item_key = _identity(item)
            _hold_for_plan(item, reason)
            planned_holds[item_key].append(item)
            pruned_count += 1
            reason_counts[reason] += 1
        elif mode == "window":
            conservative_retained_count += 1
            conservative_retained_reasons["window_expansion_scope"] += 1

    if isinstance(result, dict):
        if list_key:
            result[list_key] = items
        recommendations = result.get("recommendations")
        if list_key == "decisions" and isinstance(recommendations, list):
            queues = {key: list(values) for key, values in planned_holds.items()}
            for recommendation in recommendations:
                if not isinstance(recommendation, dict):
                    continue
                planned = queues.get(_identity(recommendation))
                if planned:
                    source = planned.pop(0)
                    _hold_for_plan(recommendation, source["verification_plan_reason"])
        if "recommendation_count" in result:
            count_items = recommendations if isinstance(recommendations, list) else items
            result["recommendation_count"] = sum(
                1 for item in count_items if isinstance(item, dict) and item.get("action") != "hold"
            )

    pending_after = sum(_is_pending_active(item) for item in items)
    summary = {
        "planner_version": 1,
        "workbook": str(Path(workbook_path)),
        "recommendation_items_before": len(items),
        "pending_active_count": pending_before,
        "dom_candidate_count_before": pending_before,
        "dom_candidate_count_after": pending_after,
        "pruned_count": pruned_count,
        "conservative_retained_count": conservative_retained_count,
        "conservative_retained_by_reason": dict(sorted(conservative_retained_reasons.items())),
        "pruned_by_reason": dict(sorted(reason_counts.items())),
        "expansion_mode": mode,
        **scan_stats,
    }
    return result, summary


def _atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, suffix=".tmp", delete=False
        ) as handle:
            temporary_path = Path(handle.name)
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workbook", required=True, type=Path)
    parser.add_argument("--recommendations", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--summary", type=Path)
    args = parser.parse_args(argv)

    try:
        workbook_path = args.workbook.resolve()
        if args.output.resolve() == workbook_path or (
            args.summary and args.summary.resolve() == workbook_path
        ):
            raise ValueError("Planner output paths must not overwrite the baseline workbook.")
        payload = engine.load_json(args.recommendations)
        planned, summary = plan_recommendations(args.workbook, args.config, payload)
        if args.summary and args.summary.resolve() == args.output.resolve():
            raise ValueError("--summary and --output must be different files.")
        if args.summary:
            _atomic_write_json(args.summary, summary)
        _atomic_write_json(args.output, planned)
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(f"Verification planning failed; use the unpruned path: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
