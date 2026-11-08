import {useCallback,useEffect,useRef,useState} from 'react';
import type {ScopedTransport} from './scoped-api';

// The existing /users endpoint only returns data to a super administrator.
// Refresh on user actions/focus, never on a timer, and discard superseded responses.
export function usePendingUserReviews(enabled:boolean,accountId:string,request:ScopedTransport){
 const [count,setCount]=useState<number|null>(null);
 const generation=useRef(0),controller=useRef<AbortController|null>(null);
 const refresh=useCallback(async()=>{
  if(!enabled)return;
  const current=++generation.current;
  controller.current?.abort();
  const active=new AbortController();controller.current=active;
  try{
   const data=await request('/users','GET',undefined,active.signal);
   if(current===generation.current&&!active.signal.aborted)setCount(data.users.filter((u:{status:string})=>u.status==='pending').length);
  }catch{if(current===generation.current&&!active.signal.aborted)setCount(null);}
 },[enabled,accountId,request]);
 const update=useCallback((value:number)=>{
  if(!enabled)return;
  ++generation.current;controller.current?.abort();
  setCount(value);
 },[enabled,accountId]);
 useEffect(()=>{
  setCount(null);
  if(!enabled)return;
  void refresh();
  const onFocus=()=>{if(document.visibilityState!=='hidden')void refresh();};
  window.addEventListener('focus',onFocus);
  return()=>{window.removeEventListener('focus',onFocus);++generation.current;controller.current?.abort();};
 },[refresh]);
 return {count:enabled?count:null,refresh,update};
}
