import React from 'react';
export function ViewTabs({items,value,onChange,label}){
 return <div className="view-tabs" role="tablist" aria-label={label}>{items.map(([id,text,Icon],index)=><button key={id} type="button" role="tab" aria-selected={value===id} tabIndex={value===id?0:-1} onClick={()=>onChange(id)} onKeyDown={e=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
  e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowRight'?1:-1)+items.length)%items.length;
  onChange(items[next][0]);e.currentTarget.parentElement.children[next].focus();
 }}>{Icon&&<Icon size={16}/>} {text}</button>)}</div>;
}
