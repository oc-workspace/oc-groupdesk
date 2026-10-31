#!/usr/bin/env python3
"""Archive all locally readable messages in one allowlisted WeChat group.

Never modifies WeChat. A fresh snapshot preserves previous exports; stable
source IDs permit a receiving material library to import repeated snapshots.
"""
from __future__ import annotations
import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
from export_persona_messages import decode_content, private_write, LABELS
from wechat_summary_bridge import build_collector, MacOSWeChatExportCollector


def export_group(collector, group_name: str, output: Path, page_size=500):
    if not isinstance(collector, MacOSWeChatExportCollector):
        raise RuntimeError('Requires the local macos-wechat-export collector')
    if output.exists() and any(output.iterdir()):
        raise RuntimeError('Use a new empty snapshot directory')
    group = collector._resolve_talker(group_name)
    started = datetime.now(collector.zone).isoformat(timespec='seconds')
    records, shards, sender_ids = [], [], set()
    for path, table in collector.reader.paths(group['username']):
        with collector.reader.open(path) as db:
            db.query('BEGIN')
            stat = db.query(f'SELECT count(*) n,max(local_id) high_water FROM "{table}"')[0]
            high = int(stat['high_water']) if stat['high_water'] is not None else None
            cursor, extracted = None, 0
            while high is not None:
                lower = '' if cursor is None else f' AND m.local_id>{cursor}'
                rows = db.query('SELECT m.local_id,m.server_id,m.local_type,m.create_time,'
                                'm.real_sender_id,n.user_name sender_id,hex(m.message_content) body '
                                f'FROM "{table}" m LEFT JOIN Name2Id n ON n.rowid=m.real_sender_id '
                                f'WHERE m.local_id<={high}{lower} ORDER BY m.local_id LIMIT {int(page_size)}')
                if not rows:
                    break
                for row in rows:
                    raw = bytes.fromhex(row['body'] or '')
                    sender = row['sender_id'] or f'unresolved:{path.name}:{row["real_sender_id"]}'
                    sender_ids.add(sender)
                    timestamp, kind = int(row['create_time']), int(row['local_type'])
                    records.append({
                        'id': f'{path.name}:{row["local_id"]}', 'group_id': group['username'],
                        'group_name': group_name, 'sender_id': sender,
                        'timestamp': timestamp,
                        'datetime': datetime.fromtimestamp(timestamp, collector.zone).isoformat(timespec='seconds'),
                        'message_type': LABELS.get(kind & 0xFFFFFFFF, 'unknown'), 'local_type': kind,
                        'source': {'database': path.name, 'table': table, 'local_id': int(row['local_id']),
                                   'server_id': row['server_id'], 'real_sender_id': row['real_sender_id']},
                        'source_payload_sha256': hashlib.sha256(raw).hexdigest(),
                        'text_origin': 'sender_message_original_authorship_unverified',
                        **decode_content(raw, sender, kind),
                    })
                extracted += len(rows)
                cursor = int(rows[-1]['local_id'])
            if extracted != int(stat['n']):
                raise RuntimeError(f'Count mismatch in {path.name}')
            db.query('COMMIT')
            shards.append({'database': path.name, 'table': table, 'count': extracted,
                           'high_water': high, 'count_verified': True})
    if not records:
        raise RuntimeError('No locally readable messages')
    names = collector._contact_names(sender_ids)
    records.sort(key=lambda r: (r['timestamp'], r['id']))
    if len({r['id'] for r in records}) != len(records):
        raise RuntimeError('Duplicate source IDs')
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(output, 0o700)
    body = output / 'messages.jsonl'
    hasher = hashlib.sha256()
    with body.open('x', encoding='utf-8', newline='\n') as stream:
        os.chmod(body, 0o600)
        for record in records:
            record['sender_display_name'] = names.get(record['sender_id'], record['sender_id'])
            line = json.dumps(record, ensure_ascii=False) + '\n'
            stream.write(line)
            hasher.update(line.encode())
        stream.flush()
        os.fsync(stream.fileno())
    manifest = {'schema_version': 1, 'snapshot_started_at': started,
                'snapshot_finished_at': datetime.now(collector.zone).isoformat(timespec='seconds'),
                'group': group, 'timezone': str(collector.zone), 'count': len(records),
                'authored_text_count': sum(bool(r['authored_text']) for r in records),
                'first_message_at': records[0]['datetime'], 'last_message_at': records[-1]['datetime'],
                'sender_count': len(sender_ids), 'shards': shards, 'all_shard_counts_verified': True,
                'content_statuses': dict(Counter(r['content_status'] for r in records)),
                'files': {'messages.jsonl': {'sha256': hasher.hexdigest(), 'bytes': body.stat().st_size}},
                'limitations': ['Local readable history only; unsynced/deleted/other-device history is unavailable.',
                               'Per-shard read snapshots, not a global cross-shard transaction.',
                               'Media is not copied, OCRed or transcribed; quoted/shared text is separate from sender body.',
                               'Raw XML, media credentials and embedded forwarded histories are not exported.']}
    private_write(output / 'manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--group', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    m = export_group(build_collector(), args.group, args.output)
    print(json.dumps({k: m[k] for k in ['count', 'authored_text_count', 'sender_count',
                                      'first_message_at', 'last_message_at', 'all_shard_counts_verified']}, ensure_ascii=False))
