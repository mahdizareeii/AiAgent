import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restoreNativeDialogFocus, runNativeDialog, type NativeDialogOwner } from '../native-dialog.ts';

function windowFixture() {
  const state = { destroyed: false, contentsDestroyed: false, focuses: 0 };
  const owner = {
    name: 'original window',
    isDestroyed: () => state.destroyed,
    focus: () => { state.focuses++; },
    webContents: { isDestroyed: () => state.contentsDestroyed },
  } satisfies NativeDialogOwner & { name: string };
  return { owner, state };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

for (const platform of ['darwin', 'win32', 'linux'] as const) {
  test(`${platform} uses the correct native overload and preserves exact options, selection and owner`, async () => {
    const { owner, state } = windowFixture();
    const options = Object.freeze({
      title: 'Choose project folder',
      defaultPath: '/projects/پروژه',
      properties: Object.freeze(['openDirectory', 'createDirectory']),
    });
    const selection = { canceled: false, filePaths: ['/projects/پروژه'], bookmarks: ['opaque bookmark'] };
    const calls: string[] = [];
    const result = await runNativeDialog(owner, options, {
      standalone: async received => {
        calls.push('standalone');
        assert.equal(received, options);
        assert.equal(state.focuses, 0, 'Focus is restored only after the native panel settles.');
        return selection;
      },
      parented: async (receivedOwner, received) => {
        calls.push('parented');
        assert.equal(receivedOwner, owner);
        assert.equal(receivedOwner.name, 'original window', 'The generic owner retains its concrete type.');
        assert.equal(received, options);
        assert.equal(state.focuses, 0);
        return selection;
      },
    }, platform);
    assert.deepEqual(calls, [platform === 'darwin' ? 'standalone' : 'parented']);
    assert.equal(result, selection, 'Selection data must not be reconstructed or modified.');
    assert.equal(state.focuses, 1);
  });
}

test('canceling a native panel preserves the exact cancellation result and restores its original window', async () => {
  const { owner, state } = windowFixture();
  const canceled = { canceled: true, filePaths: [], bookmark: undefined };
  const result = await runNativeDialog(owner, { title: 'Import GGUF' }, {
    standalone: async () => canceled,
    parented: async () => { throw new Error('macOS panels must use the standalone overload.'); },
  }, 'darwin');
  assert.equal(result, canceled);
  assert.equal(state.focuses, 1);
});

test('native dialog errors are rethrown unchanged after restoring the owner focus', async () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const { owner, state } = windowFixture();
    const failure = new Error('Native selection failed.');
    await assert.rejects(runNativeDialog(owner, {}, {
      standalone: async () => { throw failure; },
      parented: async () => { throw failure; },
    }, platform), error => error === failure);
    assert.equal(state.focuses, 1, platform);
  }
});

test('an unavailable owner rejects before any native panel can open', async () => {
  const destroyed = windowFixture();
  destroyed.state.destroyed = true;
  const destroyedContents = windowFixture();
  destroyedContents.state.contentsDestroyed = true;
  const racing = windowFixture();
  racing.owner.isDestroyed = () => { throw new Error('Window was just disposed.'); };
  for (const owner of [undefined, destroyed.owner, destroyedContents.owner, racing.owner]) {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      let panels = 0;
      await assert.rejects(runNativeDialog(owner, {}, {
        standalone: async () => { panels++; return null; },
        parented: async () => { panels++; return null; },
      }, platform), /window is unavailable/i);
      assert.equal(panels, 0);
    }
  }
  assert.equal(destroyed.state.focuses, 0);
  assert.equal(destroyedContents.state.focuses, 0);
  assert.equal(racing.state.focuses, 0);
});

test('focus returns to the original live owner only after a pending panel completes', async () => {
  const original = windowFixture(), replacement = windowFixture();
  const pending = deferred<{ canceled: false; filePath: string }>();
  let activeWindow = original.owner;
  const dialog = runNativeDialog(original.owner, { title: 'Save screenshot' }, {
    standalone: async () => pending.promise,
    parented: async () => pending.promise,
  }, 'darwin');
  activeWindow = replacement.owner;
  assert.equal(original.state.focuses, 0);
  assert.equal(replacement.state.focuses, 0);
  const selection = { canceled: false as const, filePath: '/screenshots/working.png' };
  pending.resolve(selection);
  assert.equal(await dialog, selection);
  assert.equal(activeWindow, replacement.owner);
  assert.equal(original.state.focuses, 1);
  assert.equal(replacement.state.focuses, 0, 'A newly active window must not replace the original owner.');
});

for (const destroyedPart of ['window', 'webContents'] as const) {
  test(`${destroyedPart} destruction while selection is pending preserves the result without refocusing a replacement`, async () => {
    const original = windowFixture(), replacement = windowFixture();
    const pending = deferred<{ canceled: boolean; filePaths: string[] }>();
    const dialog = runNativeDialog(original.owner, {}, {
      standalone: async () => pending.promise,
      parented: async () => pending.promise,
    }, 'win32');
    if (destroyedPart === 'window') original.state.destroyed = true;
    else original.state.contentsDestroyed = true;
    const selection = { canceled: false, filePaths: ['/projects/new-work'] };
    pending.resolve(selection);
    assert.equal(await dialog, selection);
    assert.equal(original.state.focuses, 0);
    assert.equal(replacement.state.focuses, 0);
  });
}

test('owner destruction during a pending panel rejection does not mask the native error', async () => {
  const { owner, state } = windowFixture();
  const pending = deferred<null>();
  const dialog = runNativeDialog(owner, {}, {
    standalone: async () => pending.promise,
    parented: async () => pending.promise,
  }, 'linux');
  state.destroyed = true;
  const failure = new Error('Native picker was interrupted.');
  const rejected = assert.rejects(dialog, error => error === failure);
  pending.reject(failure);
  await rejected;
  assert.equal(state.focuses, 0);
});

test('a focus race cannot replace a successful selection or the original dialog error', async () => {
  for (const fails of [false, true]) {
    const { owner } = windowFixture();
    const nativeError = new Error('Original native error.');
    owner.focus = () => { throw new Error('Owner closed between liveness check and focus.'); };
    const selection = { canceled: false, filePath: '/chosen/model.gguf' };
    const operation = async () => { if (fails) throw nativeError; return selection; };
    const dialog = runNativeDialog(owner, {}, { standalone: operation, parented: operation }, 'darwin');
    if (fails) await assert.rejects(dialog, error => error === nativeError);
    else assert.equal(await dialog, selection);
  }
});

test('focus restoration skips unavailable windows and tolerates disposal-check races', () => {
  assert.doesNotThrow(() => restoreNativeDialogFocus(undefined));
  const destroyed = windowFixture();
  destroyed.state.destroyed = true;
  restoreNativeDialogFocus(destroyed.owner);
  assert.equal(destroyed.state.focuses, 0);
  const destroyedContents = windowFixture();
  destroyedContents.state.contentsDestroyed = true;
  restoreNativeDialogFocus(destroyedContents.owner);
  assert.equal(destroyedContents.state.focuses, 0);
  const racing = windowFixture();
  racing.owner.webContents.isDestroyed = () => { throw new Error('Contents were just disposed.'); };
  assert.doesNotThrow(() => restoreNativeDialogFocus(racing.owner));
  assert.equal(racing.state.focuses, 0);
});
