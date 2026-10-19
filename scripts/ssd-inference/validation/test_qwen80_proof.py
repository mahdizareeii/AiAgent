"""Offline proof-implementation checks. Never loads a model or emits a certificate."""
import importlib.util
import array
import copy
import contextlib
import io
import json
import pathlib
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


proof = module('qwen80proof', HERE / 'run-qwen80-proof.py')
compare = module('qwen80compare', HERE / 'compare-qwen80-graphs.py')
fixtures = module('qwen80conversionfixtures', HERE / 'test_qwen80_certificate_conversion.py')


class Data:
    def __init__(self, values):
        self.values = values

    def data(self, node):
        return self.values


class ResidualEvidence:
    """In-memory metadata and bounded generated payloads; no native/model I/O."""
    def __init__(self, mode='ordinary', operands=(1., 2.), output=3.):
        self.report, _ = fixtures.graph_fixture(mode)
        self.nodes = self.report['run']['captures']
        self.operands, self.output = operands, output

    def data(self, node):
        value = (self.operands[0] if node['name'].startswith('ffn_out-') else
                 self.operands[1] if node['name'].startswith('attn_residual-') else self.output)
        return array.array('f', [value]) * (node['bytes'] // 4)


class ProofTests(unittest.TestCase):
    def test_build_binds_exact_current_source_with_quoted_cpp_string_macro(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(proof.subprocess, 'run', return_value=mock.Mock(returncode=0)) as compiler, mock.patch.object(proof, 'sha_file', return_value='a'*64):
            result = proof.build(pathlib.Path(directory)/'new-build', 'b'*64, {'identity':{}, 'digest':'c'*64})
        self.assertEqual(compiler.call_count, 2)
        for call in compiler.call_args_list:
            args = call.args[0]
            self.assertEqual([arg for arg in args if arg.startswith('-DFIXTURE_SOURCE_SHA256=')],
                             ['-DFIXTURE_SOURCE_SHA256="'+'a'*64+'"'])
        self.assertEqual([row['sourceSha256'] for row in result['binaries']], ['a'*64]*2)

    def test_comparator_requires_twenty_semantic_aliases_and_actual_residual_captures_per_mode(self):
        for mode in ('ordinary', 'streamed'):
            with self.subTest(mode=mode):
                evidence = ResidualEvidence(mode)
                rows = compare.complete_evidence(evidence)
                self.assertEqual(len(rows), 20)
                self.assertEqual(len({(r['caseId'],r['step'],r['layer']) for r in rows}), 20)
                self.assertTrue(all(row['passed'] and row['elementsOutsideTolerance']==0 for row in rows))
                self.assertTrue(compare.common_node('attn_residual-0'))
                self.assertFalse(any(node['name'].startswith('post_moe-') for node in evidence.nodes))

    def test_comparator_rejects_incomplete_stale_or_wrong_native_alias_topology(self):
        changes = ('missing','duplicate','pointer','parents','swapped','step','occurrence','operation',
                   'shape','boolean-shape','view','contiguous','control-vector','extra','version','float-version','source')
        for change in changes:
            evidence = ResidualEvidence()
            witnesses = evidence.report['run']['residualAliasWitnesses']; row = witnesses[0]
            out = next(n for n in evidence.nodes if compare.identity(n)==compare.identity(row['capture']))
            if change=='missing': witnesses.pop()
            elif change=='duplicate': witnesses[-1]=copy.deepcopy(row)
            elif change=='pointer': row['capturedTensorId']+=1
            elif change=='parents': out['nativeParentTensorIds']=[999,998]
            elif change=='swapped': row['operands'].reverse()
            elif change=='step': row['operands'][0]['step']=1
            elif change=='occurrence': row['capture']['occurrence']=1
            elif change=='operation': out['nativeOperation']='MUL'
            elif change=='shape': out['dimensions']=[2048,1,2,1]
            elif change=='boolean-shape': out['dimensions']=[2048,True,1,1]
            elif change=='view': out['nativeView']=True
            elif change=='contiguous': out['nativeContiguous']=False
            elif change=='control-vector': row['controlVectorApplied']=True
            elif change=='extra': row['unexpected']=True
            elif change=='version': evidence.report['diagnosticEvidenceVersion']=1
            elif change=='float-version': evidence.report['diagnosticEvidenceVersion']=2.0
            elif change=='source': evidence.report['diagnosticSourceSha256']='f'*64
            with self.subTest(change=change), self.assertRaises(AssertionError):
                compare.residual_alias_checks(evidence)

    def test_comparator_measures_residual_add_and_rounds_binary32_without_promoting_mismatch(self):
        rows = compare.residual_alias_checks(ResidualEvidence(output=4.))
        self.assertTrue(all(not row['passed'] and row['elementsOutsideTolerance']==row['elements'] for row in rows))
        rounded = compare.residual_alias_checks(ResidualEvidence(operands=(16777216.,1.),output=16777216.))
        self.assertTrue(all(row['passed'] and row['maxAbsoluteDifference']==0 for row in rounded))
        for operands, output in (((1.,2.),float('nan')), ((float('inf'),2.),3.), ((3.4e38,3.4e38),0.)):
            with self.subTest(operands=operands,output=output), self.assertRaises(AssertionError):
                compare.residual_alias_checks(ResidualEvidence(operands=operands,output=output))

    def test_failed_residual_add_makes_comparator_exit_failed_even_when_common_nodes_match(self):
        ordinary, streamed = ResidualEvidence(output=4.), ResidualEvidence('streamed')
        for evidence in (ordinary,streamed):
            evidence.path=pathlib.Path(evidence.report['mode']+'.json')
            evidence.close=mock.Mock()
        with tempfile.TemporaryDirectory() as directory:
            output=pathlib.Path(directory)/'new-comparison.json'
            argv=['compare','--expected-patch-sha256',proof.PATCH,'--fixture-sha256','d'*64,
                  'ordinary.json','streamed.json',str(output)]
            with mock.patch.object(compare.sys,'argv',argv), mock.patch.object(compare,'Evidence',side_effect=[ordinary,streamed]), mock.patch.object(compare,'numeric_compare',return_value=dict(passed=True,elements=1,mismatchedIds=0)), mock.patch.object(compare,'wave_checks',return_value=[]), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(compare.main(),1)
            measured=json.loads(output.read_text())
        self.assertFalse(measured['passed'])
        self.assertIsNone(measured['firstFailedNode'])
        self.assertEqual(measured['firstFailedResidual']['mode'],'ordinary')
        self.assertEqual(len(measured['residualAliasEvidence']['ordinary']),20)
        ordinary.close.assert_called_once(); streamed.close.assert_called_once()

    def native_manifest(self):
        return dict(schemaVersion=1,baseCommit=proof.BASE,patchSha256=proof.PATCH,target='darwin-arm64',
                    backends=[dict(id='cpu',executable='worker/llama-server-ssd',libraryDirectory='worker',arguments=[])],
                    planner=dict(schemaVersion=1,executable='worker/llama-plan-ssd',sourceSha256='a'*64),
                    integrity=dict(schemaVersion=1,executable='worker/llama-hash-ssd',sourceSha256='b'*64),
                    files=[dict(path='worker/'+name,size=1024+i,sha256=str(i+1)*64) for i,name in enumerate([
                        'llama-server-ssd','llama-plan-ssd','llama-hash-ssd','libllama.0.dylib','libggml.0.dylib','libggml-base.0.dylib','libggml-cpu.0.dylib'])])

    def test_native_identity_survives_report_inventory_refresh(self):
        manifest=self.native_manifest()
        before=proof.native_binding(manifest)
        manifest['files'].reverse()
        manifest['files'].append(dict(path='validation/reviewed.json',size=999,sha256='f'*64))
        manifest['validatedConfigurations']=[dict(report='validation/reviewed.json')]
        self.assertEqual(proof.native_binding(manifest),before)

    def test_native_identity_changes_for_same_patch_changed_library(self):
        manifest=self.native_manifest()
        before=proof.native_binding(manifest)
        manifest['files'][-1]['sha256']='f'*64
        self.assertNotEqual(proof.native_binding(manifest),before)

    def test_native_identity_rejects_missing_duplicate_or_unsafe_worker(self):
        for change in ('missing','duplicate','unsafe'):
            manifest=self.native_manifest()
            if change=='missing': manifest['files'].pop()
            elif change=='duplicate': manifest['files'].append(manifest['files'][0])
            else: manifest['files'][0]['path']='worker/../payload'
            with self.assertRaises(RuntimeError): proof.native_binding(manifest)

    def trial_outputs(self, pressure=1, competing=''):
        def output(args, **kwargs):
            if args[0] == '/usr/bin/vm_stat':
                return 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 655360.\nPages inactive: 0.\nPages speculative: 0.\n'
            if args[0] == '/usr/sbin/sysctl':
                return str(pressure)
            return competing
        return output

    def test_trial_elapsed_increases_without_extending_shared_deadline(self):
        with mock.patch.object(proof.time, 'monotonic', return_value=100.0) as clock, mock.patch.object(proof.subprocess, 'check_output', self.trial_outputs()), mock.patch.object(proof, 'native_usage', return_value={'rssBytes': 1024, 'physicalFootprintBytes': 1024}):
            trial = proof.Trial(pathlib.Path('.'), 60)
            deadline = trial.deadline
            elapsed = []
            for now in (100.0, 107.5, 159.5):
                clock.return_value = now
                elapsed.append(trial.guard()['elapsedSeconds'])
                self.assertEqual(trial.deadline, deadline)
            self.assertEqual(deadline, 160.0)
            self.assertEqual(elapsed, [0.0, 7.5, 59.5])
            self.assertTrue(all(value >= 0 for value in elapsed))
            self.assertTrue(all(first < second for first, second in zip(elapsed, elapsed[1:])))
            clock.return_value = deadline
            with self.assertRaisesRegex(RuntimeError, 'shared proof deadline reached'):
                trial.guard()
            self.assertEqual(len(trial.samples), 3)
            self.assertEqual(trial.deadline, deadline)
            self.assertIsNone(trial.active)

    def test_warning_pressure_fails_before_any_process_launch(self):
        trial = proof.Trial(pathlib.Path('.'), 60)
        with mock.patch.object(proof.subprocess, 'check_output', self.trial_outputs(pressure=2)), mock.patch.object(proof, 'native_usage', return_value={'rssBytes': 1024, 'physicalFootprintBytes': 1024}):
            with self.assertRaisesRegex(RuntimeError, 'normal pressure'):
                trial.guard()
        self.assertIsNone(trial.active)

    def test_competing_model_stops_serial_trial(self):
        trial = proof.Trial(pathlib.Path('.'), 60)
        with mock.patch.object(proof.subprocess, 'check_output', self.trial_outputs(competing='12345 /private/model/llama-server-ssd\n')), mock.patch.object(proof, 'native_usage', return_value={'rssBytes': 1024, 'physicalFootprintBytes': 1024}):
            with self.assertRaisesRegex(RuntimeError, 'serially'):
                trial.guard()

    def test_native_controller_memory_cap_is_fail_closed(self):
        trial = proof.Trial(pathlib.Path('.'), 60)
        with mock.patch.object(proof.subprocess, 'check_output', self.trial_outputs()), mock.patch.object(proof, 'native_usage', return_value={'rssBytes': 257 * proof.MiB, 'physicalFootprintBytes': 1024}):
            with self.assertRaisesRegex(RuntimeError, 'bounded cap'):
                trial.guard()

    def inventory_files(self, output):
        for name in proof.EVIDENCE_FILES:
            (output / name).write_bytes(('offline inventory fixture: ' + name).encode())

    def inventory_uncached(self, path):
        return proof.os.open(path, proof.os.O_RDONLY | proof.os.O_NOFOLLOW | proof.os.O_CLOEXEC)

    def test_inventory_preserves_primary_compare_failure_when_comparison_absent(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory)
            self.inventory_files(output)
            (output / 'comparison.json').unlink()
            primary = 'compare failed (1); no automatic retry or certificate'
            report = {'passed': False, 'failure': primary, 'issuedAppCertificate': False}
            trial = mock.Mock()
            with mock.patch.object(proof, 'uncached', self.inventory_uncached):
                proof.inventory_evidence(output, trial, report)
            self.assertEqual(report['failure'], primary)
            self.assertFalse(report['passed'])
            self.assertFalse(report['issuedAppCertificate'])
            self.assertFalse(report['evidenceInventoryComplete'])
            self.assertEqual(report['evidenceInventoryFailure'], {'file': 'comparison.json', 'error': 'complete retained non-payload evidence inventory required'})
            self.assertEqual(list(report['evidenceInventory']), proof.EVIDENCE_FILES[:3])
            self.assertEqual(report['uninventoriedEvidenceFiles'], proof.EVIDENCE_FILES[3:])
            self.assertTrue((output / 'compare.log').is_file())
            self.assertIn('compare.log', report['uninventoriedEvidenceFiles'])
            self.assertEqual(trial.guard.call_count, 3)

    def test_inventory_only_guard_failure_prevents_complete_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory)
            self.inventory_files(output)
            report = {'passed': True, 'issuedAppCertificate': False}
            trial = mock.Mock()
            trial.guard.side_effect = [None, None, None, RuntimeError('shared proof deadline reached')]
            with mock.patch.object(proof, 'uncached', self.inventory_uncached):
                proof.inventory_evidence(output, trial, report)
            self.assertFalse(report['passed'])
            self.assertFalse(report['issuedAppCertificate'])
            self.assertEqual(report['failure'], 'shared proof deadline reached')
            self.assertEqual(report['evidenceInventoryFailure'], {'file': 'comparison.json', 'error': 'shared proof deadline reached'})
            self.assertFalse(report['evidenceInventoryComplete'])
            self.assertEqual(list(report['evidenceInventory']), proof.EVIDENCE_FILES[:3])
            self.assertEqual(report['uninventoriedEvidenceFiles'], proof.EVIDENCE_FILES[3:])
            self.assertTrue((output / 'comparison.json').is_file())
            self.assertEqual(trial.guard.call_count, 4)

    def test_complete_inventory_retains_all_actual_hashes_without_issuing_certificate(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory)
            self.inventory_files(output)
            report = {'passed': True, 'issuedAppCertificate': False}
            trial = mock.Mock()
            with mock.patch.object(proof, 'uncached', self.inventory_uncached):
                proof.inventory_evidence(output, trial, report)
            self.assertTrue(report['evidenceInventoryComplete'])
            self.assertTrue(report['passed'])
            self.assertFalse(report['issuedAppCertificate'])
            self.assertNotIn('failure', report)
            self.assertNotIn('evidenceInventoryFailure', report)
            self.assertEqual(report['uninventoriedEvidenceFiles'], [])
            self.assertEqual(list(report['evidenceInventory']), proof.EVIDENCE_FILES)
            self.assertEqual(trial.guard.call_count, len(proof.EVIDENCE_FILES))
            for name, row in report['evidenceInventory'].items():
                self.assertEqual(row['sha256'], proof.digest((output / name).read_bytes()))
                self.assertEqual(row['sizeBytes'], (output / name).stat().st_size)
                self.assertEqual(row['fingerprint'], proof.fingerprint(output / name))

    def test_ordered_complete_artifact_identity(self):
        rows = [{'filename': f'Qwen3-Coder-Next-Q4_K_M-0000{i+1}-of-00004.gguf',
                 'sha256': sha, 'sizeBytes': size} for i, (size, sha) in enumerate(proof.ARTIFACTS)]
        self.assertEqual(proof.digest(proof.compact(rows)), proof.SET_DIGEST)
        self.assertNotEqual(proof.digest(proof.compact(rows[::-1])), proof.SET_DIGEST)
        self.assertNotEqual(proof.digest(proof.compact(rows[:3])), proof.SET_DIGEST)

    def test_fixture_recurrent_metadata_uses_actual_boolean_array_encoding(self):
        import struct
        entry = proof.metadata_entry('qwen3next.attention.recurrent_layers', 9, struct.pack('<IQ??', 7, 2, True, False))
        key = proof.gguf_string('qwen3next.attention.recurrent_layers')
        self.assertEqual(entry[len(key):], struct.pack('<IIQ??', 9, 7, 2, True, False))

    def test_exact_integer_ids_fail_on_one_router_change(self):
        node = {'type': 'i32', 'dimensions': [10, 1, 1, 1]}
        self.assertTrue(compare.numeric_compare(node, node, Data(list(range(10))), Data(list(range(10))))['passed'])
        self.assertFalse(compare.numeric_compare(node, node, Data(list(range(10))), Data(list(range(9)) + [511]))['passed'])

    def test_float_difference_and_nonfinite_are_rejected(self):
        node = {'name': 'ffn_shexp_gated-0', 'type': 'f32', 'dimensions': [2, 1, 1, 1]}
        self.assertTrue(compare.numeric_compare(node, node, Data([1., 2.]), Data([1., 2.]))['passed'])
        self.assertFalse(compare.numeric_compare(node, node, Data([1., 2.]), Data([1., 2.1]))['passed'])
        with self.assertRaises(AssertionError):
            compare.numeric_compare(node, node, Data([1., 2.]), Data([1., float('nan')]))

    def test_waves_require_all_selected_pairs_contribute_once(self):
        class Evidence:
            nodes = [{'name': 'ffn_moe_wave_mask-0', 'caseId': 0, 'step': 0, 'occurrence': 0},
                     {'name': 'ffn_moe_wave_ids-0', 'caseId': 0, 'step': 0, 'occurrence': 0}]
            def data(self, node):
                return [0., 1.] if 'mask' in node['name'] else [0, 29]
        self.assertFalse(compare.wave_checks(Evidence())[0]['allSelectedPairsContributeOnce'])

    def test_slot30_is_outside_qwen_cache(self):
        class Evidence:
            nodes = [{'name': 'ffn_moe_topk_stream-0', 'caseId': 0, 'step': 0, 'occurrence': 0}]
            def data(self, node):
                return [30]
        with self.assertRaises(AssertionError):
            compare.wave_checks(Evidence())

    def test_missing_hybrid_captures_never_pass(self):
        class Evidence:
            report = {'run': {'cases': []}}
            nodes = []
        with self.assertRaises(AssertionError):
            compare.complete_evidence(Evidence())

    def test_symlink_source_fingerprint_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            regular = pathlib.Path(directory) / 'actual'
            regular.write_bytes(b'x')
            link = pathlib.Path(directory) / 'link'
            link.symlink_to(regular)
            with self.assertRaises(RuntimeError):
                proof.fingerprint(link)


if __name__ == '__main__':
    unittest.main()
