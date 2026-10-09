import assert from 'node:assert/strict';
import { test } from 'node:test';

// Chrome's extension APIs, recording each call: the platform in Chrome must pass every call through as it is.
const calls: unknown[][] = [];
const record =
    (name: string, value?: unknown) =>
    (...args: unknown[]) => (calls.push([name, ...args]), value);
const area = (name: string) => ({ get: record(`${name}.get`, Promise.resolve({})), set: record(`${name}.set`, Promise.resolve()), remove: record(`${name}.remove`, Promise.resolve()) });
let contexts: { tabId: number; windowId: number }[] = [];
let current: { id?: number } | undefined;
const chrome = {
    runtime: {
        id: 'otus' as string | undefined,
        sendMessage: record('sendMessage', Promise.resolve('reply')),
        connect: record('connect', 'port'),
        getURL: (page: string) => `chrome-extension://otus/${page}`,
        getManifest: () => ({ version: '1.2.3' }),
        getContexts: (filter: unknown) => (calls.push(['getContexts', filter]), Promise.resolve(contexts)),
        reload: record('reload'),
    },
    storage: { local: area('local'), session: area('session'), onChanged: { addListener: record('added'), removeListener: record('removed') } },
    tabs: {
        create: record('tabs.create', Promise.resolve({ id: 9 })),
        update: record('tabs.update', Promise.resolve()),
        remove: record('tabs.remove', Promise.resolve()),
        getCurrent: (done?: (tab: typeof current) => void) => (done ? done(current) : Promise.resolve(current)),
    },
    windows: { update: record('windows.update', Promise.resolve()) },
};
Object.assign(globalThis, { chrome });

const at = await import('../src/platform.ts');
await import('../src/shell/chrome.ts');
const { platform } = at;
const last = () => calls.at(-1);

test('messages and ports go to the background as they are', async () => {
    assert.equal(await platform.send({ build: true }), 'reply');
    assert.deepEqual(last(), ['sendMessage', { build: true }]);
    assert.equal(platform.connect('approve:7'), 'port');
    assert.deepEqual(last(), ['connect', { name: 'approve:7' }]);
});

test("storage is Chrome's own, read on each use", () => {
    assert.equal(platform.storage, chrome.storage);
    const before = chrome.storage;
    chrome.storage = { ...before, session: area('other') };
    assert.equal(platform.storage.session, chrome.storage.session);
    chrome.storage = before;
});

test('pages, tabs and the runtime', async () => {
    assert.equal(platform.url('home.html#activity'), 'chrome-extension://otus/home.html#activity');
    assert.equal(platform.version(), '1.2.3');
    await platform.openTab('welcome.html#ledger');
    assert.deepEqual(last(), ['tabs.create', { url: 'chrome-extension://otus/welcome.html#ledger' }]);
    current = undefined;
    assert.equal(await platform.inTab(), false);
    current = { id: 4 };
    assert.equal(await platform.inTab(), true);
    platform.closeTab();
    assert.deepEqual(last(), ['tabs.remove', 4]);
    platform.reload();
    assert.deepEqual(last(), ['reload']);
    assert.equal(platform.alive(), true);
    chrome.runtime.id = undefined; // reloaded under the page
    assert.equal(platform.alive(), false);
    chrome.runtime.id = 'otus';
});

test('the setup page: the one open is brought forward, or one opens', async () => {
    contexts = [];
    await platform.showSetup('#add');
    assert.deepEqual(last(), ['tabs.create', { url: 'chrome-extension://otus/welcome.html#add' }]);
    contexts = [{ tabId: 3, windowId: 5 }];
    await platform.showSetup('#add');
    assert.deepEqual(calls.slice(-2), [
        ['tabs.update', 3, { active: true }],
        ['windows.update', 5, { focused: true }],
    ]);
});

test('an extension gone throws at once, as Chrome does', () => {
    const tabs = chrome.tabs;
    Object.assign(chrome, { tabs: undefined });
    assert.throws(() => platform.openTab('welcome.html'), TypeError);
    Object.assign(chrome, { tabs });
});

test('set once, and not changed after', () => {
    assert.throws(() => at.install(platform), /set already/);
    assert.ok(Object.isFrozen(platform));
});
