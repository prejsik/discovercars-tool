import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path

import openpyxl
from openpyxl.styles import PatternFill

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tools.update_excel_rates import (apply_updates, load_config, predict_site_rate,
    evaluate_target_constraints, target_for_group, format_broker_markup, resolve_apply_groups,
    find_city_top1_airport_cap_violations, build_targets, calculate_target_base_rate, get_minimum_rate)


def main():
    fixed = json.loads((ROOT / 'input/broker-markup-frozen.json').read_text())['brokerMarkupCalibration']
    groups = fixed['baseGroups'] + list(fixed['groupSupplementsPlnDay']) + ['ZZAV']
    node = shutil.which('node')
    assert node, 'Node is required for the end-to-end recommendation test'
    with tempfile.TemporaryDirectory(prefix='fixed-markup-excel-') as directory:
        folder = Path(directory)
        source = folder / 'baseline.xlsx'
        workbook = openpyxl.Workbook()
        ws = workbook.active
        ws.title = 'Sheet1'
        ws.append(['Rental rates for packages: INCLUSIVE POA'])
        ws.append(['Min days'] + [None]*7 + [1,2,3,5,8,21])
        ws.append(['Max days'] + [None]*7 + [1,2,4,7,20,35])
        ws.append(['Group','Description','Rate code','Zone','Booking start date', 'Booking end date',
            'Pickup start date','Pickup end date'] + ['Per day']*6)
        ws['A1'].fill = PatternFill(fill_type='solid', fgColor='1F4E78')
        for start in [date(2026,10,1), date(2026,10,31), date(2026,11,3)]:
            for group in groups:
                ws.append([group,None,None,'WALO',start,start,start,start]+[150]*6)
                if start == date(2026,10,1):
                    ws.cell(ws.max_row,13).value = 50
        ws.auto_filter.ref = f'A4:N{ws.max_row}'
        ws.row_dimensions[5].hidden = True
        workbook.save(source)
        saved_source = openpyxl.load_workbook(source)
        headers = [[(c.value, str(c._style)) for c in row] for row in saved_source['Sheet1'].iter_rows(max_row=4)]
        saved_source.close()
        original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        scenarios=[]
        for start in ['2026-10-01','2026-10-31','2026-11-03']:
            for days in range(2,15):
                def offer(provider, rate):
                    return dict(provider_name=provider,total_price=rate*days,rental_days=days,currency='PLN')
                if start == '2026-11-03' or days >= 8:
                    view={'top_3':[offer('MM Cars Rental',80),offer('Competitor',100),offer('Other',140)],
                        'mm_cars_rental':offer('MM Cars Rental',80)}
                else:
                    view={'top_3':[offer('Competitor',100),offer('MM Cars Rental',120),offer('Other',140)],
                        'mm_cars_rental':offer('MM Cars Rental',120)}
                scenarios.append(dict(start_date=start,rental_days=days,
                    top_3_plus_mm_by_location={'Warsaw Chopin Airport (WAW)':view},
                    offer_views_by_location={'Warsaw Chopin Airport (WAW)':{'automatic':view}}))
        payload = folder / 'results.json'
        payload.write_text(json.dumps({'locations':['Warsaw Chopin Airport (WAW)'],'scenarios':scenarios}))
        recommendations = folder / 'recommendations.json'
        wrong = folder / 'wrong-calibration.json'
        wrong.write_text(json.dumps({'brokerMarkupCalibration':{'enabled':True,'defaultMultiplier':10}}))
        subprocess.run([node,'src/pricingRecommendations.js',str(payload),str(recommendations),
            '--config=pricing-rules.config.example.json',f'--calibration={wrong}'],cwd=ROOT,check=True,capture_output=True)
        decisions=json.loads(recommendations.read_text())
        assert decisions['decisions'][0]['suggested_rate_pln_day'] == 70
        assert decisions['decisions'][0]['predicted_site_rate_pln_day'] == 99
        config=load_config(ROOT / 'excel-rate-update.config.example.json')
        config['pickup_date_expansion']={'enabled':False}
        config['baseline_manifest_file']=''
        config['baseline_workbook_sha256']=original_hash
        report=folder / 'recommendations.xlsx'
        imported=folder / 'import.xlsx'
        summary=apply_updates(source,recommendations,report,config,None,False,import_output_path=imported)
        assert not summary['broker_markup_observations']['enabled']
        assert summary['broker_markup_observations']['count']==0
        assert summary['change_count']==48, summary['change_count']
        validation = {row['check']: row for row in summary['validation']}
        unknown=validation['Klasy bez reguly - stawki zachowane']
        assert (unknown['status'],unknown['issue_count'],unknown['details'])==('WARNING',1,'ZZAV')
        permissions=validation['Zmienione klasy spoza listy dopuszczonej']
        assert (permissions['status'],permissions['issue_count'])==('OK',0)
        assert hashlib.sha256(source.read_bytes()).hexdigest()==original_hash
        result=openpyxl.load_workbook(imported)
        assert result.sheetnames==['Sheet1']
        sheet=result['Sheet1']
        assert sheet.max_row==ws.max_row
        for before, after in zip(headers, sheet.iter_rows(max_row=4)):
            assert [(c.value,str(c._style)) for c in after]==before, (before,[(c.value,str(c._style)) for c in after])
        active={'CDMV','CGAV','CWAV','CWMR','EDAV','EDMV'}
        for row in sheet.iter_rows(min_row=5):
            group=row[0].value
            if row[6].value.date()==date(2026,10,1) and group in active:
                adjustment=1 if group in {'EDAV','EDMV'} else 0
                assert [c.value for c in row[9:12]]==[69+adjustment,84+adjustment,90+adjustment]
            elif row[6].value.date()==date(2026,11,3) and group in active:
                adjustment=1 if group in {'EDAV','EDMV'} else 0
                assert [c.value for c in row[9:12]]==[70+adjustment,85+adjustment,91+adjustment]
            else:
                assert all(c.value==150 for c in row[9:12])
            assert [row[i].value for i in [8,13]]==[150,150]
            if group in active and row[6].value.date()!=date(2026,10,31):
                expected_long = 88 if group in {'EDAV','EDMV'} else 87
            else:
                expected_long = 50 if row[6].value.date()==date(2026,10,1) else 150
            assert row[12].value==expected_long, (group,row[6].value,row[12].value,expected_long)
        for change in summary['changes']:
            assert change['predicted_site_rate']==change['new_rate']+change['broker_markup_amount_pln_day']
            if (change['pickup_date']=='2026-11-03' or change['duration_band']=='8-20') and change['group'] in {'EDAV','EDMV'}:
                assert not change['target_achievable'], 'Standard +1 premium must report a consumed ranking buffer'
            else:
                assert change['target_achievable']
            if change['duration_band']=='8-20':
                assert change['minimum_rate_pln_day']==40
                assert change['covered_duration_days']==list(range(8,15))
                assert change['missing_duration_days']==list(range(15,21))
                assert not change['duration_band_coverage_complete']
                assert change['duration_band_required_coverage_complete']
        report_book=openpyxl.load_workbook(report)
        assert any('PLN/doba (staly)' in str(c.value) for row in report_book['Recommendations Review'] for c in row)
        assert any('Staly narzut brokera' == c.value for row in report_book['Changed Positions'] for c in row)
        result.close()
        report_book.close()

        approved={'CDMV','CGAV','CWAV','CWMR','EDAV','EDMV'}
        assert resolve_apply_groups(config,None)==approved
        assert resolve_apply_groups(config,'all')==approved
        assert resolve_apply_groups(config,'CDMV')=={'CDMV'}
        for selection in ('ZZAV','CDMV,ZZAV'):
            try:
                resolve_apply_groups(config,selection)
            except ValueError as error:
                assert 'ZZAV' in str(error)
            else:
                raise AssertionError('CLI cannot authorize a group outside the configured list')
        try:
            resolve_apply_groups({**config,'apply_groups':'all'},None)
        except ValueError:
            pass
        else:
            raise AssertionError('Wildcard class permission must not authorize unknown groups')

        restricted=folder / 'restricted.xlsx'
        restricted_summary=apply_updates(source,recommendations,restricted,config,'CDMV',False)
        assert restricted_summary['change_count']==8
        assert all(change['group']=='CDMV' for change in restricted_summary['changes'])
        restricted_book=openpyxl.load_workbook(restricted)
        for row in restricted_book['Sheet1'].iter_rows(min_row=5):
            if row[0].value!='CDMV' or row[6].value.date()==date(2026,10,31):
                assert all(row[i].value==150 for i in [8,9,10,11,13]), 'Parity must not modify unauthorized groups'
                assert row[12].value==(50 if row[6].value.date()==date(2026,10,1) else 150)
            assert [row[i].value for i in [8,13]]==[150,150]
        restricted_book.close()
        columns={days:(13,'8-20',8,20) for days in range(8,21)}
        long_decisions=[item for item in decisions['decisions'] if item['start_date']=='2026-11-03' and 8 <= item['rental_days'] <= 14]
        targets, skipped=build_targets(long_decisions,columns,config)
        target={**targets['WALO'][date(2026,11,3)][0],'group':'CDMV'}
        assert not skipped
        assert calculate_target_base_rate(target,50,config)[0]==87, 'Complete 8-14 evidence permits a raise across 8-20'
        incomplete, skipped=build_targets([item for item in long_decisions if item['rental_days']!=12],columns,config)
        partial_source=folder / 'partial-source.xlsx'
        partial_book=openpyxl.load_workbook(source)
        for row in partial_book['Sheet1'].iter_rows(min_row=5):
            if row[6].value.date()==date(2026,11,3):
                row[12].value=100 if row[0].value=='CDMV' else 80 if row[0].value=='CGAV' else 150
        partial_values=list(partial_book['Sheet1'].values)
        partial_book.save(partial_source)
        partial_book.close()
        partial_json=folder / 'partial.json'
        partial_json.write_text(json.dumps({'decisions':[item for item in long_decisions if item['rental_days']!=12]}))
        partial_output=folder / 'partial-output.xlsx'
        partial_config={**config,'baseline_workbook_sha256':hashlib.sha256(partial_source.read_bytes()).hexdigest()}
        partial_summary=apply_updates(partial_source,partial_json,partial_output,partial_config,None,False)
        assert partial_summary['change_count']==0, 'Missing 8-14 evidence cannot raise another class through parity'
        partial_book=openpyxl.load_workbook(partial_output)
        assert list(partial_book['Sheet1'].values)==partial_values, 'Incomplete long band preserves every base rate'
        partial_book.close()
        assert not incomplete and skipped, 'Missing required 8-14 evidence blocks the whole band'
        target={**targets['WALO'][date(2026,11,3)][0],'group':'CDMV'}
        unsafe_decisions=[{**item,'data_quality_status':'invalid_currency'} if item['rental_days']==12 else item for item in long_decisions]
        unsafe_targets, skipped=build_targets(unsafe_decisions,columns,config)
        assert not unsafe_targets and skipped, 'Long-band evidence exception cannot bypass data quality checks'
        for zone in ('WALO','KRLO','KRTI','GDLO','KA1'):
            for group in active:
                assert get_minimum_rate({**target,'zone':zone,'group':group},config)[0]==40
                assert calculate_target_base_rate({**target,'zone':zone,'group':group,'suggested_rate_pln_day':20},100,config)[0]==40
        floor_recommendations=folder / 'floor-recommendations.json'
        floor_recommendations.write_text(json.dumps({'decisions':[
            {**item,'action':'decrease','suggested_rate_pln_day':20,'maximum_import_rate_pln_day':20,
                'site_cap_rate_pln_day':32,'site_target_rate_pln_day':32,'benchmark_rate_pln_day':33}
            for item in long_decisions
        ]}))
        floor_output=folder / 'floor-output.xlsx'
        floor_summary=apply_updates(source,floor_recommendations,floor_output,config,None,False)
        assert floor_summary['change_count']==6
        floor_book=openpyxl.load_workbook(floor_output)
        for row in floor_book['Sheet1'].iter_rows(min_row=5):
            assert all(row[i].value==150 for i in [8,9,10,11,13])
            if row[6].value.date()==date(2026,11,3) and row[0].value in active:
                assert row[12].value==(41 if row[0].value in {'EDAV','EDMV'} else 40), 'Saved workbook respects long-band floor and parity'
            else:
                assert row[12].value==(50 if row[6].value.date()==date(2026,10,1) else 150)
        floor_book.close()
        workbook.close()

    cap_book=openpyxl.Workbook()
    cap_sheet=cap_book.active
    for _ in range(4):
        cap_sheet.append([None]*14)
    for group, rate in [('CDMV',70),('CWAV',150),('ZZAV',500)]:
        cap_sheet.append([group,None,None,'WA1',None,None,date(2026,11,3),None,150,rate,150,150,150,150])
    caps={('WA1',date(2026,11,3),10):{'base_rate_cap_pln_day':70}}
    violations=find_city_top1_airport_cap_violations(cap_sheet,config,caps)
    assert len(violations)==1 and violations[0].startswith('CWAV/'), 'Unknown classes cannot block publication'
    assert not find_city_top1_airport_cap_violations(cap_sheet,config,caps,allowed_groups={'CDMV'}), 'CLI-unselected classes cannot block publication'
    cap_sheet['J5']=80
    violations=find_city_top1_airport_cap_violations(cap_sheet,config,caps,allowed_groups={'CDMV'})
    assert len(violations)==1 and violations[0].startswith('CDMV/'), 'Selected class cap remains enforced'
    cap_book.close()

    target={'broker_markup_model':'fixed_amount','broker_markup_multiplier':1,'broker_markup_amount_pln_day':29,
        'broker_markup_group_supplements_pln_day':{'PDAH':10},'suggested_rate_pln_day':70,'site_cap_rate_pln_day':99}
    premium=target_for_group(target,'PDAH')
    assert premium['suggested_rate_pln_day']==60
    assert predict_site_rate(60,premium)==99
    assert predict_site_rate(70,target)==99
    assert evaluate_target_constraints(target,70)['target_achievable']
    assert not evaluate_target_constraints(target,71)['target_achievable']
    assert format_broker_markup(premium)=='39 PLN/doba (staly)'
    print('PASS fixed markup Excel: allowed groups, 8-20 floor40 with 8-14 evidence, incomplete evidence safety, long-band raises/decreases, exclusions, protected dates and baseline preserved')


if __name__=='__main__':
    main()
