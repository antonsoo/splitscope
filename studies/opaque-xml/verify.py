"""Replay XML-boundary controls with Expat and a pinned LiveSplit reference.

Python's independent XML parser establishes annotation equivalence. The native
reference establishes baseline values; it rejects the annotated XML forms.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from inputs import ROOT, cases

BASELINE = '403d5c6e87265a409758ff4cd4ad1a69128c893e'
REFERENCE = 'fb62dd42505b16e813d2779468d81bbad7f01b5e'


def h(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def structural(root: ET.Element) -> bytes:
    root = copy.deepcopy(root)
    for tag in ('GameIcon', 'AutoSplitterSettings'):
        for element in root.findall(tag):
            root.remove(element)
    for segment in root.findall('Segments/Segment'):
        for icon in segment.findall('Icon'):
            segment.remove(icon)
    return ET.tostring(root, encoding='utf-8')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--oracle', type=Path, required=True)
    parser.add_argument('--out', type=Path, default=Path(__file__).parent / 'results')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    # Do not accidentally compare against another checkout with the same version.
    baseline_sources = {}
    paths = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', BASELINE, 'src/core'], cwd=ROOT, text=True).splitlines()
    for relative in paths:
        expected = subprocess.check_output(['git', 'show', f'{BASELINE}:{relative}'], cwd=ROOT)
        actual = (args.baseline / relative).read_bytes()
        assert actual == expected, relative
        baseline_sources[relative] = h(actual)
    controls = cases()
    raw = ''.join(json.dumps(case, ensure_ascii=False) + '\n' for case in controls)
    outputs = {}
    for name, command in [
        ('before', ['node', '--import', 'tsx', 'studies/xml-evidence/analyze.ts', str(args.baseline.resolve())]),
        ('after', ['node', '--import', 'tsx', 'studies/xml-evidence/analyze.ts', str(ROOT)]),
        ('upstream', [str(args.oracle.resolve())]),
    ]:
        result = subprocess.run(command, cwd=ROOT, input=raw, capture_output=True, text=True, check=True)
        assert not result.stderr, result.stderr
        (args.out / (name + '.jsonl')).write_text(result.stdout)
        outputs[name] = {r['id']: r for r in map(json.loads, result.stdout.splitlines())}
    by_id = {c['id']: c for c in controls}
    manifest, results = [], []
    for case in controls:
        identity = case['id']
        before, after, native = (outputs[name][identity] for name in ('before', 'after', 'upstream'))
        try:
            tree = ET.fromstring(case['xml'])
            well_formed = True
        except ET.ParseError:
            tree = None
            well_formed = False
        if case.get('expected') == 'rejected':
            passes_before = before['status'] == 'rejected'
            assert after['status'] == 'rejected', identity
            equivalence = 'application rejects'
        else:
            assert tree is not None, identity
            original = case.get('equivalentTo', 'synthetic-original')
            original_tree = ET.fromstring(by_id[original]['xml'])
            expected_run = copy.deepcopy(outputs['upstream'][original]['run'])
            if 'expectedName' in case:
                assert tree.findtext('Segments/Segment/Name') == case['expectedName']
                tree.find('Segments/Segment/Name').text = original_tree.findtext('Segments/Segment/Name')
                expected_run['segments'][0]['name'] = case['expectedName']
            assert structural(tree) == structural(original_tree), identity
            expected_totals = outputs['upstream'][original]['totals']
            def same_totals(values):
                return values is not None and all(
                    a is b if a is None or b is None else math.isclose(a, b, rel_tol=0, abs_tol=1e-9)
                    for a, b in zip(values, expected_totals, strict=True))
            passes_before = before.get('run') == expected_run and same_totals(before.get('totals'))
            assert after.get('run') == expected_run and same_totals(after.get('totals')), identity
            equivalence = 'independent Expat tree plus native original data'
        results.append({
            'id': identity, 'xmlWellFormedByExpat': well_formed,
            'beforeMeetsContract': passes_before, 'afterMeetsContract': True,
            'referenceAcceptsExactInput': 'run' in native, 'oracle': equivalence,
            'beforeStatus': before['status'], 'afterStatus': after['status'],
            'beforeTotals': before.get('totals'), 'afterTotals': after.get('totals'),
        })
        manifest.append({**{k: v for k, v in case.items() if k != 'xml'},
                         'bytes': len(case['xml'].encode()), 'sha256': h(case['xml'].encode())})
    receipt = {
        'date': '2026-10-15', 'baselineCommit': BASELINE, 'referenceCommit': REFERENCE,
        'referenceTotalToleranceSeconds': 1e-9, 'referenceExecutableSha256': h(args.oracle.read_bytes()),
        'baselineSources': baseline_sources, 'controls': len(results),
        'beforePassing': sum(r['beforeMeetsContract'] for r in results),
        'afterPassing': len(results), 'exactInputAcceptedByReference': sum(r['referenceAcceptsExactInput'] for r in results),
        'referenceLimitation': 'The pinned reference rejects annotated forms. Expat establishes their XML equivalence; original native records establish expected values.',
        'cases': results,
    }
    (args.out / 'controls.json').write_text(json.dumps(receipt, indent=2) + '\n')
    (args.out / 'inputs.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f"Controlled contracts: {receipt['beforePassing']}/{len(results)} -> {len(results)}/{len(results)}")
    print('Independent Expat equivalence verified; native direct-input limitations retained.')


if __name__ == '__main__':
    main()
