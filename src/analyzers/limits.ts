/**
 * Limits & storage — the ceilings an org walks into rather than the metadata it
 * accumulates.
 *
 * Nothing here needs a scan in the usual sense: two endpoints answer the whole
 * area. `/limits` reports every governor and allocation with its maximum and
 * what is left, and `/limits/recordCount` reports how many records each object
 * holds. Both are single calls, which makes this the cheapest area in the tool
 * and the one worth running most often.
 *
 * On the storage estimate: Salesforce bills most records at roughly 2 KB, with
 * documented exceptions — Person Accounts 4 KB, Campaigns 8 KB, Campaign
 * Members 1 KB, Articles 4 KB, and Email Messages at their actual size. The
 * per-object figures below apply those rates and are labelled an estimate
 * everywhere they are shown, because the org's own Storage Usage page is the
 * authority and this is a way to find the culprit without going there.
 * Reference: https://help.salesforce.com/s/articleView?id=000318951&type=1
 *
 * The API-consumption rule reads a point in time. A scan at 09:00 says little
 * about a daily allowance, so the finding states when it was taken rather than
 * implying a trend.
 */

import type { FindingItem } from '@/shared/types';
import {
  capped,
  checkCancelled,
  finding,
  inconclusive,
  isFinding,
  percent,
  setupUrl,
  summarise,
  tryQuery,
  type Analyzer,
  type AnalyzerContext,
  type AnalyzerOutput,
  type Phase,
  type RuleOutcome,
  type RuleSpec,
} from './framework';

/** Storage above this share of the allocation is the finding, not a statistic. */
const STORAGE_CRITICAL_PCT = 85;
const STORAGE_WARNING_PCT = 75;
/** Daily API consumption above this share at scan time is worth saying. */
const API_CONSUMED_PCT = 80;
/** A limit with less than this share of its maximum left is near its ceiling. */
const HEADROOM_PCT = 20;
/** Attribution only matters once storage is filling; below this it is trivia. */
const ATTRIBUTION_FLOOR_PCT = 60;
// `/limits/` reports storage in whole megabytes. On a 10 GB org that is fine;
// on a 5 MB Developer Edition org it turns 998 KB into "0 of 5 MB" and 12.8 MB
// into "12 of 20 MB", so below this allocation the tiles say so and point at
// Setup > Storage Usage, which shows kilobytes.
const WHOLE_MB_MATTERS_BELOW = 1024;
const STORAGE_PRECISION_NOTE = 'Salesforce reports this in whole MB; Setup > Storage Usage shows KB';
/** An object holding at least this share of the data allocation is worth naming. */
const OBJECT_SHARE_PCT = 3;
/**
 * The org-wide debug log ceiling, in megabytes.
 *
 * Salesforce enforces this in two ways, and the second is the one that bites:
 * generating more than 1,000 MB in a fifteen-minute window disables the trace
 * flags that produced it, and *accumulating* more than 1,000 MB prevents every
 * user in the org from adding or editing a trace flag at all until somebody
 * deletes logs. The first symptom is usually a developer who cannot turn
 * logging on during a production incident.
 * https://help.salesforce.com/s/articleView?id=platform.code_debug_log_delete.htm
 */
const DEBUG_LOG_CEILING_MB = 1000;
/** Debug log usage above this share of the ceiling is the finding. */
const DEBUG_LOG_WARN_PCT = 70;
/** Trace flags shown before the list is capped. */
const MAX_TRACE_FLAGS = 50;
const MAX_ITEMS = 60;

/**
 * Estimated bytes per record, from Salesforce's published record-size guidance.
 * Anything not named here is billed at the standard rate.
 */
const STANDARD_RECORD_KB = 2;
const RECORD_KB: Record<string, number> = {
  Campaign: 8,
  CampaignMember: 1,
  KnowledgeArticle: 4,
  KnowledgeArticleVersion: 4,
};

/**
 * Objects whose record size is not a fixed rate, so estimating them would be
 * inventing a number. They are counted and shown, with the size left blank.
 */
const UNPRICED = new Set(['EmailMessage']);

/** Limits reported per-namespace rather than as a single pair, which this area does not model. */
interface LimitPair {
  Max: number;
  Remaining: number;
}

interface RecordCountRow {
  name: string;
  count: number;
}

interface LogAggregateRow {
  totalBytes: number | null;
  totalLogs: number | null;
}

interface LogByUserRow {
  LogUserId: string;
  LogUser: { Name: string | null } | null;
  bytes: number | null;
  logs: number | null;
}

interface TraceFlagRow {
  Id: string;
  LogType: string | null;
  TracedEntityId: string;
  StartDate: string | null;
  ExpirationDate: string | null;
  DebugLevel: { MasterLabel: string | null; ApexCode: string | null; Database: string | null } | null;
}

/**
 * Limits that have their own rule, so the generic headroom rule does not report
 * them twice.
 */
const HANDLED = new Set(['DataStorageMB', 'FileStorageMB', 'DailyApiRequests']);

/**
 * Limits that are noise in a headroom check: they are per-request ceilings or
 * counters that are *supposed* to sit near zero remaining.
 */
const IGNORED_HEADROOM = /^(ConcurrentAsyncGetReportInstances|ConcurrentSyncReportRuns|HourlyODataCallout)/;

const RULES = {
  dataStorage: {
    id: 'limits.data-storage',
    severity: 'critical',
    title: (n) => `Data storage is ${n}% full`,
    rationale:
      'When data storage reaches its allocation, Salesforce stops accepting new records: integrations fail, ' +
      'users cannot save, and the error names a limit rather than a cause. Buying more storage is expensive ' +
      'per megabyte, and the usual culprit is a handful of objects nobody has looked at in years. The ' +
      `${STORAGE_CRITICAL_PCT}% point at which this fires, and the ${STORAGE_WARNING_PCT}% watch line, are OrgTriage's ` +
      'recommendations; Salesforce enforces only the allocation itself.',
    remediation:
      'Find the objects consuming the allocation (listed under the storage-attribution check), then archive ' +
      'or delete what is no longer needed — closed activities, old integration logs, superseded records.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=xcloud.overview_storage.htm&type=5',
    weight: 26,
  },
  fileStorage: {
    id: 'limits.file-storage',
    severity: 'warning',
    title: (n) => `File storage is ${n}% full`,
    rationale:
      'File storage holds attachments, Files, and the documents generated by integrations. It fills more ' +
      'quietly than data storage because a single large export or a document-generation tool can consume ' +
      'gigabytes without anyone noticing, and it is allocated separately. The ' +
      `${STORAGE_CRITICAL_PCT}% point at which this fires is OrgTriage's recommendation, not a Salesforce figure.`,
    remediation:
      'Review Setup > Storage Usage for the largest files and their owners. Move generated documents to ' +
      'external storage, and set a retention rule for anything a process regenerates.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=xcloud.overview_storage.htm&type=5',
    weight: 14,
  },
  apiConsumption: {
    id: 'limits.api-consumption',
    severity: 'warning',
    title: (n) => `${n}% of the 24-hour API allowance was already spent when this scan ran`,
    rationale:
      'The allowance counts every caller’s requests over the previous 24 hours, not a calendar day, and it is ' +
      'shared by every integration in the org. Salesforce may let requests through somewhat past it before ' +
      'enforcing — but once it does, every integration fails at once, and the failures land wherever each ' +
      'integration logs them rather than in one place. An org routinely running near its ceiling has no room ' +
      'for a backfill, a migration, or a bad day.',
    remediation:
      'Identify the heaviest consumers (the Ops tab lists API logins by user and application), move ' +
      'row-at-a-time integrations onto the Bulk or Composite APIs, and if the usage is legitimate buy more ' +
      'calls or licences through the Your Account app or your account executive.',
    docUrl:
      'https://developer.salesforce.com/docs/atlas.en-us.salesforce_app_limits_cheatsheet.meta/salesforce_app_limits_cheatsheet/salesforce_app_limits_platform_api.htm',
    weight: 12,
  },
  headroom: {
    id: 'limits.near-ceiling',
    severity: 'warning',
    title: (n) => `${n} org ${n === 1 ? 'limit has' : 'limits have'} less than ${HEADROOM_PCT}% headroom left`,
    rationale:
      'Every one of these is a ceiling something will hit. They are listed together because the failure is ' +
      'always the same shape: work stops with an error naming a limit, at the least convenient moment, and ' +
      `nobody was watching the number. The ${HEADROOM_PCT}% line is OrgTriage's recommendation; Salesforce ` +
      'publishes the allocations but no warning point.',
    remediation:
      'For each, decide whether the consumption is legitimate. If it is, request an increase before it bites; ' +
      'if it is not, find what is spending it. Salesforce publishes the allocation for each limit by edition.',
    docUrl: 'https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_limits.htm',
    weight: 10,
  },
  debugLogStorage: {
    id: 'limits.debug-log-storage',
    severity: 'warning',
    title: (n) => `Debug logs are using ${n}% of the org’s 1,000 MB ceiling`,
    rationale:
      'Debug logs have their own org-wide ceiling, separate from data and file storage, and it is enforced ' +
      'against everyone at once. Past 1,000 MB accumulated, no user in the org can add or edit a trace flag ' +
      'until somebody deletes logs — so the failure surfaces as a developer unable to turn on logging during ' +
      'an incident, which is the worst possible moment to discover it.',
    remediation:
      'Delete old logs from Setup > Debug Logs, or with the Developer Console. Then find the trace flags that ' +
      'are still switched on (the next check lists them) — logs accumulate because logging was left running, ' +
      'not because anyone is reading them.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.code_debug_log_delete.htm&type=5',
    weight: 12,
  },
  traceFlagsOn: {
    id: 'limits.trace-flags-active',
    severity: 'warning',
    title: (n) => `${n} debug trace ${n === 1 ? 'flag is' : 'flags are'} still switched on`,
    rationale:
      'A trace flag keeps writing debug logs for every transaction the traced user or class runs, until it ' +
      'expires or someone removes it. Left on, it fills the org’s log ceiling, and Salesforce warns that the ' +
      'finer log levels slow the transactions being logged. These are almost always forgotten rather than in use.',
    remediation:
      'Open Setup > Debug Logs and delete the trace flags nobody is actively watching. Where logging is ' +
      'genuinely needed, set a short expiry rather than the maximum.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=xcloud.code_add_users_debug_log.htm&type=5',
    weight: 8,
  },
  logVolumeByUser: {
    id: 'limits.debug-log-owners',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'user accounts' : 'users account'} for the debug logs held in this org`,
    rationale:
      'Log volume is concentrated the same way storage is: one traced user or one chatty integration account ' +
      'produces most of it. Naming them turns "delete some logs" into a conversation with a person about a ' +
      'trace flag they forgot.',
    remediation:
      'Check with each user whether the logging is still needed, then remove their trace flag and delete their ' +
      'logs.',
    docUrl: 'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_debugging_debug_log.htm',
    weight: 3,
  },
  attribution: {
    id: 'limits.storage-heavy-objects',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'object accounts' : 'objects account'} for most of the data storage in use`,
    rationale:
      'Storage problems are almost always concentrated: a few objects hold the records, and the rest are ' +
      'rounding errors. Knowing which ones turns "buy more storage" into a decision about specific data with ' +
      'a specific owner.',
    remediation:
      'For each object, decide on a retention period with its owner. Archive to Big Objects or an external ' +
      'store, or hard-delete through the Bulk API, and add a scheduled job so the problem does not return.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=000318951&type=1',
    weight: 6,
  },
} satisfies Record<string, RuleSpec>;

export const LIMITS_RULE_IDS: string[] = Object.values(RULES).map((r) => r.id);

/** Bytes one record of this object is billed at, or null when it varies. */
export function recordKb(objectName: string): number | null {
  if (UNPRICED.has(objectName)) return null;
  return RECORD_KB[objectName] ?? STANDARD_RECORD_KB;
}

/** Estimated megabytes for a record count, or null when the object is unpriced. */
export function estimatedMb(objectName: string, count: number): number | null {
  const kb = recordKb(objectName);
  return kb === null ? null : Math.round(((count * kb) / 1024) * 10) / 10;
}

/** Turn a camel-case limit name into something readable: `DailyApiRequests` → `Daily API requests`. */
export function humanLimit(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\bApi\b/g, 'API');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase().replace(/\bapi\b/g, 'API');
}

/** Only pairs with a positive Max are a limit; everything else is a counter or a namespace map. */
export function usableLimits(raw: Record<string, unknown>): [string, LimitPair][] {
  const out: [string, LimitPair][] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    const pair = value as Partial<LimitPair>;
    if (typeof pair.Max !== 'number' || typeof pair.Remaining !== 'number') continue;
    if (pair.Max <= 0) continue;
    out.push([name, { Max: pair.Max, Remaining: pair.Remaining }]);
  }
  return out;
}

const usedPct = (pair: LimitPair) => percent(pair.Max - pair.Remaining, pair.Max);


/**
 * A rule whose headline is a percentage rather than a count.
 *
 * `finding()` builds the title from the number of items, which is right for
 * "6 classes have no coverage" and wrong for "data storage is 91% full" — there
 * is exactly one item and the number that matters is not its count. The title
 * is rewritten once here rather than at each of the three call sites.
 */
function percentFinding(
  spec: RuleSpec,
  pct: number,
  threshold: number,
  item: () => FindingItem,
): RuleOutcome {
  const outcome = finding('limits', spec, pct >= threshold ? [item()] : []);
  if (isFinding(outcome)) outcome.title = spec.title(pct);
  return outcome;
}

export const limitsAnalyzer: Analyzer = {
  id: 'limits',
  label: 'Limits',

  async *run(ctx: AnalyzerContext): AsyncGenerator<Phase, AnalyzerOutput, void> {
    const warnings: string[] = [];
    const outcomes: RuleOutcome[] = [];
    const skip = (reason: string) => warnings.push(reason);

    /* --- Limits --------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading org limits', fraction: 0.3 };
    const raw = await tryQuery(() => ctx.client.getLimits(), skip, 'Org limits');

    if (!raw) {
      for (const rule of Object.values(RULES)) {
        outcomes.push(
          inconclusive(
            'limits',
            rule,
            'The /limits resource could not be read. It needs the View Setup and Configuration permission.',
          ),
        );
      }
      const summary = summarise(RULES, outcomes);
      return {
        metrics: { 'Data storage': { value: '—' }, 'File storage': { value: '—' } },
        findings: summary.findings,
        coverage: summary.coverage,
        warnings,
        examined: 1,
      };
    }

    const limits = usableLimits(raw as Record<string, unknown>);
    const byName = new Map(limits);
    const data = byName.get('DataStorageMB');
    const files = byName.get('FileStorageMB');
    const api = byName.get('DailyApiRequests');

    const storageItem = (label: string, pair: LimitPair): FindingItem => ({
      name: label,
      setupUrl: setupUrl(ctx.lightningHost, 'CompanyResourceDisk/home'),
      evidence: {
        Used: `${(pair.Max - pair.Remaining).toLocaleString()} MB`,
        Allocated: `${pair.Max.toLocaleString()} MB`,
        'Percent used': `${usedPct(pair)}%`,
        Remaining: `${pair.Remaining.toLocaleString()} MB`,
        ...(pair.Max < WHOLE_MB_MATTERS_BELOW ? { Precision: STORAGE_PRECISION_NOTE } : {}),
      },
    });

    if (!data) {
      outcomes.push(inconclusive('limits', RULES.dataStorage, 'This org does not report DataStorageMB.'));
    } else {
      const used = usedPct(data);
      outcomes.push(
        percentFinding(RULES.dataStorage, used, STORAGE_CRITICAL_PCT, () =>
          storageItem('Data storage', data),
        ),
      );
      if (used >= STORAGE_WARNING_PCT && used < STORAGE_CRITICAL_PCT) {
        warnings.push(
          `Data storage is ${used}% full, below the ${STORAGE_CRITICAL_PCT}% threshold this check fires at. Worth watching.`,
        );
      }
    }

    if (!files) {
      outcomes.push(inconclusive('limits', RULES.fileStorage, 'This org does not report FileStorageMB.'));
    } else {
      const used = usedPct(files);
      outcomes.push(
        percentFinding(RULES.fileStorage, used, STORAGE_CRITICAL_PCT, () =>
          storageItem('File storage', files),
        ),
      );
    }

    if (!api) {
      outcomes.push(inconclusive('limits', RULES.apiConsumption, 'This org does not report DailyApiRequests.'));
    } else {
      const used = usedPct(api);
      outcomes.push(
        percentFinding(RULES.apiConsumption, used, API_CONSUMED_PCT, () => ({
          name: 'Daily API requests',
          setupUrl: setupUrl(ctx.lightningHost, 'CompanyProfileInfo/home'),
          evidence: {
            Spent: (api.Max - api.Remaining).toLocaleString(),
            Allocation: api.Max.toLocaleString(),
            'Percent used': `${used}%`,
            // A rolling 24-hour count: the same percentage means something
            // different depending on what the previous day looked like.
            'Measured at': new Date().toLocaleTimeString(),
            Note: "Salesforce's own tally, tabulated with a delay of up to a few minutes, so it will not match a count taken right now",
          },
        })),
      );
    }

    outcomes.push(
      finding(
        'limits',
        RULES.headroom,
        limits
          .filter(([name, pair]) => {
            if (HANDLED.has(name) || IGNORED_HEADROOM.test(name)) return false;
            return percent(pair.Remaining, pair.Max) < HEADROOM_PCT;
          })
          .map(([name, pair]) => ({
            name: humanLimit(name),
            label: name,
            evidence: {
              Used: (pair.Max - pair.Remaining).toLocaleString(),
              Allocation: pair.Max.toLocaleString(),
              'Headroom left': `${percent(pair.Remaining, pair.Max)}%`,
            },
          }))
          .sort((a, b) => parseFloat(String(a.evidence['Headroom left'])) - parseFloat(String(b.evidence['Headroom left']))),
      ),
    );

    /* --- Debug logs and trace flags -------------------------------------- */
    /* Salesforce reports the log ceiling nowhere in /limits, so it is measured
       from ApexLog itself. Both queries are aggregates, so they read a handful
       of rows however many logs the org holds. ApexLog and TraceFlag are
       Tooling objects. */
    checkCancelled(ctx);
    yield { phase: 'Reading debug logs and trace flags', fraction: 0.5 };

    const logTotals = await tryQuery(
      () =>
        ctx.client.query<LogAggregateRow>(
          'SELECT SUM(LogLength) totalBytes, COUNT(Id) totalLogs FROM ApexLog',
          { tooling: true },
        ),
      skip,
      'Debug log totals',
    );

    let debugLogMb: number | null = null;
    let debugLogPct: number | null = null;
    let debugLogCount = 0;
    if (!logTotals) {
      outcomes.push(
        inconclusive('limits', RULES.debugLogStorage, 'ApexLog could not be queried; it needs View All Data or the Author Apex permission.'),
      );
      outcomes.push(inconclusive('limits', RULES.logVolumeByUser, 'ApexLog could not be queried.'));
    } else {
      const row = logTotals.records[0];
      const bytes = Number(row?.totalBytes ?? 0);
      debugLogCount = Number(row?.totalLogs ?? 0);
      debugLogMb = Math.round((bytes / (1024 * 1024)) * 10) / 10;
      debugLogPct = percent(debugLogMb, DEBUG_LOG_CEILING_MB);

      outcomes.push(
        percentFinding(RULES.debugLogStorage, debugLogPct, DEBUG_LOG_WARN_PCT, () => ({
          name: 'Debug log storage',
          setupUrl: setupUrl(ctx.lightningHost, 'ApexDebugLogs/home'),
          evidence: {
            Used: `${debugLogMb!.toLocaleString()} MB`,
            Ceiling: `${DEBUG_LOG_CEILING_MB.toLocaleString()} MB`,
            'Percent used': `${debugLogPct}%`,
            Logs: debugLogCount,
            // The consequence is the finding; the number on its own is trivia.
            'At the ceiling': 'nobody in the org can add or edit a trace flag',
          },
        })),
      );

      const byUser = await tryQuery(
        () =>
          ctx.client.query<LogByUserRow>(
            'SELECT LogUserId, LogUser.Name, SUM(LogLength) bytes, COUNT(Id) logs FROM ApexLog GROUP BY LogUserId, LogUser.Name',
            { tooling: true },
          ),
        skip,
        'Debug logs by user',
      );
      if (!byUser) {
        outcomes.push(inconclusive('limits', RULES.logVolumeByUser, 'Debug logs could not be grouped by user.'));
      } else {
        // Only worth naming anyone once the logs are actually a problem.
        const shown =
          debugLogPct < DEBUG_LOG_WARN_PCT
            ? []
            : byUser.records
                .map((r) => ({
                  id: r.LogUserId,
                  name: r.LogUser?.Name ?? r.LogUserId,
                  setupUrl: setupUrl(ctx.lightningHost, 'ApexDebugLogs/home'),
                  evidence: {
                    'Log volume': `${Math.round((Number(r.bytes ?? 0) / (1024 * 1024)) * 10) / 10} MB`,
                    Logs: Number(r.logs ?? 0),
                  },
                }))
                .sort((a, b) => parseFloat(String(b.evidence['Log volume'])) - parseFloat(String(a.evidence['Log volume'])));
        outcomes.push(finding('limits', RULES.logVolumeByUser, shown));
      }
    }

    const traceFlags = await tryQuery(
      () =>
        ctx.client.query<TraceFlagRow>(
          'SELECT Id, LogType, TracedEntityId, StartDate, ExpirationDate, ' +
            'DebugLevel.MasterLabel, DebugLevel.ApexCode, DebugLevel.Database FROM TraceFlag',
          { tooling: true },
        ),
      skip,
      'Trace flags',
    );
    if (!traceFlags) {
      outcomes.push(inconclusive('limits', RULES.traceFlagsOn, 'TraceFlag could not be queried.'));
    } else {
      const now = Date.now();
      outcomes.push(
        finding(
          'limits',
          RULES.traceFlagsOn,
          capped(
            traceFlags.records
              .filter((t) => !t.ExpirationDate || Date.parse(t.ExpirationDate) > now)
              .map((t) => ({
                id: t.Id,
                name: t.DebugLevel?.MasterLabel ?? t.LogType ?? 'Trace flag',
                label: t.TracedEntityId,
                setupUrl: setupUrl(ctx.lightningHost, 'ApexDebugLogs/home'),
                evidence: {
                  Type: t.LogType,
                  'Traced entity': t.TracedEntityId,
                  Expires: t.ExpirationDate ?? 'no expiry set',
                  'Apex level': t.DebugLevel?.ApexCode ?? null,
                  'Database level': t.DebugLevel?.Database ?? null,
                },
              })),
            MAX_TRACE_FLAGS,
            (dropped) => warnings.push(`${dropped} further active trace flags are not listed.`),
          ),
        ),
      );
    }

    /* --- Where the storage went ------------------------------------------ */
    checkCancelled(ctx);
    yield { phase: 'Counting records by object', fraction: 0.7 };
    const counts = await tryQuery(
      () => ctx.client.get<{ sObjects?: RecordCountRow[] }>('/limits/recordCount'),
      skip,
      'Record counts',
    );

    let objectsCounted = 0;
    if (!counts) {
      outcomes.push(inconclusive('limits', RULES.attribution, 'The /limits/recordCount resource could not be read.'));
    } else if (!data) {
      outcomes.push(
        inconclusive('limits', RULES.attribution, 'Data storage is not reported, so a share of it cannot be worked out.'),
      );
    } else {
      const rows = counts.sObjects ?? [];
      objectsCounted = rows.length;
      const dataUsedPct = usedPct(data);

      // Attribution only when storage is actually filling. Naming the biggest
      // object in an org at 4% full is trivia dressed as a finding.
      const heavy =
        dataUsedPct < ATTRIBUTION_FLOOR_PCT
          ? []
          : rows
              .map((row) => {
                const mb = estimatedMb(row.name, row.count);
                return { row, mb, share: mb === null ? null : percent(mb, data.Max) };
              })
              .filter((e) => e.share !== null && e.share >= OBJECT_SHARE_PCT)
              .sort((a, b) => (b.mb ?? 0) - (a.mb ?? 0))
              .map((e) => ({
                name: e.row.name,
                setupUrl: setupUrl(ctx.lightningHost, 'CompanyResourceDisk/home'),
                evidence: {
                  Records: e.row.count,
                  'Estimated MB': e.mb,
                  'Share of allocation': `${e.share}%`,
                  Rate: `${recordKb(e.row.name)} KB/record (estimate)`,
                },
              }));

      outcomes.push(
        finding(
          'limits',
          RULES.attribution,
          capped(heavy, MAX_ITEMS, (dropped) =>
            warnings.push(`${dropped} further objects above the reporting threshold are not listed.`),
          ),
        ),
      );

      if (dataUsedPct < ATTRIBUTION_FLOOR_PCT) {
        warnings.push(
          `Storage attribution was not reported: data storage is ${dataUsedPct}% full${data.Max < WHOLE_MB_MATTERS_BELOW ? ' (in whole MB, as Salesforce reports it)' : ''}, below the ${ATTRIBUTION_FLOOR_PCT}% point where it becomes worth acting on. ${objectsCounted.toLocaleString()} objects were counted.`,
        );
      }
      if (rows.some((r) => UNPRICED.has(r.name))) {
        warnings.push(
          'Email Message records are billed at their actual size rather than a fixed rate, so they are counted but not estimated. Setup > Storage Usage has the real figure.',
        );
      }
    }

    const summary = summarise(RULES, outcomes);
    if (summary.unevaluated.length > 0) {
      warnings.push(
        `${summary.unevaluated.length} check(s) in this area could not be evaluated and are not reflected in the findings: ${summary.unevaluated.join(', ')}. The score is held back accordingly.`,
      );
    }

    const pctMetric = (pair: LimitPair | undefined, unit: string, note?: string) =>
      pair
        ? {
            value: `${usedPct(pair)}%`,
            sub: `${(pair.Max - pair.Remaining).toLocaleString()} of ${pair.Max.toLocaleString()} ${unit}${note ? ` · ${note}` : ''}`,
            meter: (pair.Max - pair.Remaining) / pair.Max,
          }
        : { value: '—' };
    // Whole-megabyte figures: "0 of 5 MB" is really "under 1 MB", and the
    // percentage carries the same rounding, so the tile says so rather than
    // inviting a reconciliation against the kilobyte figure in Setup.
    const storageMetric = (pair: LimitPair | undefined) => {
      if (!pair || pair.Max >= WHOLE_MB_MATTERS_BELOW) return pctMetric(pair, 'MB');
      const used = pair.Max - pair.Remaining;
      return {
        value: used === 0 ? '<1 MB' : `≈${usedPct(pair)}%`,
        sub: `${used === 0 ? 'under 1' : `about ${used.toLocaleString()}`} of ${pair.Max.toLocaleString()} MB · whole MB; Storage Usage shows KB`,
        meter: used / pair.Max,
      };
    };

    const metrics: AnalyzerOutput['metrics'] = {
      'Data storage': storageMetric(data),
      'File storage': storageMetric(files),
      'API used, last 24 hours': pctMetric(api, 'calls', "Salesforce's tally, delayed"),
      'Limits reported': { value: limits.length },
      'Objects counted': { value: counts ? objectsCounted : '—' },
      'Debug logs': debugLogMb === null
        ? { value: '—' }
        : {
            value: `${debugLogPct}%`,
            sub: `${debugLogMb.toLocaleString()} of ${DEBUG_LOG_CEILING_MB.toLocaleString()} MB · ${debugLogCount.toLocaleString()} logs`,
            meter: debugLogMb / DEBUG_LOG_CEILING_MB,
          },
      'Active trace flags': {
        value: traceFlags ? (summary.findings.find((f) => f.id === RULES.traceFlagsOn.id)?.items.length ?? 0) : '—',
      },
      'Limits near ceiling': {
        value: summary.findings.find((f) => f.id === RULES.headroom.id)?.items.length ?? 0,
        sub: `under ${HEADROOM_PCT}% left`,
      },
    };

    return {
      metrics,
      findings: summary.findings,
      coverage: summary.coverage,
      warnings,
      // Two endpoints, but the denominator that means something is how many
      // limits and objects were actually inspected.
      examined: Math.max(1, limits.length + objectsCounted + debugLogCount + (traceFlags?.records.length ?? 0)),
    };
  },
};
