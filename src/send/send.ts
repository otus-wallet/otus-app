import { getSignatureFromTransaction, getTransactionDecoder, isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, type Signature, type TransactionError } from '@solana/kit';

import type { Chain, Status } from '../chain.ts';
import { decode, durable } from '../review/decode.ts';

/** What became of a sent transaction. `unknown`: a durable one not seen yet, which may still land. */
export type Sent = { signature: Signature; outcome: 'confirmed' | 'failed' | 'expired' | 'unknown'; error: TransactionError | null };

const CHECK = 200; // ms between asking whether it landed: a block (200 ms slots), so a confirmation is heard at once
const ROUND = 2_000; // ms between sending it again while no node has seen it, and asking whether its blockhash lives
const CHECKS = ROUND / CHECK; // checks a round
const DURABLE_ROUNDS = 45; // a durable transaction never expires: stop watching it after this many rounds

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** A signed transaction → sent, then watched until it is confirmed, fails or can no longer land. Throws only if the RPC
 *  refuses the first send; a send that timed out or lost its connection may have gone out, so it is watched too.
 *  `preflight` false (the user's setting) sends it even if it would fail: it lands and pays its fee. */
export async function send(signed: Uint8Array, chain: Chain, wait = sleep, preflight = true): Promise<Sent> {
    const { message, signers, signed: present } = await decode(signed);
    if (present.length < signers.length) throw new Error('the transaction is missing signatures');
    const signature = getSignatureFromTransaction(getTransactionDecoder().decode(signed));
    // A result counts once confirmed: a block seen only as processed may still be dropped.
    const settle = (s: Status): Sent | null => (s?.confirmed ? { signature, outcome: s.error ? 'failed' : 'confirmed', error: s.error } : null);
    const status = () => chain.status(signature).catch(() => undefined); // undefined: no answer this time
    const expires = !durable(message);

    // With a preflight: the RPC simulates it first and refuses what would fail.
    await chain.send(signed, preflight).catch((e: unknown) => {
        if (!uncertain(e)) throw e;
    });
    let stale = 0; // rounds in a row that found its blockhash too old; one alone could come from a lagging node
    let sighted = false; // a node has seen it, not confirmed yet
    for (let rounds = 1; ; rounds++) {
        let seen = false; // this round
        for (let check = 0; check < CHECKS; check++) {
            await wait(CHECK);
            const now = await status();
            const settled = settle(now ?? null);
            if (settled) return settled;
            seen ||= Boolean(now);
        }
        sighted ||= seen;
        if (expires) {
            const valid = await chain.valid(message.lifetimeToken).catch(() => true);
            stale = valid ? 0 : stale + 1;
        }
        // Once no block can take it, it may still have landed just before. Expired only when no node ever saw it and
        // the last one asked answered: seen, or unanswered, it may have landed.
        if (stale === 2) {
            const last = await status();
            return settle(last ?? null) ?? { signature, outcome: sighted || last !== null ? 'unknown' : 'expired', error: null };
        }
        if (!expires && rounds === DURABLE_ROUNDS) return settle((await status()) ?? null) ?? { signature, outcome: 'unknown', error: null };
        if (!seen) await chain.send(signed, false).catch(() => {}); // unseen: send again; a resend that fails changes nothing
    }
}

// Whether a send that failed may still have reached the network: the RPC's own refusal (an error it answered with, or
// an HTTP 4xx) is final; a timeout, a dropped connection or a server error may have come after it was forwarded.
function uncertain(e: unknown): boolean {
    if (isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) return e.context.statusCode >= 500;
    return !isSolanaError(e);
}
