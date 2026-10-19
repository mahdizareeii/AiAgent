"""DISABLED REVIEW DRAFT: passively convert reviewed retained Qwen80 evidence.

Never runs a command, loads a model, reads model weight payloads, downloads,
changes production resources, or grants app consent. Old 4K evidence is invalid.
Only --reviewed permits writing a NEW report/configuration directory. Review is
an attestation about the retained native run: coherent JSON is not a signature
and this converter cannot prove that a deliberately forged run actually happened.
See CONVERTER-CONTRACT.md. All reads/hash comparisons are bounded and passive.
"""
import argparse
import array
import hashlib
import json
import math
import os
import pathlib
import re
import stat
import struct
import sys

BASE = 'd81235049384534c167caea52b85a694f6103d14'
PATCH = '83139a4fbe858827d75f5050defefa69413718c45335ca5c18e49919c3944bb8'
REVISION = 'b82fb7382639d97b38fa7672e526c760c2fb358e'
SET_DIGEST = '3d0fd1c8ad6c37fdac38e20b02de80149a5d93b8c457c39e8a27100c8bf62d64'
TEMPLATE = '0b5c439b5b14126c0ae8b14ca93240c3cef1e7e29d684102b07f10727523dbdb'
SCOPE = 'representative-experts-and-two-hybrid-layers'
PROTOCOL = 'qwen80-standard-cpu-hybrid-v2-8k'
DIAGNOSTIC_EVIDENCE_VERSION = 2
RESIDUAL_ALIAS_CONTRACT = 'qwen3next-residual-add-no-cvec-v1'
DIAGNOSTIC_SOURCE_SHA256 = hashlib.sha256(pathlib.Path(__file__).with_name('qwen80-graph-parity.cpp').read_bytes()).hexdigest()
REF_FIELDS = {'caseId', 'step', 'name', 'occurrence'}
WITNESS_FIELDS = {'schemaVersion', 'caseId', 'step', 'layer', 'semanticName', 'capture', 'operands',
                  'semanticTensorId', 'capturedTensorId', 'nativeParentTensorIds', 'nativeOperation',
                  'sameTensor', 'controlVectorApplied'}
REPORT_PATH = 'validation/qwen3-coder-next-80b-standard-cpu-8k.json'
MiB, GiB = 1024**2, 1024**3
PROFILE = dict(contextTokens=8192, outputTokens=2048, batchTokens=64,
               microBatchTokens=16, cacheSlotsPerLayer=30, cacheTypeK='f16',
               cacheTypeV='f16', swaFull=False, slots=1, ioWorkers=2,
               ioMode='darwin-nocache', decodeThreads=4, batchThreads=4,
               kvUnified=True, nRsSeq=0, checkpoints=0)
RUN_PROFILE = dict(backend='cpu', **PROFILE, cpuKernel='standard',
                   useExtraBufts=False, cpuRepackTensorCount=0)
RESOLVED_NATIVE_LAYOUT = dict(contextTokens=8192, contextPerSequence=8192,
                             batchTokens=64, microBatchTokens=16, slots=1,
                             kvUnified=True, nRsSeq=0, cacheTypeK='f16', cacheTypeV='f16')
GEOMETRY = dict(layers=48, expertsPerLayer=512, activeExperts=10,
                minimumSlotsPerLayer=30, expectedRoutedTensorGroups=48,
                originalTensorDescriptors=807)
ARTIFACTS = [dict(filename=f'Qwen3-Coder-Next-Q4_K_M-0000{i+1}-of-00004.gguf',
                  sha256=sha, sizeBytes=size) for i, (size, sha) in enumerate([
    (15524827040, '6bcfc9f9c37901eeb92172e2ab871224dab36a453d263bcb2547f737409534da'),
    (14872168352, '817def0691ee9d08bf3dc4444be7aed29c9e52091e8fa9d97901ce7e7f6f01d3'),
    (14503294496, '23aa634d47dca9b4ca3ea249384e6f01951b24c83cdc076f37f6f43d6c99883f'),
    (3510702144, '249c768cc5f130dc731567d6edcbdacc48e14dec9e02c5dbe2b2185d2c5bdb2b')])]
STEPS = ([f'shard{i}-integrity' for i in range(1, 5)] +
         ['expert-parity', 'fixture-integrity', 'plan-ordinary', 'plan-streamed',
          'ordinary', 'streamed', 'compare'])
FILES = (['source-proof.json', 'fixture.json', 'expert-parity.log', 'comparison.json'] +
         [f'shard{i}-integrity.log' for i in range(1, 5)] + ['fixture-integrity.log'] +
         [f'{mode}.{ext}' for mode in ('plan-ordinary', 'plan-streamed', 'ordinary', 'streamed')
          for ext in ('json', 'log')] + ['ordinary.bin', 'streamed.bin', 'compare.log'])
CASES = {'cold-decode': (1, 1), 'warm-decode': (1, 1),
         'eviction-reload': (1, 1), 'four-full-waves': (4, 4),
         'partial-final-wave': (5, 5)}
FP_FIELDS = ('device', 'inode', 'sizeBytes', 'mtimeSeconds', 'mtimeNanoseconds',
             'ctimeSeconds', 'ctimeNanoseconds')
SUMMARY_FIELDS = ('sampleCount', 'ownedChildSampleCount', 'minimumAvailableRamBytes',
                  'maximumControllerRssBytes', 'maximumControllerPhysicalFootprintBytes',
                  'maximumOwnedChildRssBytes', 'maximumOwnedChildPhysicalFootprintBytes',
                  'allPressureNormal')
CORE_LIBRARIES = ('libllama.0.dylib', 'libggml.0.dylib', 'libggml-base.0.dylib', 'libggml-cpu.0.dylib')


class Rejected(ValueError):
    pass


def require(ok, message):
    if not ok:
        raise Rejected(message)


def integer(value, low=0, high=2**63 - 1):
    return type(value) is int and low <= value <= high


def sha(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) is not None


def finite(value, low=0):
    return type(value) in (int, float) and math.isfinite(value) and value >= low


def equal_fields(value, expected, label):
    require(isinstance(value, dict), f'{label} object required')
    for key, wanted in expected.items():
        require(key in value and type(value[key]) is type(wanted) and value[key] == wanted,
                f'{label}.{key} does not match exact reviewed contract')


def validate_resolved_layout(value, label):
    require(isinstance(value, dict) and set(value) == set(RESOLVED_NATIVE_LAYOUT),
            f'{label} exact resolved native layout schema required')
    equal_fields(value, RESOLVED_NATIVE_LAYOUT, label)


def no_fake_flags(value):
    # The reviewer still must verify origin. Reject explicit test/synthetic labels.
    if isinstance(value, dict):
        for key, item in value.items():
            if key.lower() in ('fake', 'simulated', 'synthetic', 'mock', 'testfixture'):
                require(item is False, 'synthetic/mock evidence cannot issue a certificate')
            no_fake_flags(item)
    elif isinstance(value, list):
        for item in value:
            no_fake_flags(item)


def compact(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def canonical_json(value):
    """Shared TS/Python encoding: recursively ASCII-sort keys; retain array order."""
    def ordered(item):
        if isinstance(item, dict):
            require(all(isinstance(k, str) and k.isascii() for k in item), 'native identity keys must be ASCII')
            return {k: ordered(item[k]) for k in sorted(item)}
        if isinstance(item, list):
            return [ordered(x) for x in item]
        if type(item) is int:
            require(abs(item) <= 2**53 - 1, 'native identity numbers must be safe integers')
            return item
        if item is None or type(item) is bool:
            return item
        require(isinstance(item, str) and not any(0xD800 <= ord(x) <= 0xDFFF for x in item),
                'native identity values must be JSON strings, booleans, null or safe integers')
        return item
    return compact(ordered(value))


def native_path(value):
    return (isinstance(value, str) and re.fullmatch(r'worker/[A-Za-z0-9._-]+', value) is not None and
            str(pathlib.PurePosixPath(value)) == value and
            not any(p in ('.', '..') for p in pathlib.PurePosixPath(value).parts))


def validate_native_identity(identity):
    require(isinstance(identity, dict) and set(identity) ==
            {'schemaVersion', 'baseCommit', 'patchSha256', 'target', 'backends', 'planner', 'integrity', 'nativeFiles'},
            'exact stable native resource identity schema required')
    equal_fields(identity, dict(schemaVersion=1, baseCommit=BASE, patchSha256=PATCH, target='darwin-arm64'),
                 'stable native resource provenance')
    rows = identity.get('nativeFiles')
    require(isinstance(rows, list) and 0 < len(rows) <= 256, 'bounded exact worker inventory required')
    paths = []
    for row in rows:
        require(isinstance(row, dict) and set(row) == {'path', 'size', 'sha256'} and native_path(row.get('path')) and
                integer(row.get('size'), 1, 2**53 - 1) and sha(row.get('sha256')), 'safe exact native inventory row required')
        paths.append(row['path'])
    require(paths == sorted(set(paths)), 'native inventory must be unique and in ASCII path order')
    require(all('worker/' + name in paths for name in CORE_LIBRARIES), 'complete exact native core library inventory required')
    backends = identity.get('backends')
    require(isinstance(backends, list) and 0 < len(backends) <= 2 and
            {b.get('id') for b in backends if isinstance(b, dict)} <= {'cpu', 'metal'}, 'exact known native backends required')
    ids = []
    for row in backends:
        require(isinstance(row, dict) and isinstance(row.get('id'), str) and native_path(row.get('executable')) and
                row['executable'] in paths and row.get('libraryDirectory') == 'worker' and
                isinstance(row.get('arguments'), list) and all(isinstance(x, str) for x in row['arguments']),
                'covered native backend executable, worker library directory and explicit arguments required')
        ids.append(row['id'])
    require('cpu' in ids and len(set(ids)) == len(ids), 'distinct covered CPU native backend required')
    for key in ('planner', 'integrity'):
        row = identity.get(key)
        executable = 'worker/llama-plan-ssd' if key == 'planner' else 'worker/llama-hash-ssd'
        require(isinstance(row, dict) and row.get('schemaVersion') == 1 and sha(row.get('sourceSha256')) and
                row.get('executable') == executable and row['executable'] in paths,
                'covered exact native planner and integrity source/executable identities required')
    canonical_json(identity)  # Also reject floats, unsafe integers and ambiguous encodings.


def native_identity(manifest):
    equal_fields(manifest, dict(schemaVersion=1, baseCommit=BASE, patchSha256=PATCH, target='darwin-arm64'),
                 'current exact native manifest headers')
    rows = manifest.get('files')
    require(isinstance(rows, list), 'current complete resource inventory required')
    paths = [r.get('path') for r in rows if isinstance(r, dict)]
    require(len(paths) == len(rows) and all(isinstance(p, str) for p in paths) and len(set(paths)) == len(paths),
            'current resource inventory contains duplicate/missing paths')
    identity = dict(schemaVersion=1, baseCommit=manifest.get('baseCommit'), patchSha256=manifest.get('patchSha256'),
                    target=manifest.get('target'), backends=manifest.get('backends'), planner=manifest.get('planner'),
                    integrity=manifest.get('integrity'), nativeFiles=sorted(
                        [{k: r[k] for k in ('path', 'size', 'sha256')} for r in rows if r['path'].startswith('worker/')],
                        key=lambda r: r['path']))
    validate_native_identity(identity)
    return identity


def native_digest(identity):
    validate_native_identity(identity)
    return hashlib.sha256(canonical_json(identity)).hexdigest()


def validate_native_binding(record, expected):
    require(isinstance(record, dict), 'actual measured native resource binding object required')
    actual = record.get('nativeResourceIdentity')
    validate_native_identity(actual)
    require(actual == expected and record.get('nativeResourceDigest') == native_digest(expected),
            'tested native worker/library/planner/integrity inventory changed, even if patch is unchanged')


def resource_summary(samples):
    require(isinstance(samples, list) and 0 < len(samples) <= 20000, 'actual bounded resource samples required')
    children = []
    for row in samples:
        require(isinstance(row, dict), 'actual measured resource sample object required')
        require(type(row.get('pressureLevel')) is int and row['pressureLevel'] == 1 and
                integer(row.get('availableRamBytes'), GiB), 'normal pressure and 1 GiB headroom not proven throughout run')
        own = row.get('controllerMemory', {})
        require(all(integer(own.get(k), 1, 256 * MiB) for k in ('rssBytes', 'physicalFootprintBytes')),
                'bounded actual controller memory is missing')
        if 'ownedChildMemory' in row:
            child = row['ownedChildMemory']
            require(all(integer(child.get(k), 1, 7 * GiB // 2) for k in ('rssBytes', 'physicalFootprintBytes')),
                    'owned child resource cap failed')
            children.append(child)
    require(children, 'at least one actual owned child memory sample is required')
    summary = dict(sampleCount=len(samples), ownedChildSampleCount=len(children),
                   minimumAvailableRamBytes=min(r['availableRamBytes'] for r in samples),
                   maximumControllerRssBytes=max(r['controllerMemory']['rssBytes'] for r in samples),
                   maximumControllerPhysicalFootprintBytes=max(r['controllerMemory']['physicalFootprintBytes'] for r in samples),
                   maximumOwnedChildRssBytes=max(r['rssBytes'] for r in children),
                   maximumOwnedChildPhysicalFootprintBytes=max(r['physicalFootprintBytes'] for r in children),
                   allPressureNormal=True)
    validate_resource_summary(summary)
    return summary


def validate_resource_summary(summary, samples=None):
    require(isinstance(summary, dict) and set(summary) == set(SUMMARY_FIELDS), 'exact bounded resource summary schema required')
    require(integer(summary.get('sampleCount'), 1, 20000) and
            integer(summary.get('ownedChildSampleCount'), 1, summary['sampleCount']) and
            integer(summary.get('minimumAvailableRamBytes'), GiB) and summary.get('allPressureNormal') is True,
            'resource summary must prove positive actual samples, normal pressure and headroom')
    for key in ('maximumControllerRssBytes', 'maximumControllerPhysicalFootprintBytes'):
        require(integer(summary.get(key), 1, 256 * MiB), 'resource summary controller peak invalid')
    for key in ('maximumOwnedChildRssBytes', 'maximumOwnedChildPhysicalFootprintBytes'):
        require(integer(summary.get(key), 1, 7 * GiB // 2), 'resource summary owned child peak invalid')
    if samples is not None:
        require(summary == resource_summary(samples), 'resource summary disagrees with full retained measured samples')


def measured_run(process, evidence_directory, inventory):
    return dict(evidenceDirectory=str(evidence_directory), evidenceInventory=inventory,
                resourceSummary=resource_summary(process['resourceSamples']), steps=process['steps'])


def bounded_report_bytes(report):
    raw = (json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + '\n').encode()
    require(len(raw) <= MiB, 'converted reviewed report exceeds the unchanged 1 MiB runtime cap')
    return raw


def fp_from_stat(s):
    require(stat.S_ISREG(s.st_mode), 'regular retained file required; symlinks are rejected')
    return dict(device=s.st_dev, inode=s.st_ino, sizeBytes=s.st_size,
                mtimeSeconds=s.st_mtime_ns // 10**9, mtimeNanoseconds=s.st_mtime_ns % 10**9,
                ctimeSeconds=s.st_ctime_ns // 10**9, ctimeNanoseconds=s.st_ctime_ns % 10**9)


def fingerprint(path):
    return fp_from_stat(os.stat(path, follow_symlinks=False))


def valid_fp(value):
    return (isinstance(value, dict) and set(value) == set(FP_FIELDS) and
            all(integer(value[k]) for k in FP_FIELDS) and
            value['mtimeNanoseconds'] < 10**9 and value['ctimeNanoseconds'] < 10**9)


def readonly(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        fp_from_stat(os.fstat(fd))
        if sys.platform == 'darwin':
            import fcntl
            fcntl.fcntl(fd, 48, 1)  # descriptor-local F_NOCACHE
            fcntl.fcntl(fd, 45, 0)  # descriptor-local F_RDAHEAD=0
        return fd
    except BaseException:
        os.close(fd)
        raise


def duplicate_safe(items):
    result = {}
    for key, value in items:
        require(key not in result, 'duplicate JSON keys are rejected')
        result[key] = value
    return result


def parse_json(raw):
    def invalid_constant(value):
        raise Rejected(f'nonfinite JSON constant {value} is rejected')
    return json.loads(raw, object_pairs_hook=duplicate_safe, parse_constant=invalid_constant)


def read_bytes(path, cap):
    fd = readonly(path)
    try:
        before = fp_from_stat(os.fstat(fd))
        require(before['sizeBytes'] <= cap, 'retained metadata/log exceeds read cap')
        chunks, total = [], 0
        while block := os.read(fd, min(MiB, cap + 1 - total)):
            total += len(block)
            require(total <= cap, 'retained file grew past read cap')
            chunks.append(block)
        require(total == before['sizeBytes'] and before == fp_from_stat(os.fstat(fd)),
                'retained file changed during passive read')
        return b''.join(chunks)
    finally:
        os.close(fd)


def hash_retained(path, cap):
    fd = readonly(path)
    try:
        before = fp_from_stat(os.fstat(fd))
        require(0 < before['sizeBytes'] <= cap, 'retained evidence size is unbounded or empty')
        h, count = hashlib.sha256(), 0
        while block := os.read(fd, MiB):
            h.update(block)
            count += len(block)
            require(count <= cap, 'retained evidence grew beyond bounded hash cap')
        require(count == before['sizeBytes'] and before == fp_from_stat(os.fstat(fd)),
                'retained evidence changed while hashing')
        return dict(sha256=h.hexdigest(), sizeBytes=count, fingerprint=before)
    finally:
        os.close(fd)


def validate_source(source, manifest_digest, helper_digest, hashes, check_fp=fingerprint):
    equal_fields(source, dict(schemaVersion=1, completeVerifiedSource=True,
                 baseCommit=BASE, patchSha256=PATCH, resourceManifestSha256=manifest_digest,
                 artifactSetDigest=SET_DIGEST, templateSha256=TEMPLATE,
                 repository='Qwen/Qwen3-Coder-Next-GGUF', revision=REVISION,
                 architecture='qwen3next'), 'source')
    equal_fields(source.get('geometry'), GEOMETRY, 'actual source geometry')
    rows = source.get('artifacts')
    require(isinstance(rows, list) and len(rows) == 4 and len(hashes) == 4,
            'all four complete distinct shard integrity outputs required')
    actual_set = []
    paths = set()
    for row, expected, hashed in zip(rows, ARTIFACTS, hashes):
        equal_fields(row, expected, 'immutable official shard')
        equal_fields(row, dict(bytesRead=expected['sizeBytes'], ioMode='darwin-nocache'), 'source integrity')
        require(isinstance(row.get('path'), str) and pathlib.Path(row['path']).is_absolute() and
                pathlib.Path(row['path']).name == expected['filename'] and row['path'] not in paths,
                'exact distinct absolute source paths required; no partial/sparse preview identity')
        paths.add(row['path'])
        require(valid_fp(row.get('fingerprint')) and
                row['fingerprint']['sizeBytes'] == expected['sizeBytes'] and
                check_fp(row['path']) == row['fingerprint'], 'source fingerprint changed after full integrity')
        equal_fields(hashed, dict(schemaVersion=1, helperIdentity='free-local-agent-ssd-hash-v1',
                     baseCommit=BASE, patchSha256=PATCH, helperSourceSha256=helper_digest,
                     sha256=expected['sha256'], sizeBytes=expected['sizeBytes'],
                     bytesRead=expected['sizeBytes'], ioMode='darwin-nocache', bufferBytes=MiB,
                     memoryPressure='normal'), 'actual native shard integrity log')
        require(hashed.get('fingerprint') == row['fingerprint'], 'native shard fingerprint binding mismatch')
        for k in ('rssBytes', 'physicalFootprintBytes'):
            require(integer(hashed.get(k), 1, 128 * MiB), 'native integrity memory cap is not proven')
        require(integer(hashed.get('availableRamBytes'), 512 * MiB), 'native integrity headroom is missing')
        actual_set.append({k: row[k] for k in ('filename', 'sha256', 'sizeBytes')})
    require(hashlib.sha256(compact(actual_set)).hexdigest() == SET_DIGEST,
            'ordered artifact-set digest mismatch; shard1 hash is never a model-set hash')


def validate_fixture(fixture, source, hashed, manifest_digest, helper_digest, check_fp=fingerprint):
    equal_fields(fixture, dict(schemaVersion=1, sourceArtifactSetDigest=SET_DIGEST,
                 sourceTemplateSha256=TEMPLATE, nativePatchSha256=PATCH,
                 resourceManifestSha256=manifest_digest, selectedOriginalLayers=[0, 3],
                 recurrentLayers=[True, False], sourceFingerprintUnchanged=True,
                 inferenceExecuted=False, copyBufferBytes=MiB), 'separate fixture')
    require(sha(fixture.get('fixtureSha256')) and integer(fixture.get('fixtureSizeBytes'), 1, 4 * GiB),
            'bounded separately hashed fixture required')
    require(isinstance(fixture.get('fixturePath'), str) and pathlib.Path(fixture['fixturePath']).is_absolute(),
            'absolute separate fixture path required')
    require(valid_fp(fixture.get('fixtureFingerprint')) and
            fixture['fixtureFingerprint']['sizeBytes'] == fixture['fixtureSizeBytes'] and
            check_fp(fixture['fixturePath']) == fixture['fixtureFingerprint'], 'fixture fingerprint changed')
    equal_fields(hashed, dict(schemaVersion=1, helperIdentity='free-local-agent-ssd-hash-v1',
                 baseCommit=BASE, patchSha256=PATCH, helperSourceSha256=helper_digest,
                 sha256=fixture['fixtureSha256'], sizeBytes=fixture['fixtureSizeBytes'],
                 bytesRead=fixture['fixtureSizeBytes'], ioMode='darwin-nocache',
                 bufferBytes=MiB, memoryPressure='normal'), 'separate native fixture integrity')
    require(hashed.get('fingerprint') == fixture['fixtureFingerprint'], 'separate fixture integrity binding changed')
    require(all(integer(hashed.get(k), 1, 128 * MiB) for k in ('rssBytes', 'physicalFootprintBytes')),
            'fixture integrity memory cap missing')
    rows = fixture.get('tensors')
    require(isinstance(rows, list) and 0 < len(rows) <= 100, 'complete bounded fixture tensor copy proof required')
    names, groups = set(), {0: set(), 3: set()}
    for row in rows:
        name, dest = row.get('name'), row.get('destinationName')
        require(isinstance(name, str) and name not in names, 'duplicate/missing fixture source tensor')
        names.add(name)
        match = re.fullmatch(r'blk\.(0|3)\.(.+)', name)
        require(match is not None or name in ('token_embd.weight', 'output.weight', 'output_norm.weight'),
                'fixture contains an unreviewed tensor/layer')
        require(dest == name.replace('blk.3.', 'blk.1.', 1), 'fixture remapping is not original layers 0/3')
        require(integer(row.get('sourceShard'), 0, 3) and integer(row.get('sizeBytes'), 1, GiB) and
                integer(row.get('sourceOffset')) and integer(row.get('destinationOffset')) and
                row['sourceOffset'] + row['sizeBytes'] <= source['artifacts'][row['sourceShard']]['sizeBytes'] and
                row['destinationOffset'] + row['sizeBytes'] <= fixture['fixtureSizeBytes'],
                'bounded real source/fixture tensor copy offsets required')
        require(sha(row.get('sourceCopiedSha256')) and
                row['sourceCopiedSha256'] == row.get('destinationVerifiedSha256'), 'raw tensor copy/readback mismatch')
        if match and re.fullmatch(r'ffn_(down|gate|up)_exps\.weight', match[2]):
            groups[int(match[1])].add(match[2])
    required = {f'ffn_{kind}_exps.weight' for kind in ('down', 'gate', 'up')}
    require(all(g == required for g in groups.values()) and
            {'token_embd.weight', 'output.weight', 'output_norm.weight'} <= names,
            'fixture lacks both complete original routed groups or global tensors')


def validate_process(process, manifest_digest):
    no_fake_flags(process)
    equal_fields(process, dict(schemaVersion=1, evidenceKind='measured-native-qwen80-proof',
                 protocol=PROTOCOL, passed=True, issuedAppCertificate=False, fullModelLoaded=False,
                 diagnosticEvidenceVersion=DIAGNOSTIC_EVIDENCE_VERSION, evidenceInventoryComplete=True,
                 baseCommit=BASE, patchSha256=PATCH, resourceManifestSha256=manifest_digest,
                 artifactSetDigest=SET_DIGEST, templateSha256=TEMPLATE,
                 resourcesVerified=True, sourceFingerprintUnchanged=True, ownedProcessesStopped=True), 'process')
    equal_fields(process.get('profile'), RUN_PROFILE, 'measured 8K run profile')
    validate_resolved_layout(process.get('resolvedNativeLayout'), 'process actual resolved Qwen KV layout')
    build = process.get('build')
    require(isinstance(build, dict), 'actual private fixture build binding required')
    binaries = build.get('binaries')
    require(isinstance(binaries, list) and len(binaries) == 2 and
            all(isinstance(row, dict) and isinstance(row.get('path'), str) for row in binaries),
            'exact source-bound private fixture build required')
    require({pathlib.Path(row['path']).name for row in binaries} ==
            {'qwen80-expert-parity', 'qwen80-graph-parity'}, 'exact source-bound private fixture build required')
    for row in binaries:
        require(isinstance(row, dict) and set(row) == {'path', 'sha256', 'sourceSha256'} and
                isinstance(row.get('path'), str) and sha(row.get('sha256')) and
                row.get('sourceSha256') == hashlib.sha256(pathlib.Path(__file__).with_name(pathlib.Path(row['path']).name + '.cpp').read_bytes()).hexdigest(),
                'current private diagnostic/expert source differs from measured build')
    require('failure' not in process and process.get('scope') == SCOPE, 'failed/wrong-scope process cannot convert')
    steps = process.get('steps')
    require(isinstance(steps, list) and [s.get('name') for s in steps] == STEPS,
            'complete ordered eleven actual measured process steps required')
    for step in steps:
        require(type(step.get('exitCode')) is int and step['exitCode'] == 0 and
                step.get('stopReason') is None and finite(step.get('wallSeconds'), 1e-9),
                'failed/stopped/unmeasured process step cannot convert')
    resource_summary(process.get('resourceSamples'))
    if 'resourceSummary' in process:
        validate_resource_summary(process['resourceSummary'], process['resourceSamples'])


def records(text, prefix):
    require(isinstance(text, str) and len(text.encode()) <= 64 * MiB, 'bounded retained native log required')
    return [parse_json(line[len(prefix) + 1:]) for line in text.splitlines() if line.startswith(prefix + ' ')]


def single(text, prefix):
    found = records(text, prefix)
    require(len(found) == 1, f'exactly one actual {prefix} record required')
    return found[0]


def validate_experts(text, process):
    require(not any(marker in text for marker in ('SSD_PARITY_ERROR', 'SSD_PARITY_STOPPED')),
            'native expert process error/stoppage present')
    metadata, final = single(text, 'SSD_PARITY_METADATA'), single(text, 'SSD_PARITY_FINAL')
    require(metadata.get('groupsSurveyed') == 48, 'all 48 actual routed layouts must be surveyed')
    layouts = metadata.get('layouts')
    require(isinstance(layouts, list) and 0 < len(layouts) <= 48, 'actual distinct-layout details required')
    all_groups, signatures, representatives, layout_for_group = [], set(), set(), {}
    for row in layouts:
        signature, groups = row.get('signature'), row.get('groups')
        require(isinstance(signature, str) and 0 < len(signature) < 4096 and signature not in signatures,
                'distinct real tensor layout signatures required')
        signatures.add(signature)
        require(isinstance(groups, list) and groups and all(integer(g, 0, 47) for g in groups) and
                groups == sorted(set(groups)) and row.get('firstGroup') == groups[0] and
                row.get('lastGroup') == groups[-1], 'first/last representatives must derive from actual groups')
        all_groups.extend(groups)
        representatives.update((groups[0], groups[-1]))
        for group in groups:
            layout_for_group[group] = signature
    require(sorted(all_groups) == list(range(48)), 'layout survey omits/duplicates actual routed groups')
    require(metadata.get('distinctLayouts') == len(layouts) and metadata.get('representativeGroups') == len(representatives),
            'layout survey counts do not match actual first/last representatives')
    tensors = records(text, 'SSD_PARITY_TENSOR')
    tensor_map = {}
    for row in tensors:
        name = row.get('name')
        match = re.fullmatch(r'blk\.(\d+)\.(ffn_(?:down|gate|up|gate_up)_exps\.weight)', name or '')
        require(match is not None and int(match[1]) in representatives and name not in tensor_map,
                'actual representative tensor identities missing/duplicated/unreviewed')
        tensor_map[name] = row
        require(row.get('experts') == 512 and isinstance(row.get('quantization'), str) and
                integer(row.get('inputWidth'), 1, 32768) and integer(row.get('outputWidth'), 1, 32768) and
                type(row.get('actualScaleApplied')) is bool, 'actual expert tensor geometry/scale proof missing')
    expected_tensors = set()
    for group in representatives:
        components = layout_for_group[group].split(';')
        for component in filter(None, components):
            match = re.fullmatch(r'\.(ffn_(?:down|gate|up|gate_up)_exps\.weight):([A-Za-z0-9_]+):(\d+):(\d+)(?::scale:([A-Za-z0-9_]+))?', component)
            require(match is not None, 'actual layout signature cannot bind retained representative tensors')
            name = f'blk.{group}.{match[1]}'
            expected_tensors.add(name)
            equal_fields(tensor_map.get(name), dict(quantization=match[2], inputWidth=int(match[3]),
                         outputWidth=int(match[4]), experts=512, actualScaleApplied=match[5] is not None),
                         'actual surveyed representative tensor')
    require(set(tensor_map) == expected_tensors, 'representative actual tensors do not match distinct surveyed layouts')
    cases = records(text, 'SSD_PARITY_CASE')
    grouped = {}
    for row in cases:
        layer, name = row.get('layer'), row.get('name')
        require(layer in representatives and name in CASES and (layer, name) not in grouped,
                'native representative case layer/name missing, duplicated or unreviewed')
        grouped[layer, name] = row
        tokens, waves = CASES[name]
        equal_fields(row, dict(tokens=tokens, waves=waves, passed=True, nonfinite=0,
                     elementsOutsideTolerance=0, allSelectedPairsContributeOnce=True,
                     rawBytesEqual=True, absoluteTolerance=1e-5, relativeTolerance=1e-5), 'actual expert case')
        require(finite(row.get('maxAbsoluteDifference')) and finite(row.get('maxRelativeDifference')),
                'expert numeric maxima must be finite')
    require(set(grouped) == {(g, name) for g in representatives for name in CASES},
            'all five expert cases for every actual first/last layout representative are required')
    groups = records(text, 'SSD_PARITY_GROUP')
    require(len(groups) == len(representatives) and {r.get('layer') for r in groups} == representatives,
            'completed actual representative groups missing')
    for row in groups:
        require(row.get('passed') is True and integer(row.get('ordinaryExpertBytes'), 1, 1536 * MiB) and
                integer(row.get('cacheBytes'), 1, 1536 * MiB) and integer(row.get('hits'), 1) and
                integer(row.get('cacheMisses'), 31), 'expert cold/warm/eviction evidence incomplete')
        native = row.get('residentMemorySample', {})
        equal_fields(native, dict(baseCommit=BASE, patchSha256=PATCH, cpuKernel='standard',
                     useExtraBufts=False, cpuRepackTensorCount=0, decodeThreads=4, batchThreads=4,
                     allocationBudgetBytes=1536 * MiB, residentLimitBytes=1664 * MiB,
                     expectedGroups=1, streamedGroups=1, cacheSlotsPerLayer=30,
                     ioMode='darwin-nocache', stopped=False, deadlineArmed=True), 'expert actual kernel/cache/bounds')
        require(all(integer(native.get(k), 1, 1664 * MiB) for k in ('rssBytes', 'physicalFootprintBytes')) and
                isinstance(native.get('sampledAt'), str) and native['sampledAt'],
                'populated representative expert buffers need an actual bounded resident sample')
    equal_fields(final, dict(passed=True, verifiedModelSha256FromCaller=SET_DIGEST, patchSha256=PATCH,
                 allocationBudgetBytes=1536 * MiB, residentLimitBytes=1664 * MiB, llmInferencePerformed=False),
                 'expert final provenance')
    require(integer(final.get('checks'), 1) and process.get('expertParity') == final,
            'expert final report is not bound to the actual retained log')
    return len(layouts), len(representatives)


def capture_key(row):
    return row.get('caseId'), row.get('step'), row.get('name'), row.get('occurrence', 0)


def common_name(name):
    if re.fullmatch(r'ffn_moe_topk-\d+ \(cont\)', name):
        return False
    prefixes = ('ffn_moe_argsort', 'ffn_moe_logits', 'ffn_moe_probs', 'ffn_moe_topk',
                'ffn_moe_weights', 'ffn_moe_weights_norm', 'ffn_moe_out', 'ffn_moe',
                'ffn_moe_combined', 'ffn_shexp', 'shared_expert_gate',
                'shared_expert_gate_sigmoid', 'ffn_shexp_gated', 'ffn_out', 'post_moe',
                'attn_residual', 'linear_attn_out', 'attn_output')
    return (name.startswith(('API_logits_output_', 'l_out-')) or name in ('result_output', 'result_norm') or
            any(name.startswith(p + '-') for p in prefixes))


def validate_residual_aliases(report, indexed):
    """Require source-bound observed tensor identities; never synthesize captures."""
    equal_fields(report, dict(diagnosticEvidenceVersion=DIAGNOSTIC_EVIDENCE_VERSION,
                 diagnosticSourceSha256=DIAGNOSTIC_SOURCE_SHA256,
                 residualAliasContract=RESIDUAL_ALIAS_CONTRACT), 'version2 native residual diagnostics')
    expected = {(ci, si, layer): (count if si == 0 else 1)
                for ci, count in enumerate((1, 3, 4, 5, 16, 16))
                for si in range(3 if ci >= 4 else 1) for layer in (0, 1)}
    witnesses = report.get('run', {}).get('residualAliasWitnesses')
    require(isinstance(witnesses, list) and len(witnesses) == 20,
            'twenty actual residual alias witnesses per mode required')
    positions = {key: i for i, key in enumerate(indexed)}
    result = {}
    def ref_key(ref):
        require(isinstance(ref, dict) and set(ref) == REF_FIELDS and
                all(type(ref[k]) is int for k in ('caseId', 'step', 'occurrence')) and isinstance(ref['name'], str),
                'exact native capture reference required')
        return capture_key(ref)
    for row in witnesses:
        require(isinstance(row, dict) and set(row) == WITNESS_FIELDS and
                type(row['schemaVersion']) is int and row['schemaVersion'] == 1 and
                all(type(row[k]) is int for k in ('caseId', 'step', 'layer')),
                'versioned exact residual alias witness required')
        key = row['caseId'], row['step'], row['layer']
        require(key in expected and key not in result, 'missing/duplicate/wrong-step residual witness')
        ci, si, layer = key
        require(row['semanticName'] == f'post_moe-{layer}' and row['nativeOperation'] == 'ADD' and
                row['sameTensor'] is True and row['controlVectorApplied'] is False,
                'actual same-tensor post_moe/l_out residual ADD without control vector required')
        output_key = ref_key(row['capture'])
        require(output_key == (ci, si, f'l_out-{layer}', 0) and
                (ci, si, f'post_moe-{layer}', 0) not in indexed, 'witness must refer to real l_out, not a fabricated post_moe capture')
        refs = row['operands']
        require(isinstance(refs, list) and len(refs) == 2, 'exact two actual ADD operands required')
        parents = [ref_key(ref) for ref in refs]
        require(parents == [(ci, si, f'ffn_out-{layer}', 0), (ci, si, f'attn_residual-{layer}', 0)] and
                all(k in indexed for k in [output_key, *parents]), 'exact current-step residual operand captures required')
        require(all(positions[k] < positions[output_key] for k in parents), 'ADD operands must be captured before their output')
        output, left, right = [indexed[k] for k in [output_key, *parents]]
        for node in (output, left, right):
            require(node['type'] == 'f32' and node['dimensions'] == [2048, expected[key], 1, 1] and
                    all(type(d) is int for d in node['dimensions']) and
                    node['bytes'] == 2048 * expected[key] * 4 and node['nonfinite'] == 0 and
                    node.get('nativeContiguous') is True and node.get('nativeView') is False and
                    integer(node.get('nativeTensorId'), 1, 2**31 - 1),
                    'actual equal contiguous two-dimensional F32 residual tensors without views/broadcast required')
        ids = [n['nativeTensorId'] for n in (output, left, right)]
        require(len(set(ids)) == 3 and type(row['semanticTensorId']) is int and type(row['capturedTensorId']) is int and
                row['semanticTensorId'] == row['capturedTensorId'] == ids[0], 'observed native output pointer identity mismatch')
        require(row['nativeParentTensorIds'] == ids[1:] == output.get('nativeParentTensorIds') and
                isinstance(row['nativeParentTensorIds'], list) and
                all(type(n) is int for n in row['nativeParentTensorIds']) and
                isinstance(output.get('nativeParentTensorIds'), list) and
                all(type(n) is int for n in output['nativeParentTensorIds']) and output.get('nativeOperation') == 'ADD',
                'actual native ADD parent pointer identities mismatch')
        result[key] = output, left, right
    require(result.keys() == expected.keys(), 'complete post_moe and l_out semantic coverage required')
    return result


def validate_graph(report, mode, fixture, manifest_digest, binary_size):
    no_fake_flags(report)
    equal_fields(report, dict(protocol=PROTOCOL, diagnosticEvidenceVersion=DIAGNOSTIC_EVIDENCE_VERSION,
                 diagnosticSourceSha256=DIAGNOSTIC_SOURCE_SHA256, residualAliasContract=RESIDUAL_ALIAS_CONTRACT, patchSha256=PATCH,
                 resourceManifestSha256=manifest_digest, fixtureSha256=fixture['fixtureSha256'],
                 sourceArtifactSetDigest=SET_DIGEST, sourceTemplateSha256=TEMPLATE,
                 useExtraBufts=False, matchedKernelControl=True, mode=mode,
                 admitted=True, inferenceExecuted=not mode.startswith('plan-')), 'actual graph')
    equal_fields(report.get('profile'), RUN_PROFILE, 'actual graph 8K computation profile')
    validate_resolved_layout(report.get('resolvedNativeLayout'), 'actual graph resolved Qwen KV layout')
    require(integer(report.get('allocationBudgetBytes'), 1, 3 * GiB) and
            integer(report.get('residentLimitBytes'), report['allocationBudgetBytes'], 7 * GiB // 2),
            'bounded actual graph allocation/resident limits required')
    plan = report.get('plan', {})
    equal_fields(plan, dict(noAlloc=True, modelPayloadAllocatedBytes=0), 'fresh native graph plan')
    validate_resolved_layout(plan.get('resolvedNativeLayout'), 'actual native plan resolved Qwen KV layout')
    p = plan.get('profile')
    expected_plan = dict(RUN_PROFILE, cacheSlotsPerLayer=30 if mode.endswith('streamed') else 0)
    equal_fields(p, expected_plan, 'actual partial-model native shape')
    require(all(integer(plan.get(k), 1, report['allocationBudgetBytes'])
                for k in ('steadyBytes', 'loadingPeakBytes', 'requiredBytes')) and
            plan['requiredBytes'] == max(plan['steadyBytes'], plan['loadingPeakBytes']), 'native graph peak is unproven')
    for field in ('initialMeasurement', 'finalMeasurement'):
        row = report.get(field, {})
        require(row.get('valid') is True and type(row.get('pressureLevel')) is int and row['pressureLevel'] == 1 and
                integer(row.get('availableRamBytes'), 512 * MiB) and
                all(integer(row.get(k), 1, report['residentLimitBytes'])
                    for k in ('rssBytes', 'physicalFootprintBytes')), 'actual graph memory measurement invalid')
    if mode.startswith('plan-'):
        require('run' not in report, 'planning evidence falsely claims execution')
        return {}
    run = report.get('run', {})
    equal_fields(run, dict(mode=mode, partialModelOnly=True, captureBytes=binary_size), 'actual hybrid captures')
    validate_resolved_layout(run.get('resolvedNativeLayout'), 'actual native run resolved Qwen KV layout')
    cases = run.get('cases')
    require(isinstance(cases, list) and [r.get('caseId') for r in cases] == list(range(6)),
            'six actual teacher-forced cases required')
    nodes = run.get('captures')
    require(isinstance(nodes, list) and 0 < len(nodes) <= 100000, 'bounded complete graph captures required')
    indexed, at = {}, 0
    for node in nodes:
        key = capture_key(node)
        require(key not in indexed and integer(key[0], 0, 5) and integer(key[1], 0, 2) and
                isinstance(key[2], str) and integer(key[3], 0, 1000), 'graph capture identity invalid/duplicated')
        require(node.get('type') in ('f32', 'i32') and type(node.get('nonfinite')) is int and node['nonfinite'] == 0 and
                node.get('offset') == at and integer(node.get('bytes'), 4, 32 * MiB) and node['bytes'] % 4 == 0,
                'graph capture missing, nonfinite, overlapping or out of bounds')
        dims = node.get('dimensions')
        require(isinstance(dims, list) and len(dims) == 4 and all(integer(d, 1) for d in dims) and
                math.prod(dims) * 4 == node['bytes'], 'graph capture shape and bytes disagree')
        at += node['bytes']
        require(at <= binary_size, 'capture exceeds retained binary size')
        indexed[key] = node
    require(at == binary_size, 'capture binary contains missing/unaccounted bytes')
    residuals = validate_residual_aliases(report, indexed)
    required_names = ('ffn_moe_argsort', 'ffn_moe_topk', 'ffn_moe_weights_norm', 'ffn_moe_out',
                      'ffn_shexp', 'shared_expert_gate_sigmoid', 'ffn_shexp_gated', 'ffn_out', 'attn_residual', 'post_moe', 'l_out')
    for ci, case in enumerate(cases):
        expected_tokens = (1, 3, 4, 5, 16, 16)[ci]
        tokens, steps = case.get('prefillTokens'), case.get('steps')
        require(isinstance(tokens, list) and len(tokens) == expected_tokens and
                all(integer(t, 0, 151935) for t in tokens) and isinstance(steps, list) and
                [s.get('step') for s in steps] == list(range(3 if ci >= 4 else 1)), 'ten actual aligned decode steps required')
        for step in steps:
            si, nt = step['step'], expected_tokens if step['step'] == 0 else 1
            require(step.get('tokens') == nt and finite(step.get('elapsedSeconds'), 1e-9), 'actual measured token step missing')
            for layer in (0, 1):
                for name in required_names:
                    if name == 'post_moe':
                        require((ci, si, layer) in residuals, 'native post_moe alias witness missing')
                        continue
                    require((ci, si, f'{name}-{layer}', 0) in indexed, 'required hybrid per-layer diagnostic missing')
                    kind = 'i32' if name in ('ffn_moe_argsort', 'ffn_moe_topk') else 'f32'
                    require(indexed[ci, si, f'{name}-{layer}', 0]['type'] == kind,
                            'integer routing and float layer diagnostics require their actual native types')
                    if kind == 'i32':
                        count = 512 if name == 'ffn_moe_argsort' else 10
                        require(indexed[ci, si, f'{name}-{layer}', 0]['bytes'] == count * nt * 4,
                                'actual router captures must include all 512 IDs or exactly top 10 per token')
                if mode == 'streamed':
                    if nt <= 3:
                        require((ci, si, f'ffn_moe_topk_stream-{layer}', 0) in indexed, 'streamed original-ID remap missing')
                        require(indexed[ci, si, f'ffn_moe_topk_stream-{layer}', 0]['type'] == 'i32',
                                'remapped router IDs require actual I32 captures')
                        require(indexed[ci, si, f'ffn_moe_topk_stream-{layer}', 0]['bytes'] == 10 * nt * 4,
                                'complete actual remapped top10 token pairs required')
                    else:
                        for wave in range(nt):
                            require((ci, si, f'ffn_moe_wave_ids-{layer}', wave) in indexed and
                                    (ci, si, f'ffn_moe_wave_mask-{layer}', wave) in indexed, 'complete native waves missing')
                            require(indexed[ci, si, f'ffn_moe_wave_ids-{layer}', wave]['type'] == 'i32' and
                                    indexed[ci, si, f'ffn_moe_wave_mask-{layer}', wave]['type'] == 'f32',
                                    'wave IDs/masks require their actual I32/F32 types')
                            require(indexed[ci, si, f'ffn_moe_wave_ids-{layer}', wave]['bytes'] == 10 * nt * 4 and
                                    indexed[ci, si, f'ffn_moe_wave_mask-{layer}', wave]['bytes'] == 10 * nt * 4,
                                    'complete top10 selected pairs required for every actual native wave')
            for name in ('linear_attn_out-0', 'attn_output-1', 'result_output'):
                require((ci, si, name, 0) in indexed, 'recurrent/full-attention/output diagnostic missing')
            for t in range(nt):
                node = indexed.get((ci, si, f'API_logits_output_{t}', 0), {})
                require(node.get('type') == 'f32' and node.get('dimensions') == [151936, 1, 1, 1],
                        'complete original vocabulary output logits required')
    native = run.get('finalNativeLedger', {})
    equal_fields(native, dict(baseCommit=BASE, patchSha256=PATCH, cpuKernel='standard',
                 useExtraBufts=False, cpuRepackTensorCount=0, decodeThreads=4, batchThreads=4,
                 allocationBudgetBytes=report['allocationBudgetBytes'], residentLimitBytes=report['residentLimitBytes'],
                 stopped=False, deadlineArmed=True), 'final actual graph kernel/bounds')
    if mode == 'streamed':
        equal_fields(native, dict(expectedGroups=2, streamedGroups=2, cacheSlotsPerLayer=30,
                     ioMode='darwin-nocache'), 'actual partial streamed groups')
    return indexed


def validate_comparison(value, ordinary, streamed, fixture, process):
    equal_fields(value, dict(protocol=PROTOCOL, fixtureSha256=fixture['fixtureSha256'],
                 patchSha256=PATCH, absoluteTolerance=1e-5, relativeTolerance=1e-5,
                 diagnosticEvidenceVersion=DIAGNOSTIC_EVIDENCE_VERSION, diagnosticSourceSha256=DIAGNOSTIC_SOURCE_SHA256,
                 residualAliasContract=RESIDUAL_ALIAS_CONTRACT, firstFailedResidual=None,
                 passed=True, completeEvidenceForAllSixCasesTenStepsTwoLayers=True), 'measured hybrid comparison')
    equal_fields(value.get('profile'), RUN_PROFILE, 'comparison 8K profile')
    validate_resolved_layout(value.get('resolvedNativeLayout'), 'comparison actual resolved Qwen KV layout')
    require(value.get('firstFailedNode') is None and process.get('comparison') == value,
            'comparison failure or process binding mismatch')
    alias_evidence = value.get('residualAliasEvidence')
    require(isinstance(alias_evidence, dict) and set(alias_evidence) == {'schemaVersion', 'ordinary', 'streamed'} and
            type(alias_evidence['schemaVersion']) is int and alias_evidence['schemaVersion'] == 1,
            'independent residual ADD comparison evidence required')
    expected_aliases = {(ci, si, layer): (count if si == 0 else 1)
                        for ci, count in enumerate((1, 3, 4, 5, 16, 16))
                        for si in range(3 if ci >= 4 else 1) for layer in (0, 1)}
    for mode, captures in [('ordinary', ordinary), ('streamed', streamed)]:
        residual_rows = alias_evidence[mode]
        require(isinstance(residual_rows, list) and len(residual_rows) == 20,
                'twenty independently measured residual ADD checks per mode required')
        seen_aliases = set()
        for row in residual_rows:
            require(isinstance(row, dict) and set(row) == {'caseId', 'step', 'layer', 'semanticName', 'captureName',
                    'passed', 'elements', 'elementsOutsideTolerance', 'maxAbsoluteDifference', 'maxRelativeDifference',
                    'rootMeanSquaredDifference'} and all(type(row[k]) is int for k in ('caseId', 'step', 'layer')),
                    'exact residual arithmetic comparison row required')
            key = row['caseId'], row['step'], row['layer']
            require(key in expected_aliases and key not in seen_aliases, 'complete unique residual arithmetic coverage required')
            seen_aliases.add(key); ci, si, layer = key
            require(row['semanticName'] == f'post_moe-{layer}' and row['captureName'] == f'l_out-{layer}' and
                    row['passed'] is True and type(row['elements']) is int and row['elements'] == 2048 * expected_aliases[key] and
                    type(row['elementsOutsideTolerance']) is int and row['elementsOutsideTolerance'] == 0 and
                    all(finite(row[k]) for k in ('maxAbsoluteDifference', 'maxRelativeDifference', 'rootMeanSquaredDifference')) and
                    captures[ci, si, f'l_out-{layer}', 0]['bytes'] == row['elements'] * 4,
                    'residual ADD mismatch, nonfinite or wrong physical element coverage')
        require(seen_aliases == expected_aliases.keys(), 'residual arithmetic coverage incomplete')
    left = {k: n for k, n in ordinary.items() if common_name(n['name'])}
    right = {k: n for k, n in streamed.items() if common_name(n['name'])}
    require(left and left.keys() == right.keys(), 'common diagnostics fail to align')
    rows = value.get('nodes')
    require(isinstance(rows, list) and len(rows) == len(left) and value.get('nodesCompared') == len(rows),
            'comparison must cover every common actual captured node')
    seen, elements = set(), 0
    for row in rows:
        key = capture_key(row)
        require(key in left and key not in seen and row.get('passed') is True and
                row.get('elements') == left[key]['bytes'] // 4 and
                left[key]['type'] == right[key]['type'] and left[key]['dimensions'] == right[key]['dimensions'],
                'compared node does not match actual capture pair')
        seen.add(key)
        elements += row['elements']
        if left[key]['type'] == 'i32':
            require(type(row.get('mismatchedIds')) is int and row['mismatchedIds'] == 0,
                    'router IDs must match exactly')
        else:
            require(type(row.get('elementsOutsideTolerance')) is int and row['elementsOutsideTolerance'] == 0 and
                    all(finite(row.get(k)) for k in ('maxAbsoluteDifference', 'maxRelativeDifference', 'rootMeanSquaredDifference')),
                    'float mismatches/nonfinite summary cannot convert')
    require(seen == left.keys() and value.get('elementsCompared') == elements and elements > 0,
            'comparison element coverage mismatch')
    expected_waves = {(ci, 0, layer) for ci in (2, 3, 4, 5) for layer in (0, 1)}
    waves = value.get('waves')
    require(isinstance(waves, list) and len(waves) == len(expected_waves) and
            {(r.get('caseId'), r.get('step'), r.get('layer')) for r in waves} == expected_waves and
            all(r.get('allSelectedPairsContributeOnce') is True and integer(r.get('graphWaveCount'), 1)
                for r in waves), 'actual selected pairs must contribute exactly once in every wave group')
    copies = value.get('streamedOriginalIdCopies')
    expected_copies = {k: n for k, n in streamed.items() if re.fullmatch(r'ffn_moe_topk-\d+ \(cont\)', n['name'])}
    require(isinstance(copies, list) and len(copies) == len(expected_copies) and expected_copies and
            {capture_key(r) for r in copies} == expected_copies.keys() and
            all(r.get('passed') is True and type(r.get('mismatchedIds')) is int and r['mismatchedIds'] == 0 and
                r.get('elements') == expected_copies[capture_key(r)]['bytes'] // 4 for r in copies),
            'every actual contiguous original-ID copy must match exactly')
    require(isinstance(value.get('remainingCoverageGaps'), list) and len(value['remainingCoverageGaps']) >= 4,
            'incomplete full-model/Metal/quality scope must be retained')
    return left, right


def numeric_pair(fd_left, fd_right, left, right):
    """Independently recheck retained captures, using <= 2 MiB of read chunks."""
    require(sys.byteorder == 'little', 'captured native f32/i32 require a little-endian review host')
    require(left['type'] == right['type'] and left['bytes'] == right['bytes'] and
            left.get('dimensions') == right.get('dimensions'), 'actual compared capture types/shapes differ')
    kind = 'f' if left['type'] == 'f32' else 'i'
    require(array.array(kind).itemsize == 4, '32-bit standard-library capture representation required')
    for offset in range(0, left['bytes'], MiB):
        size = min(MiB, left['bytes'] - offset)
        blocks = [os.pread(fd, size, node['offset'] + offset) for fd, node in
                  ((fd_left, left), (fd_right, right))]
        require(all(len(block) == size for block in blocks), 'complete capture read required')
        a, b = array.array(kind), array.array(kind)
        a.frombytes(blocks[0]); b.frombytes(blocks[1])
        for x, y in zip(a, b):
            if kind == 'i':
                require(x == y, 'actual retained router IDs differ')
            else:
                require(math.isfinite(x) and math.isfinite(y) and abs(x - y) <= 1e-5 + 1e-5 * abs(x),
                        'actual retained float values differ or are nonfinite')


def values(fd, node):
    require(node['bytes'] <= 32 * MiB, 'bounded retained wave/remap diagnostic required')
    raw = os.pread(fd, node['bytes'], node['offset'])
    require(len(raw) == node['bytes'], 'complete retained diagnostic read required')
    result = array.array('f' if node['type'] == 'f32' else 'i')
    result.frombytes(raw)
    return result


def recheck_residual_add(fd, output, left, right):
    """Independent binary32 ADD check, retaining at most three 128 KiB tensors."""
    require(sys.byteorder == 'little' and array.array('f').itemsize == 4, 'little-endian binary32 host required')
    require(all(node['type'] == 'f32' and node['bytes'] <= 2048 * 16 * 4 for node in (output, left, right)) and
            output['bytes'] == left['bytes'] == right['bytes'], 'bounded equal residual capture payloads required')
    out, a, b = [values(fd, node) for node in (output, left, right)]
    require(len(out) == len(a) == len(b) == output['bytes'] // 4, 'complete residual payloads required')
    for actual, x, y in zip(out, a, b):
        require(all(math.isfinite(z) for z in (actual, x, y)), 'nonfinite measured residual operand/output')
        try:
            reference = struct.unpack('<f', struct.pack('<f', x + y))[0]
        except (OverflowError, struct.error):
            raise Rejected('binary32 residual ADD overflow')
        require(math.isfinite(reference) and abs(actual - reference) <= 1e-5 + 1e-5 * abs(reference),
                'actual retained residual ADD mismatch or nonfinite binary32 sum')


def recheck_captures(evidence_dir, ordinary, streamed, left, right, inventory, residual_aliases):
    fda, fdb = readonly(evidence_dir / 'ordinary.bin'), readonly(evidence_dir / 'streamed.bin')
    try:
        for fd, filename in ((fda, 'ordinary.bin'), (fdb, 'streamed.bin')):
            require(fp_from_stat(os.fstat(fd)) == inventory[filename]['fingerprint'], 'capture fingerprint changed')
        for key in left:
            numeric_pair(fda, fdb, left[key], right[key])
        for mode, fd in [('ordinary', fda), ('streamed', fdb)]:
            require(len(residual_aliases[mode]) == 20, 'complete actual residual aliases required for independent payload review')
            for output, first, second in residual_aliases[mode].values():
                recheck_residual_add(fd, output, first, second)
        wave_groups = {}
        for key, node in streamed.items():
            name = node['name']
            if name.startswith('ffn_moe_topk_stream-'):
                require(all(0 <= v < 30 for v in values(fdb, node)), 'actual remapped slot outside 30')
            if re.fullmatch(r'ffn_moe_topk-\d+ \(cont\)', name):
                original = streamed[key[0], key[1], name.removesuffix(' (cont)'), 0]
                numeric_pair(fdb, fdb, original, node)
            if name.startswith('ffn_moe_wave_mask-'):
                layer = int(name.rsplit('-', 1)[1])
                masks = values(fdb, node)
                ids = values(fdb, streamed[key[0], key[1], f'ffn_moe_wave_ids-{layer}', key[3]])
                require(len(masks) == len(ids) and all(0 <= v < 30 for v in ids) and
                        all(v in (0., 1.) for v in masks), 'actual wave IDs/mask invalid')
                group = key[0], key[1], layer
                sums = wave_groups.setdefault(group, [0.] * len(masks))
                require(len(sums) == len(masks), 'wave selected-pair geometry changed')
                for i, v in enumerate(masks):
                    sums[i] += v
        require(len(wave_groups) == 8 and all(all(v == 1. for v in sums) for sums in wave_groups.values()),
                'actual captured selected pairs do not contribute exactly once')
        for fd, filename in ((fda, 'ordinary.bin'), (fdb, 'streamed.bin')):
            require(fp_from_stat(os.fstat(fd)) == inventory[filename]['fingerprint'], 'capture changed during review')
    finally:
        os.close(fda); os.close(fdb)


def load_evidence(evidence_dir, manifest_path):
    root = pathlib.Path(evidence_dir).resolve(strict=True)
    require(root.is_dir(), 'retained evidence directory required')
    manifest_raw = read_bytes(manifest_path, 4 * MiB)
    manifest, manifest_digest = parse_json(manifest_raw), hashlib.sha256(manifest_raw).hexdigest()
    equal_fields(manifest, dict(schemaVersion=1, baseCommit=BASE, patchSha256=PATCH, target='darwin-arm64'), 'current native resource manifest')
    native = native_identity(manifest)
    helper_digest = manifest.get('integrity', {}).get('sourceSha256')
    require(sha(helper_digest), 'current native integrity helper source identity missing')
    process_raw = read_bytes(root / 'process-report.json', 32 * MiB)
    process = parse_json(process_raw)
    validate_process(process, manifest_digest)
    validate_native_binding(process, native)
    validate_native_binding(process.get('build', {}), native)
    inventory = process.get('evidenceInventory')
    require(isinstance(inventory, dict) and set(inventory) == set(FILES), 'exact complete retained evidence inventory required')
    for name in FILES:
        expected = inventory[name]
        require(isinstance(expected, dict) and sha(expected.get('sha256')) and valid_fp(expected.get('fingerprint')) and
                integer(expected.get('sizeBytes'), 1), 'retained evidence inventory row invalid')
        cap = GiB if name.endswith('.bin') else 64 * MiB if name.endswith('.log') else 32 * MiB
        actual = hash_retained(root / name, cap)
        require(actual == expected, f'retained {name} hash/size/fingerprint no longer matches measured run')
    load = lambda name: parse_json(read_bytes(root / name, 32 * MiB))
    log = lambda name: read_bytes(root / name, 64 * MiB).decode('utf-8')
    source, fixture = load('source-proof.json'), load('fixture.json')
    hashes = [single(log(f'shard{i}-integrity.log'), 'SSD_HASH') for i in range(1, 5)]
    validate_source(source, manifest_digest, helper_digest, hashes)
    validate_fixture(fixture, source, single(log('fixture-integrity.log'), 'SSD_HASH'), manifest_digest, helper_digest)
    layout_count, representative_count = validate_experts(log('expert-parity.log'), process)
    indexed, residual_aliases = {}, {}
    for mode in ('plan-ordinary', 'plan-streamed', 'ordinary', 'streamed'):
        report = load(mode + '.json')
        graph_log = log(mode + '.log')
        require(not any(marker in graph_log for marker in ('GRAPH_QA_ERROR', 'GRAPH_QA_STOPPED')), 'retained graph process error')
        complete = single(graph_log, 'GRAPH_QA_COMPLETE')
        require(complete.get('mode') == mode and complete.get('admitted') is True and
                complete.get('inferenceExecuted') is (not mode.startswith('plan-')) and
                pathlib.Path(complete.get('report', '')).resolve() == root / (mode + '.json'),
                'graph completion log does not bind retained actual report')
        require(single(graph_log, 'GRAPH_QA_PLAN') == report.get('plan'), 'native plan log does not match retained graph report')
        indexed[mode] = validate_graph(report, mode, fixture, manifest_digest,
                                      inventory.get(mode + '.bin', {}).get('sizeBytes', 0))
        if not mode.startswith('plan-'):
            residual_aliases[mode] = validate_residual_aliases(report, indexed[mode])
    comparison = load('comparison.json')
    require(pathlib.Path(comparison.get('ordinaryReport', '')).resolve() == root / 'ordinary.json' and
            pathlib.Path(comparison.get('streamedReport', '')).resolve() == root / 'streamed.json', 'comparison report paths are not retained evidence')
    summaries = [parse_json(line) for line in log('compare.log').splitlines() if line.startswith('{')]
    require(len(summaries) == 1 and summaries[0].get('passed') is True and
            summaries[0].get('fixtureSha256') == fixture['fixtureSha256'], 'actual comparison process completion missing')
    left, right = validate_comparison(comparison, indexed['ordinary'], indexed['streamed'], fixture, process)
    recheck_captures(root, indexed['ordinary'], indexed['streamed'], left, right, inventory, residual_aliases)
    # Re-stat large source/fixture only; their weight payloads are NEVER read here.
    for row in source['artifacts']:
        require(fingerprint(row['path']) == row['fingerprint'], 'source changed during conversion review')
    require(fingerprint(fixture['fixturePath']) == fixture['fixtureFingerprint'], 'fixture changed during conversion review')
    for name, row in inventory.items():
        require(fingerprint(root / name) == row['fingerprint'], 'retained evidence changed during conversion review')
    require(read_bytes(root / 'process-report.json', 32 * MiB) == process_raw and
            read_bytes(manifest_path, 4 * MiB) == manifest_raw, 'process/current resource binding changed during review')
    summary = dict(protocol=PROTOCOL, sourceArtifactSetVerified=True, expertParityPassed=True,
                   completeHybridEvidence=True, sourceFingerprintUnchanged=True, ownedProcessesStopped=True,
                   nodesCompared=comparison['nodesCompared'], elementsCompared=comparison['elementsCompared'],
                   expertLayoutsSurveyed=layout_count, representativeGroupsCompared=representative_count,
                   elementsOutsideTolerance=0, mismatchedIds=0, nonfinite=0, selectedPairsContributeOnce=True,
                   comparisonSha256=inventory['comparison.json']['sha256'],
                   processReportSha256=hashlib.sha256(process_raw).hexdigest(),
                   expertParityLogSha256=inventory['expert-parity.log']['sha256'])
    configuration = dict(modelSha256=SET_DIGEST, templateSha256=TEMPLATE, architecture='qwen3next',
                         backend='cpu', cpuKernel='standard', useExtraBufts=False, cpuRepackTensorCount=0,
                         baseCommit=BASE, workerPatchSha256=PATCH, report=REPORT_PATH, scope=SCOPE,
                         profile=dict(PROFILE))
    report = dict(configuration, schemaVersion=1, passed=True, absoluteTolerance=1e-5, relativeTolerance=1e-5,
                  measuredProof=summary, resourceManifestSha256=manifest_digest,
                  nativeResourceIdentity=native, nativeResourceDigest=native_digest(native),
                  resolvedNativeLayout=dict(RESOLVED_NATIVE_LAYOUT),
                  source=dict(repository=source['repository'], revision=REVISION, architecture='qwen3next',
                              artifactSetDigest=SET_DIGEST, templateSha256=TEMPLATE, geometry=GEOMETRY,
                              artifacts=source['artifacts']),
                  fixture=dict(fixtureSha256=fixture['fixtureSha256'], fixtureFingerprint=fixture['fixtureFingerprint'],
                               selectedOriginalLayers=[0, 3], recurrentLayers=[True, False]),
                  measuredRun=measured_run(process, root, inventory),
                  remainingCoverageGaps=comparison['remainingCoverageGaps'], issuedAppConsent=False,
                  coverageStatement='Representative actual expert layouts and original hybrid layers 0/3 only. '
                  'This does not establish all 48 layers, Metal, full-model Chat/tools, coding completion, '
                  'language quality, weak-machine support, or app consent.')
    report_raw = bounded_report_bytes(report)
    configuration['reportSha256'] = hashlib.sha256(report_raw).hexdigest()
    return configuration, report_raw


def write_reviewed(output_dir, configuration, report_raw, reviewed):
    require(reviewed is True, 'disabled draft: writing requires explicit --reviewed')
    require(isinstance(report_raw, bytes) and 0 < len(report_raw) <= MiB,
            'reviewed report bytes must fit the unchanged 1 MiB runtime cap')
    output = pathlib.Path(output_dir)
    require(not output.exists(), 'conversion output must be a NEW directory; never overwrite production or prior evidence')
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    (output / 'validation').mkdir(mode=0o700)
    for path, raw in ((output / REPORT_PATH, report_raw),
                      (output / 'qwen80-numerical-configuration.json',
                       (json.dumps(configuration, indent=2, allow_nan=False) + '\n').encode())):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, 'wb', closefd=False) as file:
                file.write(raw); file.flush(); os.fsync(fd)
        finally:
            os.close(fd)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', required=True)
    parser.add_argument('--resource-manifest', required=True)
    parser.add_argument('--validate-only', action='store_true')
    parser.add_argument('--reviewed', action='store_true', help='Explicit attestation that actual native provenance was reviewed')
    parser.add_argument('--output-dir')
    args = parser.parse_args(argv)
    require(args.validate_only or (args.reviewed and args.output_dir),
            'disabled draft: no writing without --reviewed and an explicit new --output-dir')
    require(not (args.validate_only and args.output_dir), 'validate-only cannot select a write destination')
    configuration, report_raw = load_evidence(args.evidence_dir, args.resource_manifest)
    if not args.validate_only:
        write_reviewed(args.output_dir, configuration, report_raw, args.reviewed)
    print(json.dumps(dict(status='retained-measured-scope-validated' if args.validate_only else 'reviewed-scoped-draft-written',
                          scope=SCOPE, protocol=PROTOCOL, issuedAppConsent=False,
                          fullModelOrCodingReliabilityEstablished=False)))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (Rejected, OSError, ValueError, KeyError, TypeError) as error:
        print(f'QWEN80_CONVERSION_REJECTED: {error}', file=sys.stderr)
        sys.exit(1)
