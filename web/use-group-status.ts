import {useEffect,useRef,useState} from 'react';
import {mergeStatuses,clearCheckedRevisions,type GroupStatus} from './group-status';

export function useGroupStatus(groups:readonly GroupStatus[],fetchStatuses:(signal:AbortSignal)=>Promise<GroupStatus[]>){
  const [statuses,setStatuses]=useState(()=>mergeStatuses({},groups));
  const [checking,setChecking]=useState(false),[error,setError]=useState('');
  const [required,setRequired]=useState<Record<string,number>>({});
  const fetchRef=useRef(fetchStatuses);fetchRef.current=fetchStatuses;
  const refreshRef=useRef<()=>Promise<void>>(async()=>{});
  const remember=(values:readonly GroupStatus[])=>setStatuses(old=>mergeStatuses(old,values));
  const markChanged=(id:string,revision:number)=>setRequired(old=>({...old,[id]:Math.max(old[id]||0,revision)}));
  useEffect(()=>{remember(groups);},[groups]);
  useEffect(()=>{
    let active=true,busy=false,controller:AbortController|undefined;
    async function refresh(){
      if(!active||busy)return;
      busy=true;setChecking(true);setError('');controller=new AbortController();
      const timeout=setTimeout(()=>controller?.abort(),10000);
      try{
        const incoming=await fetchRef.current(controller.signal);
        if(active){setStatuses(old=>mergeStatuses(old,incoming));setRequired(old=>clearCheckedRevisions(old,incoming));}
      }catch{
        if(active)setError('确认状态获取失败，请手动重试');
      }finally{
        clearTimeout(timeout);busy=false;if(active)setChecking(false);
      }
    }
    refreshRef.current=refresh;
    return ()=>{active=false;controller?.abort();};
  },[]);
  return {statuses,checking,error,required,remember,markChanged,refresh:()=>refreshRef.current()};
}
