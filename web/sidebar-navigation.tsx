import {useEffect,useRef,useState} from 'react';
import {ChevronDown,Menu,type LucideIcon} from 'lucide-react';
import './sidebar-navigation.css';

type NavItem={id:string;name:string;icon:LucideIcon};
const sections=[
  {id:'communities',name:'机器人与群',items:['bots','groups','onboarding']},
  {id:'content',name:'内容与人设',items:['topics','knowledge','personas','shared']},
  {id:'engagement',name:'群内互动',items:['interactions','conversation','summaries']},
  {id:'models',name:'模型与用量',items:['keys','models']},
  {id:'management',name:'管理与设置',items:['users','runtime','members','logs','settings']},
];

export function SidebarNavigation({items,page,storageKey,groupCount,onNavigate}:{items:NavItem[];page:string;storageKey:string;groupCount?:number;onNavigate:(page:string)=>boolean}){
  const activeSection=sections.find(section=>section.items.includes(page))?.id;
  const [expanded,setExpanded]=useState<Record<string,boolean>>(()=>{
    let saved:Record<string,boolean>={};
    try{const value=JSON.parse(localStorage.getItem(storageKey)||'{}');if(value&&typeof value==='object'&&!Array.isArray(value))for(const section of sections)if(typeof value[section.id]==='boolean')saved[section.id]=value[section.id];}catch{}
    return {communities:true,...saved,...(activeSection?{[activeSection]:true}:{})};
  });
  const [mobileOpen,setMobileOpen]=useState(false);
  const current=items.find(item=>item.id===page);
  const navRef=useRef<HTMLElement>(null);
  useEffect(()=>{try{localStorage.setItem(storageKey,JSON.stringify(expanded));}catch{}},[expanded,storageKey]);
  useEffect(()=>{if(activeSection)setExpanded(previous=>({...previous,[activeSection]:true}));},[activeSection]);
  useEffect(()=>{navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({block:'nearest'});},[page,mobileOpen]);
  return <div className={'sidebar-navigation'+(mobileOpen?' mobile-open':'')}>
    <button type="button" className="mobile-nav-toggle" aria-expanded={mobileOpen} aria-controls="workspace-navigation" onClick={()=>setMobileOpen(open=>!open)}><Menu size={17}/><span>功能菜单 · {current?.name||'工作空间'}</span><ChevronDown size={16}/></button>
    <nav id="workspace-navigation" aria-label="工作空间导航" ref={navRef}>
      {sections.map(section=>{
        const visible=section.items.map(id=>items.find(item=>item.id===id)).filter((item):item is NavItem=>!!item);
        if(!visible.length)return null;
        const open=expanded[section.id]===true;
        const active=section.id===activeSection;
        return <section className={'nav-section'+(active?' has-active':'')} key={section.id}>
          <button type="button" className="nav-section-toggle" aria-expanded={open} aria-controls={'nav-section-'+section.id} onClick={()=>setExpanded(previous=>({...previous,[section.id]:!open}))}><span>{section.name}</span>{!open&&active&&<small>当前</small>}<ChevronDown size={15}/></button>
          <div id={'nav-section-'+section.id} hidden={!open}>{visible.map(({id,name,icon:Icon})=><button type="button" key={id} className={'nav-item '+(page===id?'active':'')} aria-current={page===id?'page':undefined} onClick={()=>{if(onNavigate(id))setMobileOpen(false);}}><Icon size={18}/><span>{name}</span>{id==='groups'&&groupCount!==undefined&&<small>{groupCount}</small>}</button>)}</div>
        </section>;
      })}
    </nav>
  </div>;
}
