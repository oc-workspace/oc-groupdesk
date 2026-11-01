import {z} from 'zod';
import {timeoutLimits,timeoutPolicyIssue} from '../shared/timeout-policy.js';
export const timeoutPolicySchema=z.object({
 planner_seconds:z.number().int().min(timeoutLimits.planner_seconds[0]).max(timeoutLimits.planner_seconds[1]),
 request_seconds:z.number().int().min(timeoutLimits.request_seconds[0]).max(timeoutLimits.request_seconds[1]),
 direct_ttl_seconds:z.number().int().min(timeoutLimits.direct_ttl_seconds[0]).max(timeoutLimits.direct_ttl_seconds[1])
}).strict().superRefine((value,ctx)=>{const message=timeoutPolicyIssue(value);if(message)ctx.addIssue({code:'custom',message});});
