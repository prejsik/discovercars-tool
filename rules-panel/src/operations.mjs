export const dayLabel=value=>/^\d{4}-\d{2}-\d{2}$/.test(value??'')?value.split('-').reverse().join('.'):value??'Brak danych';
export function locationLabel(value) {
  return String(value??'').replace('Galeria Krakowska Shopping Mall','Kraków · Galeria Krakowska').replace('Szczecin Goleniow Airport (SZZ)','Szczecin · Lotnisko (SZZ)').replace('Warsaw Chopin Airport (WAW)','Warszawa · Lotnisko Chopina (WAW)').replace('Lodz Lublinek Airport (LCJ)','Łódź · Lotnisko (LCJ)').replace(/\b(Gdansk|Krakow|Lodz|Poznan|Torun|Warsaw|Wroclaw)\b/g,x=>({Gdansk:'Gdańsk',Krakow:'Kraków',Lodz:'Łódź',Poznan:'Poznań',Torun:'Toruń',Warsaw:'Warszawa',Wroclaw:'Wrocław'}[x])).replace('West Train Station','· Dworzec Zachodni').replace('Train Station','· Dworzec kolejowy').replace('Downtown','· Miasto').replace('Airport','· Lotnisko');
}
export function branchOverview(rows) {
  const groups=new Map();
  for(const row of rows){if(!groups.has(row.location))groups.set(row.location,[]);groups.get(row.location).push(row);}
  return [...groups].map(([location,items])=>{
    const confirmed=items.filter(r=>r.marketConfirmed);
    const comparable=confirmed.filter(r=>Number.isFinite(r.mm)&&Number.isFinite(r.competitor));
    const missingDates=new Set(confirmed.filter(r=>r.mm===null).map(r=>r.date)).size;
    const over=comparable.filter(r=>r.gap < -10).length;
    return {location,items,missingDates,over,comparable:comparable.length,share:comparable.length?over/comparable.length:null,unavailable:items.length-confirmed.length};
  }).sort((a,b)=>b.unavailable-a.unavailable||b.missingDates-a.missingDates||(b.share??-1)-(a.share??-1)||a.location.localeCompare(b.location));
}
export function countLabel(value,one,few,many) {
 const n=Math.abs(value);return `${value.toLocaleString('pl-PL')} ${n===1?one:n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?few:many}`;
}

