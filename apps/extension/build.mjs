// Bundles the extension into dist/. Load it from chrome://extensions with "Load unpacked". With --watch it builds again
// on every change to the code; then reload the extension there.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import { context } from 'esbuild';

const out = 'dist';
const watch = process.argv.includes('--watch');
const store = process.argv.includes('--store'); // for the Chrome Web Store: see KEY
const BUILD = new Date().toISOString(); // pages and background compare it: see src/build.ts

// Unpacked builds carry this public key, so Chrome gives them one id wherever dist/ is: lnjbhokdddhjacnfbogccinlneabfodn,
// the id otus-server lets through. A store build goes without it: the store gives Otus its own id.
const KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArbC4f2kefR7h3YG/uO86+2D7N9pyaqA3PE8VXNrteRJlcJAoOKRTM1lTsxjnsMhRT0Jl1MMmroAuLJjdLOZ4jwYvRCfS2PqLJgvpVXtX3/JGZIfeHs6lLjLfoR6+43Gd+HTIwTwmyezRX94IJbcnKimZechhJg27xT0ni6J0JrXCeyflUY9ZQGTjquz94b+VlvIvUl6hriGjZ/C0PhNnFx7a9kAnU37IpHLCoUC7BYlVoz9pb61r9vj0LYkzm/FUIM7Gt7F3vX1Hmul3N5954r3ehxigFT8UEk6/043M8N9oBBkkJmxAroGeDRf9g1LE3+VuSXlOlqf1Y5TTUhdcpQIDAQAB';

// The files esbuild does not bundle, copied after every build that worked.
function copy() {
    const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
    writeFileSync(`${out}/manifest.json`, `${JSON.stringify(store ? manifest : { ...manifest, key: KEY }, null, 4)}\n`);
    for (const page of ['approve.html', 'home.html', 'welcome.html']) cpSync(`src/ui/${page}`, `${out}/${page}`);
    cpSync('assets/icons', `${out}/icons`, { recursive: true });
    for (const font of ['Silkscreen.woff2', 'JetBrainsMono.woff2', 'Silkscreen-OFL.txt', 'JetBrainsMono-OFL.txt']) cpSync(`assets/fonts/${font}`, `${out}/fonts/${font}`);
    cpSync('assets/icons/ui/LICENSE-lucide.txt', `${out}/licenses/LICENSE-lucide.txt`);
    cpSync('assets/logos/LICENSE-cryptocurrency-icons.md', `${out}/licenses/LICENSE-cryptocurrency-icons.md`);
    cpSync('assets/licenses', `${out}/licenses`, { recursive: true });
}

// Every package bundled into the extension, with its license, in one file: what their licenses ask of a copy. A package
// sits in whichever node_modules npm put it, this workspace's or the repo's.
function notices(metafile) {
    const packages = new Map(); // name → its folder
    for (const input of Object.keys(metafile.inputs)) {
        const at = input.lastIndexOf('node_modules/');
        if (at < 0) continue;
        const [first, second] = input.slice(at + 'node_modules/'.length).split('/');
        const name = first.startsWith('@') ? `${first}/${second}` : first;
        packages.set(name, `${input.slice(0, at)}node_modules/${name}`);
    }
    const text = [...packages].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, dir]) => {
        const { version, license } = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
        const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
        return `${name} ${version} (${license ?? 'see below'})\n\n${file ? readFileSync(`${dir}/${file}`, 'utf8').trim() : 'No license file in the package; its license is named above.'}`;
    });
    mkdirSync(`${out}/licenses`, { recursive: true });
    writeFileSync(`${out}/licenses/THIRD-PARTY.txt`, `Packages bundled into Otus, and their licenses.\n\n${text.join(`\n\n${'-'.repeat(80)}\n\n`)}\n`);
}

// The pages' styles: Tailwind, from what the pages' code uses.
const TAILWIND = [process.execPath, [`${dirname(createRequire(import.meta.url).resolve('@tailwindcss/cli/package.json'))}/dist/index.mjs`, '-i', 'src/ui/app.css', '-o', `${out}/app.css`]];

rmSync(out, { recursive: true, force: true });
const build = await context({
    entryPoints: {
        page: 'src/shell/page.ts',
        content: 'src/shell/content.ts',
        background: 'src/shell/background.ts',
        approve: 'src/ui/review/main.tsx',
        home: 'src/ui/popup/main.tsx',
        welcome: 'src/ui/setup/main.tsx',
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
    plugins: [{ name: 'copy', setup: (b) => b.onEnd((r) => void (r.errors.length === 0 && (copy(), notices(r.metafile)))) }],
});
if (watch) {
    await build.watch();
    spawn(TAILWIND[0], [...TAILWIND[1], '--watch'], { stdio: 'inherit' });
} else {
    await build.rebuild().finally(() => build.dispose());
    execFileSync(TAILWIND[0], [...TAILWIND[1], '--minify'], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (!existsSync(`${out}/app.css`)) throw new Error('Tailwind wrote no app.css');
}
