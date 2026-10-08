// Bundles the extension into dist/. Load it from chrome://extensions with "Load unpacked". With --watch it builds again
// on every change to the code; then reload the extension there.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

import { context } from 'esbuild';

const out = 'dist';
const watch = process.argv.includes('--watch');
const BUILD = new Date().toISOString(); // pages and background compare it: see src/build.ts

// The files esbuild does not bundle, copied after every build that worked.
function copy() {
    cpSync('manifest.json', `${out}/manifest.json`);
    for (const page of ['approve.html', 'home.html', 'welcome.html']) cpSync(`src/ui/${page}`, `${out}/${page}`);
    cpSync('assets/icons', `${out}/icons`, { recursive: true });
    for (const font of ['Silkscreen.woff2', 'JetBrainsMono.woff2', 'Silkscreen-OFL.txt', 'JetBrainsMono-OFL.txt']) cpSync(`assets/fonts/${font}`, `${out}/fonts/${font}`);
    cpSync('assets/icons/ui/LICENSE-lucide.txt', `${out}/licenses/LICENSE-lucide.txt`);
    cpSync('assets/logos/LICENSE-cryptocurrency-icons.md', `${out}/licenses/LICENSE-cryptocurrency-icons.md`);
    cpSync('assets/licenses', `${out}/licenses`, { recursive: true });
}

// Every package bundled into the extension, with its license, in one file: what their licenses ask of a copy.
function notices(metafile) {
    const packages = new Set();
    for (const input of Object.keys(metafile.inputs)) {
        const at = input.lastIndexOf('node_modules/');
        if (at < 0) continue;
        const [first, second] = input.slice(at + 'node_modules/'.length).split('/');
        packages.add(first.startsWith('@') ? `${first}/${second}` : first);
    }
    const text = [...packages].sort().map((name) => {
        const dir = `node_modules/${name}`;
        const { version, license } = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
        const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
        return `${name} ${version} (${license ?? 'see below'})\n\n${file ? readFileSync(`${dir}/${file}`, 'utf8').trim() : 'No license file in the package; its license is named above.'}`;
    });
    mkdirSync(`${out}/licenses`, { recursive: true });
    writeFileSync(`${out}/licenses/THIRD-PARTY.txt`, `Packages bundled into Otus, and their licenses.\n\n${text.join(`\n\n${'-'.repeat(80)}\n\n`)}\n`);
}

// The pages' styles: Tailwind, from what the pages' code uses.
const TAILWIND = ['node_modules/.bin/tailwindcss', ['-i', 'src/ui/app.css', '-o', `${out}/app.css`]];

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
