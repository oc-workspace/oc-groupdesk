import unittest
from unittest.mock import patch
from wechat_egress import identity, plan, validate_rule, present

BOT = '11111111-2222-4333-8444-555555555555'
SLUG = identity(BOT)
PROJECT = 'gdbot-' + SLUG
NETWORK_ID = 'a' * 64


class EndpointRouteTest(unittest.TestCase):
    def setUp(self):
        self.network = {'Name': PROJECT + '_bot', 'Labels': {'com.docker.compose.project': PROJECT},
                        'Driver': 'bridge', 'Internal': False, 'Options': {}, 'Id': NETWORK_ID,
                        'IPAM': {'Config': [{'Subnet': '172.23.0.0/16'}]}}
        self.container = {'running': True, 'project': PROJECT, 'service': 'wechat',
                          'networks': {PROJECT + '_bot': {'NetworkID': NETWORK_ID, 'IPAddress': '172.23.0.2'}}}

    def test_only_one_endpoint_and_its_bridge(self):
        self.assertEqual(plan(self.container, self.network, SLUG),
                         {'source': '172.23.0.2/32', 'interface': 'br-aaaaaaaaaaaa'})

    def test_cannot_target_other_bot_or_legacy(self):
        for value in ['00000000-0000-4000-8000-000000000001', '../../etc/passwd']:
            with self.assertRaises(ValueError): identity(value)
        self.container['project'] = 'maibot-wechat'
        with self.assertRaises(ValueError): plan(self.container, self.network, SLUG)

    def test_reject_shared_and_reader_network(self):
        self.container['networks']['other'] = {}
        with self.assertRaises(ValueError): plan(self.container, self.network, SLUG)
        del self.container['networks']['other']
        self.network['Internal'] = True
        with self.assertRaises(ValueError): plan(self.container, self.network, SLUG)

    def test_reject_address_outside_own_network(self):
        self.container['networks'][PROJECT + '_bot']['IPAddress'] = '172.30.78.3'
        with self.assertRaises(ValueError): plan(self.container, self.network, SLUG)

    def test_cannot_install_broad_route_or_other_interface(self):
        for rule in [{'source': '172.23.0.0/16', 'interface': 'br-aaaaaaaaaaaa'},
                     {'source': '8.8.8.8/32', 'interface': 'br-aaaaaaaaaaaa'},
                     {'source': '172.23.0.2/32', 'interface': 'eth0'}]:
            with self.assertRaises(ValueError): validate_rule(rule)

    def test_runtime_routes_are_separate_endpoints_and_never_reader(self):
        self.container['service']='maibot'
        self.assertEqual(plan(self.container,self.network,SLUG,'maibot')['source'],'172.23.0.2/32')
        self.container['service']='wechat-bridge'
        self.container['networks'][PROJECT+'_data']={}
        self.assertEqual(plan(self.container,self.network,SLUG,'wechat-bridge')['interface'],'br-aaaaaaaaaaaa')
        with self.assertRaises(ValueError):plan(self.container,self.network,SLUG,'reader')
        self.container['networks']['foreign_data']={}
        with self.assertRaises(ValueError):plan(self.container,self.network,SLUG,'wechat-bridge')

    def test_existing_broader_or_negated_rules_are_not_owned(self):
        import json
        rule={'source':'172.23.0.2/32','interface':'br-aaaaaaaaaaaa'}
        base={'priority':8995,'src':'172.23.0.2','iif':'br-aaaaaaaaaaaa','table':'main'}
        for extra in [{'srclen':31},{'not':None}]:
            with patch('wechat_egress.run',return_value=json.dumps([{**base,**extra}])):self.assertFalse(present(rule))
        with patch('wechat_egress.run',return_value=json.dumps([base])):self.assertTrue(present(rule))


if __name__ == '__main__': unittest.main()
