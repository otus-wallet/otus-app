import { platform } from '../platform.ts';
import type { KeysCall, KeysReply } from '../shell/keys.ts';

/** A call to the keystore, which lives in the background. */
export const ask = (call: KeysCall) => platform.send(call) as Promise<KeysReply>;
