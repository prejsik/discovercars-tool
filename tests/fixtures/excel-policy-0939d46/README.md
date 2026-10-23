# Excel Synthetic Policy Fixtures

These three JSON files are verbatim snapshots from commit `0939d46`:

- `pricing-rules.config.example.json`
- `excel-rate-update.config.example.json`
- `locations.config.json`

They are fixed test inputs, not copies to refresh when the director panel changes
production rules. Use `tests/excel_test_fixtures.py` to load fresh values or merge
synthetic overrides. Tests that exercise another policy write a temporary copy.

Production integration validation must explicitly load the root config, its full
current registry and pricing rules, and the actual baseline. Do not substitute
these fixtures or disable scoped floors in that validation.
