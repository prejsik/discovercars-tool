import {dayLabel} from './operations.mjs';
import React,{useEffect,useRef} from 'react';
import { Check,X } from 'lucide-react';
import { knownGroups } from './policy.mjs';
import { amountChange,ruleDifferences,ruleScope,sameConfirmation } from './change-review.mjs';
import { money } from './market-model.mjs';

export const publishLabel=count=>`Opublikuj ${count} ${count===1?'zmianę':count%10>=2&&count%10<=4&&(count%100<12||count%100>14)?'zmiany':'zmian'}`;
export function ChangeTable({model,original,confirmations=[]}) {
  const rows=ruleDifferences(model,original);
  const groups=knownGroups(original).filter(group=>original.excel.apply_groups.includes(group)!==model.excel.apply_groups.includes(group));
  const summary=row=>!row?'Brak reguły':row.amount==null?`${row.startDate?dayLabel(row.startDate):'Bez początku'} – ${row.endDate?dayLabel(row.endDate):'bez końca'}`:`${money(row.amount)} PLN`;
  return <table className="change-review-table"><caption>Co się zmieni</caption><thead><tr><th>Reguła i zakres</th><th>Obecnie</th><th>Szkic</th><th>Zmiana</th><th>Status</th></tr></thead><tbody>{rows.map(({before,after})=>{
    const row=after??before;const delta=amountChange(before?.amount,after?.amount);const ack=delta?.large&&confirmations.some(item=>sameConfirmation(item,{ruleId:row.id,before:delta.before,after:delta.after}));
    return <tr key={`${after?'after':'before'}:${row.id}`} className={delta?.large?'large-change':''}><th scope="row" data-label="Reguła i zakres">{row.title}<small>{ruleScope(model,row)}</small><small>{row.groups.includes('*')?'Wszystkie klasy':row.groups.join(', ')}{row.zones.includes('*')?'':` · ${row.zones.join(', ')}`}</small><small>{row.startDate||row.endDate?`${row.startDate||'Bez początku'} – ${row.endDate||'bez końca'}`:'Bezterminowo'}</small></th><td data-label="Obecnie">{summary(before)}</td><td data-label="Szkic"><strong>{summary(after)}</strong></td><td data-label="Zmiana">{delta?`${delta.delta>0?'+':''}${money(delta.delta)} PLN · ${delta.percent>0?'+':''}${delta.percent.toLocaleString('pl-PL',{maximumFractionDigits:2})}%${delta.large?` · ×${delta.factor.toLocaleString('pl-PL',{maximumFractionDigits:2})}`:''}`:!before?'Nowa reguła':!after?'Usunięcie reguły':'Zmiana zakresu'}</td><td data-label="Status">{delta?.large?<span className="badge amber">Duża zmiana · {ack?'potwierdzona':'brak potwierdzenia'}</span>:<span className="badge">{!before?'Nowa reguła':!after?'Usunięcie':'W normie'}</span>}</td></tr>;
  })}{groups.map(group=><tr key={group}><th scope="row" data-label="Reguła i zakres">Klasa {group}</th><td data-label="Obecnie">{original.excel.apply_groups.includes(group)?'Rekomendacje włączone':'Rekomendacje wyłączone'}</td><td data-label="Szkic">{model.excel.apply_groups.includes(group)?'Rekomendacje włączone':'Rekomendacje wyłączone'}</td><td data-label="Zmiana">Zmiana dopuszczenia klasy</td><td data-label="Status">W normie</td></tr>)}</tbody></table>;
}
export function PublicationDialog({model,original,confirmations,count,busy,error,onClose,onConfirm}) {
  const dialog=useRef(null);const title=useRef(null);
  useEffect(()=>{const previous=document.activeElement;dialog.current.showModal();title.current.focus();return()=>{dialog.current?.close();previous?.focus();};},[]);
  return <dialog ref={dialog} className="publication-dialog editor-dialog" aria-labelledby="publication-title" onCancel={e=>{e.preventDefault();if(!busy)onClose();}}>
    <header className="dialog-header"><h2 ref={title} tabIndex={-1} id="publication-title">{publishLabel(count).replace('Opublikuj','Opublikować')}?</h2><button className="icon-button" aria-label="Zamknij potwierdzenie publikacji" disabled={busy} onClick={onClose}><X size={20}/></button></header>
    <div className="dialog-body"><ChangeTable model={model} original={original} confirmations={confirmations}/><p>Zapis do GitHub main. Zasady dotyczą uruchomień rozpoczętych po publikacji. Nie zmieni to już trwającego przebiegu ani nie zaimportuje stawek do DiscoverCars.</p>{error&&<p className="alert error" role="alert">{error}</p>}</div>
    <footer className="dialog-footer"><button className="button" disabled={busy} onClick={onClose}>Wróć do szkicu</button><button className="button primary" disabled={busy} onClick={onConfirm}><Check size={17}/>{busy?'Publikowanie…':'Opublikuj'}</button></footer>
  </dialog>;
}
