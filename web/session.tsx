import {createContext,useContext} from 'react';
import {allowed,type SessionUser,type Permission} from '../shared/user-permissions';
export const SessionContext=createContext<SessionUser|null>(null);
export const useSession=()=>useContext(SessionContext);
export const usePermission=(p:Permission)=>{const u=useSession();return !!u&&allowed(u,p);};
