import type { Chain, Simulation } from '../chain.ts';
import type { Resolved } from './resolve.ts';

export type Simulated = Resolved & { simulation: Simulation };

/** Resolved → Simulated: what the network says the transaction would do, with every writable account watched. */
export async function simulate(resolved: Resolved, chain: Chain): Promise<Simulated> {
    const writable = resolved.accounts.filter((a) => a.writable).map((a) => a.address);
    const simulation = await chain.simulate(resolved.bytes, writable, resolved.slot);
    const loaded = resolved.accounts.filter((a) => a.table).map((a) => a.address);
    const watched = simulation.error !== null || simulation.after.length === writable.length;
    if (!watched || (simulation.loaded && simulation.loaded.join() !== loaded.join())) {
        throw new Error('the simulation does not match the transaction');
    }
    return { ...resolved, simulation };
}
