"""Controlled XML annotations over synthetic and retained licensed .lss sources."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def cases() -> list[dict[str, str]]:
    synthetic = (ROOT / 'tests/fixtures/modern-full.lss').read_bytes().decode('utf-8')
    out = [{'id': 'synthetic-original', 'xml': synthetic, 'equivalentTo': 'synthetic-original'}]
    for tag in ('Icon', 'GameIcon', 'AutoSplitterSettings'):
        # Only comments change. They enclose the second timing record, not an icon.
        comments = re.sub(r'(<Time id="2">[\s\S]*?</Time>)',
                          f'<!-- <{tag}> -->\\1<!-- </{tag}> -->', synthetic, count=1)
        out.append({'id': 'comment-' + tag, 'xml': comments, 'equivalentTo': 'synthetic-original'})
        pi = comments.replace(f'<!-- <{tag}> -->', f'<?note <{tag}> ?>').replace(
            f'<!-- </{tag}> -->', f'<?note </{tag}> ?>')
        out.append({'id': 'pi-' + tag, 'xml': pi, 'equivalentTo': 'synthetic-original'})
        cdata = synthetic.replace('<Name>Cave Entrance</Name>',
                                 f'<Name><![CDATA[Cave <{tag}>literal</{tag}> Entrance]]></Name>')
        out.append({'id': 'cdata-name-' + tag, 'xml': cdata,
                    'expectedName': f'Cave <{tag}>literal</{tag}> Entrance'})
    # Apparent closers inside opaque CDATA/comments must not terminate that subtree.
    for tag in ('Icon', 'GameIcon', 'AutoSplitterSettings'):
        payload = f'<{tag}><![CDATA[</{tag}>]]><!-- </{tag}> --><Setting>A</Setting></{tag}>'
        old = '<Icon />' if tag == 'Icon' else '<GameIcon />'
        xml = synthetic.replace(old, payload, 1) if tag != 'AutoSplitterSettings' else synthetic.replace('</Run>', payload + '</Run>')
        out.append({'id': 'opaque-literal-closers-' + tag, 'xml': xml, 'equivalentTo': 'synthetic-original'})
    for tag in ('GameIcon', 'Icon', 'AutoSplitterSettings'):
        bad = f'<{tag}><Unclosed></{tag}>'
        old = '<Icon />' if tag == 'Icon' else '<GameIcon />'
        xml = synthetic.replace(old, bad, 1) if tag != 'AutoSplitterSettings' else synthetic.replace('</Run>', bad + '</Run>')
        out.append({'id': 'malformed-opaque-' + tag, 'xml': xml, 'expected': 'rejected'})
    out.append({'id': 'nested-icon-in-name', 'xml': synthetic.replace('<Name>Cave Entrance</Name>', '<Name>Cave <Icon>nested</Icon> Entrance</Name>'), 'expected': 'rejected'})
    for source in ('destrega', 'zero-divide-2'):
        original = (ROOT / f'examples/recorded/{source}.lss').read_bytes().decode('utf-8')
        identity = source + '-original'
        out.append({'id': identity, 'xml': original, 'equivalentTo': identity})
        for tag in ('Icon', 'GameIcon', 'AutoSplitterSettings'):
            parts = original.split('<Segment>')
            index, attempt = (15, 58) if source == 'destrega' else (0, 124)
            parts[index + 1], count = re.subn(
                rf'(<Time id="{attempt}">[\s\S]*?</Time>)',
                f'<!-- <{tag}> -->\\1<!-- </{tag}> -->', parts[index + 1], count=1)
            assert count == 1
            changed = '<Segment>'.join(parts)
            out.append({'id': source + '-comment-' + tag, 'xml': changed, 'equivalentTo': identity})
    return out


if __name__ == '__main__':
    for case in cases():
        print(json.dumps(case, ensure_ascii=False))
