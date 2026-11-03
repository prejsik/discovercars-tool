import React from 'react';
import {priceTone} from './market-model.mjs';
import {signedPrice} from './visual-format.mjs';
import {gapLabel} from './market-review.mjs';
export function PriceBadge({gap,missing=false,unavailable=false,digits=2}){
 const tone=missing?'missing':unavailable?'nodata':priceTone(Number.isFinite(gap)?-gap:null);
 return <span className={'price-badge tone-'+tone} title={missing?'Brak oferty MM':unavailable?'Brak potwierdzonych danych':gapLabel(gap)}>{missing?'brak MM':unavailable?'?':signedPrice(Number.isFinite(gap)?-gap:null,digits)}</span>;
}
