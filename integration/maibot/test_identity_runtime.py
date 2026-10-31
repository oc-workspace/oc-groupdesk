import copy
import unittest
from unittest.mock import patch

from groupdesk_runtime import validate_bundle, generation_rules
from test_groupdesk_runtime import bundle


class IdentityContractTests(unittest.TestCase):
    def test_legacy_contract_is_accepted_but_concealment_values_are_rejected(self):
        p = bundle()
        validate_bundle(p, 'example-room')
        for value in ['never', False, 'pretend_human']:
            candidate = copy.deepcopy(p)
            candidate['policy']['identity'] = {'disclosure': value, 'personal_questions': 'tactful'}
            with self.assertRaisesRegex(ValueError, 'identity policy'):
                validate_bundle(candidate, 'example-room')

    def test_server_instructions_are_used_for_short_and_normal_requests(self):
        p = bundle()
        p['policy']['identity'] = {'disclosure': 'proactive', 'personal_questions': 'plain'}
        p['identity_instructions'] = ['Synthetic identity policy chosen for this group.']
        for short in [False, True]:
            text = generation_rules(p, short=short)
            self.assertIn('Synthetic identity policy chosen for this group.', text)
            self.assertIn('proactive', text)
            self.assertIn('不能否认AI', text)
        del p['identity_instructions']
        self.assertNotIn('Synthetic identity policy chosen for this group.', generation_rules(p))

    def test_bad_instruction_shape_fails_before_lease_is_published(self):
        p = bundle()
        p['identity_instructions'] = 'not a list'
        with self.assertRaisesRegex(ValueError, 'identity instructions'):
            validate_bundle(p, 'example-room')

    def test_informed_roleplay_contract_and_fallback_do_not_force_an_ordinary_disclaimer(self):
        p = bundle()
        p['policy']['identity'] = {'disclosure': 'roleplay', 'personal_questions': 'plain'}
        validate_bundle(p, 'example-room')
        text = generation_rules(p)
        self.assertIn('已知情', text)
        self.assertIn('角色外身份确认', text)
        self.assertNotIn('直接问是否AI、机器人或真人时简短如实回答', text)


try:
    from src.llm_models.model_client.base_client import ResponseRequest
    from src.config.model_configs import ModelInfo
    NATIVE = True
except ModuleNotFoundError:
    NATIVE = False


@unittest.skipUnless(NATIVE, 'MaiBot native request classes required')
class IdentityBindingTests(unittest.TestCase):
    def test_roleplay_selects_a_different_skill_guide_without_normal_identity_rule(self):
        from persona_runtime import bind_request, load_persona
        p = bundle()
        p['policy']['identity'] = {'disclosure': 'roleplay', 'personal_questions': 'plain'}
        p['identity_instructions'] = ['Synthetic informed roleplay instructions.']
        r = ResponseRequest(model_info=ModelInfo(name='test', model_identifier='test', api_provider='test', model_type='llm'), context_items=[], max_tokens=100)
        result = bind_request(r, managed_profile=p)
        self.assertIn('参与者已知情', result['text'])
        self.assertIn('Synthetic informed roleplay instructions.', result['text'])
        self.assertIn('跳出角色', result['text'])
        self.assertNotIn('直接问是否AI时简短如实说明', result['text'])
        normal = load_persona(identity_mode='when_asked')
        self.assertNotEqual(result['sha256'], normal['sha256'])
        self.assertNotIn('角色内问来历', normal['text'])
        self.assertLess(load_persona('short', identity_mode='roleplay')['characters'], 1800)

    def test_identity_setting_changes_native_system_binding_and_digest(self):
        from persona_runtime import bind_request
        def request():
            return ResponseRequest(model_info=ModelInfo(name='test', model_identifier='test', api_provider='test', model_type='llm'), context_items=[], max_tokens=100)
        p = bundle()
        p['identity_instructions'] = ['Synthetic tactful response policy.']
        first = bind_request(request(), managed_profile=p)
        p['policy']['identity'] = {'disclosure': 'proactive', 'personal_questions': 'plain'}
        p['identity_instructions'] = ['Synthetic direct response policy.']
        r = request()
        second = bind_request(r, managed_profile=p)
        bind_request(r, managed_profile=p)
        self.assertNotEqual(first['sha256'], second['sha256'])
        self.assertIn('Synthetic direct response policy.', second['text'])
        self.assertNotIn('Synthetic tactful response policy.', second['text'])
        self.assertEqual(sum(type(i).__name__ == 'SystemMessageItem' for i in r.context_items), 1)

    def test_neutral_mode_receives_identity_rule_without_loading_gt(self):
        from persona_runtime import bind_request
        p = bundle()
        p['policy']['persona'] = 'neutral'
        p['identity_instructions'] = ['Synthetic neutral identity policy.']
        r = ResponseRequest(model_info=ModelInfo(name='test', model_identifier='test', api_provider='test', model_type='llm'), context_items=[], max_tokens=100)
        with patch('persona_runtime.load_persona', side_effect=AssertionError('must not load GT')):
            result = bind_request(r, managed_profile=p)
        self.assertIn('Synthetic neutral identity policy.', result['text'])
