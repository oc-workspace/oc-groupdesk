import {createContext,useCallback,useContext,useEffect,useRef,useState,type ReactNode,type RefObject} from 'react';
import {Menu,X} from 'lucide-react';
import './workspace-navigation.css';

const mobileQuery='(max-width: 680px)';
const NavigationContext=createContext<{mobile:boolean;open:boolean;close:()=>void;toggle:()=>void;buttonRef:RefObject<HTMLButtonElement|null>;noticeCount:number}|null>(null);
export function useWorkspaceNavigation(){return useContext(NavigationContext);}

export function MobileNavigationButton(){
 const navigation=useWorkspaceNavigation();
 if(!navigation)return null;
 return <button ref={navigation.buttonRef} type="button" className="mobile-navigation-button" aria-label="打开全站菜单" aria-expanded={navigation.open} aria-controls="workspace-sidebar" onClick={navigation.toggle}>
  <Menu size={22}/>{navigation.noticeCount>0&&<span className="mobile-navigation-notice" aria-label={navigation.noticeCount+' 个注册申请等待审核'}>{navigation.noticeCount>99?'99+':navigation.noticeCount}</span>}
 </button>;
}

export function WorkspaceNavigation({sidebar,children,page,noticeCount=0,onOpen}:{sidebar:ReactNode;children:ReactNode;page:string;noticeCount?:number;onOpen?:()=>void}){
 const [mobile,setMobile]=useState(()=>window.matchMedia(mobileQuery).matches),[open,setOpen]=useState(false);
 const asideRef=useRef<HTMLElement>(null),buttonRef=useRef<HTMLButtonElement>(null),closeRef=useRef<HTMLButtonElement>(null);
 const close=useCallback(()=>setOpen(false),[]);
 useEffect(()=>{
  const media=window.matchMedia(mobileQuery),changed=()=>{setMobile(media.matches);setOpen(false);};
  media.addEventListener('change',changed);return()=>media.removeEventListener('change',changed);
 },[]);
 useEffect(close,[page,close]);
 useEffect(()=>{
  if(!mobile||!open)return;
  const previousOverflow=document.body.style.overflow,previousOverscroll=document.body.style.overscrollBehavior;
  document.body.style.overflow='hidden';document.body.style.overscrollBehavior='none';
  const focusFrame=requestAnimationFrame(()=>closeRef.current?.focus({preventScroll:true}));
  const handleKey=(event:KeyboardEvent)=>{
   if(event.key==='Escape'){event.preventDefault();close();return;}
   if(event.key!=='Tab')return;
   const elements=Array.from(asideRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],select:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]')||[]).filter(element=>element.getClientRects().length>0&&!element.closest('[hidden],[inert]'));
   const first=elements[0],last=elements.at(-1);if(!first)return;
   if(event.shiftKey&&(document.activeElement===first||!asideRef.current?.contains(document.activeElement))){event.preventDefault();last?.focus();}
   else if(!event.shiftKey&&(document.activeElement===last||!asideRef.current?.contains(document.activeElement))){event.preventDefault();first.focus();}
  };
  document.addEventListener('keydown',handleKey);
  return()=>{
   cancelAnimationFrame(focusFrame);
   document.body.style.overflow=previousOverflow;document.body.style.overscrollBehavior=previousOverscroll;
   document.removeEventListener('keydown',handleKey);
   if(window.matchMedia(mobileQuery).matches&&buttonRef.current?.isConnected)buttonRef.current.focus({preventScroll:true});
  };
 },[mobile,open,close]);
 const toggle=()=>{if(!open)onOpen?.();setOpen(previous=>!previous);};
 return <NavigationContext.Provider value={{mobile,open,close,toggle,buttonRef,noticeCount}}>
  <div className="app-shell">
   {mobile&&open&&<button type="button" className="workspace-navigation-backdrop" aria-label="关闭全站菜单遮罩" tabIndex={-1} onClick={close}/>}
   <aside id="workspace-sidebar" className={'sidebar'+(mobile&&open?' drawer-open':'')} ref={asideRef} role={mobile&&open?'dialog':undefined} aria-modal={mobile&&open?true:undefined} aria-label="全站菜单" aria-hidden={mobile&&!open?true:undefined} inert={mobile&&!open}>
    <div className="mobile-drawer-heading"><strong>全站菜单</strong><button ref={closeRef} type="button" className="mobile-drawer-close" aria-label="关闭全站菜单" onClick={close}><X size={21}/></button></div>
    {sidebar}
   </aside>
   <div className="workspace-navigation-content" inert={mobile&&open}>{children}</div>
  </div>
 </NavigationContext.Provider>;
}
