import { AccountRole, type Address, type ReadonlyUint8Array } from '@solana/kit';

import { CORE_PLUGINS } from '../programs/core.ts';
import type { Explanation, KitInstruction, Plugin } from '../programs/plugin.ts';
import type { Message } from './decode.ts';
import type { Account } from './resolve.ts';

/** One top-level instruction, as its program's plugin explains it. */
export type Explained = Explanation & {
    program: Address;
    programName: string | null; // null: no plugin for this program
    source: 'plugin' | 'unknown';
    data: ReadonlyUint8Array; // as the transaction carries it
};

/** The instructions and accounts explain needs: a transaction's, or one a Squads proposal carries. */
type Explainable = { message: { instructions: Pick<Message['instructions'][number], 'programAddressIndex' | 'accountIndices' | 'data'>[] }; accounts: Roles[] };
type Roles = Pick<Account, 'address' | 'signer' | 'writable'>;

/** Resolved → one Explained per top-level instruction. Pure. */
export function explain(resolved: Explainable, plugins: Plugin[] = CORE_PLUGINS): Explained[] {
    const byProgram = new Map(plugins.map((p) => [p.program, p]));
    return resolved.message.instructions.map((ix) => {
        const instruction = kitInstruction(ix, resolved.accounts);
        const plugin = byProgram.get(instruction.programAddress);
        const found = plugin ? attempt(plugin, instruction) : null;
        return {
            program: instruction.programAddress,
            programName: plugin?.name ?? null,
            source: found ? 'plugin' : 'unknown',
            data: instruction.data,
            ...(found ?? {
                name: 'Unknown instruction',
                accounts: instruction.accounts.map((meta, i) => ({ role: `account ${i + 1}`, address: meta.address })),
                args: [],
            }),
        };
    });
}

// A plugin that throws explains nothing: the instruction shows as unknown, never as safe.
function attempt(plugin: Plugin, instruction: KitInstruction): Explanation | null {
    try {
        return plugin.explain(instruction);
    } catch {
        return null;
    }
}

function kitInstruction(ix: Explainable['message']['instructions'][number], accounts: Roles[]): KitInstruction & { accounts: { address: Address; role: AccountRole }[] } {
    return {
        programAddress: accounts[ix.programAddressIndex].address,
        accounts: ix.accountIndices.map((i) => ({ address: accounts[i].address, role: role(accounts[i]) })),
        data: ix.data,
    };
}

function role(a: Roles): AccountRole {
    if (a.signer) return a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER;
    return a.writable ? AccountRole.WRITABLE : AccountRole.READONLY;
}
