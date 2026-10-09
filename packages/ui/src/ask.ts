import { platform } from '@otus-wallet/core/platform.ts';
import type { KeysCall, KeysReply } from '@otus-wallet/core/keystore.ts';

/** A call to the keystore, which lives in the background. */
export const ask = (call: KeysCall) => platform.send(call) as Promise<KeysReply>;
