/** The original window owns native selection, even for standalone macOS panels. */
export interface NativeDialogOwner {
  isDestroyed(): boolean;
  focus(): void;
  webContents: { isDestroyed(): boolean };
}

// Open and save panels share ownership. A second request must not present
// another application-modal panel while the first native promise is pending.
const pendingOwners = new WeakSet<NativeDialogOwner>();

function liveOwner(owner: NativeDialogOwner | undefined): owner is NativeDialogOwner {
  try { return !!owner && !owner.isDestroyed() && !owner.webContents.isDestroyed(); }
  catch { return false; }
}

/** A window may close between a native panel settling and focus restoration. */
export function restoreNativeDialogFocus(owner: NativeDialogOwner | undefined): void {
  try { if (liveOwner(owner)) owner.focus(); }
  catch { /* Closing the owner must not replace the selection/result error. */ }
}

export async function runNativeDialog<TOwner extends NativeDialogOwner, TOptions, TResult>(
  owner: TOwner | undefined,
  options: TOptions,
  handlers: {
    standalone(options: TOptions): Promise<TResult>;
    parented(owner: TOwner, options: TOptions): Promise<TResult>;
  },
  platform: NodeJS.Platform = process.platform,
): Promise<TResult> {
  if (!liveOwner(owner)) throw new Error('The app window is unavailable for this native dialog.');
  if (pendingOwners.has(owner)) throw new Error('Finish the open native dialog before opening another.');
  pendingOwners.add(owner);
  try {
    // Attached sheets have left valid file/folder confirmation disabled on the
    // pinned Electron/macOS combination. Other platforms keep their parent.
    if (platform === 'darwin') {
      restoreNativeDialogFocus(owner);
      if (!liveOwner(owner)) throw new Error('The app window is unavailable for this native dialog.');
    }
    return await (platform === 'darwin' ? handlers.standalone(options) : handlers.parented(owner, options));
  } finally {
    pendingOwners.delete(owner);
    restoreNativeDialogFocus(owner);
  }
}
