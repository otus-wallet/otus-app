// A first password, as the setup asks it with the first wallet: for a phrase or a key it goes with the wallet itself;
// a Ledger or an address watched, which hold no secret, set it on its own, first.
import { useState } from 'react';

import type { KeyStatus } from '@otus-wallet/core/keystore.ts';
import { MAX_PASSWORD, MIN_PASSWORD, passwordProblem } from '@otus-wallet/core/password.ts';
import { PasswordInput } from '../components/password.tsx';
import { Strength } from '../components/strength.tsx';
import { ask } from '../ask.ts';
import { Heading, Muted } from './parts.tsx';

// What the password is for, and the way back if it is forgotten, by the wallet it comes with.
const UNLOCKS = `It unlocks Otus on this computer: ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.`;
export const NOTES = {
    phrase: `${UNLOCKS} Your phrase is the only way back if you forget it.`,
    ledger: `${UNLOCKS} If you forget it, reinstall Otus: your keys stay on your Ledger.`,
    watch: `${UNLOCKS} If you forget it, reinstall Otus and add the address again.`,
};

// A new password when there is no vault yet. With one, nothing: this page shows only while Otus is unlocked.
export type Credentials = { newPassword?: string };

/** The fields of a first password, and what was typed in them. `seal`, for a wallet that holds no secret (a Ledger, an
 *  address watched): the password set on its own, before the wallet; why not, or null once it is. */
export function usePassword(keys: KeyStatus, note = NOTES.phrase, focus = true) {
    const [first, setFirst] = useState('');
    const [again, setAgain] = useState('');
    const [made, setMade] = useState(false); // set here by seal()
    const value = (): Credentials | Error => {
        if (keys.vault || made) return {};
        const problem = passwordProblem(first, again);
        return problem ? new Error(problem) : { newPassword: first };
    };
    const seal = async (): Promise<string | null> => {
        const credentials = value();
        if (credentials instanceof Error) return credentials.message;
        if (credentials.newPassword === undefined) return null;
        const reply = await ask({ keys: 'seal', newPassword: credentials.newPassword }).catch(() => undefined);
        if (!reply?.ok) return reply?.error ?? 'Otus could not do that';
        setMade(true);
        return null;
    };
    if (keys.vault || made) return { fields: null, value, seal };
    const fields = (
        <>
            <Heading>Password</Heading>
            <Muted>{note}</Muted>
            <div className="flex flex-col gap-1.5">
                <PasswordInput placeholder="New password" autoComplete="new-password" aria-label="New password" autoFocus={focus} value={first} onChange={(e) => setFirst(e.target.value)} />
                <Strength password={first} />
                <PasswordInput placeholder="The same again" autoComplete="new-password" aria-label="The same again" value={again} onChange={(e) => setAgain(e.target.value)} />
            </div>
        </>
    );
    return { fields, value, seal };
}
