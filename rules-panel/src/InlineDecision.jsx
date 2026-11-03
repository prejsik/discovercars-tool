import React,{useEffect,useState} from 'react';
import {knownGroups} from './policy.mjs';
import {DecisionEvidence} from './PricesView.jsx';
import {money} from './market-model.mjs';

export function InlineDecision({row,data,model,workspace,service,onRules,lockedSelection=false}) {
  const groups=knownGroups(model);const [group,setGroup]=useState(row.excelSelection?.group??(groups.includes('CDMV')?'CDMV':groups[0]));
  const zones=data.locations.find(item=>item.scraper_label===row.location)?.zones??[];
  const [chosen,setChosen]=useState(row.excelSelection?.zone??'');const zone=zones.includes(chosen)?chosen:zones[0];
  const [state,setState]=useState({});const [attempt,setAttempt]=useState(0);
  const excel=workspace?.status?.excel;
  const key=JSON.stringify([zone,group,row.date,row.duration,row.transmission,data.report.runId,excel?.runId,excel?.files]);
  useEffect(()=>{let active=true;setState({key,busy:true});if(!excel||!zone||!group){setState({key,error:'Brak poprawnego Excela lub powiązania lokalizacji.'});return;}
    const cached=row.excelEvidence;
    if(cached&&row.excelSelection?.zone===zone&&row.excelSelection?.group===group&&cached.report.runId===data.report.runId&&cached.excel.runId===excel.runId&&JSON.stringify(cached.excel.files)===JSON.stringify(excel.files)){
      setState({key,data:cached});return;
    }
    service.prices({zone,group,duration:row.duration,transmission:row.transmission,reportRunId:data.report.runId,excelRunId:excel.runId}).then(result=>{if(active)setState({key,data:result});}).catch(error=>{if(active)setState({key,error:error.message});});return()=>{active=false;};
  },[key,attempt,service]);
  const current=state.key===key?state:{};const record=current.data?.rows.find(item=>item.date===row.date);
  return <section className="inline-decision"><h3>Dlaczego taka stawka w Excelu?</h3>
    {!lockedSelection&&<label>Klasa w Excelu<select value={group} onChange={e=>setGroup(e.target.value)}>{groups.map(g=><option key={g}>{g}</option>)}</select></label>}
    {!lockedSelection&&zones.length>1&&<label>Kod w Excelu<select value={zone} onChange={e=>setChosen(e.target.value)}>{zones.map(z=><option key={z}>{z}</option>)}</select></label>}
    <p className="evidence-note">Cena MM powyżej dotyczy najtańszej oferty MM, niekoniecznie wybranej klasy.</p>
    {current.busy&&<p role="status">Odczytywanie zapisu z Excela…</p>}
    {current.error&&<div role="alert">{current.error}<button className="button" onClick={()=>setAttempt(n=>n+1)}>Ponów</button></div>}
    {current.data&&<>{current.data.report.runId!==current.data.excel.runId&&<p className="alert">Raport i Excel pochodzą z różnych uruchomień. Ten zapis nie wyjaśnia aktualnych cen rynku.</p>}{current.data.warnings?.map((warning,i)=><p className="alert" key={i}>{warning}</p>)}{record?<><dl className="source-list inline-rates"><div><dt>Baza · PLN/dobę</dt><dd>{money(record.baseline)}</dd></div><div><dt>Do importu · PLN/dobę</dt><dd>{money(record.importRate)}</dd></div></dl><DecisionEvidence compact row={record} data={current.data} duration={row.duration}/></>:<p>Brak zapisu dla tej daty i klasy. Nie odtwarzamy decyzji z dzisiejszych reguł.</p>}</>}
    {zone&&group&&onRules&&<button className="button" onClick={()=>onRules({zone,group,pickupDate:row.date,duration:row.duration})}>Zobacz aktualne reguły</button>}
  </section>;
}
