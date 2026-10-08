import type { Address } from '@solana/kit';

import type { Chain } from '../chain.ts';
import { Refused } from '../protocol.ts';
import { assess, type Assessment, type Context } from './assess.ts';
import { changes, type Changes } from './changes.ts';
import { decode } from './decode.ts';
import { deployments, type Deployment } from './programs.ts';
import { explain, type Explained } from './explain.ts';
import { resolve } from './resolve.ts';
import { simulate, type Simulated } from './simulate.ts';

export type Review = Simulated & { changes: Changes; explained: Explained[]; deployments: Map<Address, Deployment>; assessment: Assessment };

/** One transaction through steps 3 to 8. Throws Refused for what cannot be signed at all. */
export async function review(bytes: Uint8Array, context: Context, chain: Chain): Promise<Review> {
    const decoded = await decode(bytes);
    if (!decoded.signers.includes(context.wallet)) throw new Refused('this wallet does not sign this transaction');
    const resolved = await resolve(decoded, chain);
    // When its programs were deployed is worth knowing, never worth failing the review for.
    const [simulated, deployed] = await Promise.all([simulate(resolved, chain), deployments(resolved, chain).catch(() => new Map<Address, Deployment>())]);
    const changed = changes(simulated);
    const explained = explain(resolved);
    const assessment = assess(simulated, changed, explained, { now: Math.floor(Date.now() / 1000), ...context, deployments: deployed });
    return { ...simulated, changes: changed, explained, deployments: deployed, assessment };
}
