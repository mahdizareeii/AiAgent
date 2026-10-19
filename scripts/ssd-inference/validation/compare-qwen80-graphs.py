"""Private, read-only comparison of existing computational fixture outputs.

This never launches inference. It checks numerical diagnostics for two retained
Qwen hybrid layers and does not establish full-model correctness or language quality.
"""
import array
import collections
import fcntl
import hashlib
import heapq
import json
import math
import os
import pathlib
import re
import sys
import struct

PATCH = None
FIXTURE = None
PROFILE = {'backend':'cpu','contextTokens':8192,'outputTokens':2048,'batchTokens':64,'microBatchTokens':16,
           'cacheSlotsPerLayer':30,'cacheTypeK':'f16','cacheTypeV':'f16','swaFull':False,'slots':1,'ioWorkers':2,
           'ioMode':'darwin-nocache','decodeThreads':4,'batchThreads':4,'cpuKernel':'standard','useExtraBufts':False,'cpuRepackTensorCount':0,'kvUnified':True,'nRsSeq':0,'checkpoints':0}
RESOLVED_NATIVE_LAYOUT = {'contextTokens':8192,'contextPerSequence':8192,'batchTokens':64,'microBatchTokens':16,'slots':1,'kvUnified':True,'nRsSeq':0,'cacheTypeK':'f16','cacheTypeV':'f16'}
CAP = 32 * 1024**2
ABS_TOL = 1e-5
REL_TOL = 1e-5
DIAGNOSTIC_EVIDENCE_VERSION = 2
RESIDUAL_ALIAS_CONTRACT = 'qwen3next-residual-add-no-cvec-v1'
DIAGNOSTIC_SOURCE_SHA256 = hashlib.sha256(pathlib.Path(__file__).with_name('qwen80-graph-parity.cpp').read_bytes()).hexdigest()
REF_FIELDS = {'caseId', 'step', 'name', 'occurrence'}
WITNESS_FIELDS = {'schemaVersion', 'caseId', 'step', 'layer', 'semanticName', 'capture', 'operands',
                  'semanticTensorId', 'capturedTensorId', 'nativeParentTensorIds', 'nativeOperation',
                  'sameTensor', 'controlVectorApplied'}


class Evidence:
    def __init__(self, path):
        self.path = pathlib.Path(path)
        self.report = json.loads(self.path.read_text())
        assert self.report['patchSha256'] == PATCH
        assert self.report['fixtureSha256'] == FIXTURE
        assert self.report['sourceArtifactSetDigest'] == '3d0fd1c8ad6c37fdac38e20b02de80149a5d93b8c457c39e8a27100c8bf62d64'
        assert self.report['sourceTemplateSha256'] == '0b5c439b5b14126c0ae8b14ca93240c3cef1e7e29d684102b07f10727523dbdb'
        assert self.report['inferenceExecuted'] is True
        assert self.report['schemaVersion'] == 1 and self.report['baseCommit'] == 'd81235049384534c167caea52b85a694f6103d14'
        assert self.report['workerPatchSha256'] == PATCH
        assert type(self.report['diagnosticEvidenceVersion']) is int and self.report['diagnosticEvidenceVersion'] == DIAGNOSTIC_EVIDENCE_VERSION
        assert self.report['diagnosticSourceSha256'] == DIAGNOSTIC_SOURCE_SHA256
        assert self.report['residualAliasContract'] == RESIDUAL_ALIAS_CONTRACT
        assert self.report['profile'] == PROFILE
        assert self.report['resolvedNativeLayout']==RESOLVED_NATIVE_LAYOUT
        assert self.report['plan']['resolvedNativeLayout']==RESOLVED_NATIVE_LAYOUT
        assert self.report['run']['resolvedNativeLayout']==RESOLVED_NATIVE_LAYOUT
        assert self.report['admitted'] is True
        assert self.report['useExtraBufts'] is False and self.report['matchedKernelControl'] is True
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
            'ffn_moe_out', 'ffn_moe', 'ffn_moe_combined', 'ffn_shexp',
            'shared_expert_gate', 'shared_expert_gate_sigmoid', 'ffn_shexp_gated',
            'ffn_out', 'post_moe', 'attn_residual', 'linear_attn_out', 'attn_output',
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
            assert all(0 <= x < 30 for x in streamed.data(node))
    results = []
    for key, nodes in sorted(groups.items()):
        sums = None
        empty = active = 0
        for node in nodes:
            values = streamed.data(node)
            assert all(x in (0.0, 1.0) for x in values)
            wave_ids = streamed.data(ids[key + (node['occurrence'],)])
            assert len(wave_ids) == len(values) and all(0 <= x < 30 for x in wave_ids)
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


def residual_alias_checks(evidence):
    """Validate native pointer witnesses and independently check their measured ADD.

    post_moe is a semantic role of the captured l_out tensor, not a fabricated
    second capture. Its actual two operands are retained and compared normally.
    """
    assert type(evidence.report.get('diagnosticEvidenceVersion')) is int and evidence.report['diagnosticEvidenceVersion'] == DIAGNOSTIC_EVIDENCE_VERSION
    assert evidence.report.get('diagnosticSourceSha256') == DIAGNOSTIC_SOURCE_SHA256
    assert evidence.report.get('residualAliasContract') == RESIDUAL_ALIAS_CONTRACT
    indexed = {identity(n): n for n in evidence.nodes}
    positions = {identity(n): i for i, n in enumerate(evidence.nodes)}
    assert len(indexed) == len(evidence.nodes), 'duplicated actual capture identity'
    expected = {(ci, si, layer): (count if si == 0 else 1)
                for ci, count in enumerate((1, 3, 4, 5, 16, 16))
                for si in range(3 if ci >= 4 else 1) for layer in (0, 1)}
    witnesses = evidence.report['run'].get('residualAliasWitnesses')
    assert isinstance(witnesses, list) and len(witnesses) == 20, 'twenty actual residual alias witnesses per mode required'
    seen, results = set(), []
    def ref_key(ref):
        assert isinstance(ref, dict) and set(ref) == REF_FIELDS
        assert all(type(ref[k]) is int for k in ('caseId', 'step', 'occurrence')) and isinstance(ref['name'], str)
        return identity(ref)
    for witness in witnesses:
        assert isinstance(witness, dict) and set(witness) == WITNESS_FIELDS
        assert type(witness['schemaVersion']) is int and witness['schemaVersion'] == 1
        assert all(type(witness[k]) is int for k in ('caseId', 'step', 'layer'))
        key = witness['caseId'], witness['step'], witness['layer']
        assert key in expected and key not in seen, 'missing/duplicate/wrong-step residual alias witness'
        seen.add(key); ci, si, layer = key
        assert witness['semanticName'] == f'post_moe-{layer}' and witness['nativeOperation'] == 'ADD'
        assert witness['sameTensor'] is True and witness['controlVectorApplied'] is False
        output_key = ref_key(witness['capture'])
        assert output_key == (ci, si, f'l_out-{layer}', 0)
        assert (ci, si, f'post_moe-{layer}', 0) not in indexed, 'alias evidence must not fabricate a post_moe capture'
        refs = witness['operands']; assert isinstance(refs, list) and len(refs) == 2
        parent_keys = [ref_key(ref) for ref in refs]
        assert parent_keys == [(ci, si, f'ffn_out-{layer}', 0), (ci, si, f'attn_residual-{layer}', 0)]
        assert all(k in indexed for k in [output_key, *parent_keys])
        assert all(positions[k] < positions[output_key] for k in parent_keys), 'parents must be earlier current-step captures'
        output, left, right = [indexed[k] for k in [output_key, *parent_keys]]
        for node in (output, left, right):
            assert node['type'] == 'f32' and node['dimensions'] == [2048, expected[key], 1, 1]
            assert all(type(d) is int for d in node['dimensions'])
            assert node['bytes'] == 2048 * expected[key] * 4 and node['nonfinite'] == 0
            assert node.get('nativeContiguous') is True and node.get('nativeView') is False
            assert type(node.get('nativeTensorId')) is int and 0 < node['nativeTensorId'] < 2**31
        native_ids = [n['nativeTensorId'] for n in (output, left, right)]
        assert len(set(native_ids)) == 3
        assert type(witness['semanticTensorId']) is int and type(witness['capturedTensorId']) is int
        assert witness['semanticTensorId'] == witness['capturedTensorId'] == native_ids[0]
        assert witness['nativeParentTensorIds'] == native_ids[1:] == output.get('nativeParentTensorIds')
        assert isinstance(witness['nativeParentTensorIds'], list) and isinstance(output.get('nativeParentTensorIds'), list)
        assert all(type(n) is int for n in witness['nativeParentTensorIds'] + output['nativeParentTensorIds'])
        assert output.get('nativeOperation') == 'ADD'
        values_out, values_left, values_right = [evidence.data(n) for n in (output, left, right)]
        assert len(values_out) == len(values_left) == len(values_right) == output['bytes'] // 4
        outside = 0; max_abs = max_rel = sq = 0.0
        for actual, a, b in zip(values_out, values_left, values_right):
            assert all(math.isfinite(x) for x in (actual, a, b))
            try:
                reference = struct.unpack('<f', struct.pack('<f', a + b))[0]
            except (OverflowError, struct.error):
                raise AssertionError('binary32 residual ADD overflow')
            assert math.isfinite(reference), 'nonfinite binary32 residual ADD'
            delta = abs(actual - reference)
            outside += delta > ABS_TOL + REL_TOL * abs(reference)
            max_abs = max(max_abs, delta); max_rel = max(max_rel, delta / max(1e-12, abs(reference))); sq += delta * delta
        results.append({'caseId': ci, 'step': si, 'layer': layer, 'semanticName': witness['semanticName'],
                        'captureName': output['name'], 'passed': outside == 0, 'elements': len(values_out),
                        'elementsOutsideTolerance': outside, 'maxAbsoluteDifference': max_abs,
                        'maxRelativeDifference': max_rel, 'rootMeanSquaredDifference': math.sqrt(sq / len(values_out))})
    assert seen == expected.keys(), 'complete post_moe and l_out semantic coverage required'
    return results


def complete_evidence(evidence):
    cases = evidence.report['run']['cases']
    assert [case['caseId'] for case in cases] == list(range(6))
    assert [len(case['prefillTokens']) for case in cases] == [1, 3, 4, 5, 16, 16]
    nodes = {identity(node): node for node in evidence.nodes}
    residuals = residual_alias_checks(evidence)
    residual_keys = {(r['caseId'], r['step'], r['layer']) for r in residuals}
    for case in cases:
        assert len(case['steps']) == (3 if case['caseId'] in (4, 5) else 1)
        for step in case['steps']:
            ci, si, tokens = case['caseId'], step['step'], step['tokens']
            for layer in (0, 1):
                for name in ('ffn_moe_argsort', 'ffn_moe_topk', 'ffn_moe_weights_norm',
                             'ffn_moe_out', 'ffn_shexp',
                             'shared_expert_gate_sigmoid', 'ffn_shexp_gated', 'ffn_out', 'attn_residual', 'post_moe', 'l_out'):
                    if name == 'post_moe':
                        assert (ci, si, layer) in residual_keys, 'native post_moe alias evidence missing'
                    else:
                        assert (ci, si, f'{name}-{layer}', 0) in nodes, 'required per-layer diagnostic is missing'
                if evidence.report['mode'] == 'streamed':
                    if tokens <= 3:
                        assert (ci, si, f'ffn_moe_topk_stream-{layer}', 0) in nodes
                    else:
                        for wave in range(tokens):
                            assert (ci, si, f'ffn_moe_wave_ids-{layer}', wave) in nodes
                            assert (ci, si, f'ffn_moe_wave_mask-{layer}', wave) in nodes
            assert (ci, si, 'linear_attn_out-0', 0) in nodes
            assert (ci, si, 'attn_output-1', 0) in nodes
            assert (ci, si, 'result_output', 0) in nodes
            for token in range(tokens):
                node = nodes[ci, si, f'API_logits_output_{token}', 0]
                assert node['dimensions'] == [151936, 1, 1, 1] and node['bytes'] == 607744
    return residuals


def main():
    global PATCH, FIXTURE
    assert len(sys.argv) == 8 and sys.argv[1] == '--expected-patch-sha256' and sys.argv[3] == '--fixture-sha256', '--expected-patch-sha256 PATCH --fixture-sha256 FIXTURE ordinary.json streamed.json new-output.json'
    PATCH = sys.argv[2]
    assert re.fullmatch(r'[0-9a-f]{64}', PATCH)
    FIXTURE = sys.argv[4]
    assert re.fullmatch(r'[0-9a-f]{64}', FIXTURE)
    assert PATCH == '83139a4fbe858827d75f5050defefa69413718c45335ca5c18e49919c3944bb8'
    sys.argv = [sys.argv[0]] + sys.argv[5:]
    ordinary, streamed = Evidence(sys.argv[1]), Evidence(sys.argv[2])
    output = pathlib.Path(sys.argv[3])
    assert not output.exists()
    assert ordinary.report['mode'] == 'ordinary' and streamed.report['mode'] == 'streamed'
    residuals_ordinary = complete_evidence(ordinary)
    residuals_streamed = complete_evidence(streamed)
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
    residuals = residuals_ordinary + residuals_streamed
    passed = all(item['passed'] for item in compared + residuals) and all(item['allSelectedPairsContributeOnce'] for item in waves)
    result = {
        'schemaVersion': 1, 'profile': PROFILE, 'resolvedNativeLayout':ordinary.report['resolvedNativeLayout'], 'protocol': 'qwen80-standard-cpu-hybrid-v2-8k',
        'diagnosticEvidenceVersion': DIAGNOSTIC_EVIDENCE_VERSION, 'diagnosticSourceSha256': DIAGNOSTIC_SOURCE_SHA256,
        'residualAliasContract': RESIDUAL_ALIAS_CONTRACT,
        'residualAliasEvidence': {'schemaVersion': 1, 'ordinary': residuals_ordinary, 'streamed': residuals_streamed},
        'firstFailedResidual': next((dict(mode=mode, **row) for mode, rows in [('ordinary', residuals_ordinary), ('streamed', residuals_streamed)] for row in rows if not row['passed']), None),
        'nonfinite':0, 'elementsOutsideTolerance':sum(n.get('elementsOutsideTolerance',0) for n in compared),
        'mismatchedIds':sum(n.get('mismatchedIds',0) for n in compared),
        'scope': 'Two original Qwen hybrid layers (0 recurrent, 3 full-attention), remapped 0/1: standard CPU ordinary versus SSD graph. No full48-layer, Metal, language or coding-quality claim.',
        'fixtureSha256': FIXTURE, 'patchSha256': PATCH,
        'absoluteTolerance': ABS_TOL, 'relativeTolerance': REL_TOL,
        'passed': passed, 'completeEvidenceForAllSixCasesTenStepsTwoLayers': True,
        'nodesCompared': len(compared),
        'elementsCompared': sum(item['elements'] for item in compared),
        'firstFailedNode': next((item for item in compared if not item['passed']), None),
        'ordinaryReport': str(ordinary.path), 'streamedReport': str(streamed.path),
        'nodes': compared, 'waves': waves, 'streamedOriginalIdCopies': copies,
        'remainingCoverageGaps': [
            'Original recurrent chain depth and other attention/recurrent layer positions',
            'All 48 transformer layers and accumulated numerical drift',
            'Long-context positions and complete2048-token generation; cases use short teacher-forced sequences inside8K capacity',
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
