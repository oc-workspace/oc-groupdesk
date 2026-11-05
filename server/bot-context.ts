import {AsyncLocalStorage} from 'node:async_hooks';
import {resolve} from 'node:path';
import type pg from 'pg';
export const legacyBotId='00000000-0000-4000-8000-000000000001';
export type BotScope={id:string;pool:pg.Pool;dataDirectory:string;modelKey:string};
export const botStorage=new AsyncLocalStorage<BotScope>();
export const dataDirectory=()=>botStorage.getStore()?.dataDirectory||resolve(process.env.DATA_DIR||'data');
export const modelMasterKey=()=>botStorage.getStore()?.modelKey||process.env.MODEL_ENCRYPTION_KEY||'';
