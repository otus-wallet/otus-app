// Zips dist-store/ into otus.zip the same way on any machine: files in one order, one date, one mode, no directory
// entries and no extra attributes, so that the same commit gives the same bytes with the same zip. verify.mjs compares
// what is inside, whatever made the zip.
import { execFileSync } from 'node:child_process';
import { chmodSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('.', import.meta.url)));
const DATE = new Date('2026-01-01T00:00:00Z'); // zip keeps local time: TZ is UTC below
const files = readdirSync('dist-store', { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => relative('dist-store', join(f.parentPath, f.name)))
    .sort();
for (const f of files) {
    chmodSync(`dist-store/${f}`, 0o644);
    utimesSync(`dist-store/${f}`, DATE, DATE);
}
rmSync('otus.zip', { force: true });
execFileSync('zip', ['-q', '-X', '-D', '-9', '../otus.zip', '-@'], { cwd: 'dist-store', input: files.join('\n'), env: { ...process.env, TZ: 'UTC' } });
console.log(`otus.zip: ${files.length} files`);
