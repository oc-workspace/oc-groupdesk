import React,{useSyncExternalStore} from 'react';
import {requestActivity} from '../shared/request-activity';
export function Spinner(){return <span className="loading-spinner" aria-hidden="true"/>;}
export function LoadingStatus({label,detail,active=true}:{label:string;detail?:string;active?:boolean}){
 return <div className={'loading-status '+(active?'is-loading':'')} role="status" aria-live="polite" aria-atomic="true">{active&&<Spinner/>}<div><strong>{label}</strong>{detail&&<small>{detail}</small>}</div></div>;
}
export function LoadingButton({loading=false,busyLabel,children,disabled,...props}:React.ButtonHTMLAttributes<HTMLButtonElement>&{loading?:boolean;busyLabel?:string}){
 return <button {...props} disabled={disabled||loading} aria-busy={loading||undefined}>{loading&&<Spinner/>}{loading&&busyLabel?busyLabel:children}</button>;
}
export function NetworkActivity({botId}:{botId:string}){
 const snapshot=useSyncExternalStore(requestActivity.subscribe,requestActivity.getSnapshot,requestActivity.getSnapshot);
 const items=snapshot.filter(item=>!item.botId||item.botId===botId);
 return items.length?<div className="request-activity" role="status" aria-live="polite" aria-atomic="true"><Spinner/><span>{items[0].label}</span>{items.length>1&&<small>共 {items.length} 项</small>}</div>:null;
}
