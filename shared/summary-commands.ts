export const summaryCommandTexts=['/generate-summary','/generate-summary focus','/generate-summary today','/generate-summary today focus','/generate-summary 截止目前'] as const;
export type SummaryCommandText=typeof summaryCommandTexts[number];
export type SummaryCommandMode='previous_day'|'today'|'previous_day_focus'|'today_focus'|'legacy_today';

export function summaryCommandMode(text:SummaryCommandText):SummaryCommandMode{
 switch(text){
  case '/generate-summary':return 'previous_day';
  case '/generate-summary focus':return 'previous_day_focus';
  case '/generate-summary today':return 'today';
  case '/generate-summary today focus':return 'today_focus';
  case '/generate-summary 截止目前':return 'legacy_today';
 }
}
export function summaryCommandText(mode:SummaryCommandMode):string{
 switch(mode){
  case 'previous_day':return '/generate-summary';
  case 'previous_day_focus':return '/generate-summary focus';
  case 'today':return '/generate-summary today';
  case 'today_focus':return '/generate-summary today focus';
  case 'legacy_today':return '/generate-summary 截止目前';
 }
}
export function focusedSummary(mode:string|null|undefined){return mode==='previous_day_focus'||mode==='today_focus';}
export function summaryWindowKind(mode:SummaryCommandMode){return mode==='today'||mode==='today_focus'||mode==='legacy_today'?'today':'previous_day';}
