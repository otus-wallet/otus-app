import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Approval, Life } from '@otus-wallet/core/view.ts';

// Chrome's windows and ports, played here: the windows opened and removed, and the ports that connect back.
const created: { id: number; url: string }[] = [];
const asked: string[] = []; // the address of each window asked for, before Chrome opens it
const removed: number[] = [];
let connected: (port: unknown) => void = () => {};
let closed: (window: number) => void = () => {};
let refusing = false; // Chrome refuses to open a window
let opening: Promise<void> = Promise.resolve(); // what a window waits for to open
const chrome = {
    runtime: {
        id: 'otus',
        getURL: (page: string) => `chrome-extension://otus/${page}`,
        onConnect: { addListener: (f: typeof connected) => (connected = f) },
    },
    windows: {
        getLastFocused: async () => ({ left: 0, top: 0, width: 1200 }),
        create: async ({ url }: { url: string }) => {
            asked.push(url);
            await opening;
            if (refusing) throw new Error('Chrome would not open it');
            created.push({ id: 100 + created.length, url });
            return { id: 100 + created.length - 1, tabs: [{ id: 1_000 + created.length - 1 }] };
        },
        remove: async (id: number) => void removed.push(id),
        onRemoved: { addListener: (f: typeof closed) => (closed = f) },
    },
    storage: { local: { get: async () => ({}) }, session: { get: async () => ({}) } }, // no vault: nothing to unlock
};
Object.assign(globalThis, { chrome });
const { answerOf, approve, early } = await import('../src/shell/approvals.ts');

const tick = () => new Promise((r) => setTimeout(r, 5));
const form = (kind: string, origin = 'https://jup.ag') => ({ kind, site: { origin, host: new URL(origin).host, note: '', tone: 'plain' }, account: { label: 'Me', address: 'x' } }) as unknown as Approval;

// The window's page connecting back, from Otus's own page in that window (or `from` another): what it hears, whether it
// was cut off, and how it answers.
function page(window = created.at(-1)!, from = window.id, tab?: number) {
    const heard: unknown[] = [];
    let said: (m: object) => void = () => {};
    let gone: () => void = () => {};
    let cut = false;
    const id = window.url.split('#')[1];
    connected({
        name: `approve:${id}`,
        sender: { id: 'otus', url: window.url, tab: { windowId: from, id: tab ?? window.id + 900 } },
        postMessage: (m: unknown) => heard.push(m),
        onMessage: { addListener: (f: typeof said) => (said = f) },
        onDisconnect: { addListener: (f: typeof gone) => (gone = f) },
        disconnect: () => void (cut = true),
    });
    return { heard, say: (m: object) => said(m), leave: () => gone(), cut: () => cut };
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

test('a window that does not open is the error, for its approve and as its no', async () => {
    refusing = true;
    const window = early(form('pending', 'https://e.app'));
    await assert.rejects(window.no, /would not open/);
    await assert.rejects(window.approve(form('transaction', 'https://e.app'), undefined, new Promise(() => {})), /would not open/);
    await assert.rejects(approve(form('message', 'https://e.app')), /would not open/);
    refusing = false;
});

test('a yes with someone to tell keeps the window, and tells it how it goes; a no closes it, telling no one', async () => {
    const heard: unknown[] = [];
    const answer = approve(form('message', 'https://f.app'), undefined, undefined, (tell) => tell({ phase: 'sending' } as never));
    await tick();
    const w = page();
    const before = removed.length;
    w.say({ approve: true });
    assert.deepEqual(await state(answer), { answered: true });
    await tick();
    assert.equal(removed.length, before); // kept
    assert.deepEqual(w.heard.at(-1), { outcome: { phase: 'sending' } });
    let told = false;
    const no = approve(form('message', 'https://g.app'), undefined, undefined, () => void (told = true));
    await tick();
    page().say({ approve: false });
    assert.deepEqual(await state(no), { answered: false });
    await tick();
    assert.deepEqual([removed.at(-1), told, heard.length], [created.at(-1)!.id, false, 0]);
});

test('closed before Chrome opens it, the window goes once it does', async () => {
    let open: () => void = () => {};
    opening = new Promise((r) => (open = r));
    const window = early(form('pending', 'https://h.app'));
    window.close();
    const count = created.length;
    open();
    opening = Promise.resolve();
    await tick();
    assert.equal(created.length, count + 1);
    assert.equal(removed.at(-1), created.at(-1)!.id);
});

test('while pending, a yes is nothing, nor kept for later, and a connect’s is a no; the site’s other requests wait', async () => {
    const window = early(form('pending', 'https://i.app'));
    assert.throws(() => early(form('message', 'https://i.app')), /already asking you/);
    await assert.rejects(approve(form('message', 'https://i.app')), /already asking you/);
    await tick();
    page().say({ approve: true, account: 'HH2vCgeHY4PNpYfACYSAAr11P1chxbMsSYbY7VzAHVx2' }); // a connect's yes: a no for anything else
    assert.deepEqual(await state(window.no), { answered: undefined });
    await tick();
    assert.equal(removed.at(-1), created.at(-1)!.id);
    const again = early(form('pending', 'https://j.app'));
    await tick();
    const v = page();
    v.say({ approve: true });
    v.say({ approve: true, signature: `${'A'.repeat(86)}==` }); // 64 bytes: a Ledger's yes
    let final: (a: Approval) => void = () => {};
    const answer = again.approve(form('transaction', 'https://j.app'), undefined, new Promise((r) => (final = r)));
    final(form('transaction', 'https://j.app'));
    await tick();
    assert.equal(await state(answer), 'waiting'); // the yes said while pending counts for nothing now
    v.say({ approve: true });
    assert.deepEqual(await state(answer), { answered: true });
});

test('a window answers one request: a second approve on it is refused', async () => {
    const window = early(form('pending', 'https://k.app'));
    void window.approve(form('transaction', 'https://k.app'), undefined, new Promise(() => {}));
    await assert.rejects(window.approve(form('transaction', 'https://k.app'), undefined, Promise.resolve(form('transaction', 'https://k.app'))), /one request/);
    window.close();
    await tick();
});

test('closed saying why, the window says it and stays until the user closes it; the site waits until then', async () => {
    const window = early(form('pending', 'https://l.app'));
    await tick();
    const w = page();
    const count = removed.length;
    window.close('this transaction is not for mainnet');
    assert.deepEqual(w.heard.at(-1), { ...form('pending', 'https://l.app'), refused: 'this transaction is not for mainnet' });
    await tick();
    assert.equal(removed.length, count);
    assert.throws(() => early(form('pending', 'https://l.app')), /already asking you/);
    w.say({ approve: true }); // nothing to approve: still there
    await tick();
    assert.equal(removed.length, count);
    w.say({ approve: false });
    await tick();
    assert.equal(removed.at(-1), created.at(-1)!.id);
    early(form('pending', 'https://l.app')).close();
    await tick();
});

test('the no a request hears at once is only one said before the window is given what to answer', async () => {
    const before = early(form('pending', 'https://m.app'));
    await tick();
    page().say({ approve: false });
    assert.deepEqual(await state(before.no), { answered: undefined });
    const after = early(form('pending', 'https://n.app'));
    await tick();
    const w = page();
    const answer = after.approve(form('transaction', 'https://n.app'), undefined, Promise.reject(new Error('prepare failed')));
    assert.deepEqual(await state(answer), { answered: false });
    w.say({ approve: false });
    assert.equal(await state(after.no), 'waiting'); // the review's own failure: the request hears that, not a no
});

test('the window answers only from the window Otus opened for it, and only once', async () => {
    const answer = approve(form('connect', 'https://one.example'));
    await tick();
    const window = created.at(-1)!;
    // Its address read by another extension and opened in a window of its own: cut off, told nothing.
    const copy = page(window, 999);
    await tick();
    assert.deepEqual([copy.cut(), copy.heard], [true, []]);
    copy.say({ approve: true });
    assert.equal(await state(answer), 'waiting');
    // Another tab put in that very window: cut off.
    const slipped = page(window, window.id, 4_242);
    await tick();
    assert.equal(slipped.cut(), true);
    // Its own page is heard; a second one, even from that window, is cut off.
    const own = page(window);
    const again = page(window);
    await tick();
    assert.deepEqual([own.cut(), own.heard.length, again.cut()], [false, 1, true]);
    own.say({ approve: true });
    assert.deepEqual(await state(answer), { answered: true });
});

test('a page that connects before its window is known waits for it, then is taken or cut off', async () => {
    let open: () => void = () => {};
    opening = new Promise((r) => (open = r));
    const answer = approve(form('connect', 'https://two.example'));
    await tick();
    const window = { id: 100 + created.length, url: asked.at(-1)! }; // the window Chrome is about to give it
    const own = page(window);
    const other = page(window, 998);
    await tick();
    assert.deepEqual([own.heard, own.cut(), other.cut()], [[], false, false]); // both wait
    open();
    await tick();
    opening = Promise.resolve();
    assert.deepEqual([own.heard.length, own.cut(), other.cut()], [1, false, true]);
    own.say({ approve: true });
    assert.deepEqual(await state(answer), { answered: true });
});

test('a window’s yes: with one signature for one transaction, with one for each of several, in order; anything else is no', () => {
    const sig = (b: number) => Buffer.from(new Uint8Array(64).fill(b)).toString('base64');
    assert.equal(answerOf({ approve: true }, 'batch'), true);
    assert.equal((answerOf({ approve: true, signature: sig(1) }, 'transaction') as Uint8Array).length, 64);
    const two = answerOf({ approve: true, signatures: [sig(1), sig(2)] }, 'batch') as Uint8Array[];
    assert.deepEqual(two.map((s) => s[0]), [1, 2]);
    // One signature for several, several for one, too many, a bad one among them, both ways at once: no.
    assert.equal(answerOf({ approve: true, signature: sig(1) }, 'batch'), false);
    assert.equal(answerOf({ approve: true, signatures: [sig(1)] }, 'transaction'), false);
    assert.equal(answerOf({ approve: true, signatures: Array.from({ length: 11 }, () => sig(1)) }, 'batch'), false);
    assert.equal(answerOf({ approve: true, signatures: [sig(1), 'short'] }, 'batch'), false);
    assert.equal(answerOf({ approve: true, signatures: [] }, 'batch'), false);
    assert.equal(answerOf({ approve: true, signatures: 'x' }, 'batch'), false);
    assert.equal(answerOf({ approve: true, signature: sig(1), signatures: [sig(1)] }, 'batch'), false);
    assert.equal(answerOf({ approve: true, account: 'x', signatures: [sig(1)] }, 'connect'), false);
    assert.equal(answerOf({ approve: false, signatures: [sig(1)] }, 'batch'), false);
});
