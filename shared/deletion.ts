import {z} from 'zod';
export const deletionReasons={test:'测试号',violation:'违规',duplicate:'重复登记',inactive:'不再使用',other:'其他'} as const;
export const deletionReason=z.object({reason:z.enum(['test','violation','duplicate','inactive','other']),reason_note:z.string().trim().max(500).default('')}).refine(v=>v.reason!=='other'||v.reason_note.length>0,{message:'选择其他时请补充原因',path:['reason_note']});
export type DeletionReason=z.infer<typeof deletionReason>;
export const reasonFields={reason:z.enum(['test','violation','duplicate','inactive','other']),reason_note:z.string().trim().max(500).default('')};
export const reasonDetails=(v:DeletionReason)=>({reason:v.reason,reason_label:deletionReasons[v.reason],reason_note:v.reason_note});
