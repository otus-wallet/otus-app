// Builds this commit for the store and compares it, file by file, with an Otus from elsewhere: a release's otus.zip,
// the store's .crx, or the folder Chrome installed it in. Usage: npm run verify -- <zip, crx or folder>.
// Left out of the comparison is only what the store adds: its signature of the files (_metadata/), and the manifest's
// "key" and "update_url". Everything else must be the same, byte for byte.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.argv[2] && resolve(process.env.INIT_CWD ?? process.cwd(), process.argv[2]); // npm runs scripts from the package's folder
if (!target || !existsSync(target)) {
    console.error('Usage: npm run verify -- <otus.zip, the store\'s .crx, or the installed extension\'s folder>');
    process.exit(2);
}
process.chdir(fileURLToPath(new URL('.', import.meta.url)));

const files = (dir) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((f) => f.isFile())
        .map((f) => relative(dir, join(f.parentPath, f.name)))
        .filter((f) => !f.startsWith('_metadata/'))
        .sort();
const git = (dir) => {
    try {
        const head = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
        const dirty = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim() !== '';
        return `${head}${dirty ? ' with changes not committed' : ''}`;
    } catch {
        return 'not a git checkout';
    }
};

try {
    execFileSync('node', ['build.mjs', '--store'], { stdio: 'pipe' });
} catch (e) {
    console.error(String(e.stderr));
    process.exit(2);
}
console.log(`built otus-app ${git('.')}`);

let dir = target;
let temp = null;
if (!statSync(target).isDirectory()) {
    // unzip reads a .crx too: its header comes before the zip, and unzip says so with status 1.
    temp = mkdtempSync(join(tmpdir(), 'otus-verify-'));
    try {
        execFileSync('unzip', ['-qq', '-o', target, '-d', temp], { stdio: 'ignore' });
    } catch (e) {
        if (e.status !== 1) throw e;
    }
    dir = temp;
}

// The manifest as written, less what the store adds to it.
const manifest = (path) => {
    const { key, update_url, ...rest } = JSON.parse(readFileSync(path, 'utf8'));
    return JSON.stringify(rest);
};
const built = files('dist-store');
const theirs = new Set(files(dir));
const missing = built.filter((f) => !theirs.has(f));
const extra = [...theirs].filter((f) => !built.includes(f));
const differ = built.filter((f) => theirs.has(f) && (f === 'manifest.json' ? manifest(`dist-store/${f}`) !== manifest(join(dir, f)) : !readFileSync(`dist-store/${f}`).equals(readFileSync(join(dir, f)))));
if (temp) rmSync(temp, { recursive: true, force: true });

for (const [what, list] of [['missing there', missing], ['only there', extra], ['different', differ]]) for (const f of list) console.log(`${what}: ${f}`);
if (missing.length + extra.length + differ.length > 0) {
    console.log(`NOT THE SAME: ${missing.length + extra.length + differ.length} of ${built.length} files`);
    process.exit(1);
}
console.log(`THE SAME: all ${built.length} files match this commit's build`);
