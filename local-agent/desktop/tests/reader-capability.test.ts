import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasReaderCapability, shouldPersistRequestFile } from '../reader-capability.ts';

const offline = { fileReading: true, projectSearch: false, webResearch: false };
test('a plain assistant has no useful reader without actual scope; recovery and explicit attachments retain it', () => {
  assert.equal(hasReaderCapability(offline, [], []), false);
  for (const files of [['/private/request.txt'], ['/private/session/context-recovery/manifest.json.part-01.txt'], ['/selected/attachment.txt']]) {
    assert.equal(hasReaderCapability(offline, [], files), true);
  }
  assert.equal(hasReaderCapability(offline, ['/selected/workspace'], []), true);
  assert.equal(hasReaderCapability({ ...offline, fileReading: false }, ['/selected/workspace'], ['/selected/attachment.txt']), false);
  assert.equal(hasReaderCapability({ fileReading: false, projectSearch: true, webResearch: false }, ['/selected/workspace'], []), true);
  assert.equal(hasReaderCapability({ fileReading: false, projectSearch: true, webResearch: false }, [], ['/selected/attachment.txt']), false);
  assert.equal(hasReaderCapability({ fileReading: false, projectSearch: false, webResearch: true }, [], []), true);
});

test('request recovery artifacts remain unchanged for coding/research or explicit chat files, and honor disabled reading', () => {
  assert.equal(shouldPersistRequestFile('assistant', offline, undefined, []), false);
  for (const mode of ['coding', 'research'] as const) assert.equal(shouldPersistRequestFile(mode, offline, undefined, []), true);
  assert.equal(shouldPersistRequestFile('assistant', offline, '/selected/workspace', []), true);
  assert.equal(shouldPersistRequestFile('assistant', offline, undefined, [{ name: 'text', path: '/selected/text.txt' }]), true);
  for (const mode of ['coding', 'research', 'assistant'] as const) assert.equal(shouldPersistRequestFile(mode, { fileReading: false }, '/selected/workspace', [{ name: 'text', path: '/selected/text.txt' }]), false);
});
