import {useEffect,useRef,useState} from 'react';
import {ChevronDown,type LucideIcon} from 'lucide-react';
import './sidebar-navigation.css';
import {useWorkspaceNavigation} from './workspace-navigation';

type NavItem={id:string;name:string;icon:LucideIcon};
const sections=[
  {id:'communities',name:'机器人与群',items:['bots','groups','onboarding']},
  {id:'content',name:'内容与人设',items:['topics','knowledge','personas','shared']},
  {id:'engagement',name:'群内互动',items:['interactions','conversation','summaries']},
  {id:'models',name:'模型与用量',items:['keys','models']},
  {id:'management',name:'管理与设置',items:['users','runtime','members','logs','settings']},
];

function NoticeBadge({count}:{count:number}){
 return count>0?<span className="nav-review-badge" title={'有 '+count+' 个注册申请等待审核'} aria-label={count+' 个注册申请等待审核'}>new {count>99?'99+':count}</span>:null;
}
export function SidebarNavigation({items,page,storageKey,groupCount,noticeCounts={},onCheckNotices,onNavigate}:{items:NavItem[];page:string;storageKey:string;groupCount?:number;noticeCounts?:Record<string,number>;onCheckNotices?:()=>void;onNavigate:(page:string)=>boolean}){
  const activeSection=sections.find(section=>section.items.includes(page))?.id;
  const [expanded,setExpanded]=useState<Record<string,boolean>>(()=>{
    let saved:Record<string,boolean>={};
    try{const value=JSON.parse(localStorage.getItem(storageKey)||'{}');if(value&&typeof value==='object'&&!Array.isArray(value))for(const section of sections)if(typeof value[section.id]==='boolean')saved[section.id]=value[section.id];}catch{}
    return {communities:true,...saved,...(activeSection?{[activeSection]:true}:{})};
  });
  const navigation=useWorkspaceNavigation();
  const navRef=useRef<HTMLElement>(null);
  useEffect(()=>{try{localStorage.setItem(storageKey,JSON.stringify(expanded));}catch{}},[expanded,storageKey]);
  useEffect(()=>{if(activeSection)setExpanded(previous=>({...previous,[activeSection]:true}));},[activeSection]);
  useEffect(()=>{if(!navigation?.mobile||navigation.open)navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({block:'nearest'});},[page,navigation?.mobile,navigation?.open]);
  return <div className="sidebar-navigation">
    <nav id="workspace-navigation" aria-label="工作空间导航" ref={navRef}>
      {sections.map(section=>{
        const visible=section.items.map(id=>items.find(item=>item.id===id)).filter((item):item is NavItem=>!!item);
        if(!visible.length)return null;
        const open=expanded[section.id]===true;
        const active=section.id===activeSection;
        const notices=visible.reduce((sum,item)=>sum+(noticeCounts[item.id]||0),0);
        return <section className={'nav-section'+(active?' has-active':'')} key={section.id}>
          <button type="button" className="nav-section-toggle" aria-expanded={open} aria-controls={'nav-section-'+section.id} onClick={()=>{if(!open&&section.items.includes('users'))onCheckNotices?.();setExpanded(previous=>({...previous,[section.id]:!open}));}}><span>{section.name}</span>{!open&&(notices>0?<NoticeBadge count={notices}/>:active&&<small>当前</small>)}<ChevronDown size={15}/></button>
          <div id={'nav-section-'+section.id} hidden={!open}>{visible.map(({id,name,icon:Icon})=><button type="button" key={id} className={'nav-item '+(page===id?'active':'')} aria-current={page===id?'page':undefined} onClick={()=>{if(onNavigate(id))navigation?.close();}}><Icon size={18}/><span>{name}</span><NoticeBadge count={noticeCounts[id]||0}/>{id==='groups'&&groupCount!==undefined&&<small>{groupCount}</small>}</button>)}</div>
        </section>;
      })}
    </nav>
  </div>;
}
