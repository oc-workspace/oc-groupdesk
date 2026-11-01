import type express from 'express';
import {z} from 'zod';
import {digest} from '../security.js';
import {executeInteraction,interactionEventSchema,reserveInteraction,reportInteractionDelivery,type RuntimeAccess} from './service.js';
export function registerInteractionRuntime(app:express.Express,options:{clock?:()=>number;random?:(min:number,max:number)=>number}={}){
 const access=(req:express.Request):RuntimeAccess=>({adapterHash:digest(req.headers.authorization||''),groups:req.runtimeGroups});
 app.post('/api/runtime/interactions/events',async(req,res)=>res.json(await executeInteraction(interactionEventSchema.parse(req.body),access(req),options.clock?.(),options.random)));
 app.post('/api/runtime/interactions/events/:id/reserve',async(req,res)=>{const body=z.object({revision:z.number().int().positive()}).strict().parse(req.body);res.json(await reserveInteraction(z.uuid().parse(req.params.id),body.revision,access(req),options.clock?.()));});
 app.post('/api/runtime/interactions/events/:id/delivery',async(req,res)=>{const body=z.object({status:z.enum(['sent','uncertain','failed'])}).strict().parse(req.body);res.json(await reportInteractionDelivery(z.uuid().parse(req.params.id),body.status,access(req)));});
}
