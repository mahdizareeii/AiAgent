"""Offline rejection tests for the DISABLED converter. No real certificate is made.

Positive records here exist only in memory and are explicitly unit-test fixtures.
No model, native process, native hash, download, or production resource is opened.
"""
import copy
import importlib.util
import json
import math
import os
import pathlib
import struct
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('draft_qwen80_converter', HERE / 'convert-qwen80-certificate.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
MANIFEST, HELPER = 'a' * 64, 'b' * 64


def fake_fp(size):
    return dict(device=1, inode=2, sizeBytes=size, mtimeSeconds=1, mtimeNanoseconds=0,
                ctimeSeconds=1, ctimeNanoseconds=0)


def hash_record(size, sha, fp):
    return dict(schemaVersion=1, helperIdentity='free-local-agent-ssd-hash-v1', baseCommit=c.BASE,
                patchSha256=c.PATCH, helperSourceSha256=HELPER, sha256=sha,
                sizeBytes=size, bytesRead=size, ioMode='darwin-nocache', bufferBytes=c.MiB,
                fingerprint=fp, rssBytes=c.MiB, physicalFootprintBytes=c.MiB,
                availableRamBytes=2 * c.GiB, memoryPressure='normal')


def source_fixture():
    rows = [dict(row, path='/pure-in-memory/' + row['filename'], bytesRead=row['sizeBytes'],
                 ioMode='darwin-nocache', fingerprint=fake_fp(row['sizeBytes'])) for row in c.ARTIFACTS]
    source = dict(schemaVersion=1, completeVerifiedSource=True, baseCommit=c.BASE, patchSha256=c.PATCH,
                  resourceManifestSha256=MANIFEST, artifactSetDigest=c.SET_DIGEST, templateSha256=c.TEMPLATE,
                  repository='Qwen/Qwen3-Coder-Next-GGUF', revision=c.REVISION, architecture='qwen3next',
                  geometry=dict(c.GEOMETRY), artifacts=rows)
    hashes = [hash_record(row['sizeBytes'], row['sha256'], row['fingerprint']) for row in rows]
    return source, hashes


def fixture_fixture():
    rows = []
    for name in ['token_embd.weight', 'output.weight', 'output_norm.weight'] + [
            f'blk.{layer}.ffn_{kind}_exps.weight' for layer in (0, 3) for kind in ('down', 'gate', 'up')]:
        rows.append(dict(name=name, destinationName=name.replace('blk.3.', 'blk.1.'), sourceShard=0,
                         sizeBytes=4, sourceOffset=0, destinationOffset=0,
                         sourceCopiedSha256='c' * 64, destinationVerifiedSha256='c' * 64))
    value = dict(schemaVersion=1, sourceArtifactSetDigest=c.SET_DIGEST, sourceTemplateSha256=c.TEMPLATE,
                 nativePatchSha256=c.PATCH, resourceManifestSha256=MANIFEST, selectedOriginalLayers=[0, 3],
                 recurrentLayers=[True, False], sourceFingerprintUnchanged=True, inferenceExecuted=False,
                 copyBufferBytes=c.MiB, fixtureSha256='d' * 64, fixtureSizeBytes=1024,
                 fixturePath='/pure-in-memory/private-fixture.gguf', fixtureFingerprint=fake_fp(1024), tensors=rows)
    return value, hash_record(1024, value['fixtureSha256'], value['fixtureFingerprint'])


def process_fixture():
    return dict(schemaVersion=1, evidenceKind='measured-native-qwen80-proof', protocol=c.PROTOCOL,
                scope=c.SCOPE, passed=True, issuedAppCertificate=False, fullModelLoaded=False,
                baseCommit=c.BASE, patchSha256=c.PATCH, resourceManifestSha256=MANIFEST,
                artifactSetDigest=c.SET_DIGEST, templateSha256=c.TEMPLATE, resourcesVerified=True,
                sourceFingerprintUnchanged=True, ownedProcessesStopped=True, profile=dict(c.RUN_PROFILE),
                diagnosticEvidenceVersion=2, evidenceInventoryComplete=True,
                build=dict(binaries=[dict(path='/pure-in-memory/'+name, sha256='a'*64,
                    sourceSha256=c.hashlib.sha256((HERE/(name+'.cpp')).read_bytes()).hexdigest())
                    for name in ('qwen80-expert-parity','qwen80-graph-parity')]),
                resolvedNativeLayout=dict(c.RESOLVED_NATIVE_LAYOUT),
                steps=[dict(name=name, exitCode=0, stopReason=None, wallSeconds=1.0) for name in c.STEPS],
                resourceSamples=[dict(pressureLevel=1, availableRamBytes=2 * c.GiB,
                    controllerMemory=dict(rssBytes=c.MiB, physicalFootprintBytes=c.MiB),
                    ownedChildMemory=dict(rssBytes=c.MiB, physicalFootprintBytes=c.MiB))])


def native_kernel():
    return dict(baseCommit=c.BASE, patchSha256=c.PATCH, cpuKernel='standard', useExtraBufts=False,
                cpuRepackTensorCount=0, decodeThreads=4, batchThreads=4)


def native_manifest_fixture():
    return dict(schemaVersion=1, baseCommit=c.BASE, patchSha256=c.PATCH, target='darwin-arm64',
                backends=[dict(id='metal', executable='worker/llama-server-ssd', libraryDirectory='worker', arguments=[]),
                          dict(id='cpu', executable='worker/llama-server-ssd', libraryDirectory='worker', arguments=['--device', 'none'])],
                planner=dict(id='planner', executable='worker/llama-plan-ssd', schemaVersion=1, sourceSha256='c' * 64),
                integrity=dict(id='integrity', executable='worker/llama-hash-ssd', schemaVersion=1, sourceSha256='b' * 64),
                files=[dict(path=p, size=1, sha256='a' * 64) for p in
                       ('worker/libllama.0.dylib', 'worker/libggml.0.dylib', 'worker/libggml-base.0.dylib',
                        'worker/libggml-cpu.0.dylib', 'worker/llama-hash-ssd', 'worker/llama-plan-ssd', 'worker/llama-server-ssd')] +
                      [dict(path='validation/gemma.json', size=1, sha256='d' * 64),
                       dict(path='licenses/LICENSE', size=1, sha256='e' * 64)])


def expert_fixture():
    signature = ''.join(f'.ffn_{kind}_exps.weight:q4_K:512:2048;' for kind in ('down', 'gate', 'up'))
    metadata = dict(groupsSurveyed=48, distinctLayouts=1, representativeGroups=2,
                    layouts=[dict(signature=signature, groups=list(range(48)), firstGroup=0, lastGroup=47)])
    final = dict(passed=True, verifiedModelSha256FromCaller=c.SET_DIGEST, patchSha256=c.PATCH,
                 allocationBudgetBytes=1536 * c.MiB, residentLimitBytes=1664 * c.MiB,
                 llmInferencePerformed=False, checks=100)
    records = [('SSD_PARITY_METADATA', metadata)]
    for layer in (0, 47):
        for kind in ('down', 'gate', 'up'):
            records.append(('SSD_PARITY_TENSOR', dict(name=f'blk.{layer}.ffn_{kind}_exps.weight',
                quantization='q4_K', inputWidth=512, outputWidth=2048, experts=512, actualScaleApplied=False)))
        for name, (tokens, waves) in c.CASES.items():
            records.append(('SSD_PARITY_CASE', dict(name=name, layer=layer, tokens=tokens, waves=waves,
                passed=True, nonfinite=0, elementsOutsideTolerance=0, allSelectedPairsContributeOnce=True,
                rawBytesEqual=True, absoluteTolerance=1e-5, relativeTolerance=1e-5,
                maxAbsoluteDifference=0., maxRelativeDifference=0.)))
        native = dict(native_kernel(), allocationBudgetBytes=1536 * c.MiB, residentLimitBytes=1664 * c.MiB,
                      expectedGroups=1, streamedGroups=1, cacheSlotsPerLayer=30, ioMode='darwin-nocache',
                      stopped=False, deadlineArmed=True, rssBytes=c.MiB, physicalFootprintBytes=c.MiB,
                      sampledAt='2026-10-15T00:00:00Z')
        records.append(('SSD_PARITY_GROUP', dict(layer=layer, passed=True, ordinaryExpertBytes=c.MiB,
            cacheBytes=c.MiB, hits=1, cacheMisses=31, residentMemorySample=native)))
    records.append(('SSD_PARITY_FINAL', final))
    return records, dict(expertParity=final)


def expert_text(records):
    return '\n'.join(prefix + ' ' + json.dumps(row) for prefix, row in records)


def graph_fixture(mode='ordinary'):
    fixture, _ = fixture_fixture()
    plan = dict(noAlloc=True, modelPayloadAllocatedBytes=0, steadyBytes=c.GiB,
                loadingPeakBytes=c.GiB, requiredBytes=c.GiB,
                resolvedNativeLayout=dict(c.RESOLVED_NATIVE_LAYOUT),
                profile=dict(c.RUN_PROFILE, cacheSlotsPerLayer=30 if mode.endswith('streamed') else 0))
    memory = dict(valid=True, pressureLevel=1, availableRamBytes=c.GiB,
                  rssBytes=c.MiB, physicalFootprintBytes=c.MiB)
    report = dict(protocol=c.PROTOCOL, diagnosticEvidenceVersion=2,
                  diagnosticSourceSha256=c.DIAGNOSTIC_SOURCE_SHA256, residualAliasContract=c.RESIDUAL_ALIAS_CONTRACT,
                  patchSha256=c.PATCH, resourceManifestSha256=MANIFEST,
                  fixtureSha256=fixture['fixtureSha256'], sourceArtifactSetDigest=c.SET_DIGEST,
                  sourceTemplateSha256=c.TEMPLATE, useExtraBufts=False, matchedKernelControl=True,
                  mode=mode, admitted=True, inferenceExecuted=not mode.startswith('plan-'),
                  resolvedNativeLayout=dict(c.RESOLVED_NATIVE_LAYOUT),
                  profile=dict(c.RUN_PROFILE), allocationBudgetBytes=3 * c.GiB,
                  residentLimitBytes=7 * c.GiB // 2, plan=plan,
                  initialMeasurement=memory, finalMeasurement=memory)
    if mode.startswith('plan-'):
        return report, 0
    captures, cases, aliases, offset = [], [], [], 0
    def node(ci, step, name, kind='f32', dims=None, occurrence=0):
        nonlocal offset
        dims = dims or [1, 1, 1, 1]
        size = 4
        for d in dims:
            size *= d
        captures.append(dict(caseId=ci, step=step, name=name, occurrence=occurrence,
                             type=kind, dimensions=dims, bytes=size, offset=offset, nonfinite=0))
        offset += size
        return captures[-1]
    for ci, count in enumerate((1, 3, 4, 5, 16, 16)):
        steps = []
        for step in range(3 if ci >= 4 else 1):
            tokens = count if step == 0 else 1
            steps.append(dict(step=step, tokens=tokens, elapsedSeconds=.01))
            for layer in (0, 1):
                residual_nodes = {}
                for name in ('attn_residual', 'ffn_moe_argsort', 'ffn_moe_topk', 'ffn_moe_weights_norm', 'ffn_moe_out',
                             'ffn_shexp', 'shared_expert_gate_sigmoid', 'ffn_shexp_gated', 'ffn_out', 'l_out'):
                    kind = 'i32' if name in ('ffn_moe_argsort', 'ffn_moe_topk') else 'f32'
                    dims = [512 if name == 'ffn_moe_argsort' else 10, tokens, 1, 1] if kind == 'i32' else None
                    if name in ('attn_residual','ffn_out','l_out'): dims = [2048,tokens,1,1]
                    captured = node(ci, step, f'{name}-{layer}', kind, dims)
                    if name in ('attn_residual','ffn_out','l_out'):
                        captured.update(nativeTensorId=len(captures),nativeOperation='ADD',nativeParentTensorIds=[],
                                        nativeContiguous=True,nativeView=False)
                        residual_nodes[name]=captured
                out,first,second=[residual_nodes[n] for n in ('l_out','ffn_out','attn_residual')]
                parent_ids=[first['nativeTensorId'],second['nativeTensorId']]
                out['nativeParentTensorIds']=parent_ids
                reference=lambda n:{k:n[k] for k in ('caseId','step','name','occurrence')}
                aliases.append(dict(schemaVersion=1,caseId=ci,step=step,layer=layer,semanticName=f'post_moe-{layer}',
                    capture=reference(out),operands=[reference(first),reference(second)],
                    semanticTensorId=out['nativeTensorId'],capturedTensorId=out['nativeTensorId'],
                    nativeParentTensorIds=parent_ids,nativeOperation='ADD',sameTensor=True,controlVectorApplied=False))
                if mode == 'streamed':
                    node(ci, step, f'ffn_moe_topk-{layer} (cont)', 'i32', [10, tokens, 1, 1])
                    if tokens <= 3:
                        node(ci, step, f'ffn_moe_topk_stream-{layer}', 'i32', [10, tokens, 1, 1])
                    else:
                        for wave in range(tokens):
                            node(ci, step, f'ffn_moe_wave_ids-{layer}', 'i32', [10, tokens, 1, 1], occurrence=wave)
                            node(ci, step, f'ffn_moe_wave_mask-{layer}', dims=[1, 10, tokens, 1], occurrence=wave)
            for name in ('linear_attn_out-0', 'attn_output-1', 'result_output'):
                node(ci, step, name)
            for token in range(tokens):
                node(ci, step, f'API_logits_output_{token}', dims=[151936, 1, 1, 1])
        cases.append(dict(caseId=ci, prefillTokens=[101] * count, steps=steps))
    native = dict(native_kernel(), allocationBudgetBytes=3 * c.GiB, residentLimitBytes=7 * c.GiB // 2,
                  stopped=False, deadlineArmed=True)
    if mode == 'streamed':
        native.update(expectedGroups=2, streamedGroups=2, cacheSlotsPerLayer=30, ioMode='darwin-nocache')
    report['run'] = dict(mode=mode, partialModelOnly=True, captureBytes=offset,
                         resolvedNativeLayout=dict(c.RESOLVED_NATIVE_LAYOUT),
                         cases=cases, captures=captures, residualAliasWitnesses=aliases, finalNativeLedger=native)
    return report, offset


def comparison_fixture(left, right):
    rows = []
    for key, node in left.items():
        if not c.common_name(node['name']):
            continue
        row = dict(caseId=key[0], step=key[1], name=key[2], occurrence=key[3], passed=True, elements=node['bytes'] // 4)
        if node['type'] == 'i32':
            row.update(mismatchedIds=0)
        else:
            row.update(elementsOutsideTolerance=0, maxAbsoluteDifference=0., maxRelativeDifference=0.,
                       rootMeanSquaredDifference=0.)
        rows.append(row)
    fixture, _ = fixture_fixture()
    residual_rows=lambda indexed:[dict(caseId=k[0],step=k[1],layer=int(k[2].rsplit('-',1)[1]),
            semanticName='post_moe-'+k[2].rsplit('-',1)[1],captureName=k[2],passed=True,
            elements=n['bytes']//4,elementsOutsideTolerance=0,maxAbsoluteDifference=0.,maxRelativeDifference=0.,
            rootMeanSquaredDifference=0.) for k,n in indexed.items() if k[2].startswith('l_out-')]
    return dict(protocol=c.PROTOCOL, diagnosticEvidenceVersion=2, diagnosticSourceSha256=c.DIAGNOSTIC_SOURCE_SHA256,
                residualAliasContract=c.RESIDUAL_ALIAS_CONTRACT, firstFailedResidual=None,
                residualAliasEvidence=dict(schemaVersion=1,ordinary=residual_rows(left),streamed=residual_rows(right)),
                fixtureSha256=fixture['fixtureSha256'], patchSha256=c.PATCH,
                absoluteTolerance=1e-5, relativeTolerance=1e-5, passed=True,
                completeEvidenceForAllSixCasesTenStepsTwoLayers=True, profile=dict(c.RUN_PROFILE),
                resolvedNativeLayout=dict(c.RESOLVED_NATIVE_LAYOUT),
                firstFailedNode=None, nodes=rows, nodesCompared=len(rows),
                elementsCompared=sum(r['elements'] for r in rows),
                waves=[dict(caseId=ci, step=0, layer=layer, graphWaveCount=4,
                            allSelectedPairsContributeOnce=True) for ci in (2, 3, 4, 5) for layer in (0, 1)],
                streamedOriginalIdCopies=[dict(caseId=k[0], step=k[1], name=k[2], passed=True, mismatchedIds=0,
                    elements=n['bytes'] // 4) for k, n in right.items() if ' (cont)' in n['name']],
                remainingCoverageGaps=['other layers', 'full model', 'Metal', 'coding quality'])


class ConverterTests(unittest.TestCase):
    def test_no_review_rejects_before_read_or_write(self):
        with mock.patch.object(c, 'load_evidence') as load, mock.patch.object(c, 'write_reviewed') as write:
            with self.assertRaisesRegex(c.Rejected, '--reviewed'):
                c.main(['--evidence-dir', '/absent', '--resource-manifest', '/absent', '--output-dir', '/absent-new'])
        load.assert_not_called(); write.assert_not_called()

    def test_direct_writer_without_review_does_not_create_output(self):
        with tempfile.TemporaryDirectory() as directory:
            out = pathlib.Path(directory) / 'never-created'
            with self.assertRaisesRegex(c.Rejected, '--reviewed'):
                c.write_reviewed(out, {}, b'', False)
            self.assertFalse(out.exists())

    def test_reviewed_missing_evidence_still_writes_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            out = pathlib.Path(directory) / 'never-created'
            with self.assertRaises(OSError):
                c.main(['--reviewed', '--evidence-dir', directory, '--resource-manifest', str(out / 'absent'),
                        '--output-dir', str(out)])
            self.assertFalse(out.exists())

    def test_source_identity_contract_is_in_memory_only(self):
        source, hashes = source_fixture()
        c.validate_source(source, MANIFEST, HELPER, hashes, lambda p: next(r['fingerprint'] for r in source['artifacts'] if r['path'] == p))

    def test_missing_shard_wrong_order_digest_template_revision_and_bytes_reject(self):
        for change in ('missing', 'order', 'digest', 'template', 'revision', 'bytes', 'helper'):
            with self.subTest(change=change):
                source, hashes = source_fixture()
                if change == 'missing': source['artifacts'].pop()
                if change == 'order': source['artifacts'].reverse()
                if change == 'digest': source['artifactSetDigest'] = c.ARTIFACTS[0]['sha256']
                if change == 'template': source['templateSha256'] = '0' * 64
                if change == 'revision': source['revision'] = '0' * 40
                if change == 'bytes': hashes[0]['bytesRead'] -= 1
                if change == 'helper': hashes[0]['helperSourceSha256'] = '0' * 64
                with self.assertRaises(c.Rejected):
                    c.validate_source(source, MANIFEST, HELPER, hashes, lambda p: next(r['fingerprint'] for r in source['artifacts'] if r['path'] == p))

    def test_tampered_source_fingerprint_rejects(self):
        source, hashes = source_fixture()
        with self.assertRaisesRegex(c.Rejected, 'fingerprint'):
            c.validate_source(source, MANIFEST, HELPER, hashes, lambda p: dict(source['artifacts'][0]['fingerprint'], inode=999))

    def test_fixture_actual_source_copy_integrity_separate(self):
        source, _ = source_fixture()
        fixture, hashed = fixture_fixture()
        c.validate_fixture(fixture, source, hashed, MANIFEST, HELPER, lambda p: fixture['fixtureFingerprint'])
        fixture['tensors'][0]['destinationVerifiedSha256'] = 'f' * 64
        with self.assertRaisesRegex(c.Rejected, 'readback'):
            c.validate_fixture(fixture, source, hashed, MANIFEST, HELPER, lambda p: fixture['fixtureFingerprint'])

    def test_fixture_scope_remapping_and_full_hash_not_substitutable(self):
        for change in ('layers', 'remap', 'hash', 'group', 'fingerprint'):
            source, _ = source_fixture(); fixture, hashed = fixture_fixture()
            if change == 'layers': fixture['selectedOriginalLayers'] = [0, 1]
            if change == 'remap': fixture['tensors'][-1]['destinationName'] = 'blk.3.ffn_up_exps.weight'
            if change == 'hash': hashed['bytesRead'] -= 1
            if change == 'group': fixture['tensors'].pop()
            if change == 'fingerprint': hashed['fingerprint'] = fake_fp(1023)
            with self.subTest(change=change), self.assertRaises(c.Rejected):
                c.validate_fixture(fixture, source, hashed, MANIFEST, HELPER, lambda p: fixture['fixtureFingerprint'])

    def test_exact8k_process_passes_only_in_memory(self):
        c.validate_process(process_fixture(), MANIFEST)

    def test_review_does_not_silently_convert4k_or_weaken_profile(self):
        for key, value in (('contextTokens', 4096), ('outputTokens', 1024), ('cacheSlotsPerLayer', 24),
                           ('decodeThreads', 8), ('batchThreads', 8), ('cacheTypeK', 'q8_0'),
                           ('useExtraBufts', True), ('cpuRepackTensorCount', 1), ('backend', 'metal'),
                           ('kvUnified', False), ('nRsSeq', 1), ('checkpoints', 1)):
            process = process_fixture(); process['profile'][key] = value
            with self.subTest(key=key), self.assertRaises(c.Rejected): c.validate_process(process, MANIFEST)

    def test_wrong_scope_failed_incomplete_or_mock_process_rejects(self):
        changes = [dict(scope='chat-and-coding-ready'), dict(passed=False), dict(fake=True), dict(simulated=True),
                   dict(issuedAppCertificate=True), dict(ownedProcessesStopped=False), dict(resourcesVerified=False)]
        for change in changes:
            value = process_fixture(); value.update(change)
            with self.subTest(change=change), self.assertRaises(c.Rejected): c.validate_process(value, MANIFEST)
        value = process_fixture(); value['steps'].pop()
        with self.assertRaisesRegex(c.Rejected, 'eleven'): c.validate_process(value, MANIFEST)

    def test_pressure_resource_or_cleanup_failures_reject(self):
        for change in ('pressure', 'headroom', 'controller', 'child', 'exit', 'stop'):
            value = process_fixture(); row = value['resourceSamples'][0]
            if change == 'pressure': row['pressureLevel'] = 2
            if change == 'headroom': row['availableRamBytes'] = c.GiB - 1
            if change == 'controller': row['controllerMemory']['physicalFootprintBytes'] = 257 * c.MiB
            if change == 'child': row['ownedChildMemory']['rssBytes'] = 4 * c.GiB
            if change == 'exit': value['steps'][0]['exitCode'] = 1
            if change == 'stop': value['steps'][0]['stopReason'] = 'deadline'
            with self.subTest(change=change), self.assertRaises(c.Rejected): c.validate_process(value, MANIFEST)

    def test_expert_distinct_layout_endpoints_and_all_cases_are_required(self):
        rows, process = expert_fixture()
        self.assertEqual(c.validate_experts(expert_text(rows), process), (1, 2))
        for change in ('missing-group', 'wrong-first', 'missing-case', 'float-error', 'nonfinite', 'double-wave'):
            rows, process = expert_fixture()
            if change == 'missing-group': rows[0][1]['layouts'][0]['groups'].pop()
            if change == 'wrong-first': rows[0][1]['layouts'][0]['firstGroup'] = 1
            case = next(r for prefix, r in rows if prefix == 'SSD_PARITY_CASE')
            if change == 'missing-case': rows = [(p, r) for p, r in rows if r is not case]
            if change == 'float-error': case['elementsOutsideTolerance'] = 1
            if change == 'nonfinite': case['nonfinite'] = 1
            if change == 'double-wave': case['allSelectedPairsContributeOnce'] = False
            with self.subTest(change=change), self.assertRaises(c.Rejected): c.validate_experts(expert_text(rows), process)

    def test_old_aggregate_expert_metadata_without_actual_layouts_rejects(self):
        rows, process = expert_fixture(); rows[0][1].pop('layouts')
        with self.assertRaisesRegex(c.Rejected, 'layout details'): c.validate_experts(expert_text(rows), process)

    def test_complete_hybrid_capture_contract_in_memory(self):
        fixture, _ = fixture_fixture()
        for mode in ('plan-ordinary', 'plan-streamed', 'ordinary', 'streamed'):
            report, size = graph_fixture(mode)
            self.assertIsInstance(c.validate_graph(report, mode, fixture, MANIFEST, size), dict)

    def test_incomplete_wrong_type_nonfinite_or_wrong8k_capture_rejects(self):
        fixture, _ = fixture_fixture()
        for change in ('missing', 'type', 'nonfinite', 'context', 'output', 'plan-only', 'unaccounted'):
            report, size = graph_fixture('ordinary')
            if change == 'missing': report['run']['cases'].pop()
            if change == 'type': next(n for n in report['run']['captures'] if n['name']=='ffn_moe_argsort-0')['type'] = 'f32'
            if change == 'nonfinite': report['run']['captures'][0]['nonfinite'] = 1
            if change == 'context': report['plan']['profile']['contextTokens'] = 4096
            if change == 'output': report['profile']['outputTokens'] = 1024
            if change == 'plan-only': report['inferenceExecuted'] = False
            if change == 'unaccounted': size += 4
            with self.subTest(change=change), self.assertRaises(c.Rejected):
                c.validate_graph(report, 'ordinary', fixture, MANIFEST, size)

    def test_version2_requires_current_diagnostic_source_build_and_complete_inventory(self):
        for change in ('version','inventory','missing-inventory','build-source','build-path','missing-build'):
            value=process_fixture()
            if change=='version':value.pop('diagnosticEvidenceVersion')
            if change=='inventory':value['evidenceInventoryComplete']=False
            if change=='missing-inventory':value.pop('evidenceInventoryComplete')
            if change=='build-source':value['build']['binaries'][1]['sourceSha256']='f'*64
            if change=='build-path':value['build']['binaries'][1]['path']=None
            if change=='missing-build':value.pop('build')
            with self.subTest(change=change),self.assertRaises(c.Rejected):c.validate_process(value,MANIFEST)
        fixture,_=fixture_fixture()
        for change in ('version','source','contract'):
            value,size=graph_fixture()
            if change=='version':value.pop('diagnosticEvidenceVersion')
            if change=='source':value['diagnosticSourceSha256']='f'*64
            if change=='contract':value['residualAliasContract']='assumed-alias'
            with self.subTest(change=change),self.assertRaises(c.Rejected):c.validate_graph(value,'ordinary',fixture,MANIFEST,size)

    def test_native_alias_witness_requires_exact_pointers_parents_shapes_and_steps(self):
        for change in ('missing','duplicate','pointer','parent-pointer','parents','step','occurrence','operation',
                       'view','contiguous','shape','boolean-shape','broadcast','later-parent','extra-parent','extra-witness-field','control-vector'):
            value,_=graph_fixture();captures=value['run']['captures'];w=value['run']['residualAliasWitnesses'][0]
            indexed={c.capture_key(n):n for n in captures};out=indexed[c.capture_key(w['capture'])]
            if change=='missing':value['run']['residualAliasWitnesses'].pop()
            if change=='duplicate':value['run']['residualAliasWitnesses'][-1]=copy.deepcopy(w)
            if change=='pointer':w['semanticTensorId']+=10000
            if change=='parent-pointer':w['nativeParentTensorIds']=[10000,10001]
            if change=='parents':w['operands'].reverse()
            if change=='step':w['step']=2
            if change=='occurrence':w['capture']['occurrence']=1
            if change=='operation':out['nativeOperation']='MUL'
            if change=='view':out['nativeView']=True
            if change=='contiguous':out['nativeContiguous']=False
            if change=='shape':out['dimensions']=[1,2048,1,1]
            if change=='boolean-shape':out['dimensions']=[2048,True,1,1]
            if change=='broadcast':indexed[c.capture_key(w['operands'][0])]['dimensions']=[2048,1,1,2]
            if change=='later-parent':
                parent=indexed.pop(c.capture_key(w['operands'][0]));indexed[c.capture_key(parent)]=parent
            if change=='extra-parent':out['nativeParentTensorIds'].append(10000)
            if change=='extra-witness-field':w['trusted']=True
            if change=='control-vector':w['controlVectorApplied']=True
            with self.subTest(change=change),self.assertRaises(c.Rejected):c.validate_residual_aliases(value,indexed)

    def test_independent_retained_residual_add_rounds_f32_and_rejects_mismatch_nonfinite_or_overflow(self):
        # Only tiny newly-created unit-test payloads are opened, never model/v1 evidence.
        for actual,left,right,passed in [(3.,1.,2.,True),(16777216.,16777216.,1.,True),
                (4.,1.,2.,False),(float('nan'),1.,2.,False),(0.,float('inf'),2.,False),
                (0.,3.4e38,3.4e38,False)]:
            with self.subTest(actual=actual,left=left,right=right),tempfile.TemporaryDirectory() as directory:
                p=pathlib.Path(directory)/'unit.bin';p.write_bytes(struct.pack('<fff',actual,left,right));fd=os.open(p,os.O_RDONLY)
                nodes=[dict(type='f32',bytes=4,offset=offset) for offset in (0,4,8)]
                try:
                    if passed:c.recheck_residual_add(fd,*nodes)
                    else:
                        with self.assertRaises(c.Rejected):c.recheck_residual_add(fd,*nodes)
                finally:os.close(fd)

    def test_residual_comparison_summary_cannot_omit_or_promote_failed_checks(self):
        fixture,_=fixture_fixture();a,sa=graph_fixture();b,sb=graph_fixture('streamed')
        left=c.validate_graph(a,'ordinary',fixture,MANIFEST,sa);right=c.validate_graph(b,'streamed',fixture,MANIFEST,sb)
        for change in ('missing-mode','missing-row','duplicate','failed','wrong-elements','wrong-name','nonfinite','version'):
            value=comparison_fixture(left,right)
            if change=='missing-mode':value['residualAliasEvidence'].pop('ordinary')
            elif change=='version':value['diagnosticEvidenceVersion']=1
            else:
                rows=value['residualAliasEvidence']['ordinary']
                if change=='missing-row':rows.pop()
                if change=='duplicate':rows[-1]=copy.deepcopy(rows[0])
                if change=='failed':rows[0]['passed']=False
                if change=='wrong-elements':rows[0]['elements']-=1
                if change=='wrong-name':rows[0]['captureName']='ffn_out-0'
                if change=='nonfinite':rows[0]['maxAbsoluteDifference']=float('nan')
            with self.subTest(change=change),self.assertRaises(c.Rejected):c.validate_comparison(value,left,right,fixture,dict(comparison=value))

    def test_comparison_exact_id_fixed_tolerance_and_complete_coverage(self):
        fixture, _ = fixture_fixture()
        a, sa = graph_fixture(); b, sb = graph_fixture('streamed')
        left = c.validate_graph(a, 'ordinary', fixture, MANIFEST, sa)
        right = c.validate_graph(b, 'streamed', fixture, MANIFEST, sb)
        good = comparison_fixture(left, right)
        c.validate_comparison(good, left, right, fixture, dict(comparison=good))
        for change in ('integer', 'float', 'tolerance', 'missing-node', 'missing-wave', 'scope-gap', 'layout'):
            value = copy.deepcopy(good)
            if change == 'integer': next(r for r in value['nodes'] if r['name']=='ffn_moe_argsort-0')['mismatchedIds'] = 1
            if change == 'float': next(r for r in value['nodes'] if 'elementsOutsideTolerance' in r)['elementsOutsideTolerance'] = 1
            if change == 'tolerance': value['absoluteTolerance'] = .001
            if change == 'missing-node': value['nodes'].pop()
            if change == 'missing-wave': value['waves'].pop()
            if change == 'scope-gap': value['remainingCoverageGaps'] = []
            if change == 'layout': value['resolvedNativeLayout']['kvUnified'] = False
            with self.subTest(change=change), self.assertRaises(c.Rejected):
                c.validate_comparison(value, left, right, fixture, dict(comparison=value))

    def test_retained_numeric_capture_recheck_rejects_actual_mismatch(self):
        with tempfile.TemporaryFile() as a, tempfile.TemporaryFile() as b:
            node = dict(type='i32', bytes=8, offset=0)
            a.write(struct.pack('<ii', 0, 511)); a.flush()
            b.write(struct.pack('<ii', 0, 510)); b.flush()
            with self.assertRaisesRegex(c.Rejected, 'router IDs differ'):
                c.numeric_pair(a.fileno(), b.fileno(), node, node)
        for value in (2.1, float('nan'), float('inf')):
            with tempfile.TemporaryFile() as a, tempfile.TemporaryFile() as b:
                node = dict(type='f32', bytes=4, offset=0)
                a.write(struct.pack('<f', 2.)); a.flush()
                b.write(struct.pack('<f', value)); b.flush()
                with self.assertRaisesRegex(c.Rejected, 'float values differ'):
                    c.numeric_pair(a.fileno(), b.fileno(), node, node)

    def test_duplicate_nonfinite_json_and_symlink_evidence_reject(self):
        for raw in ('{"passed":true,"passed":false}', '{"value":NaN}', '{"value":Infinity}'):
            with self.assertRaises(c.Rejected): c.parse_json(raw)
        with tempfile.TemporaryDirectory() as directory:
            p = pathlib.Path(directory) / 'ordinary.log'; p.write_bytes(b'x')
            link = pathlib.Path(directory) / 'alias.log'; link.symlink_to(p)
            with self.assertRaises(OSError): c.read_bytes(link, c.MiB)

    def test_retained_log_tampering_changes_bound_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            p = pathlib.Path(directory) / 'small-test.log'; p.write_bytes(b'unit-test-only')
            original = c.hash_retained(p, c.MiB)
            p.write_bytes(b'tampered-unit-test-only')
            self.assertNotEqual(c.hash_retained(p, c.MiB), original)

    def test_native_identity_excludes_report_refresh_and_licenses(self):
        original = native_manifest_fixture()
        identity = c.native_identity(original)
        refreshed = copy.deepcopy(original)
        refreshed['files'][-1]['sha256'] = 'f' * 64
        refreshed['files'].append(dict(path=c.REPORT_PATH, size=100, sha256='f' * 64))
        self.assertEqual(c.native_identity(refreshed), identity)
        self.assertEqual(c.native_digest(c.native_identity(refreshed)), c.native_digest(identity))
        self.assertTrue(all(row['path'].startswith('worker/') for row in identity['nativeFiles']))

    def test_same_patch_recompiled_native_library_invalidates_binding(self):
        identity = c.native_identity(native_manifest_fixture())
        record = dict(nativeResourceIdentity=identity, nativeResourceDigest=c.native_digest(identity))
        c.validate_native_binding(record, identity)
        changed = copy.deepcopy(identity)
        changed['nativeFiles'][0]['sha256'] = 'f' * 64
        with self.assertRaisesRegex(c.Rejected, 'inventory changed'):
            c.validate_native_binding(record, changed)
        self.assertNotEqual(c.native_digest(changed), c.native_digest(identity))

    def test_native_order_duplicates_paths_and_uncovered_executables_reject(self):
        for change in ('order', 'duplicate', 'non-native', 'escape', 'zero-size', 'sha', 'uncovered', 'unsafe-number'):
            identity = c.native_identity(native_manifest_fixture())
            if change == 'order': identity['nativeFiles'].reverse()
            if change == 'duplicate': identity['nativeFiles'].append(copy.deepcopy(identity['nativeFiles'][-1]))
            if change == 'non-native': identity['nativeFiles'][0]['path'] = 'validation/other.json'
            if change == 'escape': identity['nativeFiles'][0]['path'] = 'worker/../other'
            if change == 'zero-size': identity['nativeFiles'][0]['size'] = 0
            if change == 'sha': identity['nativeFiles'][0]['sha256'] = 'not-a-hash'
            if change == 'uncovered': identity['planner']['executable'] = 'worker/absent'
            if change == 'unsafe-number': identity['nativeFiles'][0]['size'] = 2**53
            with self.subTest(change=change), self.assertRaises(c.Rejected): c.validate_native_identity(identity)

    def test_native_subpaths_missing_core_libraries_and_alternate_helpers_reject(self):
        for change in ('subpath', 'library', 'planner', 'integrity', 'directory', 'arguments'):
            identity = c.native_identity(native_manifest_fixture())
            if change == 'subpath': identity['nativeFiles'][0]['path'] = 'worker/nested/libggml-base.0.dylib'
            if change == 'library': identity['nativeFiles'] = [r for r in identity['nativeFiles'] if r['path'] != 'worker/libllama.0.dylib']
            if change in ('planner', 'integrity'):
                identity[change]['executable'] = 'worker/llama-server-ssd'  # Covered but not the exact helper.
            if change == 'directory': identity['backends'][1]['libraryDirectory'] = 'worker/nested'
            if change == 'arguments': identity['backends'][1].pop('arguments')
            with self.subTest(change=change), self.assertRaises(c.Rejected): c.validate_native_identity(identity)

    def test_native_manifest_schema_is_not_silently_relabelled(self):
        manifest = native_manifest_fixture(); manifest['schemaVersion'] = 2
        with self.assertRaisesRegex(c.Rejected, 'schemaVersion'):
            c.native_identity(manifest)

    def test_actual_resolved_kv_layout_is_required_for_process(self):
        for change in ('missing', 'unified', 'rs-seq', 'per-sequence', 'precision', 'extra-field'):
            value = process_fixture()
            if change == 'missing': value.pop('resolvedNativeLayout')
            if change == 'unified': value['resolvedNativeLayout']['kvUnified'] = False
            if change == 'rs-seq': value['resolvedNativeLayout']['nRsSeq'] = 1
            if change == 'per-sequence': value['resolvedNativeLayout']['contextPerSequence'] = 4096
            if change == 'precision': value['resolvedNativeLayout']['cacheTypeV'] = 'q8_0'
            if change == 'extra-field': value['resolvedNativeLayout']['checkpoints'] = 0
            with self.subTest(change=change), self.assertRaises(c.Rejected): c.validate_process(value, MANIFEST)

    def test_plan_and_run_cannot_inherit_an_unmeasured_requested_kv_layout(self):
        fixture, _ = fixture_fixture()
        for location in ('report', 'plan', 'run'):
            for change in ('missing', 'unified', 'rs-seq'):
                report, size = graph_fixture('streamed')
                target = report if location == 'report' else report[location]
                if change == 'missing': target.pop('resolvedNativeLayout')
                if change == 'unified': target['resolvedNativeLayout']['kvUnified'] = False
                if change == 'rs-seq': target['resolvedNativeLayout']['nRsSeq'] = 1
                with self.subTest(location=location, change=change), self.assertRaises(c.Rejected):
                    c.validate_graph(report, 'streamed', fixture, MANIFEST, size)

    def test_zero_checkpoint_profile_is_required_per_graph_and_native_plan(self):
        fixture, _ = fixture_fixture()
        for location in ('report', 'plan'):
            report, size = graph_fixture()
            target = report if location == 'report' else report[location]
            target['profile']['checkpoints'] = 1
            with self.subTest(location=location), self.assertRaises(c.Rejected):
                c.validate_graph(report, 'ordinary', fixture, MANIFEST, size)

    def test_native_backend_and_digest_drift_cannot_bind_old_record(self):
        identity = c.native_identity(native_manifest_fixture())
        for change in ('backends', 'flags', 'planner', 'digest'):
            record = dict(nativeResourceIdentity=copy.deepcopy(identity), nativeResourceDigest=c.native_digest(identity))
            if change == 'backends': record['nativeResourceIdentity']['backends'].reverse()
            if change == 'flags': record['nativeResourceIdentity']['backends'][1]['arguments'].append('--no-repack')
            if change == 'planner': record['nativeResourceIdentity']['planner']['sourceSha256'] = 'f' * 64
            if change == 'digest': record['nativeResourceDigest'] = 'f' * 64
            with self.subTest(change=change), self.assertRaises(c.Rejected): c.validate_native_binding(record, identity)

    def test_canonical_native_encoding_sorts_keys_but_retains_array_order(self):
        value = {'z': [{'b': 2, 'a': 1}], 'a': {'z': False, 'a': None}}
        self.assertEqual(c.canonical_json(value), b'{"a":{"a":null,"z":false},"z":[{"a":1,"b":2}]}')
        self.assertNotEqual(c.canonical_json({'a': [1, 2]}), c.canonical_json({'a': [2, 1]}))
        for invalid in ({'nonAscii\u00e9': 1}, {'value': 1.5}, {'value': 2**53}):
            with self.assertRaises(c.Rejected): c.canonical_json(invalid)

    def test_resource_summary_is_derived_from_every_full_sample(self):
        samples = process_fixture()['resourceSamples']
        samples = samples + [dict(pressureLevel=1, availableRamBytes=c.GiB,
                                 controllerMemory=dict(rssBytes=2 * c.MiB, physicalFootprintBytes=3 * c.MiB))]
        summary = c.resource_summary(samples)
        self.assertEqual(summary, dict(sampleCount=2, ownedChildSampleCount=1,
            minimumAvailableRamBytes=c.GiB, maximumControllerRssBytes=2 * c.MiB,
            maximumControllerPhysicalFootprintBytes=3 * c.MiB, maximumOwnedChildRssBytes=c.MiB,
            maximumOwnedChildPhysicalFootprintBytes=c.MiB, allPressureNormal=True))
        c.validate_resource_summary(summary, samples)
        for key in ('sampleCount', 'ownedChildSampleCount', 'minimumAvailableRamBytes', 'maximumControllerRssBytes'):
            changed = dict(summary); changed[key] += 1
            with self.subTest(key=key), self.assertRaises(c.Rejected): c.validate_resource_summary(changed, samples)

    def test_no_child_nonpositive_or_hidden_bad_sample_cannot_summarize(self):
        samples = process_fixture()['resourceSamples']
        value = copy.deepcopy(samples); value[0].pop('ownedChildMemory')
        with self.assertRaisesRegex(c.Rejected, 'owned child'): c.resource_summary(value)
        for change in ('pressure', 'memory', 'headroom'):
            value = copy.deepcopy(samples) * 10
            value[-1] = copy.deepcopy(value[-1])
            if change == 'pressure': value[-1]['pressureLevel'] = 2
            if change == 'memory': value[-1]['ownedChildMemory']['rssBytes'] = 0
            if change == 'headroom': value[-1]['availableRamBytes'] = c.GiB - 1
            with self.subTest(change=change), self.assertRaises(c.Rejected): c.resource_summary(value)

    def test_long_full_samples_collapse_to_bounded_positive_summary(self):
        samples = copy.deepcopy(process_fixture()['resourceSamples']) * 10000
        summary = c.resource_summary(samples)
        self.assertEqual(summary['sampleCount'], 10000)
        self.assertEqual(summary['ownedChildSampleCount'], 10000)
        self.assertLess(len(json.dumps(summary).encode()), 1024)
        self.assertNotIn('resourceSamples', summary)

    def test_emitted_long_run_report_omits_raw_samples_and_preserves_summary(self):
        process = process_fixture()
        process['resourceSamples'] *= 10000
        run = c.measured_run(process, '/unit-test-evidence', {'process-bound': 'test-only'})
        self.assertNotIn('resourceSamples', run)
        self.assertEqual(run['resourceSummary']['sampleCount'], 10000)
        self.assertEqual(run['steps'], process['steps'])
        self.assertLess(len(c.bounded_report_bytes(dict(measuredRun=run))), c.MiB)

    def test_oversized_emitted_report_is_rejected_before_any_write(self):
        with mock.patch.object(c, 'write_reviewed') as write:
            with self.assertRaisesRegex(c.Rejected, '1 MiB'):
                c.bounded_report_bytes(dict(excess='x' * c.MiB))
        write.assert_not_called()

    def test_inconsistent_process_resource_summary_is_rejected(self):
        process = process_fixture()
        process['resourceSummary'] = c.resource_summary(process['resourceSamples'])
        process['resourceSummary']['maximumControllerRssBytes'] += 1
        with self.assertRaisesRegex(c.Rejected, 'disagrees'):
            c.validate_process(process, MANIFEST)


if __name__ == '__main__':
    unittest.main()
