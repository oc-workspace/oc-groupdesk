import type {TopicDraft} from '../server/topic-drafting.js';
export const foodDraft:TopicDraft={name:'美食交流',description:'讨论菜系、做法、餐厅与饮食体验。',instructions:'先接住具体问题，必要时追问口味、预算和食材；普通接话简短，实质问题给做法与取舍，不编造价格或安排。',color:'amber',policy:{schema_version:1,
 lexicons:{'zh-CN':['美食','火锅','寿司'],en:['cuisine','hot pot']},combinations:[{name:'食物与口味',all:[['dish','soup','菜','汤'],['tasty','delicious','鲜','好喝']]}],
 exclusions:['food for thought','心灵鸡汤','字母汤'],continuations:['听起来不错','有机会去试试'],continuation_exclusions:['bus fare','修电脑'],exit_terms:['换个话题','back to work'],hard_exit_terms:['不聊美食'],
 context:{enabled:true,seconds:180,max_intervening_messages:3,anchor_chars:400},reply_depth:'detailed'}};
