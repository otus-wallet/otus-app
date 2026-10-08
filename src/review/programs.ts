// When each program the transaction calls was last deployed, and whether it can still change. A program deployed hours
// ago that asks for your signature is what a drainer often looks like.
import { address, getAddressDecoder, getU32Decoder, getU64Decoder, type Address } from '@solana/kit';

import type { Chain } from '../chain.ts';
import type { Resolved } from './resolve.ts';

/** `deployed`: seconds since 1970, null when unknown; `upgradeable`: whether its upgrade authority can still change it. */
export type Deployment = { deployed: number | null; upgradeable: boolean | null; builtin: boolean };

const UPGRADEABLE_LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');
const LOADER_V4 = address('LoaderV411111111111111111111111111111111111');
const NATIVE_LOADER = address('NativeLoader1111111111111111111111111111111');
const PROGRAM_DATA_HEAD = 45; // kind (4), slot (8), upgrade authority (an option: 1 + 32)

/** Resolved → each called program's deployment. Asks the network for what the transaction's accounts do not hold. */
export async function deployments(r: Resolved, chain: Chain): Promise<Map<Address, Deployment>> {
    const found = new Map<Address, Deployment>();
    const slots = new Map<Address, { slot: bigint; upgradeable: boolean }>();
    const programData = new Map<Address, Address>(); // program → the account its code and deploy slot are in
    for (const ix of r.message.instructions) {
        const { address: program, state } = r.accounts[ix.programAddressIndex];
        if (found.has(program) || slots.has(program) || programData.has(program)) continue;
        if (!state.exists) found.set(program, { deployed: null, upgradeable: null, builtin: false });
        else if (state.programAddress === NATIVE_LOADER) found.set(program, { deployed: null, upgradeable: false, builtin: true });
        else if (state.programAddress === UPGRADEABLE_LOADER && state.data.length >= 36 && getU32Decoder().decode(state.data) === 2) programData.set(program, getAddressDecoder().decode(state.data, 4));
        else if (state.programAddress === LOADER_V4 && state.data.length >= 48) slots.set(program, { slot: getU64Decoder().decode(state.data), upgradeable: getU64Decoder().decode(state.data, 40) !== 2n }); // 2: finalized
        else found.set(program, { deployed: null, upgradeable: false, builtin: false }); // the first loaders: never changes
    }
    const programs = [...programData.keys()];
    const heads = programs.length ? await chain.heads([...programData.values()], PROGRAM_DATA_HEAD) : [];
    heads.forEach((head, i) => {
        // Program data is the loader's own account: an answer naming any other owner is not it.
        if (head.exists && head.programAddress === UPGRADEABLE_LOADER && head.data.length >= 13 && getU32Decoder().decode(head.data) === 3) slots.set(programs[i], { slot: getU64Decoder().decode(head.data, 4), upgradeable: head.data[12] === 1 });
        else found.set(programs[i], { deployed: null, upgradeable: null, builtin: false });
    });
    await Promise.all(
        [...slots].map(async ([program, { slot, upgradeable }]) => {
            found.set(program, { deployed: await chain.blockTime(slot).catch(() => null), upgradeable, builtin: false });
        }),
    );
    return found;
}
