/**
 * Remove source maps from `dist/` before packaging.
 *
 * Two reasons, both about the Chrome Web Store submission: the maps are ~450 KB
 * of the upload, and they contain the full original TypeScript source. Reviewers
 * also flag a `sourceMappingURL` that points at a file not present in the
 * package, so the comment is stripped as well as the file.
 *
 * `npm run build` still emits maps; only `npm run zip` removes them.
 */
import { readdirSync, statSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const dist = resolve(import.meta.dirname, '..', 'dist');

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path);
    } else if (path.endsWith('.map')) {
      unlinkSync(path);
      removed++;
    } else if (path.endsWith('.js') || path.endsWith('.css')) {
      const before = readFileSync(path, 'utf8');
      const after = before.replace(/\n?\/[/*]# sourceMappingURL=.*?(\*\/)?\s*$/, '\n');
      if (after !== before) {
        writeFileSync(path, after);
        cleaned++;
      }
    }
  }
}

let removed = 0;
let cleaned = 0;
walk(dist);
console.log(`Stripped ${removed} source map(s); cleaned ${cleaned} sourceMappingURL comment(s).`);
