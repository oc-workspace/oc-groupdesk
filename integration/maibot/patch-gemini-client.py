"""Apply the narrowly scoped generateContent function-response role correction."""
from pathlib import Path
import argparse,hashlib
BASE='61146326efc825284757a98d21059af31cf8ebfd7b9d1656e2606fa5420de636'
def patched(text):
 old='contents.append(Content(role="tool", parts=[function_response_part]))'
 new='contents.append(Content(role="user", parts=[function_response_part]))'
 if old not in text and new in text:return text
 if hashlib.sha256(text.encode()).hexdigest()!=BASE or text.count(old)!=1:raise ValueError('Unexpected MaiBot Gemini baseline; review before updating')
 return text.replace(old,new)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('source',type=Path);p.add_argument('output',type=Path);a=p.parse_args();a.output.write_text(patched(a.source.read_text()))
