import unittest
from model_routing import request_extra_params
class ParamsTests(unittest.TestCase):
 def test_only_the_selected_plain_gemini_flash_gets_low_thinking(self):
  self.assertEqual(request_extra_params('gemini','gemini-3.8-flash')['thinking_config']['thinking_level'],'LOW')
  self.assertEqual(request_extra_params('gemini','gemini-3.8-flash-high'),{})
  self.assertEqual(request_extra_params('openai','example'),{})
  self.assertEqual(request_extra_params('openai_responses','example'),{'store':False})
class NativeTests(unittest.TestCase):
 def test_function_results_use_a_gemini_user_content_not_the_tool_role(self):
  from src.llm_models.model_client.gemini_client import _convert_messages
  from src.llm_models.payload_content.context_item import ContextItemBuilder,FunctionCallOutputItem
  from dataclasses import replace
  meta=replace(ContextItemBuilder().add_text_content('fixture').build().meta,logical_turn_id='fixture-turn')
  output=FunctionCallOutputItem(meta=meta,call_id='example-call',output='{"ok":true}',tool_name='reply')
  contents,_=_convert_messages([output])
  self.assertEqual(contents[0].role,'user');self.assertEqual(contents[0].parts[0].function_response.name,'reply')
 def test_sdk_preserves_low_thinking_and_the_existing_output_cap(self):
  from src.llm_models.model_client.gemini_client import GeminiClient
  client=object.__new__(GeminiClient)
  config=client._build_generation_config(model_identifier='gemini-3.8-flash',system_instruction='fixture',tool_options=None,response_format=None,max_tokens=768,temperature=None,extra_params=request_extra_params('gemini','gemini-3.8-flash'),enable_google_search=False)
  self.assertEqual(config.max_output_tokens,768);self.assertFalse(config.thinking_config.include_thoughts)
  self.assertEqual(str(config.thinking_config.thinking_level).split('.')[-1],'LOW')
if __name__=='__main__':unittest.main()
