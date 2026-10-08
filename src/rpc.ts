// Every RPC client Otus makes. Each request gives up after a while: a node that never answers fails the read,
// rather than leaving a review or a balance waiting for good. Besides Solana's methods, a client can ask for Helius'
// priority fee estimate; an RPC without it answers with an error.
import { createDefaultRpcTransport, createRpc, createSolanaRpcApi, DEFAULT_RPC_CONFIG, type Address, type Rpc, type RpcTransport, type SolanaRpcApi } from '@solana/kit';

export const RPC_WAIT = 20_000; // ms for one request

/** Helius' estimate. `recommended`: the median price paid lately to write these accounts, and 10,000 at least; in
 *  micro-lamports per unit, which may come with a fraction. */
export type PriorityFeeApi = {
    getPriorityFeeEstimate(request: { accountKeys: readonly Address[]; options: { recommended: true } }): { priorityFeeEstimate?: number | bigint };
};

export type OtusRpc = Rpc<SolanaRpcApi & PriorityFeeApi>;

/** A client over a transport, as Kit's createSolanaRpcFromTransport makes one, with Helius' method too. */
export const rpcFrom = (transport: RpcTransport): OtusRpc => createRpc({ api: createSolanaRpcApi<SolanaRpcApi & PriorityFeeApi>(DEFAULT_RPC_CONFIG), transport });

export function rpcAt(url: string): OtusRpc {
    const transport = createDefaultRpcTransport({ url });
    const timed: RpcTransport = (config) => {
        const limit = AbortSignal.timeout(RPC_WAIT);
        return transport({ ...config, signal: config.signal ? AbortSignal.any([config.signal, limit]) : limit });
    };
    return rpcFrom(timed);
}

/** Whether a request gave up waiting. */
export const timedOut = (e: unknown) => e instanceof DOMException && e.name === 'TimeoutError';
