"""Validate current production inputs separately from immutable unit fixtures."""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tools import update_excel_rates as engine


def validate_inputs(config_path: Path, workbook_path: Path) -> dict:
    config_path = config_path.resolve()
    config = engine.load_config(config_path)
    for field in ("pricing_rules_file", "baseline_manifest_file"):
        path = Path(config.get(field) or "")
        if not path.is_absolute():
            path = config_path.parent / path
        if not path.is_file():
            raise FileNotFoundError(f"Missing production {field}: {path}")
        config[field] = str(path)
    if not config.get("location_zones"):
        raise ValueError("Production validation requires the complete location registry")
    engine.get_pricing_policy(config)
    engine.resolve_apply_groups(config, None)
    engine.get_protected_rate_periods(config)
    engine.get_mandatory_zone_floors(config)
    engine.get_mandatory_group_floors(config)
    scoped = engine.get_mandatory_scoped_floors(config)
    engine.get_location_type_floors(config)
    digest = engine.sha256_file(workbook_path)
    confirmation = engine.load_baseline_confirmation(config, digest)
    return {"status": "ok", "scoped_rule_count": len(scoped),
            "registered_zone_count": len({zone for values in config["location_zones"].values() for zone in values}),
            "baseline_sha256": digest, "baseline_status": confirmation["status"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "excel-rate-update.config.example.json")
    parser.add_argument("--workbook", type=Path, default=ROOT / "input/mm-cars-rental-rates-inclusive-fp.xlsx")
    args = parser.parse_args()
    print(json.dumps(validate_inputs(args.config, args.workbook)))


if __name__ == "__main__":
    main()
