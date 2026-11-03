export const MATRIX_BANDS=[[2,2],[3,4],[5,7],[8,20]];
export const bandLabel=([low,high])=>low===high?String(low):`${low}–${high}`;
export function buildBandMatrix(dates,rows,durations) {
  return dates.map(date=>({date,cells:MATRIX_BANDS.map(band=>{
    const expected=durations.filter(d=>d>=band[0]&&d<=Math.min(14,band[1]));
    const items=rows.filter(r=>r.date===date&&expected.includes(r.duration)).sort((a,b)=>a.duration-b.duration);
    const valid=items.filter(r=>r.marketConfirmed);
    const gaps=valid.map(r=>r.gap).filter(Number.isFinite);
    return {band,expected,rows:items,missingMM:valid.filter(r=>r.mm===null).length,
      unavailable:expected.filter(d=>!valid.some(r=>r.duration===d)).length,
      worstGap:gaps.length?Math.min(...gaps):null};
  })}));
}
export function bandEvidence(data,duration) {
  const band=MATRIX_BANDS.find(([lo,hi])=>duration>=lo&&duration<=hi);
  const found=data?.bands?.find(item=>item.duration===band?.[0]);
  return found?{...data,rows:found.rows}:null;
}
