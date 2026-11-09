import React,{useEffect,useRef,type ReactNode} from 'react';
import {ChevronDown} from 'lucide-react';
import './settings-section.css';

type Props={title:string;description?:string;children:ReactNode;defaultOpen?:boolean;issue?:string|null;className?:string};

// Keep fields mounted so collapsing never discards an in-progress edit.
export function SettingsSection({title,description,children,defaultOpen=false,issue,className=''}:Props){
 const detail=useRef<HTMLDetailsElement>(null),initialOpen=useRef(defaultOpen);
 useEffect(()=>{if(issue&&detail.current)detail.current.open=true;},[issue]);
 return <details ref={detail} open={initialOpen.current} className={'settings-section '+className} onInvalidCapture={()=>{if(detail.current)detail.current.open=true;}}>
  <summary>
   <span className="settings-section-heading"><span className="settings-section-title">{title}</span>{description&&<span className="settings-section-description">{description}</span>}{issue&&<span className="settings-section-issue" role="alert">{issue}</span>}</span>
   <span className="settings-section-toggle" aria-hidden="true"><span className="settings-section-expand">展开</span><span className="settings-section-collapse">收起</span><ChevronDown size={16}/></span>
  </summary>
  <div className="settings-section-content">{children}</div>
 </details>;
}
