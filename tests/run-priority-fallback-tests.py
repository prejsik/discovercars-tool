from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools.update_excel_rates import build_targets, merge_config, get_recommendation_outcome_pl, calculate_target_base_rate

config = merge_config({"location_zones": {"Test": ["WA1"]}})
items = [{
    "location": "Test", "start_date": "2026-10-01", "rental_days": days,
    "action": "decrease", "priority_rule_id": "all-locations-autumn-2026-short",
    "recommendation_type": "force_top1_undercut" if rank == 1 else "priority_top3",
    "target_rank": rank, "suggested_rate_pln_day": rate,
    "maximum_import_rate_pln_day": rate, "site_cap_rate_pln_day": rate,
    "data_quality_status": "ok",
} for days, rank, rate in [(3, 1, 35), (4, 3, 50)]]
columns = {3: (11, "3-4", 3, 4), 4: (11, "3-4", 3, 4)}
targets, _ = build_targets(items, columns, config)
target = next(iter(targets['WA1'].values()))[0]
assert target['target_rank'] == 3
assert target['recommendation_type'] == 'priority_top3'
assert 'top3' in get_recommendation_outcome_pl(target)
assert calculate_target_base_rate(target, 100, config)[0] == 34
items[1].update(action='hold', suggested_rate_pln_day=None, maximum_import_rate_pln_day=None, data_quality_status='floor_blocks_top3')
targets, skipped = build_targets(items, columns, config)
assert not targets and skipped
print('PASS: mixed-rank band labels, premium offset and blocked scenario preserve the band.')
