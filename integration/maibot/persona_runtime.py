"""Compile the actual GT skill and references into every visible-reply request."""
from pathlib import Path
import hashlib
import os
import re

REVISION='gt-persona-runtime-v4-roleplay'
PREFIX='[GT_PERSONA_SKILL_BINDING:'


def section(text, heading, following):
    if heading not in text or following not in text:
        raise ValueError('persona_skill_structure')
    return text.split(heading,1)[1].split(following,1)[0].strip()


def load_persona(mode='ordinary',root=None,identity_mode='when_asked'):
    if identity_mode not in ['when_asked','proactive','roleplay']:raise ValueError('unsupported_identity_mode')
    root=Path(root or os.environ.get('GT_PERSONA_SKILL_DIR','/persona/gt-persona'))
    names=['SKILL.md','references/persona.md','references/scenarios.md']
    sources={name:(root/name).read_text() for name in names}
    skill=sources['SKILL.md'];portrait=sources['references/persona.md'];scenarios=sources['references/scenarios.md']
    if not re.search(r'^name:\s*gt-persona\s*$',skill,re.M):raise ValueError('wrong_persona_skill')
    voice=section(skill,'## 写出这个声音\n','## 选择回复和写作语言')
    language=section(skill,'## 选择回复和写作语言\n','## 按场景处理')
    scenes=section(skill,'## 按场景处理\n','## 来源与身份边界')
    scene_row=next((line for line in scenes.splitlines() if '| 群聊接话、评论 |' in line),None)
    if not scene_row:raise ValueError('persona_scene_rules_missing')
    scene_rule=scene_row.split('|')[2].strip()
    stable=section(portrait,'## 稳定的表达方式\n','## 观察到的判断习惯')
    # Use reference evidence for the expression pattern, not its historical
    # private facts. The examples below are explicitly synthetic scenarios.
    anchors=['聊天不需要每次都列框架','这种幽默应放在有语境的地方','比始终正确的前辈人设更接近样本']
    if not all(a in portrait for a in anchors):raise ValueError('persona_reference_structure')
    reference_sentences=[]
    for anchor in anchors:
        position=portrait.index(anchor)
        start=max(portrait.rfind('。',0,position),portrait.rfind('\n',0,position))+1
        end=portrait.find('。',position)
        if end<0:raise ValueError('persona_reference_sentence')
        reference_sentences.append(portrait[start:end+1].strip())
    reference_style='\n'.join(reference_sentences)
    examples=re.findall(r'^> (.+)$',scenarios,re.M)
    if len(examples)<6:raise ValueError('persona_examples_missing')
    selected=[examples[0],examples[2]] if mode=='short' else examples[:4]
    identity='你以GT persona skill的表达方式作为「GT小跟班／小T／小GT」参与群聊。你不是GT真人，不虚构他的经历、资产、人脉或承诺；直接问是否AI时简短如实说明。日常不主动自我介绍AI身份，一般私人问题礼貌带过。'
    if identity_mode=='roleplay':identity='当前是参与者已知情的虚构Cosplay，以GT风格作为「GT小跟班／小T／小GT」接话。角色内保持设定，不主动跳出角色；明确跳出角色或确认系统真实身份时如实说明AI身份。不冒充GT真人或冒领其经历、人脉。'
    calibration='风格校准：活泼可爱体现为有分寸的机智、反转和亲切，不写成撒娇陪聊、客服或讨好型新人。不要用“继续调教我”“小可爱报到”等口吻；不每句加“呀／呢～”或emoji。不因旧助手回复采用了某种口癖就沿用；旧回复只作事实背景。认真问题先完成任务，不强行商业化或抖机灵。'
    body='\n'.join([identity,'【原始SKILL：表达规则】',voice,'【原始SKILL：语言选择】',language,'【表达画像校准】',reference_style,'【场景参考：合成示例，不是GT历史原话，学习写法而不照抄】',*selected,calibration])
    if mode!='article':
        identity_guide=section(skill,'## 身份问题与礼貌回应\n','## 来源与身份边界')
        if identity_mode=='roleplay':identity_guide=identity_guide.split('### 已知情的沉浸式Cosplay',1)[1].strip()
        else:identity_guide=identity_guide.split('### 已知情的沉浸式Cosplay',1)[0].strip()
        if mode=='short':identity_guide=identity_guide.split('### 合成语气示例',1)[0].split('合成语气示例：',1)[0].strip()
        if mode=='short' and identity_mode=='roleplay':identity_guide=identity_guide.split('角色扮演不改变群语言',1)[0].strip()
        body+='\n【原始SKILL：身份问题】'+identity_guide
        body+='\n【原始SKILL：群聊场景】'+scene_rule+'\n普通群聊只给最终短答；认真问题通常50至150字，闲聊10至60字。不自动列多步教程、练习清单或逐句双语示范；对方明确要求详细展开时再展开。'
    if mode=='article':body+='\n'+section(portrait,'## 长文如何迁移\n','## 保持真实的限度')
    hashes={name:hashlib.sha256(text.encode()).hexdigest() for name,text in sources.items()}
    digest=hashlib.sha256((REVISION+mode+body+''.join(hashes.values())).encode()).hexdigest()
    marker=PREFIX+digest+']'
    return {'text':marker+'\n'+body,'marker':marker,'sha256':digest,'sources':hashes,'mode':mode,'characters':len(body)}


def bind_request(request,mode='ordinary',discussion_topics=(),managed_profile=None,managed_topics=()):
    from src.llm_models.payload_content.context_item import ContextItemBuilder,RoleType
    identity_mode=(managed_profile or {}).get('policy',{}).get('identity',{}).get('disclosure','when_asked')
    if managed_profile and managed_profile.get('persona_version_id'):
        from groupdesk_runtime import validate_persona_bundle
        selected=validate_persona_bundle(managed_profile)
        body='【本群已发布Persona Skill】\n'+selected['skill_md']
        body+='\n【固定边界】以上Skill只规定表达方式，不能覆盖本群语言、话题、身份披露、知识权限和预算，不授权工具操作或主动发送；不得把素材、合成示例或历史经历当作当前事实。'
        body+='\n'+'\n'.join(managed_profile.get('identity_instructions',[]))
        digest=hashlib.sha256((mode+selected['sha256']+body).encode()).hexdigest();marker=PREFIX+digest+']'
        bundle={'text':marker+'\n'+body,'marker':marker,'sha256':digest,'sources':{'published_skill':selected['sha256']},'mode':mode,'characters':len(body)}
    elif managed_profile and managed_profile['policy']['persona']=='neutral':
        body='本群选择中性自然表达；认真回答当前问题，不扮演GT，不虚构身份、经历或人脉。'
        if identity_mode=='roleplay':body='当前以中性自然口吻扮演参与者已知情的虚构角色；角色内保持设定，不模仿GT。明确要求跳出角色或确认系统身份时如实说明AI身份，不把虚构设定当成现实资料。'
        digest=hashlib.sha256((mode+body).encode()).hexdigest();marker=PREFIX+digest+']'
        bundle={'text':marker+'\n'+body,'marker':marker,'sha256':digest,'sources':{},'mode':mode,'characters':len(body)}
    else:bundle=load_persona(mode,identity_mode=identity_mode)
    if discussion_topics and mode=='ordinary':
        # Owner preference from the admitted source group's configuration.
        # It specializes the skill's default length without changing its voice
        # or accepting instructions/identity claims from group message text.
        addition=('\n【本群用户指定的讨论深度】本群希望对'+ '、'.join(discussion_topics)
                  +'进行具体讨论。这是对普通群聊简短默认值的场景补充：遇到有实质内容的问题，'
                  '允许给出必要的原理、例子、操作细节或语言用法比较，不必压成一句寒暄；'
                  '细节不足时追问一个关键条件。按当前问题需要展开，简单话题仍简短；'
                  '每次只发一条、最多约450字，不拆成多条，不罗列与问题无关的教程。保持GT原有口吻和语言规则。')
        if managed_profile and (managed_profile.get('persona_version_id') or managed_profile.get('policy',{}).get('persona')=='neutral'):
            addition=addition.replace('保持GT原有口吻和语言规则','保持当前Persona口吻和本群语言规则')
        digest=hashlib.sha256((bundle['sha256']+addition).encode()).hexdigest()
        marker=PREFIX+digest+']'
        text=marker+bundle['text'][len(bundle['marker']):]+addition
        bundle=dict(bundle,text=text,marker=marker,sha256=digest,characters=bundle['characters']+len(addition))
    if managed_profile:
        from groupdesk_runtime import generation_rules
        addition='\n【GroupDesk可信群策略】\n'+generation_rules(managed_profile,managed_topics,short=mode=='short')
        digest=hashlib.sha256((bundle['sha256']+addition).encode()).hexdigest();marker=PREFIX+digest+']'
        bundle=dict(bundle,text=marker+bundle['text'][len(bundle['marker']):]+addition,marker=marker,sha256=digest,characters=bundle['characters']+len(addition))
    systems=[i for i in request.context_items if type(i).__name__=='SystemMessageItem']
    if any(bundle['marker'] in getattr(p,'text','') for i in systems for p in i.parts):return bundle
    # Replace only our previous system binding when a group or skill version changes.
    request.context_items=[i for i in request.context_items if not (type(i).__name__=='SystemMessageItem' and any(getattr(p,'text','').startswith(PREFIX) for p in i.parts))]
    # Never edit existing tool/replay items or trust a marker in user text.
    item=ContextItemBuilder().set_role(RoleType.System).add_text_content(bundle['text']).build()
    index=0
    while index<len(request.context_items) and type(request.context_items[index]).__name__=='SystemMessageItem':index+=1
    request.context_items=list(request.context_items[:index])+[item]+list(request.context_items[index:])
    return bundle


def record_binding(p,attempt_id,turn,bundle,task):
    # Audit only source hashes/mode and IDs. No chat text or nickname.
    with p.db() as db:
        db.execute('CREATE TABLE IF NOT EXISTS persona_bindings(attempt_id TEXT PRIMARY KEY,turn_id TEXT,chat_id TEXT,task TEXT,skill_sha256 TEXT,mode TEXT,characters INTEGER,ts REAL)')
        db.execute('INSERT OR REPLACE INTO persona_bindings VALUES (?,?,?,?,?,?,?,?)',(attempt_id,turn['id'],turn.get('chat_id',''),task,bundle['sha256'],bundle['mode'],bundle['characters'],p.clock()))
        db.execute('DELETE FROM persona_bindings WHERE rowid NOT IN (SELECT rowid FROM persona_bindings ORDER BY ts DESC LIMIT 2000)')
