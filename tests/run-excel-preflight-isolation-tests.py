"""Keep unit fixtures independent of policies edited through the director panel."""
import runpy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tools import update_excel_rates as engine


class FixtureIsolationTests(unittest.TestCase):
    def test_priority_fallback_fixture_does_not_read_mutable_production_policy(self):
        original = engine.load_json

        def read_fixture_only(path):
            if Path(path).resolve() == ROOT / "pricing-rules.config.example.json":
                raise AssertionError("Synthetic fixture attempted to read director-approved production rules")
            return original(path)

        with patch.object(engine, "load_json", side_effect=read_fixture_only):
            runpy.run_path(str(ROOT / "tests/run-priority-fallback-tests.py"))

    def test_cap_projection_fixture_does_not_read_mutable_production_policy(self):
        original = Path.read_text

        def read_fixture_only(path, *args, **kwargs):
            if path.resolve() == ROOT / "pricing-rules.config.example.json":
                raise AssertionError("Cap fixture attempted to read director-approved production rules")
            return original(path, *args, **kwargs)

        with patch.object(Path, "read_text", read_fixture_only):
            module = runpy.run_path(str(ROOT / "tests/run-cap-projection-tests.py"))
            result = unittest.TestResult()
            module["CapProjectionTests"]("test_airport_family_minimum_keeps_compatible_city_cap_active").run(result)
        self.assertTrue(result.wasSuccessful(), result.errors or result.failures)


class ProductionValidationTests(unittest.TestCase):
    def setUp(self):
        from tools.validate_excel_inputs import validate_inputs
        self.validate = validate_inputs
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.config = json.loads((ROOT / "excel-rate-update.config.example.json").read_text(encoding="utf-8"))
        self.config["location_registry_file"] = str(ROOT / "locations.config.json")
        self.config["baseline_manifest_file"] = str(ROOT / "input/baseline-manifest.json")
        self.config["pricing_rules_file"] = str(self.directory / "pricing.json")
        self.config_path = self.directory / "excel.json"
        self.base = ROOT / "input/mm-cars-rental-rates-inclusive-fp.xlsx"
        self.rule = {"groups":["CDMV","CFAV"], "zones":["KALO"], "startDate":"2026-10-23",
                     "endDate":"2027-12-23", "minDays":3, "maxDays":4,
                     "minimumRatePlnDay":80, "overrideProtected":False}

    def write_config(self, rules):
        (self.directory / "pricing.json").write_text(json.dumps({"pricing":{"mandatoryScopedFloorsPlnDay":rules}}), encoding="utf-8")
        self.config_path.write_text(json.dumps(self.config), encoding="utf-8")

    def test_valid_director_rules_use_full_registry_without_modifying_inputs(self):
        self.write_config([self.rule])
        inputs = [self.config_path, self.directory / "pricing.json", self.base, ROOT / "input/baseline-manifest.json"]
        original = {path:path.read_bytes() for path in inputs}
        result = self.validate(self.config_path, self.base)
        self.assertEqual(result["scoped_rule_count"], 1)
        self.assertGreater(result["registered_zone_count"], 1)
        for path in inputs:
            self.assertEqual(path.read_bytes(), original[path])

    def test_invalid_director_rules_still_fail_closed(self):
        for change in ({"zones":["FAKE"]}, {"groups":["ZZZZ"]}, {"minimumRatePlnDay":-1}, {"endDate":"2026-01-01"}):
            with self.subTest(change=change):
                self.write_config([{**self.rule, **change}])
                with self.assertRaises(ValueError):
                    self.validate(self.config_path, self.base)

    def test_missing_policy_or_mismatching_baseline_blocks_collection(self):
        self.write_config([self.rule])
        (self.directory / "pricing.json").unlink()
        with self.assertRaises(FileNotFoundError):
            self.validate(self.config_path, self.base)
        self.write_config([self.rule])
        manifest = json.loads((ROOT / "input/baseline-manifest.json").read_text(encoding="utf-8"))
        manifest["workbook_sha256"] = "0" * 64
        manifest_path = self.directory / "baseline.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        self.config["baseline_manifest_file"] = str(manifest_path)
        self.write_config([self.rule])
        with self.assertRaises(ValueError):
            self.validate(self.config_path, self.base)


if __name__ == "__main__":
    unittest.main()
