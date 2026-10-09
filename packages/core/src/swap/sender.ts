// How a swap lands: sent through Otus's server to Helius Sender (stake-weighted connections only, away from validators
// known to sandwich), with no preflight of the RPC's own (Otus simulated it already) and no retries of Sender's; the
// wallet sends it again itself while it is unseen. Everything else (its status, its blockhash) is read as before.
import { getBase64Decoder, type Base64EncodedWireTransaction } from '@solana/kit';

import type { Chain } from '@otus-wallet/sdk/chain';
import { rpcAt } from '@otus-wallet/sdk/rpc';
import { OTUS_RPC } from '../settings.ts';

/** `chain`, sending through Sender. */
export function throughSender(chain: Chain, url = `${OTUS_RPC}/send`): Chain {
    const sender = rpcAt(url);
    return {
        ...chain,
        async send(transaction) {
            await sender.sendTransaction(getBase64Decoder().decode(transaction) as Base64EncodedWireTransaction, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send();
        },
    };
}
