import {AsyncLocalStorage} from 'node:async_hooks';
import type {SessionUser} from '../shared/user-permissions.js';
export const userStorage=new AsyncLocalStorage<SessionUser>();
export const currentUserId=()=>userStorage.getStore()?.id||null;
