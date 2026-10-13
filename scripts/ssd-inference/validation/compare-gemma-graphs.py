"""Private, read-only comparison of existing computational fixture outputs.

This never launches inference. It checks numerical diagnostics for two retained
Gemma layers and does not establish full-model correctness or language quality.
"""
import array
import collections
import fcntl
import heapq
import json
import math
import os
import pathlib
import re
import sys

PATCH = None
FIXTURE = '40928e674a3801e81e230acb6b9cfefd4a3648d05cb93b959626f2241a5a7fa1'
CAP = 32 * 1024**2
ABS_TOL = 1e-5
REL_TOL = 1e-5


class Evidence:
    def __init__(self, path):
        self.path = pathlib.Path(path)
        self.report = json.loads(self.path.read_text())
        assert self.report['patchSha256'] == PATCH
        assert self.report['fixtureSha256'] == FIXTURE
        assert self.report['inferenceExecuted'] is True
        self.fd = os.open(self.path.with_suffix('.bin'), os.O_RDONLY | os.O_NOFOLLOW)
        fcntl.fcntl(self.fd, 48, 1)  # F_NOCACHE
        fcntl.fcntl(self.fd, 45, 0)  # F_RDAHEAD
        self.fingerprint = os.fstat(self.fd)
        self.nodes = self.report['run']['captures']
        assert all(node['nonfinite'] == 0 for node in self.nodes)

    def close(self):
        now = os.fstat(self.fd)
        fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        assert all(getattr(now, key) == getattr(self.fingerprint, key) for key in fields)
        os.close(self.fd)

    def data(self, node):
        assert 0 <= node['bytes'] <= CAP
        assert 0 <= node['offset'] <= self.fingerprint.st_size - node['bytes']
        value = array.array('f' if node['type'] == 'f32' else 'i')
        assert node['type'] in ('f32', 'i32') and value.itemsize == 4
        offset, left = node['offset'], node['bytes']
        while left:
            block = os.pread(self.fd, min(left, 1024**2), offset)
            assert block and len(block) % 4 == 0
            value.frombytes(block)
            offset, left = offset + len(block), left - len(block)
        return value


def identity(node):
    return node['caseId'], node['step'], node['name'], node['occurrence']


def common_node(name):
    if re.fullmatch(r'ffn_moe_topk-\d+ \(cont\)', name):
        return False  # SSD-only materialization is verified against original IDs below.
    return (
        name.startswith('API_logits_output_')
        or name.startswith('l_out-')
        or name in ('result_output', 'result_norm')
        or any(name.startswith(prefix + '-') for prefix in (
            'ffn_moe_argsort', 'ffn_moe_logits', 'ffn_moe_probs',
            'ffn_moe_topk', 'ffn_moe_weights', 'ffn_moe_weights_norm',
            'ffn_moe_out', 'ffn_moe', 'ffn_moe_combined',
        ))
    )


def numeric_compare(a, b, left, right):
    assert a['type'] == b['type'] and a['dimensions'] == b['dimensions']
    va, vb = left.data(a), right.data(b)
    assert len(va) == len(vb)
    if a['type'] == 'i32':
        count = sum(x != y for x, y in zip(va, vb))
        return {'passed': count == 0, 'elements': len(va), 'mismatchedIds': count}
    max_abs = max_rel = sq = 0.0
    outside = 0
    for x, y in zip(va, vb):
        assert math.isfinite(x) and math.isfinite(y)
        delta = abs(x - y)
        max_abs = max(max_abs, delta)
        max_rel = max(max_rel, delta / max(1e-12, abs(x)))
        sq += delta * delta
        outside += delta > ABS_TOL + REL_TOL * abs(x)
    result = {
        'passed': outside == 0, 'elements': len(va),
        'maxAbsoluteDifference': max_abs, 'maxRelativeDifference': max_rel,
        'rootMeanSquaredDifference': math.sqrt(sq / max(1, len(va))),
        'elementsOutsideTolerance': outside,
    }
    if a['name'].startswith('API_logits_output_'):
        ka = heapq.nlargest(5, range(len(va)), key=va.__getitem__)
        kb = heapq.nlargest(5, range(len(vb)), key=vb.__getitem__)
        result.update({'top5IdsOrdinary': ka, 'top5IdsStreamed': kb,
                       'top1Agreement': ka[0] == kb[0], 'top5Agreement': ka == kb})
    return result


def wave_checks(streamed):
    groups = collections.defaultdict(list)
    ids = {}
    for node in streamed.nodes:
        if node['name'].startswith('ffn_moe_wave_mask-'):
            layer = int(node['name'].rsplit('-', 1)[1])
            groups[node['caseId'], node['step'], layer].append(node)
        elif node['name'].startswith('ffn_moe_wave_ids-'):
            layer = int(node['name'].rsplit('-', 1)[1])
            ids[node['caseId'], node['step'], layer, node['occurrence']] = node
        elif node['name'].startswith('ffn_moe_topk_stream-'):
            assert all(0 <= x < 24 for x in streamed.data(node))
    results = []
    for key, nodes in sorted(groups.items()):
        sums = None
        empty = active = 0
        for node in nodes:
            values = streamed.data(node)
            assert all(x in (0.0, 1.0) for x in values)
            wave_ids = streamed.data(ids[key + (node['occurrence'],)])
            assert len(wave_ids) == len(values) and all(0 <= x < 24 for x in wave_ids)
            if sums is None:
                sums = [0.0] * len(values)
            assert len(values) == len(sums)
            for i, x in enumerate(values):
                sums[i] += x
            empty += not any(values)
            active += any(values)
        results.append({'caseId': key[0], 'step': key[1], 'layer': key[2],
                        'graphWaveCount': len(nodes), 'activeWaves': active,
                        'emptyTrailingWaves': empty,
                        'allSelectedPairsContributeOnce': all(x == 1.0 for x in sums)})
    return results


def complete_evidence(evidence):
    cases = evidence.report['run']['cases']
    assert [case['caseId'] for case in cases] == list(range(6))
    assert [len(case['prefillTokens']) for case in cases] == [1, 3, 4, 5, 16, 16]
    nodes = {identity(node): node for node in evidence.nodes}
    for case in cases:
        assert len(case['steps']) == (3 if case['caseId'] in (4, 5) else 1)
        for step in case['steps']:
            ci, si, tokens = case['caseId'], step['step'], step['tokens']
            for layer in (0, 1):
                for name in ('ffn_moe_argsort', 'ffn_moe_topk', 'ffn_moe_weights_norm',
                             'ffn_moe_out', 'ffn_moe_combined', 'l_out'):
                    assert (ci, si, f'{name}-{layer}', 0) in nodes, 'required per-layer diagnostic is missing'
                if evidence.report['mode'] == 'streamed':
                    if tokens <= 3:
                        assert (ci, si, f'ffn_moe_topk_stream-{layer}', 0) in nodes
                    else:
                        for wave in range(tokens):
                            assert (ci, si, f'ffn_moe_wave_ids-{layer}', wave) in nodes
                            assert (ci, si, f'ffn_moe_wave_mask-{layer}', wave) in nodes
            assert (ci, si, 'result_output', 0) in nodes
            for token in range(tokens):
                node = nodes[ci, si, f'API_logits_output_{token}', 0]
                assert node['dimensions'] == [262144, 1, 1, 1] and node['bytes'] == 1048576


def main():
    global PATCH
    assert len(sys.argv) == 6 and sys.argv[1] == '--expected-patch-sha256', '--expected-patch-sha256 PATCH ordinary.json streamed.json new-output.json'
    PATCH = sys.argv[2]
    assert re.fullmatch(r'[0-9a-f]{64}', PATCH)
    sys.argv = [sys.argv[0]] + sys.argv[3:]
    ordinary, streamed = Evidence(sys.argv[1]), Evidence(sys.argv[2])
    output = pathlib.Path(sys.argv[3])
    assert not output.exists()
    assert ordinary.report['mode'] == 'ordinary' and streamed.report['mode'] == 'streamed'
    complete_evidence(ordinary)
    complete_evidence(streamed)
    for left, right in zip(ordinary.report['run']['cases'], streamed.report['run']['cases']):
        assert left['prefillTokens'] == right['prefillTokens']
    nodes_a = {identity(node): node for node in ordinary.nodes if common_node(node['name'])}
    nodes_b = {identity(node): node for node in streamed.nodes if common_node(node['name'])}
    copies = []
    originals_streamed = {identity(node): node for node in streamed.nodes}
    for node in streamed.nodes:
        if re.fullmatch(r'ffn_moe_topk-\d+ \(cont\)', node['name']):
            source_name = node['name'].removesuffix(' (cont)')
            source = originals_streamed[node['caseId'], node['step'], source_name, 0]
            compared_copy = numeric_compare(source, node, streamed, streamed)
            assert compared_copy['passed'], 'SSD contiguous topK must preserve original expert IDs'
            copies.append({'caseId': node['caseId'], 'step': node['step'], 'name': node['name'], **compared_copy})
    missing = sorted(set(nodes_a) ^ set(nodes_b))
    assert not missing, f'common graph diagnostics do not align: {missing}'
    compared = []
    for key, a in nodes_a.items():
        b = nodes_b[key]
        result = numeric_compare(a, b, ordinary, streamed)
        compared.append({'caseId': key[0], 'step': key[1], 'name': key[2],
                         'occurrence': key[3], **result})
    assert any(item['name'].startswith('API_logits_output_') for item in compared)
    assert any(item['name'].startswith('ffn_moe_argsort-') for item in compared)
    assert any(item['name'].startswith('ffn_moe_out-') for item in compared)
    assert any(item['name'].startswith('l_out-') for item in compared)
    waves = wave_checks(streamed)
    passed = all(item['passed'] for item in compared) and all(item['allSelectedPairsContributeOnce'] for item in waves)
    result = {
        'scope': 'Two original Gemma SWA layers only: CPU ordinary versus CPU SSD waved graph. No full-model, global-attention, Metal, language or task-quality claim.',
        'fixtureSha256': FIXTURE, 'patchSha256': PATCH,
        'absoluteTolerance': ABS_TOL, 'relativeTolerance': REL_TOL,
        'passed': passed, 'completeEvidenceForAllSixCasesTenStepsTwoLayers': True,
        'nodesCompared': len(compared),
        'elementsCompared': sum(item['elements'] for item in compared),
        'firstFailedNode': next((item for item in compared if not item['passed']), None),
        'ordinaryReport': str(ordinary.path), 'streamedReport': str(streamed.path),
        'nodes': compared, 'waves': waves, 'streamedOriginalIdCopies': copies,
        'remainingCoverageGaps': [
            'Full-attention layers and global rope frequencies',
            'All 30 transformer layers and accumulated numerical drift',
            'Metal execution and uploads', 'Full-model Chat/tool/Agent quality',
        ],
    }
    ordinary.close()
    streamed.close()
    with output.open('x') as file:
        json.dump(result, file, indent=2)
        file.write('\n')
    print(json.dumps({key: value for key, value in result.items() if key not in ('nodes', 'waves')}))
    return 0 if passed else 1


if __name__ == '__main__':
    sys.exit(main())
