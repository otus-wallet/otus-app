import type { KeysCall, KeysReply } from '../shell/keys.ts';

/** A call to the keystore, which lives in the background. */
export const ask = (call: KeysCall): Promise<KeysReply> => chrome.runtime.sendMessage(call);
