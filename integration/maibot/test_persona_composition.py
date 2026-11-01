import copy,hashlib,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import groupdesk_runtime as gd
from test_published_persona import published,NATIVE
import test_published_persona as fixtures


def feature(identifier='feature-a',text='Contextual banter: only use an appropriate joke; substantive requests still require an answer.'):
    return {'version_id':identifier+'-v1','persona_id':identifier,'kind':'feature','version':1,'name':identifier,'skill_md':text,'sha256':hashlib.sha256(text.encode()).hexdigest()}


def composed(base=True):
    p=published() if base else published()
    if not base:p.pop('persona_version_id');p['persona_skill']=None
    p['persona_feature_skills']=[feature(),feature('feature-b','Detailed teaching: give an example when needed; otherwise retain the base voice and avoid a lecture.')]
    p['persona_composition_contract_version']=1
    return sign(p)


def sign(p):
    base=p.get('persona_skill') or {}
    manifest=[1,base.get('version_id'),base.get('sha256'),[[v['version_id'],v['sha256']] for v in p['persona_feature_skills']]]
    p['persona_composition_sha256']=hashlib.sha256(json.dumps(manifest,separators=(',',':')).encode()).hexdigest()
    return p


class CompositionContractTests(unittest.TestCase):
    def test_two_features_validate_with_a_base_or_builtin(self):
        for base in [True,False]:
            p=composed(base);gd.validate_bundle(p,p['external_id']);self.assertEqual(len(gd.validate_persona_composition(p)),2)

    def test_corrupt_feature_missing_contract_digest_and_order_are_rejected(self):
        p=composed()
        for mutate in [lambda p:p.pop('persona_composition_contract_version'),
                       lambda p:p.update(persona_composition_contract_version=99),
                       lambda p:p['persona_feature_skills'][0].update(skill_md='Unverified modified text'),
                       lambda p:p['persona_feature_skills'].reverse(),
                       lambda p:p.update(persona_composition_sha256='0'*64)]:
            bad=copy.deepcopy(p);mutate(bad)
            with self.assertRaises(ValueError):gd.validate_bundle(bad,p['external_id'])

    def test_duplicate_wrong_kind_and_oversized_features_are_rejected_even_when_signed(self):
        for values in [[feature(),feature()],
                       [{**feature(),'kind':'base'}],
                       [feature(str(i)) for i in range(6)],
                       [feature(text='x'*6001)],
                       [feature(text='😀'*3001)]]:
            p=composed();p['persona_feature_skills']=values;sign(p)
            with self.assertRaises(ValueError):gd.validate_persona_composition(p)

    def test_sync_ack_covers_complete_combination(self):
        p=composed();acks=[]
        def api(path,body=None):
            if path.startswith('/config/'):return p
            if path=='/ack':acks.append(body);return {'ok':True}
            raise AssertionError(path)
        with tempfile.TemporaryDirectory() as folder:
            c=Path(folder)/'connection.json';snapshot=Path(folder)/'snapshot.json';c.write_text(json.dumps({'groups':{'chat':p['external_id']}}))
            with patch.object(gd,'CONNECTION',c),patch.object(gd,'SNAPSHOT',snapshot),patch.object(gd,'api',side_effect=api):result=gd.sync()
        self.assertTrue(result['chat']['enabled']);self.assertEqual(acks[0]['persona_composition_version'],1)
        self.assertEqual(acks[0]['persona_composition_sha256'],p['persona_composition_sha256'])

    def test_bad_sync_never_acknowledges_a_partial_configuration(self):
        p=composed();p['persona_feature_skills'][0]['sha256']='0'*64;acks=[]
        def api(path,body=None):
            if path.startswith('/config/'):return p
            acks.append(body);return {'ok':True}
        with tempfile.TemporaryDirectory() as folder:
            c=Path(folder)/'connection.json';c.write_text(json.dumps({'groups':{'chat':p['external_id']}}))
            with patch.object(gd,'CONNECTION',c),patch.object(gd,'SNAPSHOT',Path(folder)/'state'),patch.object(gd,'api',side_effect=api):result=gd.sync()
        self.assertFalse(result['chat']['enabled']);self.assertFalse(acks)


@unittest.skipUnless(NATIVE,'Pinned native request classes required')
class NativeCompositionTests(unittest.TestCase):
    request=fixtures.NativeBindingTests.request
    content=fixtures.NativeBindingTests.content

    def test_native_prompt_preserves_base_features_and_group_rules(self):
        from persona_runtime import bind_request
        p=composed();request=self.request();b=bind_request(request,managed_profile=p)
        text=self.content(request)
        self.assertIn(p['persona_skill']['skill_md'],text)
        for f in p['persona_feature_skills']:self.assertIn(f['skill_md'],text)
        self.assertIn('GroupDesk可信群策略',text);self.assertIn('认真问题先答实质内容',text)
        self.assertEqual(b['sources']['persona_composition'],p['persona_composition_sha256'])

    def test_feature_update_or_group_switch_removes_previous_feature_prompt(self):
        from persona_runtime import bind_request
        request=self.request();first=composed();bind_request(request,managed_profile=first)
        second=published('A different group base with no optional banter features attached.','other-base')
        bind_request(request,managed_profile=second);text=self.content(request)
        self.assertNotIn(first['persona_feature_skills'][0]['skill_md'],text)
        self.assertIn(second['persona_skill']['skill_md'],text);self.assertEqual(text.count('[GT_PERSONA_SKILL_BINDING:'),1)

    def test_same_feature_text_with_new_version_updates_binding_identity(self):
        from persona_runtime import bind_request
        request=self.request();p=composed();first=bind_request(request,managed_profile=p)
        p['persona_feature_skills'][0]['version_id']='new-version';sign(p)
        second=bind_request(request,managed_profile=p)
        self.assertNotEqual(first['sha256'],second['sha256']);self.assertEqual(self.content(request).count('[GT_PERSONA_SKILL_BINDING:'),1)

    def test_builtin_neutral_base_does_not_load_gt_when_features_selected(self):
        from persona_runtime import bind_request
        p=composed(False);p['policy']['persona']='neutral'
        with patch('persona_runtime.load_persona',side_effect=AssertionError('No GT loading')):
            text=bind_request(self.request(),managed_profile=p)['text']
        self.assertIn('中性自然表达',text);self.assertIn(p['persona_feature_skills'][0]['skill_md'],text)

    def test_corrupt_feature_does_not_fall_back_to_base_only(self):
        from persona_runtime import bind_request
        p=composed();p['persona_feature_skills'][0]['sha256']='0'*64
        with self.assertRaises(ValueError):bind_request(self.request(),managed_profile=p)


if __name__=='__main__':unittest.main()
