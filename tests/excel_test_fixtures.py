"""Fixed synthetic inputs; production integration tests must load ROOT config explicitly."""

import json
from pathlib import Path

from tools.update_excel_rates import load_config, merge_config


FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "excel-policy-0939d46"
FIXTURE_PRICING_RULES_PATH = FIXTURE_DIR / "pricing-rules.config.example.json"
FIXTURE_CONFIG_PATH = FIXTURE_DIR / "excel-rate-update.config.example.json"
FIXTURE_REGISTRY_PATH = FIXTURE_DIR / "locations.config.json"


def load_fixture_pricing_rules():
    """Return a fresh policy payload so a test can edit its own copy."""
    return json.loads(FIXTURE_PRICING_RULES_PATH.read_text(encoding="utf-8"))


def merge_fixture_config(overrides=None):
    """Use updater defaults with an explicit fixed policy, not the live panel policy."""
    return merge_config({"pricing_rules_file": str(FIXTURE_PRICING_RULES_PATH), **(overrides or {})})


def load_fixture_config():
    """Load the historical config and registry without the production baseline manifest."""
    config = load_config(FIXTURE_CONFIG_PATH)
    config.update(pricing_rules_file=str(FIXTURE_PRICING_RULES_PATH), baseline_manifest_file="")
    return config
