/**
 * The three `node:path` functions Lightning Flow Scanner reaches for, and
 * nothing else.
 *
 * LFS is built to run in a CLI, so `Flow`'s constructor derives a display name
 * from a file path. OrgTriage never has a file: it passes `<ApiName>.flow-meta.xml`
 * as a virtual path purely so the scanner reports findings against the flow's
 * API name. That means these functions only ever see a bare filename, and the
 * full `path` semantics — separators, `..` segments, absolute resolution,
 * Windows drive letters — are never exercised.
 *
 * A polyfill package would bring all of it into the service worker bundle to
 * support code paths that cannot be reached. This is the whole surface, with
 * POSIX separators, because the input is a string we construct ourselves.
 *
 * `resolve` is the one place to be careful: LFS calls it only when `process` is
 * defined, which in a service worker it is not, so in the extension it never
 * runs at all. Under Node — the test bundle — it does, and returning the input
 * unchanged is correct for our use because the result lands in `Flow.fsPath`,
 * which no rule reads.
 */

/** Trailing extension including the dot, or '' when there is none. */
export function extname(p: string): string {
  const base = basename(p);
  const dot = base.lastIndexOf('.');
  // A leading dot is part of the name ('.gitignore'), not an extension.
  return dot > 0 ? base.slice(dot) : '';
}

/** Final path segment, with `ext` removed when the segment ends in it. */
export function basename(p: string, ext?: string): string {
  const segments = String(p).split(/[\\/]/);
  const base = segments[segments.length - 1] ?? '';
  if (ext && base !== ext && base.endsWith(ext)) return base.slice(0, -ext.length);
  return base;
}

/** Identity: see the note above on why nothing more is needed. */
export function resolve(...parts: string[]): string {
  return parts.filter(Boolean).join('/');
}

export const sep = '/';

export default { basename, extname, resolve, sep };
