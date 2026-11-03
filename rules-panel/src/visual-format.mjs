export function signedPrice(value,digits=2){
 if(!Number.isFinite(value))return '?';
 return (value>0?'+':value<0?'−':'')+Math.abs(value).toLocaleString('pl-PL',{minimumFractionDigits:digits,maximumFractionDigits:digits});
}
export function weekdayDate(value,short=false){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value??''))return 'Brak daty';
 const date=new Date(value+'T12:00:00Z');
 return ['nd','pn','wt','śr','cz','pt','sb'][date.getUTCDay()]+' '+value.slice(8)+'.'+value.slice(5,7)+(short?'':'.'+value.slice(0,4));
}
export const monthLabel=value=>new Intl.DateTimeFormat('pl-PL',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(value+'-01T12:00:00Z'));
export const isWeekend=value=>[0,6].includes(new Date(value+'T12:00:00Z').getUTCDay());
