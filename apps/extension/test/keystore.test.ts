import assert from 'node:assert/strict';
import { test } from 'node:test';

// chrome.storage as the keystore uses it: local and session areas, in memory.
function area() {
    let data: Record<string, unknown> = {};
    return {
        get: async (keys?: string | string[] | Record<string, unknown>) => {
            if (typeof keys === 'string') return keys in data ? { [keys]: structuredClone(data[keys]) } : {};
            if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
            if (keys) return Object.fromEntries(Object.entries(keys).map(([k, fallback]) => [k, k in data ? structuredClone(data[k]) : fallback]));
            return structuredClone(data);
        },
        set: async (items: Record<string, unknown>) => void (data = { ...data, ...structuredClone(items) }),
        remove: async (keys: string | string[]) => void [keys].flat().forEach((k) => delete data[k]),
    };
}
Object.assign(globalThis, { chrome: { storage: { local: area(), session: area() }, alarms: { clear: async () => true } } });

await import('../src/shell/chrome.ts'); // the platform, over the chrome above
const { keysCall, prune } = await import('../src/shell/keys.ts');
const { edited, load, update } = await import('../src/shell/state.ts');
const { readSecrets, bytes } = await import('../src/keys/vault.ts');

const A = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PASSWORD = 'correct horse';
const call = async (c: Parameters<typeof keysCall>[0]) => {
    const reply = await keysCall(c);
    if (!reply.ok) throw new Error(reply.error);
    return reply.result as { address: string };
};
// A removal as the background makes it: the edit, then the vault without what no account uses.
const remove = async (address: string) => {
    await update((s) => edited({ edit: 'remove', address }, s));
    await prune();
};
const secrets = async () => {
    const { vault } = (await chrome.storage.local.get('vault')) as { vault: Parameters<typeof readSecrets>[0] };
    const { unlocked } = (await chrome.storage.session.get('unlocked')) as { unlocked: string };
    return (await readSecrets(vault, bytes(unlocked))).map((s) => ('phrase' in s ? s.phrase : 'key'));
};

test('New account never brings back a wallet you removed, nor a phrase with no wallet left; a removed one leaves the vault', async () => {
    const a0 = await call({ keys: 'add', from: { phrase: A }, label: 'A0', newPassword: PASSWORD });
    const a1 = await call({ keys: 'derive', label: 'A1' });
    await remove(a1.address);
    const a2 = await call({ keys: 'derive', label: 'A2' });
    assert.notEqual(a2.address, a1.address); // index 1 was removed: the next is index 2
    assert.deepEqual((await load()).accounts.map((a) => a.key?.index), [0, 2]);

    // Phrase B's only wallet removed: B leaves the vault, and New account stays on A.
    const b0 = await call({ keys: 'add', from: { phrase: B }, label: 'B0' });
    assert.deepEqual(await secrets(), [A, B]);
    await remove(b0.address);
    assert.deepEqual(await secrets(), [A]);
    await update((s) => edited({ edit: 'use', address: a0.address }, s));
    assert.notEqual((await call({ keys: 'derive', label: 'A3' })).address, b0.address);
});

test('an address changed in storage while Otus was locked is put back to the one its key gives, at unlock', async () => {
    const { accounts } = await load();
    const real = accounts[0].address;
    const forged = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    await call({ keys: 'lock' });
    await chrome.storage.local.set({ accounts: accounts.map((a, i) => (i === 0 ? { ...a, address: forged } : a)), active: forged });
    await call({ keys: 'unlock', password: PASSWORD });
    const after = await load();
    assert.equal(after.accounts[0].address, real);
    assert.equal(after.active, real);
});

test('an account whose key the vault does not hold is watched only; one that comes back to an address held already goes', async () => {
    const { accounts } = await load();
    const forged = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const other = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy';
    await call({ keys: 'lock' });
    await chrome.storage.local.set({
        accounts: [
            ...accounts,
            { address: forged, label: 'Fake', key: { secret: 'no-such-secret', index: 0 } }, // no key for it in the vault
            { address: other, label: 'Copy', key: accounts[0].key }, // the first account's key, under another address
        ],
    });
    await call({ keys: 'unlock', password: PASSWORD });
    const after = (await load()).accounts;
    assert.deepEqual(after.find((a) => a.address === forged), { address: forged, label: 'Fake' }); // watched only: no key
    assert.equal(after.filter((a) => a.address === accounts[0].address).length, 1);
    assert.equal(after.some((a) => a.address === other), false);
});

test('a phrase imported again brings back the accounts you removed from it', async () => {
    const { accounts } = await load();
    const last = accounts.filter((a) => a.key?.index !== undefined).at(-1)!;
    await remove(last.address);
    assert.ok((await load()).removed.includes(last.address));
    const reply = await keysCall({ keys: 'add', from: { phrase: A }, label: 'Again' });
    assert.deepEqual(reply, { ok: false, error: 'That phrase is in Otus already: New account brings back the accounts you removed from it' });
    assert.equal((await load()).removed.length, 1); // phrase B's, still; every one of phrase A's, the first test's index 1 too, gone
    const back = await call({ keys: 'derive', label: 'Back' });
    assert.equal((await load()).accounts.find((a) => a.address === back.address)?.key?.index, 1);
});
