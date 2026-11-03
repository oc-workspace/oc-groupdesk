"""Per-topic, single-message character budgets for admitted group turns."""
import json
import re
import unicodedata

MINIMUM=100
MAXIMUM=4000
MARKER='[GT_REPLY_LENGTH]'

def validate_bundle(bundle):
    version=bundle.get('topic_reply_length_contract_version')
    if version not in (None,1):raise ValueError('Unknown topic reply length contract')
    for topic in bundle.get('topics',[]):
        value=topic.get('policy',{}).get('max_reply_chars')
        if value is None:continue
        if version!=1 or type(value) is not int or not MINIMUM<=value<=MAXIMUM:
            raise ValueError('Invalid topic reply character limit')

def for_turn(config,turn):
    import groupdesk_runtime as gd
    turn=dict(turn)
    base=2000 if turn.get('article') else config['output_chars']
    managed=gd.profile(config,turn.get('chat_id',''))
    names=json.loads(turn.get('managed_topics') or '[]')
    if not isinstance(names,list) or any(not isinstance(v,str) for v in names):raise ValueError('Invalid admitted topic list')
    configured=[]
    for topic in (managed or {}).get('topics',[]):
        if topic['name'] not in names:continue
        value=topic.get('policy',{}).get('max_reply_chars')
        if value is None:continue
        if type(value) is not int or not MINIMUM<=value<=MAXIMUM:raise ValueError('Invalid topic reply character limit')
        configured.append((topic['name'],value))
    return (max(v for _,v in configured),[name for name,_ in configured]) if configured else (base,[])

def shorten(text,limit):
    """Prefer complete sentences; never slice through a Latin word or URL."""
    if len(text)<=limit:return text
    if limit<1:return ''
    head=text[:limit-1]
    for match in re.finditer(r'https?://\S+',text):
        if match.start()<len(head)<match.end():head=head[:match.start()];break
    # Do not publish a partial fenced block as if it were complete code.
    if head.count('```')%2:head=head[:head.rfind('```')]
    ends=list(re.finditer(r'[。！？]|[.!?](?=\s|$)|\n',head))
    if ends and ends[-1].end()>=max(20,int(limit*.55)):
        return head[:ends[-1].end()].rstrip()
    if head and len(head)<len(text) and re.match(r'[A-Za-z0-9_]',text[len(head)]) and re.search(r'[A-Za-z0-9_]$',head):
        head=re.sub(r'[A-Za-z0-9_]+$','',head)
    head=head.rstrip()
    while head and (unicodedata.combining(head[-1]) or head[-1]=='\u200d'):head=head[:-1]
    return head.rstrip()+'…'

def prepare(p,turn_id,text):
    with p.db() as db:turn=db.execute('SELECT * FROM turns WHERE id=?',(turn_id,)).fetchone()
    if not turn:raise ValueError('Unattributed reply length')
    limit,names=for_turn(p.cfg,turn)
    result=shorten(text,limit)
    if result!=text:
        with p.db() as db:p.count(db,'reply_length_shortened')
    return result,limit

def bind(p,request,turn,task):
    if task not in {'planner','replyer'}:return
    from src.llm_models.payload_content.context_item import ContextItemBuilder,RoleType
    limit,names=for_turn(p.cfg,turn)
    text=(MARKER+'【可信单条回复长度】本次最终发到群里的单条文字回复最多'+str(limit)+
          '个Unicode字符，空格、标点和发送层可能添加的等待致歉都计入；这是上限，不是目标长度。'
          '按当前任务给出完整、简洁的回答，优先保留核心信息和必要结论；不要写到一半，不为绕过上限拆成多条。'
          '保持当前Persona与回复语言，超限时发送层会按完整句或词收尾。')
    items=[i for i in request.context_items if not (type(i).__name__=='SystemMessageItem' and any(getattr(part,'text','').startswith(MARKER) for part in i.parts))]
    index=next((i for i,item in enumerate(items) if type(item).__name__!='SystemMessageItem'),len(items))
    request.context_items=[*items[:index],ContextItemBuilder().set_role(RoleType.System).add_text_content(text).build(),*items[index:]]
