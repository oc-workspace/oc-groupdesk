import {z} from 'zod';
import {conversationDefaults,replyLimitsDefaults} from '../shared/conversation.js';
export const replyLimitsSchema=z.object({enabled:z.boolean(),max_rounds:z.number().int().min(1).max(20),reset_seconds:z.number().int().min(30).max(1800),followup_seconds:z.number().int().min(30).max(1800)}).strict().default(replyLimitsDefaults);
export const conversationPolicySchema=z.object({enabled:z.boolean(),banter_replies:z.boolean(),frequency:z.enum(['low','normal','high']),instructions:z.string().trim().max(1500),reply_limits:replyLimitsSchema}).strict().default(conversationDefaults);
