import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Approval, Life } from '@otus-wallet/core/view.ts';

// Chrome's windows and ports, played here: the windows opened and removed, and the ports that connect back.
const created: { id: number; url: string }[] = [];
const removed: number[] = [];
let connected: (port: unknown) => void = () => {};
let closed: (window: number) => void = () => {};
const chrome = {
    runtime: {
        id: 'otus',
        getURL: (page: string) => `chrome-extension://otus/${page}`,
        onConnect: { addListener: (f: typeof connected) => (connected = f) },
    },
    windows: {
        getLastFocused: async () => ({ left: 0, top: 0, width: 1200 }),
        create: async ({ url }: { url: string }) => (created.push({ id: 100 + created.length, url }), { id: 100 + created.length - 1 }),
        remove: async (id: number) => void removed.push(id),
        onRemoved: { addListener: (f: typeof closed) => (closed = f) },
    },
    storage: { local: { get: async () => ({}) }, session: { get: async () => ({}) } }, // no vault: nothing to unlock
};
Object.assign(globalThis, { chrome });
const { approve, early } = await import('../src/shell/approvals.ts');

const tick = () => new Promise((r) => setTimeout(r, 5));
const form = (kind: string, origin = 'https://jup.ag') => ({ kind, site: { origin, host: new URL(origin).host, note: '', tone: 'plain' }, account: { label: 'Me', address: 'x' } }) as unknown as Approval;

// The window's page connecting back, from Otus's own page: what it hears, and how it answers.
function page(window = created.at(-1)!) {
    const heard: unknown[] = [];
    let said: (m: object) => void = () => {};
    let gone: () => void = () => {};
    const id = window.url.split('#')[1];
    connected({
        name: `approve:${id}`,
        sender: { id: 'otus', url: window.url },
        postMessage: (m: unknown) => heard.push(m),
        onMessage: { addListener: (f: typeof said) => (said = f) },
        onDisconnect: { addListener: (f: typeof gone) => (gone = f) },
        disconnect: () => {},
    });
    return { heard, say: (m: object) => said(m), leave: () => gone() };
}
// Whether a promise has settled yet, and how.
const state = async (p: Promise<unknown>) => Promise.race([p.then((v) => ({ answered: v })), tick().then(() => 'waiting')]);

test('opened early, the window shows who asks and takes no yes until its final form; then the yes counts', async () => {
    const window = early(form('pending'));
    await tick();
    const w = page();
    assert.deepEqual(w.heard, [form('pending')]);
    w.say({ approve: true }); // on the pending form: nothing
    let final: (a: Approval) => void = () => {};
    const lives: ((life: Life) => void)[] = [];
    const answer = window.approve(form('transaction'), (tell) => lives.push(tell), new Promise((r) => (final = r)));
    assert.equal(lives.length, 1); // the window came first: it hears the blockhash's life from now, once
    lives[0]({ until: 5 });
    assert.deepEqual(w.heard.slice(1), [form('transaction'), { life: { until: 5 } }]);
    w.say({ approve: true }); // reviewed, not prepared: nothing
    assert.equal(await state(answer), 'waiting');
    final({ ...form('transaction'), note: 'final' } as unknown as Approval);
    await tick();
    assert.deepEqual(w.heard.at(-1), { ...form('transaction'), note: 'final' });
    w.say({ approve: true });
    assert.deepEqual(await state(answer), { answered: true });
    await tick();
    assert.deepEqual(removed.at(-1), created.at(-1)!.id); // no one to tell how it goes: the window closes
});

test('a no while it is reviewed closes the window at once, and is the answer', async () => {
    const window = early(form('pending'));
    await tick();
    const w = page();
    w.say({ approve: false });
    await tick();
    assert.equal(removed.at(-1), created.at(-1)!.id);
    assert.deepEqual(await state(window.approve(form('transaction'), undefined, new Promise(() => {}))), { answered: false });
});

test('a request that ends before it is ready closes its window; the site may ask again then, not before', async () => {
    const window = early(form('pending', 'https://a.app'));
    assert.throws(() => early(form('pending', 'https://a.app')), /already asking you/);
    await tick();
    window.close();
    await tick();
    assert.equal(removed.at(-1), created.at(-1)!.id);
    early(form('pending', 'https://a.app')).close();
    await tick();
});

test('given its review before the page connects, the window hears it, and the life, when it does', async () => {
    const window = early(form('pending'));
    const lives: ((life: Life) => void)[] = [];
    void window.approve(form('transaction'), (tell) => lives.push(tell), new Promise(() => {}));
    assert.equal(lives.length, 0);
    await tick();
    const w = page();
    assert.equal(lives.length, 1);
    lives[0]({ until: 7 });
    assert.deepEqual(w.heard, [form('transaction'), { life: { until: 7 } }]);
    window.close();
    await tick();
});

test('a final form that fails says no; a window closed, or its page gone, says no too', async () => {
    const failing = early(form('pending'));
    await tick();
    assert.deepEqual(await state(failing.approve(form('transaction'), undefined, Promise.reject(new Error('prepare failed')))), { answered: false });
    const shut = approve(form('message', 'https://b.app'));
    await tick();
    closed(created.at(-1)!.id);
    assert.deepEqual(await state(shut), { answered: false });
    const left = approve(form('message', 'https://c.app'));
    await tick();
    page().leave();
    assert.deepEqual(await state(left), { answered: false });
});

test('asked as before, the window shows the form and its yes counts at once', async () => {
    const answer = approve(form('message', 'https://d.app'));
    await tick();
    const w = page();
    assert.deepEqual(w.heard, [form('message', 'https://d.app')]);
    w.say({ approve: true });
    assert.deepEqual(await state(answer), { answered: true });
});
