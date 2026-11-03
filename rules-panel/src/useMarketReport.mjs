import { useCallback,useEffect,useRef,useState } from 'react';

export function useMarketReport(service,report,enabled) {
  const key=JSON.stringify([report?.runId,report?.reportSha256]);const current=useRef(key);current.current=key;
  const pending=useRef(null);const attempted=useRef(null);
  const [state,setState]=useState({key,data:null,busy:false,error:''});
  const load=useCallback(async()=>{
    if(!report?.runId)return;
    setState(old=>({...old,key,busy:true,error:'',data:old.key===key?old.data:null}));
    try {
      if(pending.current?.key!==key){const promise=service.market({reportRunId:report.runId});pending.current={key,promise};promise.finally(()=>{if(pending.current?.promise===promise)pending.current=null;}).catch(()=>{});}
      const data=await pending.current.promise;
      if(current.current===key)setState({key,data,busy:false,error:''});
    }catch(error){if(current.current===key)setState(old=>({...old,key,busy:false,error:error.message}));}
  },[key,service,report?.runId]);
  useEffect(()=>{if(enabled&&report?.runId&&attempted.current!==key){attempted.current=key;void load();}},[key,enabled,load,report?.runId]);
  return {...(state.key===key?state:{data:null,busy:false,error:''}),load};
}
