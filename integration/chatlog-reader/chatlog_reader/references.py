"""Decode authored text from native appmsg/57; never trust quoted names."""
import re
import xml.etree.ElementTree as ET

def text_reference(raw):
 if not isinstance(raw,str) or len(raw)>262144 or re.search(r'<!\s*(?:DOCTYPE|ENTITY)',raw,re.I):return None
 offset=raw.find('<')
 if offset<0:return None
 try:root=ET.fromstring(raw[offset:])
 except ET.ParseError:return None
 app=root if root.tag=='appmsg' else root.find('appmsg')
 if app is None or app.findtext('type')!='57':return None
 title=app.findtext('title')
 reference=app.find('refermsg');server=reference.findtext('svrid','') if reference is not None else ''
 if not isinstance(title,str) or not title.strip():return None
 return {'content':title.strip(),'reference_kind':'text_reply','reference_server_id':server if re.fullmatch(r'[1-9]\d{0,20}',server) else None}
