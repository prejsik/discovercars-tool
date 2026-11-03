import sys
import unittest
import json
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
from datetime import date
from pathlib import Path

import openpyxl

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools.update_excel_rates import find_city_top1_airport_cap_violations, merge_config
from tools import update_excel_rates as updater


class ExcelErrorDiagnosticsTests(unittest.TestCase):
    def test_preserved_exception_requires_exactly_unchanged_rate_in_explicit_cell(self):
        book = openpyxl.Workbook()
        ws = book.active
        for _ in range(4):
            ws.append([])
        ws.append(['CDMV', None, None, 'KRDW', None, None, date(2026,12,9)] + [None]*5 + [80])
        ws.append(['CGAV', None, None, 'KRDW', None, None, date(2026,12,9)] + [None]*5 + [80])
        config = merge_config({'apply_groups':['CDMV','CGAV'],'excluded_groups':[]})
        caps = {('KRDW',date(2026,12,9),13):{'base_rate_cap_pln_day':77}}
        kept = []
        errors = find_city_top1_airport_cap_violations(ws,config,caps,{'CDMV','CGAV'},preserved_rates={'M5':80},preserved_details=kept)
        self.assertEqual(len(errors),1)
        self.assertIn('CGAV',errors[0])
        self.assertEqual(len(kept),1)
        ws['M5'] = 80.01
        errors = find_city_top1_airport_cap_violations(ws,config,caps,{'CDMV','CGAV'},preserved_rates={'M5':80})
        self.assertEqual(len(errors),2)
        book.close()

    def test_cli_writes_diagnostic_without_swallowing_validation_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'diagnostic.json'
            args = SimpleNamespace(config='config.json',workbook='base.xlsx',recommendations='recommendations.json',output=None,groups=None,dry_run=False,accepted_only=False,acceptance_workbook=None,import_output=None,diagnostics_output=str(path))
            error = updater.WorkbookValidationError('Cap violation', {'code':'city_airport_cap','total':0,'positions':[]}, 'a'*64, {'confirmed':True})
            with patch.object(updater, 'parse_args', return_value=args), patch.object(updater,'load_config',return_value={}), patch.object(updater,'apply_updates',side_effect=error):
                with self.assertRaises(updater.WorkbookValidationError):
                    updater.main()
            result = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(result['input_workbook_sha256'],'a'*64)
            self.assertEqual(result['diagnostics']['code'],'city_airport_cap')

    def test_cap_errors_include_each_exact_cell_without_modifying_rates(self):
        book = openpyxl.Workbook()
        ws = book.active
        for _ in range(4):
            ws.append([])
        for group in ['CDMV', 'CGAV']:
            ws.append([group, None, None, 'KRDW', None, None, date(2026, 12, 9)] + [None] * 5 + [80])
        config = merge_config({'apply_groups': ['CDMV', 'CGAV'], 'excluded_groups': []})
        caps = {('KRDW', date(2026, 12, 9), 13): {'base_rate_cap_pln_day': 77, 'airport_zone': 'KRLO', 'max_multiplier': 1.3, 'airport_rates_by_group': {'CDMV': 60, 'CGAV': 60}}}
        details = []
        errors = find_city_top1_airport_cap_violations(ws, config, caps, {'CDMV', 'CGAV'}, details=details)
        self.assertEqual(len(errors), 2)
        self.assertEqual(len(details), 2)
        self.assertEqual(details[0]['rate'], 80)
        self.assertEqual(details[0]['limit'], 77)
        self.assertEqual(details[0]['column'], 'M')
        self.assertEqual(details[0]['airportZone'], 'KRLO')
        self.assertEqual(ws['M5'].value, 80)
        ignored = {('KRDW', date(2026, 12, 9), 13, 'CDMV')}
        details = []
        errors = find_city_top1_airport_cap_violations(ws, config, caps, {'CDMV','CGAV'}, ignored, details=details)
        self.assertEqual(len(errors), 1)
        self.assertEqual(details[0]['group'], 'CGAV')
        book.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
