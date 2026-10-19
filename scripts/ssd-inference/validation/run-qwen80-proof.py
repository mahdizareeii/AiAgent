"""Private, serial Qwen80 CPU computation proof; never issues an app certificate.

--build-only compiles two small fixtures against the verified current libraries.
--run requires four complete exact official shards and fresh normal pressure.
All actual weight work is fail-closed, bounded, uncached and retained as evidence.
"""
import argparse
import ctypes
import fcntl
import hashlib
import json
import os
import pathlib
import re
import signal
import stat
import struct
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[3]
HERE = pathlib.Path(__file__).resolve().parent
RESOURCE = ROOT / 'resources/ssd-inference/darwin-arm64'
SOURCE = ROOT / '.cache/ssd-engine/source'
BASE = 'd81235049384534c167caea52b85a694f6103d14'
PATCH = '83139a4fbe858827d75f5050defefa69413718c45335ca5c18e49919c3944bb8'
REVISION = 'b82fb7382639d97b38fa7672e526c760c2fb358e'
TEMPLATE = '0b5c439b5b14126c0ae8b14ca93240c3cef1e7e29d684102b07f10727523dbdb'
SET_DIGEST = '3d0fd1c8ad6c37fdac38e20b02de80149a5d93b8c457c39e8a27100c8bf62d64'
ARTIFACTS = [(15524827040, '6bcfc9f9c37901eeb92172e2ab871224dab36a453d263bcb2547f737409534da'),
             (14872168352, '817def0691ee9d08bf3dc4444be7aed29c9e52091e8fa9d97901ce7e7f6f01d3'),
             (14503294496, '23aa634d47dca9b4ca3ea249384e6f01951b24c83cdc076f37f6f43d6c99883f'),
             (3510702144, '249c768cc5f130dc731567d6edcbdacc48e14dec9e02c5dbe2b2185d2c5bdb2b')]
PROFILE = {'backend':'cpu','contextTokens':8192,'outputTokens':2048,'batchTokens':64,'microBatchTokens':16,
           'cacheSlotsPerLayer':30,'cacheTypeK':'f16','cacheTypeV':'f16','swaFull':False,'slots':1,'ioWorkers':2,
           'ioMode':'darwin-nocache','decodeThreads':4,'batchThreads':4,'cpuKernel':'standard','useExtraBufts':False,'cpuRepackTensorCount':0,'kvUnified':True,'nRsSeq':0,'checkpoints':0}
RESOLVED_NATIVE_LAYOUT = {'contextTokens':8192,'contextPerSequence':8192,'batchTokens':64,'microBatchTokens':16,'slots':1,'kvUnified':True,'nRsSeq':0,'cacheTypeK':'f16','cacheTypeV':'f16'}
GEOMETRY = {'layers':48,'expertsPerLayer':512,'activeExperts':10,'minimumSlotsPerLayer':30,'expectedRoutedTensorGroups':48,'originalTensorDescriptors':807}
GiB = 1024**3
MiB = 1024**2
EVIDENCE_FILES = (['source-proof.json','fixture.json','expert-parity.log','comparison.json'] +
                  [f'shard{i}-integrity.log' for i in range(1,5)] + ['fixture-integrity.log'] +
                  [f'{mode}.{ext}' for mode in ('plan-ordinary','plan-streamed','ordinary','streamed') for ext in ('json','log')] +
                  ['ordinary.bin','streamed.bin','compare.log'])

STORAGE = {0: (1, 4), 1: (1, 2), 2: (32, 18), 3: (32, 20), 6: (32, 22),
           7: (32, 24), 8: (32, 34), 9: (32, 36), 10: (256, 84), 11: (256, 110),
           12: (256, 144), 13: (256, 176), 14: (256, 210), 15: (256, 292)}


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def compact(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def native_binding(manifest):
    """Stable inventoried computation bytes, excluding reports/manifest/licenses."""
    require(manifest.get('schemaVersion') == 1 and manifest.get('baseCommit') == BASE and
            manifest.get('patchSha256') == PATCH and manifest.get('target') == 'darwin-arm64', 'exact native identity headers')
    all_paths = [row.get('path') for row in manifest.get('files', []) if isinstance(row,dict)]
    require(len(all_paths)==len(manifest.get('files',[])) and all(isinstance(path,str) for path in all_paths) and
            len(set(all_paths))==len(all_paths), 'complete unique inventory paths')
    paths, native_files = set(), []
    for row in manifest.get('files', []):
        if not isinstance(row.get('path'), str) or not row['path'].startswith('worker/'):
            continue
        require(re.fullmatch(r'worker/[a-zA-Z0-9._-]+', row['path']) and row['path'] not in ('worker/.','worker/..') and row['path'] not in paths and
                type(row.get('size')) is int and 0 < row['size'] <= 2**53-1 and
                isinstance(row.get('sha256'), str) and re.fullmatch(r'[a-f0-9]{64}', row['sha256']), 'safe distinct native inventory')
        paths.add(row['path'])
        native_files.append({k:row[k] for k in ('path','size','sha256')})
    require(0<len(native_files)<=256 and all('worker/'+name in paths for name in ('libllama.0.dylib','libggml.0.dylib','libggml-base.0.dylib','libggml-cpu.0.dylib')), 'complete native library inventory')
    for helper, executable in ((manifest.get('planner'), 'worker/llama-plan-ssd'), (manifest.get('integrity'), 'worker/llama-hash-ssd')):
        require(isinstance(helper,dict) and helper.get('schemaVersion') == 1 and helper.get('executable') == executable and
                executable in paths and isinstance(helper.get('sourceSha256'),str) and re.fullmatch(r'[a-f0-9]{64}',helper['sourceSha256']), 'covered native helper source')
    backends, ids = manifest.get('backends'), set()
    require(isinstance(backends,list) and 1 <= len(backends) <= 2, 'exact native backend array')
    for backend in backends:
        require(isinstance(backend,dict) and backend.get('id') in ('cpu','metal') and backend['id'] not in ids and
                backend.get('executable') in paths and backend.get('libraryDirectory') == 'worker' and
                isinstance(backend.get('arguments'),list) and all(isinstance(x,str) for x in backend['arguments']), 'covered distinct native backends')
        ids.add(backend['id'])
    require('cpu' in ids, 'CPU native identity required')
    identity = dict(schemaVersion=1,baseCommit=BASE,patchSha256=PATCH,target='darwin-arm64',backends=backends,
                    planner=manifest['planner'],integrity=manifest['integrity'],nativeFiles=sorted(native_files,key=lambda row:row['path']))
    def json_data(value):
        if isinstance(value,dict):
            require(all(isinstance(k,str) and k.isascii() for k in value), 'ASCII native identity keys')
            for child in value.values(): json_data(child)
        elif isinstance(value,list):
            for child in value: json_data(child)
        elif type(value) is int: require(abs(value)<=2**53-1,'safe native identity integer')
        elif value is None or type(value) is bool: pass
        else: require(isinstance(value,str) and not any(0xd800<=ord(c)<=0xdfff for c in value),'strict native identity JSON value')
    json_data(identity)
    canonical = json.dumps(identity,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
    return {'identity':identity,'digest':digest(canonical)}


def uncached(path, flags=os.O_RDONLY):
    fd = os.open(path, flags | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode), 'regular file required')
        fcntl.fcntl(fd, 48, 1)  # F_NOCACHE on Darwin, descriptor-local only.
        fcntl.fcntl(fd, 45, 0)  # F_RDAHEAD=0.
        return fd
    except BaseException:
        os.close(fd)
        raise


def sha_file(path, guard=None):
    fd = uncached(path)
    try:
        h = hashlib.sha256()
        while block := os.read(fd, MiB):
            if guard: guard()
            h.update(block)
        return h.hexdigest()
    finally:
        os.close(fd)


def native_usage(pid):
    lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    lib.proc_pid_rusage.restype = ctypes.c_int
    data = ctypes.create_string_buffer(1024)
    require(lib.proc_pid_rusage(pid, 4, data) == 0, 'native RSS/physical footprint monitoring unavailable')
    rss, foot = struct.unpack_from('<QQ', data.raw, 64)
    require(rss > 0 and foot > 0, 'valid native process memory required')
    return {'rssBytes': rss, 'physicalFootprintBytes': foot}


def fingerprint(path):
    s = os.stat(path, follow_symlinks=False)
    require(stat.S_ISREG(s.st_mode), 'regular source, never symlink, required')
    return {'device': s.st_dev, 'inode': s.st_ino, 'sizeBytes': s.st_size,
            'mtimeSeconds': s.st_mtime_ns // 10**9, 'mtimeNanoseconds': s.st_mtime_ns % 10**9,
            'ctimeSeconds': s.st_ctime_ns // 10**9, 'ctimeNanoseconds': s.st_ctime_ns % 10**9}


def write_json(path, value):
    with open(path, 'x', encoding='utf-8') as f:
        os.chmod(path, 0o600)
        json.dump(value, f, indent=2)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())


def resources():
    require(sys.platform == 'darwin' and os.uname().machine == 'arm64', 'native Darwin ARM64 required')
    raw = (RESOURCE / 'manifest.json').read_bytes()
    m = json.loads(raw)
    require(m['baseCommit'] == BASE and m['patchSha256'] == PATCH and m['target'] == 'darwin-arm64', 'exact current native inventory required')
    require(sha_file(ROOT / 'scripts/ssd-inference/llama.cpp-ssd.patch') == PATCH, 'tracked patch changed')
    require(sha_file(ROOT / 'scripts/ssd-inference/native-hash.cpp') == m['integrity']['sourceSha256'], 'integrity source changed')
    require(sha_file(ROOT / 'scripts/ssd-inference/native-plan.cpp') == m['planner']['sourceSha256'], 'planner source changed')
    listed = set()
    for row in m['files']:
        rel = pathlib.PurePosixPath(row['path'])
        require(not rel.is_absolute() and '..' not in rel.parts and row['path'] not in listed, 'invalid/duplicate inventory entry')
        listed.add(row['path'])
        p = RESOURCE / row['path']
        require(fingerprint(p)['sizeBytes'] == row['size'] and sha_file(p) == row['sha256'], 'native resource bytes changed')
    actual = {str(p.relative_to(RESOURCE)) for p in RESOURCE.rglob('*') if p.is_file() and p.name != 'manifest.json'}
    require(actual == listed, 'complete native resource inventory required')
    require(subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=SOURCE, text=True).strip() == BASE, 'fixture headers need exact pinned native checkout')
    require(subprocess.check_output(['git', 'diff', '--binary', 'HEAD'], cwd=SOURCE) == (ROOT / 'scripts/ssd-inference/llama.cpp-ssd.patch').read_bytes(), 'patched native headers differ from actual bundle source')
    return m, digest(raw)


def build(directory, manifest_digest, native):
    directory.mkdir(parents=True, exist_ok=False)
    os.chmod(directory, 0o700)
    lib = RESOURCE / 'worker'
    rows = []
    for name, macro in [('qwen80-expert-parity', 'SSD_PARITY_PATCH_SHA256'), ('qwen80-graph-parity', 'FIXTURE_PATCH_SHA256')]:
        output = directory / name
        args = ['clang++', '-std=c++17', '-O2', '-pthread', f'-D{macro}="{PATCH}"',
                f'-DQWEN80_RESOURCE_MANIFEST_SHA256="{manifest_digest}"',
                f'-DFIXTURE_SOURCE_SHA256="{sha_file(HERE / (name + ".cpp"))}"',
                '-I' + str(SOURCE / 'include'), '-I' + str(SOURCE / 'src'),
                '-I' + str(SOURCE / 'ggml/include'), '-I' + str(SOURCE / 'vendor'),
                str(HERE / (name + '.cpp')), '-L' + str(lib), '-lllama.0', '-lggml.0',
                '-lggml-base.0', '-lggml-cpu.0', '-Wl,-rpath,' + str(lib), '-o', str(output)]
        with open(directory / (name + '-build.log'), 'x') as f:
            r = subprocess.run(args, cwd=ROOT, stdout=f, stderr=subprocess.STDOUT, timeout=120)
        require(r.returncode == 0, f'{name} compilation failed; retained build log')
        rows.append({'path': str(output), 'sha256': sha_file(output), 'sourceSha256': sha_file(HERE / (name + '.cpp'))})
    b = {'baseCommit': BASE, 'patchSha256': PATCH, 'resourceManifestSha256': manifest_digest,
         'bindingHeaderSha256': sha_file(HERE / 'qwen80-proof-binding.h'), 'profile':PROFILE, 'binaries': rows, 'largeModelLoaded': False,
         'nativeResourceIdentity':native['identity'],'nativeResourceDigest':native['digest']}
    write_json(directory / 'build.json', b)
    return b


class Trial:
    def __init__(self, output, maximum_seconds):
        self.started = time.monotonic()
        self.output, self.deadline, self.samples, self.steps = output, self.started + maximum_seconds, [], []
        self.active = None
        self.active_limit = None

    def guard(self):
        require(time.monotonic() < self.deadline, 'shared proof deadline reached')
        vm = subprocess.check_output(['/usr/bin/vm_stat'], text=True)
        page = int(re.search(r'page size of (\d+) bytes', vm)[1])
        values = {k: int(v) for k, v in re.findall(r'^([^:\n]+):\s*(\d+)\.', vm, re.M)}
        pressure = int(subprocess.check_output(['/usr/sbin/sysctl', '-n', 'kern.memorystatus_vm_pressure_level'], text=True))
        available = sum(values.get(k, 0) for k in ('Pages free', 'Pages inactive', 'Pages speculative')) * page
        row = {'elapsedSeconds': time.monotonic() - self.started, 'availableRamBytes': available, 'pressureLevel': pressure}
        own = native_usage(os.getpid())
        row['controllerMemory'] = own
        require(max(own.values()) <= 256 * MiB, 'controller native memory exceeded bounded cap')
        if self.active and self.active.poll() is None:
            try:
                used = native_usage(self.active.pid)
            except RuntimeError:
                if self.active.poll() is None:
                    raise
            else:
                row['ownedChildMemory'] = used
                require(max(used.values()) <= self.active_limit, 'owned proof child exceeded native memory cap')
        self.samples.append(row)
        require(pressure == 1 and available >= GiB, 'normal pressure and 1 GiB current available headroom required')
        raw = subprocess.check_output(['/bin/ps', '-axo', 'pid=,comm='], text=True)
        competing = [line for line in raw.splitlines() if re.search(r'/llama-server(?:-ssd)?\s*$', line) or re.search(r'/(?:qwen80|gemma.*graph|quantized)-.*parity\s*$', line)]
        if self.active:
            competing = [line for line in competing if int(line.strip().split(None, 1)[0]) != self.active.pid]
        require(not competing, 'another model/native proof is active; private trials must run serially')
        return row

    def run(self, name, args, maximum=300, resident_limit=256 * MiB):
        self.guard()
        began = time.monotonic()
        stop = None
        with open(self.output / (name + '.log'), 'x') as log:
            safe_env = {k: v for k, v in os.environ.items() if not k.startswith(('DYLD_', 'LLAMA_', 'GGML_', 'OPENAI_', 'ANTHROPIC_')) and 'PROXY' not in k.upper()}
            self.active = subprocess.Popen(args, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, env=safe_env)
            self.active_limit = resident_limit
            try:
                while self.active.poll() is None:
                    self.guard()
                    require(time.monotonic() - began < maximum, 'owned-step deadline reached')
                    time.sleep(0.25)
            except BaseException as e:
                stop = str(e)
                self.active.send_signal(signal.SIGTERM)
                try:
                    self.active.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.active.kill()
                    self.active.wait(timeout=2)
                raise
            finally:
                code = self.active.wait()
                self.steps.append({'name': name, 'exitCode': code, 'stopReason': stop, 'wallSeconds': time.monotonic() - began})
                self.active = None
                self.active_limit = None
        require(code == 0, f'{name} failed ({code}); no automatic retry or certificate')
        return (self.output / (name + '.log')).read_text()


class Header:
    def __init__(self, path):
        self.fd = uncached(path)
        self.size = os.fstat(self.fd).st_size
        self.at, self.entries, self.values, self.tensors = 0, {}, {}, []
        require(self.take(4) == b'GGUF' and self.u32() == 3, 'exact GGUF v3 required')
        nt, nk = self.u64(), self.u64()
        require(0 < nt <= 100000 and nk <= 10000, 'bounded GGUF table required')
        for _ in range(nk):
            begin = self.at
            key, kind = self.string().decode(), self.u32()
            require(key not in self.entries, 'duplicate metadata key')
            self.values[key] = self.value(kind)
            self.entries[key] = os.pread(self.fd, self.at - begin, begin)
        alignment = self.values.get('general.alignment', 32)
        require(alignment == 32, 'review exact alignment before supporting another source')
        expected = 0
        for _ in range(nt):
            name, nd = self.string().decode(), self.u32()
            require(0 < nd <= 4 and len(name.encode()) < 64, 'bounded tensor descriptor')
            dims = [self.u64() for _ in range(nd)]
            kind, offset = self.u32(), self.u64()
            require(kind in STORAGE and dims[0] % STORAGE[kind][0] == 0 and all(d > 0 for d in dims), 'review unsupported tensor geometry/quantization')
            elements = 1
            for d in dims:
                elements *= d
            n = elements // STORAGE[kind][0] * STORAGE[kind][1]
            require(offset == expected, 'source GGUF contiguous geometry mismatch')
            expected = (offset + n + 31) // 32 * 32
            self.tensors.append({'name': name, 'dimensions': dims, 'type': kind, 'sizeBytes': n, 'relativeOffset': offset})
        self.data_start = (self.at + 31) // 32 * 32
        for t in self.tensors:
            t['sourceOffset'] = self.data_start + t['relativeOffset']
            require(t['sourceOffset'] + t['sizeBytes'] <= self.size, 'truncated source tensor payload')

    def close(self):
        os.close(self.fd)

    def take(self, n):
        require(0 <= n and self.at + n <= min(self.size, 64 * MiB), 'bounded metadata read required')
        data = os.pread(self.fd, n, self.at)
        require(len(data) == n, 'complete metadata read')
        self.at += n
        return data

    def u32(self):
        return struct.unpack('<I', self.take(4))[0]

    def u64(self):
        return struct.unpack('<Q', self.take(8))[0]

    def string(self):
        return self.take(self.u64())

    def value(self, kind):
        formats = {0: 'B', 1: 'b', 2: 'H', 3: 'h', 4: 'I', 5: 'i', 6: 'f', 7: '?', 10: 'Q', 11: 'q', 12: 'd'}
        if kind == 8:
            return self.string()
        if kind == 9:
            subtype, n = self.u32(), self.u64()
            require(n <= 1000000 and subtype != 9, 'bounded nonnested metadata array')
            values = []
            for _ in range(n):
                value = self.value(subtype)
                if n <= 4096:
                    values.append(value)
            return {'arrayType': subtype, 'arrayCount': n, 'arrayValues': values if n <= 4096 else None}
        require(kind in formats, 'unknown metadata type')
        return struct.unpack('<' + formats[kind], self.take(struct.calcsize(formats[kind])))[0]


def validate_geometry(headers):
    first = headers[0]
    expected = {'qwen3next.block_count': 48, 'qwen3next.embedding_length': 2048,
                'qwen3next.expert_count': 512, 'qwen3next.expert_used_count': 10,
                'qwen3next.expert_feed_forward_length': 512, 'qwen3next.expert_shared_feed_forward_length': 512,
                'qwen3next.ssm.conv_kernel': 4, 'qwen3next.ssm.state_size': 128,
                'qwen3next.ssm.group_count': 16, 'qwen3next.ssm.time_step_rank': 32}
    require(first.values['general.architecture'] == b'qwen3next', 'exact source architecture')
    require(all(first.values.get(k) == v for k, v in expected.items()), 'exact official source geometry changed')
    require(digest(first.values['tokenizer.chat_template']) == TEMPLATE, 'exact official template changed')
    require(sum(len(h.tensors) for h in headers) == 807, 'all807 original descriptors required')
    names = [t['name'] for h in headers for t in h.tensors]
    require(len(names) == len(set(names)), 'shard tensor names overlap')
    for i, h in enumerate(headers):
        require(h.values.get('split.no') == i and h.values.get('split.count') == 4 and h.values.get('split.tensors.count') == 807, 'complete exact shard identities required')
    for k, value in first.values.items():
        if k.startswith('qwen3next.') and isinstance(value, dict):
            require(k == 'qwen3next.attention.recurrent_layers', 'unaccounted per-layer array requires explicit fixture review')
    groups = {i: [] for i in range(48)}
    for h in headers:
        for t in h.tensors:
            m = re.fullmatch(r'blk\.(\d+)\.ffn_(down|gate|up)_exps\.weight', t['name'])
            if m:
                groups[int(m[1])].append(t)
    require(all(len(g) == 3 and all(t['dimensions'][2] == 512 for t in g) for g in groups.values()), 'complete actual routed group geometry required')


def gguf_string(value):
    if isinstance(value, str):
        value = value.encode()
    return struct.pack('<Q', len(value)) + value


def metadata_entry(key, kind, data):
    return gguf_string(key) + struct.pack('<I', kind) + data


def make_fixture(headers, proof, output, trial):
    first = headers[0]
    entries = {k: v for k, v in first.entries.items() if not k.startswith('split.')}
    entries['qwen3next.block_count'] = metadata_entry('qwen3next.block_count', 4, struct.pack('<I', 2))
    entries['qwen3next.attention.recurrent_layers'] = metadata_entry('qwen3next.attention.recurrent_layers', 9, struct.pack('<IQ??', 7, 2, True, False))
    entries['general.name'] = metadata_entry('general.name', 8, gguf_string('COMPUTATIONAL QA ONLY: original Qwen80 layers0/3; no language quality claim'))
    tensors, offset = [], 0
    for fi, h in enumerate(headers):
        for t in h.tensors:
            match = re.match(r'blk\.(\d+)\.', t['name'])
            if match and int(match[1]) not in (0, 3):
                continue
            if not match and t['name'] not in ('token_embd.weight', 'output.weight', 'output_norm.weight'):
                raise RuntimeError('unaccounted global tensor needs explicit fixture review')
            row = dict(t, sourceShard=fi, destinationName=t['name'].replace('blk.3.', 'blk.1.', 1), destinationRelativeOffset=offset)
            tensors.append(row)
            offset = (offset + t['sizeBytes'] + 31) // 32 * 32
    descriptors = b''
    for t in tensors:
        descriptors += gguf_string(t['destinationName']) + struct.pack('<I', len(t['dimensions']))
        descriptors += b''.join(struct.pack('<Q', d) for d in t['dimensions']) + struct.pack('<IQ', t['type'], t['destinationRelativeOffset'])
    header = b'GGUF' + struct.pack('<IQQ', 3, len(tensors), len(entries)) + b''.join(entries.values()) + descriptors
    header += bytes((-len(header)) % 32)
    path = output / 'qwen80-two-hybrid-layers.gguf'
    part = path.with_suffix('.gguf.part')
    fd = uncached(part, os.O_RDWR | os.O_CREAT | os.O_EXCL)
    try:
        os.ftruncate(fd, len(header) + offset)
        require(os.pwrite(fd, header, 0) == len(header), 'complete fixture header write')
        for t in tensors:
            trial.guard()
            require(fingerprint(proof['artifacts'][t['sourceShard']]['path']) == proof['artifacts'][t['sourceShard']]['fingerprint'], 'source changed since full hash')
            h, sha, at = headers[t['sourceShard']], hashlib.sha256(), 0
            t['destinationOffset'] = len(header) + t['destinationRelativeOffset']
            while at < t['sizeBytes']:
                trial.guard()
                block = os.pread(h.fd, min(MiB, t['sizeBytes'] - at), t['sourceOffset'] + at)
                require(block, 'complete selected tensor copy')
                require(os.pwrite(fd, block, t['destinationOffset'] + at) == len(block), 'complete selected tensor write')
                sha.update(block)
                at += len(block)
            t['sourceCopiedSha256'] = sha.hexdigest()
            sha, at = hashlib.sha256(), 0
            while at < t['sizeBytes']:
                trial.guard()
                block = os.pread(fd, min(MiB, t['sizeBytes'] - at), t['destinationOffset'] + at)
                require(block, 'complete fixture tensor readback')
                sha.update(block)
                at += len(block)
            t['destinationVerifiedSha256'] = sha.hexdigest()
            require(t['sourceCopiedSha256'] == t['destinationVerifiedSha256'], 'raw quantized tensor bytes differ')
        os.fsync(fd)
    finally:
        os.close(fd)
    require(all(fingerprint(a['path']) == a['fingerprint'] for a in proof['artifacts']), 'verified source changed while copying')
    require(not path.exists(), 'private fixture output must be new')
    os.rename(part, path)
    log = trial.run('fixture-integrity', [str(RESOURCE / 'worker/llama-hash-ssd'), '--file', str(path), '--deadline-ms', '180000', '--resident-limit-bytes', str(128 * MiB)], 180, 128 * MiB)
    integrity = next(json.loads(line.split(' ', 1)[1]) for line in log.splitlines() if line.startswith('SSD_HASH '))
    require(integrity['baseCommit'] == BASE and integrity['patchSha256'] == PATCH and integrity['sizeBytes'] == path.stat().st_size and integrity['bytesRead'] == path.stat().st_size and integrity['ioMode'] == 'darwin-nocache', 'full native private fixture integrity required')
    require(fingerprint(path) == integrity['fingerprint'], 'hashed private fixture changed')
    fixture = {'schemaVersion': 1, 'scope': 'Private partial-model computation only, no language/coding quality',
               'sourceArtifactSetDigest': SET_DIGEST, 'sourceTemplateSha256': TEMPLATE,
               'nativePatchSha256': PATCH, 'resourceManifestSha256': proof['resourceManifestSha256'],
               'selectedOriginalLayers': [0, 3], 'recurrentLayers': [True, False], 'sourceFingerprintUnchanged': True,
               'fixturePath': str(path), 'fixtureSha256': integrity['sha256'], 'fixtureSizeBytes': path.stat().st_size, 'fixtureFingerprint': integrity['fingerprint'],
               'inferenceExecuted': False, 'copyBufferBytes': MiB, 'tensors': tensors}
    write_json(output / 'fixture.json', fixture)
    return fixture


def inventory_evidence(output, trial, report):
    report['evidenceInventory'] = {}
    report['evidenceInventoryComplete'] = False
    for evidence_name in EVIDENCE_FILES:
        evidence=output/evidence_name
        try:
            require(evidence.is_file(),'complete retained non-payload evidence inventory required')
            before=fingerprint(evidence)
            sha=sha_file(evidence, trial.guard)
            require(fingerprint(evidence)==before,'evidence changed during inventory')
            report['evidenceInventory'][evidence.name]={'sha256':sha,'sizeBytes':before['sizeBytes'],'fingerprint':before}
        except BaseException as failure:
            report['passed'] = False
            report.setdefault('failure', str(failure))
            report['evidenceInventoryFailure'] = {'file': evidence_name, 'error': str(failure)}
            break
    else:
        report['evidenceInventoryComplete'] = True
    report['uninventoriedEvidenceFiles'] = EVIDENCE_FILES[len(report['evidenceInventory']):]


def execute(args, manifest, manifest_digest):
    require(args.source_dir and args.build_dir, '--run requires explicit source and separately built fixture directory')
    output = pathlib.Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    os.chmod(output, 0o700)
    build_dir = pathlib.Path(args.build_dir).resolve()
    bound = json.loads((build_dir / 'build.json').read_text())
    native = native_binding(manifest)
    require(bound.get('nativeResourceIdentity') == native['identity'] and bound.get('nativeResourceDigest') == native['digest'], 'compiled native computation inventory changed')
    require(bound.get('profile') == PROFILE, 'fixture build must explicitly cover this8K/2048 profile')
    require(bound['baseCommit'] == BASE and bound['patchSha256'] == PATCH and bound['resourceManifestSha256'] == manifest_digest and bound['bindingHeaderSha256'] == sha_file(HERE / 'qwen80-proof-binding.h'), 'compiled fixture binding changed')
    for b in bound['binaries']:
        require(sha_file(b['path']) == b['sha256'] and sha_file(HERE / (pathlib.Path(b['path']).name + '.cpp')) == b['sourceSha256'], 'compiled fixture/source changed')
    trial = Trial(output, 1800)
    report = {'schemaVersion':1,'evidenceKind':'measured-native-qwen80-proof','protocol':'qwen80-standard-cpu-hybrid-v2-8k','diagnosticEvidenceVersion':2,'profile':PROFILE,'resourcesVerified':True,
              'resourceHelperSourceSha256':manifest['integrity']['sourceSha256'],'build':bound,
              'nativeResourceIdentity':native['identity'],'nativeResourceDigest':native['digest'],
              'scope': 'representative-experts-and-two-hybrid-layers', 'passed': False, 'issuedAppCertificate': False, 'fullModelLoaded': False}
    headers = []
    try:
        trial.guard()
        artifacts = []
        for i, (size, sha) in enumerate(ARTIFACTS):
            filename = f'Qwen3-Coder-Next-Q4_K_M-0000{i+1}-of-00004.gguf'
            path = (pathlib.Path(args.source_dir).resolve() / filename)
            require(fingerprint(path)['sizeBytes'] == size, 'exact complete source shard required; sparse or partial not accepted')
            log = trial.run(f'shard{i+1}-integrity', [str(RESOURCE / 'worker/llama-hash-ssd'), '--file', str(path), '--deadline-ms', '180000', '--resident-limit-bytes', str(128 * MiB)], 180, 128 * MiB)
            result = next(json.loads(line.split(' ', 1)[1]) for line in log.splitlines() if line.startswith('SSD_HASH '))
            require(result['baseCommit'] == BASE and result['patchSha256'] == PATCH and result['helperSourceSha256'] == manifest['integrity']['sourceSha256'], 'actual hash process provenance')
            require(result['sha256'] == sha and result['sizeBytes'] == size and result['bytesRead'] == size and result['ioMode'] == 'darwin-nocache', 'actual full artifact hash/bytes required')
            require(fingerprint(path) == result['fingerprint'], 'hashed shard changed')
            artifacts.append(dict(filename=filename, path=str(path), **{k: result[k] for k in ('sha256', 'sizeBytes', 'bytesRead', 'ioMode', 'fingerprint')}))
            headers.append(Header(path))
        require(digest(compact([{k: a[k] for k in ('filename', 'sha256', 'sizeBytes')} for a in artifacts])) == SET_DIGEST, 'exact runtime ordered artifact-set digest')
        validate_geometry(headers)
        proof = {'schemaVersion': 1, 'completeVerifiedSource': True, 'baseCommit': BASE, 'patchSha256': PATCH,
                 'resourceManifestSha256': manifest_digest, 'repository': 'Qwen/Qwen3-Coder-Next-GGUF', 'revision': REVISION,
                 'artifactSetDigest': SET_DIGEST, 'templateSha256': TEMPLATE, 'geometry':GEOMETRY,'architecture':'qwen3next', 'artifacts': artifacts}
        write_json(output / 'source-proof.json', proof)
        expert_log = trial.run('expert-parity', [str(build_dir / 'qwen80-expert-parity'), '--source-proof', str(output / 'source-proof.json')], resident_limit=1664 * MiB)
        final = next(json.loads(line.split(' ', 1)[1]) for line in expert_log.splitlines() if line.startswith('SSD_PARITY_FINAL '))
        require(final['passed'] and final['verifiedModelSha256FromCaller'] == SET_DIGEST and final['patchSha256'] == PATCH, 'actual expert parity not established')
        report['expertParity'] = final
        layout_rows=next(json.loads(line.split(' ',1)[1]) for line in expert_log.splitlines() if line.startswith('SSD_PARITY_METADATA '))['layouts']
        report['expertLayouts'] = layout_rows
        fixture = make_fixture(headers, proof, output, trial)
        for mode in ('plan-ordinary', 'plan-streamed', 'ordinary', 'streamed'):
            prefix = output / mode
            trial.run(mode, [str(build_dir / 'qwen80-graph-parity'), '--model', fixture['fixturePath'], '--source-proof', str(output / 'source-proof.json'),
                            '--fixture-manifest', str(output / 'fixture.json'), '--fixture-sha256', fixture['fixtureSha256'], '--kernel-control', 'standard', '--mode', mode,
                            '--out-prefix', str(prefix), '--allocation-budget-bytes', str(3 * GiB), '--resident-limit-bytes', str(7 * GiB // 2), '--deadline-ms', '300000'], resident_limit=7 * GiB // 2)
        trial.run('compare', [sys.executable, str(HERE / 'compare-qwen80-graphs.py'), '--expected-patch-sha256', PATCH, '--fixture-sha256', fixture['fixtureSha256'], str(output / 'ordinary.json'), str(output / 'streamed.json'), str(output / 'comparison.json')], 60)
        actual_layouts=[]
        for mode in ('plan-ordinary','plan-streamed','ordinary','streamed'):
            actual=json.loads((output/(mode+'.json')).read_text())
            require(actual.get('resolvedNativeLayout')==RESOLVED_NATIVE_LAYOUT and actual.get('plan',{}).get('resolvedNativeLayout')==RESOLVED_NATIVE_LAYOUT,'actual native plan layout was not confirmed')
            if not mode.startswith('plan-'): require(actual.get('run',{}).get('resolvedNativeLayout')==RESOLVED_NATIVE_LAYOUT,'actual native executed layout was not confirmed')
            actual_layouts.append(actual['resolvedNativeLayout'])
        report['resolvedNativeLayout']=actual_layouts[0]
        report['comparison'] = json.loads((output / 'comparison.json').read_text())
        require(report['comparison']['passed'], 'actual hybrid graph parity failed')
        require(all(fingerprint(a['path']) == a['fingerprint'] for a in artifacts), 'source changed by end of trial')
        report['sourceFingerprintUnchanged'] = True
        report['ownedProcessesStopped'] = trial.active is None
        report['passed'] = True
    except BaseException as error:
        report['failure'] = str(error)
        raise
    finally:
        for header in headers:
            header.close()
        inventory_evidence(output, trial, report)
        report.update(resourceSamples=trial.samples, steps=trial.steps, baseCommit=BASE, patchSha256=PATCH,
                      resourceManifestSha256=manifest_digest, artifactSetDigest=SET_DIGEST, templateSha256=TEMPLATE)
        write_json(output / 'process-report.json', report)
        print(json.dumps({k: v for k, v in report.items() if k not in ('resourceSamples', 'comparison')}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--build-only', action='store_true')
    mode.add_argument('--run', action='store_true')
    parser.add_argument('--source-dir')
    parser.add_argument('--build-dir')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    manifest, manifest_digest = resources()
    if args.build_only:
        require(not args.source_dir and not args.build_dir, 'build-only never inspects model paths')
        print(json.dumps(build(pathlib.Path(args.output).resolve(), manifest_digest, native_binding(manifest))))
    else:
        lock = os.open(ROOT / '.cache/ssd-engine/qwen80-proof.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            execute(args, manifest, manifest_digest)
        finally:
            os.close(lock)


if __name__ == '__main__':
    main()
