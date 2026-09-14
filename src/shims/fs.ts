/**
 * A deliberately empty stand-in for `node:fs`.
 *
 * Lightning Flow Scanner's entry point imports its `parse()` helper, which
 * reads `.flow-meta.xml` files from disk for the CLI. OrgTriage never calls it —
 * flow metadata arrives from the Tooling API as JSON and goes straight into
 * `new Flow(virtualPath, metadata)` — but the import is eager, so the bundler
 * needs something to resolve.
 *
 * Every function throws rather than returning an empty result. An extension
 * that has started reading the filesystem is either broken or doing something
 * it should not; the one thing that must not happen is for it to look like it
 * worked. If this ever fires, the fix is to stop calling `parse()`, not to
 * make the shim do more.
 */

function unavailable(name: string): never {
  throw new Error(
    `fs.${name} is not available: OrgTriage runs in a service worker and reads flow metadata from ` +
      'the Tooling API, never from disk.',
  );
}

export const promises = {
  readFile: () => unavailable('promises.readFile'),
  writeFile: () => unavailable('promises.writeFile'),
  readdir: () => unavailable('promises.readdir'),
  stat: () => unavailable('promises.stat'),
};

export function readFileSync(): never {
  return unavailable('readFileSync');
}

export function existsSync(): boolean {
  // The only honest answer: this extension has no filesystem to look in.
  return false;
}

export default { promises, readFileSync, existsSync };
