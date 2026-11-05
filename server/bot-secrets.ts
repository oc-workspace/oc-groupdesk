import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {requireCondition} from './security.js';
function controlKey(){const k=process.env.MODEL_ENCRYPTION_KEY||'';requireCondition(/^[a-f0-9]{64}$/i.test(k),503,'控制面密钥尚未初始化');return Buffer.from(k,'hex');}
export function sealControlSecret(value:string){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',controlKey(),iv),b=Buffer.concat([c.update(value,'utf8'),c.final()]);return ['v1',iv.toString('base64url'),c.getAuthTag().toString('base64url'),b.toString('base64url')].join('.');}
export function openControlSecret(value:string){const [v,iv,tag,body]=value.split('.');requireCondition(v==='v1'&&!!body,503,'机器人配置密钥不可读');const d=createDecipheriv('aes-256-gcm',controlKey(),Buffer.from(iv,'base64url'));d.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([d.update(Buffer.from(body,'base64url')),d.final()]).toString('utf8');}
