"""Read-only static analysis of one pinned public Linux WeChat ELF build.

Does not inspect processes, load the executable, extract keys or send messages.
"""
import bisect
import hashlib
import json
import mmap
from pathlib import Path
import re
import struct
import subprocess
import sys

EXPECTED = '2ca28ea56b1a400543d0128ebaf0b93f88172dd66dc0426d3d74fdb971eab959'
ANCHORS = (
    'send_text_message_failed: MessageManager is unavailable',
    'Failed to send text message: ',
    'image send failed: ',
    'File message send failed: ',
)


def analyze(path, emit_disassembly=False):
    with path.open('rb') as handle, mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as raw:
        digest = hashlib.sha256(raw).hexdigest()
        if digest != EXPECTED:
            raise ValueError('Unsupported executable SHA256')
        if raw[:6] != b'\x7fELF\x02\x01' or struct.unpack_from('<H', raw, 18)[0] != 62:
            raise ValueError('Expected little-endian x86_64 ELF')
        section_offset = struct.unpack_from('<Q', raw, 40)[0]
        stride, count, names_index = struct.unpack_from('<HHH', raw, 58)
        sections = [struct.unpack_from('<IIQQQQIIQQ', raw, section_offset + i * stride) for i in range(count)]
        names_section = sections[names_index]
        names = raw[names_section[4]:names_section[4] + names_section[5]]
        named = {}
        for section in sections:
            end = names.find(b'\0', section[0])
            named[names[section[0]:end].decode()] = section
        note = named['.note.gnu.build-id']
        name_size, descriptor_size, note_type = struct.unpack_from('<III', raw, note[4])
        if note_type != 3:
            raise ValueError('Expected GNU build ID')
        descriptor_at = note[4] + 12 + ((name_size + 3) & ~3)
        build_id = bytes(raw[descriptor_at:descriptor_at + descriptor_size]).hex()
        def virtual(file_offset):
            for section in sections:
                if section[1] != 8 and section[4] <= file_offset < section[4] + section[5]:
                    return file_offset - section[4] + section[3]
            raise ValueError('File offset outside sections')
        header = named['.eh_frame_hdr']
        offset, address = header[4], header[3]
        encodings = bytes(raw[offset:offset + 4])
        if encodings != b'\x01\x1b\x03\x3b':
            raise ValueError('Unsupported EH header encodings: ' + encodings.hex())
        functions = struct.unpack_from('<I', raw, offset + 8)[0]
        starts = [address + struct.unpack_from('<i', raw, offset + 12 + 8 * i)[0] for i in range(functions)]
        if starts != sorted(starts):
            raise ValueError('Invalid EH function order')
        wanted = {}
        strings = {}
        for anchor in ANCHORS:
            positions = []
            start = 0
            while True:
                position = raw.find(anchor.encode() + b'\0', start)
                if position < 0:
                    break
                va = virtual(position)
                for shift in (0, 16, 32):
                    if shift < len(anchor):
                        wanted[va + shift] = anchor
                positions.append({'file_offset': hex(position), 'rva': hex(va)})
                start = position + len(anchor)
            strings[anchor] = {'found': bool(positions), 'locations': positions, 'references': []}
        # RIP-relative LEA/MOV or SSE constant loads. Every candidate is subsequently
        # checked by objdump; byte scanning alone is not an instruction proof.
        pattern = re.compile(rb'(?:[\x48-\x4f][\x8d\x8b]|[\x40-\x4f]?\x0f[\x10\x28\x6f])[\x05\x0d\x15\x1d\x25\x2d\x35\x3d](....)', re.S)
        ranges = set()
        for section in sections:
            if not section[2] & 4:
                continue
            begin, end = section[4], section[4] + section[5]
            for match in pattern.finditer(raw, begin, end):
                site = match.start() - section[4] + section[3]
                target = site + len(match[0]) + struct.unpack('<i', match[1])[0]
                if target not in wanted:
                    continue
                index = bisect.bisect_right(starts, site) - 1
                if index < 0 or index + 1 >= len(starts):
                    raise ValueError('Reference has no bounded EH table entry')
                start, stop = starts[index:index + 2]
                strings[wanted[target]]['references'].append({'instruction_rva': hex(site), 'string_rva': hex(target), 'eh_start': hex(start), 'next_eh_start': hex(stop)})
                ranges.add((start, stop))
        output = {'scope': 'static_public_elf_only', 'sha256': digest, 'build_id': build_id, 'eh_table_entries': functions, 'anchors': strings, 'native_send_verified': False}
        disassemblies = {}
        for start, stop in sorted(ranges):
            # Bound output and mark truncation rather than invent a function end.
            bounded = min(stop, start + 8192)
            result = subprocess.run(['objdump', '-d', '-M', 'intel', '--no-show-raw-insn', '--start-address=' + hex(start), '--stop-address=' + hex(bounded), str(path)], capture_output=True, text=True, timeout=30)
            if result.returncode:
                raise RuntimeError('objdump failed')
            disassemblies[start] = (stop, bounded, result.stdout)
        verified = 0
        for anchor, metadata in strings.items():
            if not metadata['references']:
                raise ValueError('No bounded instruction reference for ' + anchor)
            for reference in metadata['references']:
                start = int(reference['eh_start'], 16)
                instruction = int(reference['instruction_rva'], 16)
                target = int(reference['string_rva'], 16)
                assembly = disassemblies[start][2]
                pattern = r'^\s*' + format(instruction, 'x') + r':\s+[^\n]+#\s+' + format(target, 'x') + r'(?:\s|$)'
                if not re.search(pattern, assembly, re.M):
                    raise ValueError('objdump did not verify instruction ' + reference['instruction_rva'])
                reference['objdump_verified'] = True
                verified += 1
        output['objdump_verified_references'] = verified
        print(json.dumps(output, ensure_ascii=False, indent=2), flush=True)
        if emit_disassembly:
            for start, (stop, bounded, assembly) in disassemblies.items():
                print('\nDISASSEMBLY', hex(start), hex(stop), 'truncated', bounded != stop, flush=True)
                print(assembly, flush=True)


if __name__ == '__main__':
    if len(sys.argv) not in (2, 3) or len(sys.argv) == 3 and sys.argv[2] != '--disassembly':
        raise SystemExit('Supply a public ELF path and optionally --disassembly')
    analyze(Path(sys.argv[1]), emit_disassembly=len(sys.argv) == 3)
