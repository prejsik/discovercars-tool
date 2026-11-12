import { useCallback,useEffect,useRef,useState } from 'react';

export function useMarketReport(service,report,enabled) {
  const key=JSON.stringify([report?.runId,report?.reportSha256]);const current=useRef(key);current.current=key;
  const pending=useRef(null);const attempted=useRef(null);
  const [state,setState]=useState({key,data:null,busy:false,error:''});
  const load=useCallback(async()=>{
    if(!report?.runId)return;
    setState(old=>({...old,key,busy:true,error:'',data:old.key===key?old.data:null}));
    if(pending.current?.key!==key){
      pending.current?.controller.abort();const controller=new AbortController();
      pending.current={key,controller,promise:service.market({reportRunId:report.runId},{signal:controller.signal})};
    }
    const job=pending.current;
    try {
      const data=await job.promise;
      if(current.current===key&&!job.controller.signal.aborted)setState({key,data,busy:false,error:''});
    }catch(error){if(current.current===key&&!job.controller.signal.aborted)setState(old=>({...old,key,busy:false,error:error.message}));}
    finally{if(pending.current===job)pending.current=null;}
  },[key,service,report?.runId]);
  useEffect(()=>{
    if(enabled&&report?.runId&&attempted.current!==key){attempted.current=key;void load();}
    return()=>{if(pending.current?.key===key){pending.current.controller.abort();pending.current=null;attempted.current=null;}};
  },[key,enabled,load,report?.runId]);
  return {...(state.key===key?state:{data:null,busy:false,error:''}),load};
}
