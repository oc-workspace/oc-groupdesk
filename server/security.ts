import {randomBytes,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
export const token=()=>randomBytes(32).toString('base64url');
export const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export function passwordHash(password:string){
  const salt=randomBytes(16).toString('hex');
  return salt+':'+scryptSync(password,salt,64).toString('hex');
}
export function passwordValid(password:string,encoded:string){
  const [salt,hash]=encoded.split(':');
  if(!salt||!hash||hash.length!==128)return false;
  return timingSafeEqual(scryptSync(password,salt,64),Buffer.from(hash,'hex'));
}
export function secureEqual(a:string,b:string){
  return timingSafeEqual(Buffer.from(digest(a)),Buffer.from(digest(b)));
}
export class HttpError extends Error {
  constructor(public status:number,message:string){super(message);}
}
export function requireCondition(condition:unknown,status:number,message:string):asserts condition {
  if(!condition)throw new HttpError(status,message);
}
