"""Operator-only direct route for one registered bot's WeChat endpoint.

No firewall, proxy configuration, shared network, or account files are changed.
Only a matching /32 source AND Docker bridge ingress uses the main route table.
"""
import argparse
import ipaddress
import json
import re
import subprocess
import time
import uuid
from pathlib import Path

PRIORITY = 8995
STATE = Path('/run/groupdesk-bot-egress')


def run(*args):
    return subprocess.check_output(list(args), text=True, timeout=10)


def identity(value):
    bot = str(uuid.UUID(value))
    if value != bot or bot == '00000000-0000-4000-8000-000000000001':
        raise ValueError('Use a canonical independent bot UUID')
    return bot.replace('-', '')


def validate_rule(rule):
    address = ipaddress.ip_interface(rule['source'])
    if address.version != 4 or address.network.prefixlen != 32 or not address.ip.is_private:
        raise ValueError('Only a private IPv4 endpoint /32 is allowed')
    if not re.fullmatch(r'br-[a-f0-9]{12}', rule['interface']):
        raise ValueError('Expected an independent Docker bridge')
    if set(rule) != {'source', 'interface'}:
        raise ValueError('Unexpected rule fields')
    return rule


def plan(container, network, slug, service='wechat'):
    project = 'gdbot-' + slug
    if service not in {'wechat', 'maibot', 'wechat-bridge', 'group-onboarding-agent'} or not container['running'] or container['project'] != project or container['service'] != service:
        raise ValueError('Expected this bot’s running outbound service')
    if network['Name'] != project + '_bot' or network['Labels'].get('com.docker.compose.project') != project:
        raise ValueError('Network belongs to another bot')
    if network['Driver'] != 'bridge' or network.get('Internal') or network.get('Options'):
        raise ValueError('Expected the default independent outbound bridge')
    endpoints = container['networks']
    expected = {network['Name'], project + '_data'} if service == 'wechat-bridge' else {network['Name']}
    if set(endpoints) != expected:
        raise ValueError('Service must use only its own expected networks')
    endpoint = endpoints[network['Name']]
    if endpoint['NetworkID'] != network['Id'] or not re.fullmatch('[a-f0-9]{64}', network['Id']):
        raise ValueError('Docker network identity mismatch')
    address = ipaddress.ip_address(endpoint['IPAddress'])
    if not any(address in ipaddress.ip_network(c['Subnet']) for c in network['IPAM']['Config'] if ':' not in c['Subnet']):
        raise ValueError('Endpoint is outside this network')
    return validate_rule({'source': str(address) + '/32', 'interface': 'br-' + network['Id'][:12]})


def inspect_rule(slug, service='wechat'):
    project = 'gdbot-' + slug
    fmt = '{"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"networks":{{json .NetworkSettings.Networks}}}'
    container = json.loads(run('docker', 'inspect', '--format', fmt, project + '-' + service + '-1'))
    network = json.loads(run('docker', 'network', 'inspect', project + '_bot'))[0]
    return plan(container, network, slug, service)


def present(rule):
    address = str(ipaddress.ip_interface(rule['source']).ip)
    return any(r.get('priority') == PRIORITY and r.get('src') in (address, rule['source']) and r.get('srclen', 32) == 32 and 'not' not in r
               and r.get('iif') == rule['interface'] and r.get('table') in ('main', 254)
               for r in json.loads(run('ip', '-j', '-4', 'rule', 'show')))


def change(action, rule):
    validate_rule(rule)
    run('ip', '-4', 'rule', action, 'priority', str(PRIORITY), 'from', rule['source'],
        'iif', rule['interface'], 'lookup', 'main')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['show', 'apply', 'remove'])
    parser.add_argument('bot_id')
    parser.add_argument('--service', choices=['wechat', 'maibot', 'wechat-bridge', 'group-onboarding-agent'], default='wechat')
    args = parser.parse_args()
    slug = identity(args.bot_id)
    suffix = '' if args.service == 'wechat' else '-' + args.service
    state = STATE / (slug + suffix + '.json')
    if args.action == 'remove':
        if state.exists():
            old = json.loads(state.read_text())
            validate_rule(old['rule'])
            if old['owned'] and present(old['rule']):
                change('del', old['rule'])
            state.unlink()
        return
    root = Path('/opt/docker/oc-projects/groupdesk-bots') / slug
    meta = json.loads((root / 'deployment.json').read_text())
    if root.resolve() != root or meta['bot_id'] != args.bot_id or meta['deployment'] != str(root):
        raise ValueError('Deployment identity mismatch')
    deadline = time.monotonic() + (25 if args.action == 'apply' else 0)
    while True:
        try:
            rule = inspect_rule(slug, args.service)
            break
        except subprocess.CalledProcessError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(1)
    if args.action == 'show':
        print(json.dumps({'rule': rule, 'present': present(rule)}))
        return
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    if state.exists():
        old = json.loads(state.read_text())
        validate_rule(old['rule'])
        if old['rule'] == rule and present(rule):
            return
        if old['owned'] and present(old['rule']):
            change('del', old['rule'])
    owned = not present(rule)
    # Record before mutation so a later stop can clean up a partially applied start.
    state.write_text(json.dumps({'rule': rule, 'owned': owned}) + '\n')
    state.chmod(0o600)
    if owned:
        change('add', rule)
    if not present(rule):
        raise RuntimeError('Route verification failed')
    print('Independent WeChat /32 direct egress applied; no other routes changed.')


if __name__ == '__main__':
    main()
