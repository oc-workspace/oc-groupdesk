import {z} from 'zod';
import {conversationDefaults} from '../shared/conversation.js';
export const conversationPolicySchema=z.object({enabled:z.boolean(),banter_replies:z.boolean(),frequency:z.enum(['low','normal','high']),instructions:z.string().trim().max(1500)}).strict().default(conversationDefaults);
