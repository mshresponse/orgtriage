/**
 * Hybrid metadata cache — local persistence with manual refresh.
 *
 * "Hybrid" means the cache never refetches on its own. A read returns whatever
 * snapshot exists, together with an honest verdict about whether the org has
 * moved on since. Refreshing is always the user's explicit act, because every
 * refresh spends the org's daily API allowance and admins are entitled to know
 * when that happens.
 *
 * Staleness is decided by two independent signals:
 *   1. Age — a snapshot older than {@link MAX_FRESH_MS} is stale by fiat.
 *   2. Watermark — a cheap probe (a handful of `SELECT MAX(LastModifiedDate)`
 *      style queries plus a component count) taken at scan time and compared on
 *      read. If the org's watermark has advanced, the snapshot is stale
 *      regardless of age.
 *
 * The store holds analysis output only: component names, counts, dates, and
 * rule verdicts. It never holds record data, and never holds credentials.
 */

import type {
  AnalyzerId,
  CacheEntryMeta,
  OrgWatermark,
  ScanResult,
  StalenessVerdict,
} from '@/shared/types';
import { digestOf, type SnapshotDigest } from '@/shared/diff';

const DB_NAME = 'orgtriage';
const DB_VERSION = 1;
const STORE = 'scans';

/** A snapshot older than this is reported stale even if nothing changed. */
export const MAX_FRESH_MS = 24 * 60 * 60 * 1000;

interface StoredEntry {
  orgId: string;
  analyzer: AnalyzerId;
  completedAt: number;
  apiVersion: string;
  bytes: number;
  watermark?: OrgWatermark;
  result: ScanResult;
  /**
   * A digest of the snapshot this one replaced, so the panel can say what
   * changed. Only one generation is kept, and only the digest rather than the
   * whole `ScanResult` — see `src/shared/diff.ts`. Absent on the first scan of
   * an area and on entries written by an older build.
   */
  previous?: SnapshotDigest;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: ['orgId', 'analyzer'] });
        store.createIndex('byOrg', 'orgId', { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // A version change from another tab must not leave us holding a blocked
      // connection; drop the memoised promise so the next call reopens.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = fn(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.onabort = () => reject(transaction.error);
      }),
  );
}

/** Rough byte size of the serialized entry, for the storage readout. */
function sizeOf(value: unknown): number {
  try {
    return new Blob([JSON.stringify(value)]).size;
  } catch {
    return 0;
  }
}

export async function put(
  result: ScanResult,
  watermark: OrgWatermark | undefined,
  /** Checked after the read and immediately before the write; false aborts with nothing written. */
  stillWanted: () => boolean = () => true,
): Promise<CacheEntryMeta> {
  // Read before write so the snapshot being replaced can be kept as a digest.
  // A failure here must not lose the scan: the diff is a convenience, the
  // result is the thing the user paid API calls for.
  let previous: SnapshotDigest | undefined;
  try {
    const existing = (await tx<StoredEntry | undefined>('readonly', (store) =>
      store.get([result.orgId, result.analyzer]) as IDBRequest<StoredEntry | undefined>,
    )) as StoredEntry | undefined;
    if (existing) previous = digestOf(existing.result);
  } catch {
    /* no previous snapshot to compare against */
  }

  const entry: StoredEntry = {
    orgId: result.orgId,
    analyzer: result.analyzer,
    completedAt: result.completedAt,
    apiVersion: result.apiVersion,
    bytes: sizeOf(result),
    watermark,
    result,
    previous,
  };
  if (!stillWanted()) throw new DOMException('Scan cancelled', 'AbortError');
  await tx('readwrite', (store) => store.put(entry));
  return toMeta(entry);
}

export async function get(
  orgId: string,
  analyzer: AnalyzerId,
): Promise<{ result: ScanResult; meta: CacheEntryMeta; previous?: SnapshotDigest } | null> {
  const entry = (await tx<StoredEntry | undefined>('readonly', (store) =>
    store.get([orgId, analyzer]) as IDBRequest<StoredEntry | undefined>,
  )) as StoredEntry | undefined;
  if (!entry) return null;
  return { result: entry.result, meta: toMeta(entry), previous: entry.previous };
}

export async function listMeta(orgId?: string): Promise<CacheEntryMeta[]> {
  const all = (await tx<StoredEntry[]>('readonly', (store) =>
    store.getAll() as IDBRequest<StoredEntry[]>,
  )) as StoredEntry[];
  return all.filter((e) => !orgId || e.orgId === orgId).map(toMeta);
}

export async function clear(orgId: string, analyzer?: AnalyzerId): Promise<number> {
  const entries = await listMeta(orgId);
  const targets = analyzer ? entries.filter((e) => e.analyzer === analyzer) : entries;
  if (targets.length === 0) return 0;

  // One transaction for the whole set. A transaction per entry was five round
  // trips through IndexedDB for a five-area org, each waiting on the last.
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    for (const entry of targets) store.delete([entry.orgId, entry.analyzer]);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  return targets.length;
}

/**
 * Compare a cached snapshot against a freshly probed watermark.
 *
 * A missing or unreadable probe yields `fresh` when the entry is young: an
 * admin without SetupAuditTrail access should not be told their cache is stale
 * on every read simply because we could not check.
 */
export function judge(
  meta: CacheEntryMeta | null,
  probe: OrgWatermark | null,
  now: number,
): StalenessVerdict {
  if (!meta) return { state: 'absent' };

  const age = now - meta.completedAt;
  if (age > MAX_FRESH_MS) {
    return {
      state: 'stale',
      cachedAt: meta.completedAt,
      reason: `Snapshot is ${formatAge(age)} old.`,
    };
  }

  const previous = meta.watermark;
  if (probe && previous) {
    if (
      previous.lastMetadataChangeAt &&
      probe.lastMetadataChangeAt &&
      probe.lastMetadataChangeAt > previous.lastMetadataChangeAt
    ) {
      return {
        state: 'stale',
        cachedAt: meta.completedAt,
        reason: `Metadata changed in the org at ${probe.lastMetadataChangeAt}.`,
      };
    }
    if (
      previous.lastSetupChangeAt &&
      probe.lastSetupChangeAt &&
      probe.lastSetupChangeAt > previous.lastSetupChangeAt
    ) {
      return {
        state: 'stale',
        cachedAt: meta.completedAt,
        reason: 'Setup changes were recorded after this snapshot.',
      };
    }
    if (
      typeof previous.componentCount === 'number' &&
      typeof probe.componentCount === 'number' &&
      probe.componentCount !== previous.componentCount
    ) {
      const delta = probe.componentCount - previous.componentCount;
      return {
        state: 'stale',
        cachedAt: meta.completedAt,
        reason: `Component count changed by ${delta > 0 ? '+' : ''}${delta}.`,
      };
    }
  }

  return { state: 'fresh', cachedAt: meta.completedAt };
}

export async function estimateUsage(): Promise<{ used: number; quota: number | null }> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return { used: estimate?.usage ?? 0, quota: estimate?.quota ?? null };
  } catch {
    return { used: 0, quota: null };
  }
}

function toMeta(entry: StoredEntry): CacheEntryMeta {
  return {
    analyzer: entry.analyzer,
    orgId: entry.orgId,
    completedAt: entry.completedAt,
    apiVersion: entry.apiVersion,
    bytes: entry.bytes,
    watermark: entry.watermark,
  };
}

export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'moments';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
