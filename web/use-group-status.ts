import {useEffect,useRef,useState} from 'react';
import {mergeStatuses,type GroupStatus} from './group-status';

export function useGroupStatus(groups:readonly GroupStatus[],fetchStatuses:(signal:AbortSignal)=>Promise<GroupStatus[]>){
  const [statuses,setStatuses]=useState(()=>mergeStatuses({},groups));
  const [checking,setChecking]=useState(false),[error,setError]=useState('');
  const fetchRef=useRef(fetchStatuses);
  fetchRef.current=fetchStatuses;
  const refreshRef=useRef<()=>Promise<void>>(async()=>{});
  const remember=(values:readonly GroupStatus[])=>setStatuses(old=>mergeStatuses(old,values));
  useEffect(()=>{remember(groups);},[groups]);
  useEffect(()=>{
    let active=true,busy=false,controller:AbortController|undefined;
    async function refresh(){
      if(!active||busy||document.hidden)return;
      busy=true;setChecking(true);controller=new AbortController();
      const timeout=setTimeout(()=>controller?.abort(),10000);
      try{
        const incoming=await fetchRef.current(controller.signal);
        if(active){setStatuses(old=>mergeStatuses(old,incoming));setError('');}
      }catch{
        if(active)setError('确认状态获取失败，请重试');
      }finally{
        clearTimeout(timeout);busy=false;
        if(active)setChecking(false);
      }
    }
    refreshRef.current=refresh;
    void refresh();
    const interval=setInterval(()=>void refresh(),5000);
    const visible=()=>{if(!document.hidden)void refresh();};
    document.addEventListener('visibilitychange',visible);
    window.addEventListener('focus',visible);
    return ()=>{
      active=false;controller?.abort();clearInterval(interval);
      document.removeEventListener('visibilitychange',visible);
      window.removeEventListener('focus',visible);
    };
  },[]);
  return {statuses,checking,error,remember,refresh:()=>refreshRef.current()};
}
