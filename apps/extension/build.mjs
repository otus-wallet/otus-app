// Bundles the extension into dist/. Load it from chrome://extensions with "Load unpacked". With --watch it builds again
// on every change to the code; then reload the extension there. With --store, into dist-store/, for the Chrome Web Store.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { context } from 'esbuild';

process.chdir(fileURLToPath(new URL('.', import.meta.url))); // the paths below are this folder's, wherever it runs from
const watch = process.argv.includes('--watch');
const store = process.argv.includes('--store'); // for the Chrome Web Store: see KEY
const out = store ? 'dist-store' : 'dist'; // apart, so that packaging never takes the unpacked build's key away
// Pages and background compare it: see packages/core/src/build.ts. A store build takes its version, so that the same
// commit always builds the same bytes; every store upload has a version of its own.
const BUILD = store ? JSON.parse(readFileSync('manifest.json', 'utf8')).version : new Date().toISOString();

// Unpacked builds carry this public key, so Chrome gives them one id wherever dist/ is: lnjbhokdddhjacnfbogccinlneabfodn,
// the id otus-server lets through. A store build goes without it: the store gives Otus its own id.
const KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArbC4f2kefR7h3YG/uO86+2D7N9pyaqA3PE8VXNrteRJlcJAoOKRTM1lTsxjnsMhRT0Jl1MMmroAuLJjdLOZ4jwYvRCfS2PqLJgvpVXtX3/JGZIfeHs6lLjLfoR6+43Gd+HTIwTwmyezRX94IJbcnKimZechhJg27xT0ni6J0JrXCeyflUY9ZQGTjquz94b+VlvIvUl6hriGjZ/C0PhNnFx7a9kAnU37IpHLCoUC7BYlVoz9pb61r9vj0LYkzm/FUIM7Gt7F3vX1Hmul3N5954r3ehxigFT8UEk6/043M8N9oBBkkJmxAroGeDRf9g1LE3+VuSXlOlqf1Y5TTUhdcpQIDAQAB';

const UI = '../../packages/ui'; // the screens: their styles, fonts and icons, which the build takes from there

// The files esbuild does not bundle, copied after every build that worked.
function copy() {
    const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
    if ('key' in manifest) throw new Error('manifest.json has a key: only unpacked builds get one, from KEY');
    writeFileSync(`${out}/manifest.json`, `${JSON.stringify(store ? manifest : { ...manifest, key: KEY }, null, 4)}\n`);
    for (const page of ['approve.html', 'home.html', 'welcome.html']) cpSync(`src/pages/${page}`, `${out}/${page}`);
    cpSync('assets/icons', `${out}/icons`, { recursive: true });
    for (const font of ['Silkscreen.woff2', 'JetBrainsMono.woff2', 'Silkscreen-OFL.txt', 'JetBrainsMono-OFL.txt']) cpSync(`${UI}/assets/fonts/${font}`, `${out}/fonts/${font}`);
    cpSync(`${UI}/assets/icons/LICENSE-lucide.txt`, `${out}/licenses/LICENSE-lucide.txt`);
    cpSync(`${UI}/assets/logos/LICENSE-cryptocurrency-icons.md`, `${out}/licenses/LICENSE-cryptocurrency-icons.md`);
    cpSync('assets/licenses', `${out}/licenses`, { recursive: true });
}

// Every package bundled into the extension, with its license, in one file: what their licenses ask of a copy. A package
// sits in whichever node_modules npm put it, this workspace's or the repo's.
function notices(metafile) {
    const packages = new Map(); // folder → its package's name: two versions of one are two folders
    for (const input of Object.keys(metafile.inputs)) {
        const at = input.lastIndexOf('node_modules/');
        if (at < 0) {
            if (!/^(src|assets)\/|^\.\.\/\.\.\/packages\//.test(input)) throw new Error(`Bundled from outside this repo's code and node_modules: ${input}`);
            continue;
        }
        const [first, second] = input.slice(at + 'node_modules/'.length).split('/');
        const name = first.startsWith('@') ? `${first}/${second}` : first;
        packages.set(`${input.slice(0, at)}node_modules/${name}`, name);
    }
    const text = [...packages].sort(([, a], [, b]) => (a < b ? -1 : 1)).map(([dir, name]) => {
        const { version, license } = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
        const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
        return `${name} ${version} (${license ?? 'see below'})\n\n${file ? readFileSync(`${dir}/${file}`, 'utf8').trim() : 'No license file in the package; its license is named above.'}`;
    });
    mkdirSync(`${out}/licenses`, { recursive: true });
    writeFileSync(`${out}/licenses/THIRD-PARTY.txt`, `Packages bundled into Otus, and their licenses.\n\n${text.join(`\n\n${'-'.repeat(80)}\n\n`)}\n`);
}

// Every bundle that uses the platform sets it, with Chrome's: a page would break at its first call otherwise.
function platformSet(metafile) {
    for (const [file, { inputs }] of Object.entries(metafile.outputs)) {
        if ('../../packages/core/src/platform.ts' in inputs && !('src/shell/chrome.ts' in inputs)) throw new Error(`${file} uses the platform but does not set it`);
    }
}

// The pages' styles: Tailwind, from what the pages' code uses. Its CLI is the one locked here, never one found further up.
const CLI = createRequire(import.meta.url).resolve('@tailwindcss/cli/package.json');
if (!['node_modules/', '../../node_modules/'].some((d) => CLI.startsWith(fileURLToPath(new URL(d, import.meta.url))))) throw new Error(`Tailwind's CLI is not this repo's: ${CLI}`);
const TAILWIND = [process.execPath, [`${dirname(CLI)}/dist/index.mjs`, '-i', `${UI}/src/app.css`, '-o', `${out}/app.css`]];

rmSync(out, { recursive: true, force: true });
const build = await context({
    entryPoints: {
        page: '../../packages/provider/src/page.ts',
        content: 'src/shell/content.ts',
        background: 'src/shell/background.ts',
        approve: 'src/pages/approve.ts',
        home: 'src/pages/home.ts',
        welcome: 'src/pages/welcome.ts',
    },
    outdir: out,
    bundle: true,
    format: 'iife',
    target: 'chrome140',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'), __BUILD__: JSON.stringify(BUILD) },
    minifySyntax: !watch,
    loader: { '.woff2': 'file', '.svg': 'text' },
    assetNames: 'fonts/[name]',
    legalComments: 'none',
    metafile: true,
    logLevel: watch ? 'info' : 'warning',
    plugins: [{ name: 'copy', setup: (b) => b.onEnd((r) => void (r.errors.length === 0 && (platformSet(r.metafile), copy(), notices(r.metafile)))) }],
});
if (watch) {
    await build.watch();
    spawn(TAILWIND[0], [...TAILWIND[1], '--watch'], { stdio: 'inherit' });
} else {
    await build.rebuild().finally(() => build.dispose());
    execFileSync(TAILWIND[0], [...TAILWIND[1], '--minify'], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (!existsSync(`${out}/app.css`)) throw new Error('Tailwind wrote no app.css');
    if ('key' in JSON.parse(readFileSync(`${out}/manifest.json`, 'utf8')) === store) throw new Error(store ? 'The store build has a key' : 'The unpacked build has no key');
}
