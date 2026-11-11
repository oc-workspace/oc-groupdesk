import {hermesStats} from './hermes-format.js';

export function sourceStats(messages:any[]){
 return {
  count:messages.length,
  capture_time_count:messages.filter(m=>m.time_kind==='capture').length,
  unknown_sender_count:messages.filter(m=>!m.sender).length,
  ...hermesStats(messages)
 };
}
