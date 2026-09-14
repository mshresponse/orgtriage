/**
 * Operations analyzer — the things that go wrong at run time and are only
 * visible on scattered Setup pages: failed async Apex, scheduled jobs in error
 * or owned by someone who has left, failed and paused flow interviews,
 * approval requests stuck on a deactivated approver, and who is actually using
 * the API. Two Setup-page items that are not run-time failures but behave
 * like them live here too: release updates with steps still outstanding
 * before their enforcement date, and custom buttons whose URL is welded to
 * one org's address or one record's id.
 *
 * Everything here is a SOQL read of a Setup object. None of it needs Event
 * Monitoring, and none of it is a record-data query: the objects involved
 * describe jobs, interviews and approval steps, not business records. Where a
 * rule needs an approver or job owner's name it reads the User object's name
 * and active flag only.
 *
 * Deliberately absent: unhandled Apex exception counts. Salesforce exposes
 * those only by email (Apex Exception Email) or through Event Monitoring's
 * ApexUnexpectedException event, which is a paid add-on. The Apex analyzer
 * already checks that someone is on the email.
 */

import type { FindingItem } from '@/shared/types';
import {
  checkCancelled,
  daysSince,
  finding,
  groupBy,
  inconclusive,
  recordUrl,
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
import { readKeyPrefixes } from './flows';
import { hardcodedIdsIn } from '@/shared/salesforceIds';

/** Window for job failures and interview errors. */
const RECENT_DAYS = 7;
/** A paused interview older than this is stuck, not waiting. */
const PAUSED_STALE_DAYS = 7;
/** A pending approval older than this has been forgotten. */
const APPROVAL_STALE_DAYS = 30;
/** Scheduled jobs sharing one hour of the day before it counts as stacked. */
const STACKED_JOBS_PER_HOUR = 5;
/** Users listed in the API-logins review item. */
const API_USERS_SHOWN = 25;

interface AsyncJobRow {
  Id: string;
  ApexClass: { Name: string } | null;
  MethodName: string | null;
  JobType: string;
  Status: string;
  NumberOfErrors: number | null;
  ExtendedStatus: string | null;
  CompletedDate: string | null;
  CreatedDate: string;
}

interface CronRow {
  Id: string;
  CronJobDetail: { Name: string | null; JobType: string | null } | null;
  State: string;
  NextFireTime: string | null;
  PreviousFireTime: string | null;
  TimesTriggered: number | null;
  OwnerId: string;
  CronExpression: string | null;
}

interface FlowInterviewRow {
  Id: string;
  InterviewLabel: string | null;
  CurrentElement: string | null;
  PauseLabel: string | null;
  InterviewStatus?: string | null;
  CreatedDate: string;
  CreatedById: string;
}

interface ProcessInstanceRow {
  Id: string;
  Status: string;
  CreatedDate: string;
  TargetObjectId: string;
  ProcessDefinition: { Name: string | null } | null;
  Workitems: { records: { Id: string; ActorId: string; OriginalActorId: string | null; CreatedDate: string }[] } | null;
}

interface UserRow {
  Id: string;
  Name: string;
  IsActive: boolean;
}

/** One Tooling `ReleaseUpdate` row. Field list taken from Org Check's dataset, which reads the same object. */
interface ReleaseUpdateRow {
  DurableId: string;
  Title: string | null;
  Category: string | null;
  DueDate: string | null;
  IsReleased: boolean | null;
  NumCompSteps: number | null;
  NumSteps: number | null;
  ReleaseLabel: string | null;
  Status: string | null;
}

/** One Tooling `WebLink` row: a custom button or link and the URL it opens. */
interface WebLinkRow {
  Id: string;
  Name: string;
  Url: string | null;
  LinkType: string | null;
  OpenType: string | null;
  NamespacePrefix: string | null;
  ManageableState: string | null;
  EntityDefinition: { DurableId: string | null } | null;
}

interface LoginRow {
  UserId: string;
  Application: string | null;
  LoginType: string | null;
  n: number;
}

/** CronJobDetail.JobType codes, from the object reference. */
const CRON_JOB_TYPE: Record<string, string> = {
  '1': 'Data export',
  '3': 'Dashboard refresh',
  '4': 'Reporting snapshot',
  '6': 'Scheduled flow',
  '7': 'Scheduled Apex',
  '8': 'Report run',
  '9': 'Batch job',
  A: 'Reporting notification',
  B: 'Scheduled Apex (queueable)',
};

const RULES = {
  asyncFailures: {
    id: 'ops.async-job-failures',
    severity: 'critical',
    title: (n) => `${n} Apex ${n === 1 ? 'class has' : 'classes have'} batch, queueable or future jobs failing in the last ${RECENT_DAYS} days`,
    rationale:
      'A failed batch or queueable job usually means records were not processed and nobody was told: the ' +
      'platform records the failure in Apex Jobs and moves on. Batch jobs also fail partially — a job that ' +
      'completed with errors skipped whole batches of records.',
    remediation:
      'Open Setup > Apex Jobs, read the error for each failing class, fix the cause, and re-run the job for the records it missed.',
    docUrl: 'https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_asyncapexjob.htm',
    weight: 24,
  },
  cronErrors: {
    id: 'ops.scheduled-job-errors',
    severity: 'critical',
    title: (n) => `${n} scheduled ${n === 1 ? 'job is' : 'jobs are'} in an error state`,
    rationale:
      'A scheduled job in ERROR will not fire again until someone deletes and reschedules it. PAUSED and ' +
      'BLOCKED are passing states Salesforce sets during releases and overlapping runs and clears itself, so ' +
      'they are not counted. ' +
      'The next run of whatever it does — a nightly rollup, a report subscription, a data export — has ' +
      'already been missed.',
    remediation:
      'Open Setup > Scheduled Jobs, delete the failed entry, fix the cause (usually the class or the owner), and reschedule it.',
    docUrl: 'https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_crontrigger.htm',
    weight: 18,
  },
  cronOrphaned: {
    id: 'ops.scheduled-jobs-orphaned',
    severity: 'warning',
    title: (n) => `${n} scheduled ${n === 1 ? 'job is' : 'jobs are'} owned by a deactivated user`,
    rationale:
      'A scheduled job runs as the user who scheduled it, so deactivating that user stops the job: the entry ' +
      'stays in the schedule, but the run fails with INACTIVE_OWNER_OR_USER or simply never happens again. ' +
      'Nothing raises an alarm, and the failure notice goes to a mailbox nobody reads. This is the most ' +
      'common way a nightly process silently stops.',
    remediation:
      'The owner of an existing job cannot be reassigned, so reschedule each one as an active integration or ' +
      'admin user and delete the original entry. Schedule under a service account rather than a person, so the ' +
      'next leaver does not take the schedule with them.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=000385764&type=1',
    weight: 10,
  },
  cronStacked: {
    id: 'ops.scheduled-jobs-stacked',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'hour of the day has' : 'hours of the day have'} ${STACKED_JOBS_PER_HOUR} or more scheduled jobs`,
    rationale:
      'Scheduled Apex, report subscriptions and dashboard refreshes share the org’s async queue. When many ' +
      'land in the same hour they queue behind each other, dashboards refresh late, and the batch that ' +
      'runs last is the one that hits the daily limit. Salesforce publishes no per-hour job limit — ' +
      `${STACKED_JOBS_PER_HOUR} in one hour is an OrgTriage recommendation, not a platform ceiling.`,
    remediation: 'Spread jobs across the night; put dashboard refreshes after the batches they depend on.',
    docUrl: 'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_scheduler.htm',
    weight: 4,
  },
  interviewsFailed: {
    id: 'ops.flow-interviews-failed',
    severity: 'critical',
    title: (n) => `${n} ${n === 1 ? 'flow has' : 'flows have'} failed interviews in the last ${RECENT_DAYS} days`,
    rationale:
      'A failed interview is a flow that threw an unhandled error mid-run: a screen flow the user could ' +
      'not finish, or a scheduled or record-triggered flow whose work was rolled back. The failure email ' +
      'goes to the flow’s last editor by default, which is rarely who should act on it.',
    remediation:
      'Open Setup > Paused And Failed Flow Interviews, read the error for each flow, add a fault path, and fix the cause.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.automate_ala_monitor.htm&type=5',
    weight: 20,
  },
  interviewsPaused: {
    id: 'ops.flow-interviews-paused',
    severity: 'warning',
    title: (n) => `${n} ${n === 1 ? 'flow has' : 'flows have'} interviews paused for more than ${PAUSED_STALE_DAYS} days`,
    rationale:
      'Paused interviews wait for a resume event or a scheduled path. Ones that have waited for weeks are ' +
      'usually waiting for something that will never happen — a record that was deleted, a user who left — ' +
      'and each is a piece of business left half-done: the record moved on, the flow did not. Salesforce ' +
      'removed the cap on paused and waiting interviews, so this is not about a limit; it is about work ' +
      `nobody finished. Nor does Salesforce set an age at which a paused interview is stale — ${PAUSED_STALE_DAYS} ` +
      'days is an OrgTriage recommendation.',
    remediation:
      'Review the paused interviews per flow; resume the ones that still make sense and delete the rest. Add a time-out path to the flow.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_considerations_design_pause.htm&type=5',
    weight: 10,
  },
  approvalsStale: {
    id: 'ops.approvals-stale',
    severity: 'warning',
    title: (n) => `${n} approval ${n === 1 ? 'request has' : 'requests have'} been pending for more than ${APPROVAL_STALE_DAYS} days`,
    rationale:
      'A record locked in an approval process cannot be edited by its owner. Requests that nobody has ' +
      'actioned in a month are almost always forgotten rather than under consideration, and the records ' +
      `behind them are stuck. ${APPROVAL_STALE_DAYS} days is an OrgTriage recommendation — Salesforce ` +
      'places no age limit on a pending approval.',
    remediation:
      'Recall or approve each request from the record, or as an admin use Setup > Approval Processes to reassign the approver.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.approvals_create_recordeditability.htm&type=5',
    weight: 12,
  },
  approvalsOrphaned: {
    id: 'ops.approvals-inactive-approver',
    severity: 'critical',
    title: (n) => `${n} approval ${n === 1 ? 'request is' : 'requests are'} assigned to a deactivated user`,
    rationale:
      'The approver has left, so the request can never be approved or rejected through the normal path. ' +
      'The record stays locked until an admin reassigns it.',
    remediation:
      'Reassign each request to an active approver (Reassign on the approval item, or an admin with Modify All Data), ' +
      'and set the approval process’s approver to a queue or a related user field rather than a named person.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.how_to_deactivate_users.htm&type=5',
    weight: 18,
  },
  releaseUpdates: {
    id: 'ops.release-updates-due',
    severity: 'warning',
    title: (n) => `${n} release ${n === 1 ? 'update needs action before its' : 'updates need action before their'} enforcement date`,
    rationale:
      'A release update is a change Salesforce enforces on a fixed date whether or not the org is ready: ' +
      'after that date the new behaviour switches on and anything built on the old one breaks in production. ' +
      'Each update has test-run and activation steps; the ones listed can be activated now and have not been. ' +
      'Updates already activated or enforced, informational ones with nothing to activate, and ones not yet ' +
      'released to the org are not listed.',
    remediation:
      'Open Setup > Release Updates, run each update’s test run in a sandbox, fix what it surfaces, then ' +
      'activate before the due date. An update within one release of its date is a sprint item, not a Setup chore.',
    // Salesforce Help, "Release Updates" — opened and read in the owner's
    // browser 2026-09-10 (the platform. and sf. ids both redirect here).
    docUrl: 'https://help.salesforce.com/s/articleView?id=xcloud.release_updates.htm&type=5',
    weight: 12,
  },
  hardcodedUrls: {
    id: 'ops.hardcoded-urls',
    severity: 'warning',
    title: (n) => `${n} custom ${n === 1 ? 'button or link points' : 'buttons or links point'} at a hard-coded org address or record id`,
    rationale:
      'A button whose URL names a Salesforce instance or My Domain works in exactly one org: a sandbox ' +
      'refresh, a My Domain rename or the enhanced-domains change alters the host and the button opens the ' +
      'wrong org or nothing. A record id in the URL breaks the same way in the next environment. Instance-name ' +
      'hosts were removed from My Domain URLs when enhanced domains were enforced, so those links are already broken.',
    remediation:
      'Replace the host with a relative path or a URLFOR expression and the record id with a merge field or a ' +
      'custom label. A button that also runs JavaScript needs rebuilding as a Lightning action in any case.',
    // No citation yet: sf.domain_name_hardcoded_references.htm renders Help's
    // 404 page (owner's browser, 2026-09-10). The browser session finds the
    // My Domain "hard-coded references" article; nothing ships here unverified.
    docUrl: 'https://help.salesforce.com/s/articleView?id=000387070&type=1',
    weight: 8,
  },
  apiLogins: {
    id: 'ops.api-logins',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'user has' : 'users have'} API logins in the last ${RECENT_DAYS} days`,
    rationale:
      'Per-call API usage by user lives in the ApiTotalUsage event log (free in Developer, Enterprise, ' +
      'Unlimited and Performance editions with one day of retention, once event log files are switched on) ' +
      'and in the Classic "API Usage Last 7 Days" report. Login History is the signal that needs no setup: ' +
      'it records every API session by user, application and login type, and answers "who is using the API and from ' +
      'what" — the question behind an unexpected daily-limit alert — and shows integrations still running ' +
      'under a person’s login.',
    remediation:
      'Move integrations off personal user logins onto a dedicated integration user; investigate any user whose API login count looks like a runaway job.',
    docUrl: 'https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_loginhistory.htm',
    weight: 0,
  },
} satisfies Record<string, RuleSpec>;

export const OPS_RULE_IDS: string[] = Object.values(RULES).map((r) => r.id);

/* -------------------------------------------------------------------------- */
/* Pure helpers (tested)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Hostname suffixes that belong to one specific org rather than to Salesforce
 * generally: My Domain, Lightning, Visualforce, Sites and Experience hosts,
 * plus the pre-enhanced-domains instance names (`na139.salesforce.com`).
 */
const ORG_HOST_SUFFIXES = [
  '.my.salesforce.com',
  '.lightning.force.com',
  '.force.com',
  '.my.site.com',
  '.salesforce-sites.com',
  '.salesforce-setup.com',
  '.salesforce-experience.com',
  '.force-user-content.com',
  '.cloudforce.com',
  '.database.com',
];
const INSTANCE_HOST = /^(?:na|eu|ap|cs|um|gs|ca|in|jp|au|uk|br|fr|de|ind)\d+\.salesforce\.com$/;
/** Salesforce hosts that are the same for every org and so are not hard-coded org addresses. */
const NOT_ORG_HOSTS = new Set([
  'login.salesforce.com',
  'test.salesforce.com',
  'help.salesforce.com',
  'developer.salesforce.com',
  'developer.force.com',
  'trailhead.salesforce.com',
  'appexchange.salesforce.com',
  'www.salesforce.com',
  'salesforce.com',
  'trust.salesforce.com',
  'status.salesforce.com',
  'success.salesforce.com',
]);

/** Org-specific Salesforce hostnames found in a URL or formula, lower-cased and de-duplicated. */
export function hardcodedHostsIn(text: string): string[] {
  const hosts = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
    const host = (match[1] ?? '').toLowerCase();
    if (!host) continue;
    if (NOT_ORG_HOSTS.has(host)) continue;
    if (INSTANCE_HOST.test(host) || ORG_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) hosts.add(host);
  }
  return [...hosts];
}

/**
 * Release updates the org can act on now, soonest due first.
 *
 * `Status` values measured on a Developer Edition org (2026-09-10):
 * `Invocable` (released to the org, not activated — the actionable state),
 * `Pending` (due date passed without activation; seen on rows dated 2020
 * onwards, so it does not mean "enforcement is imminent"), `Invoked`
 * (activated or enforced), `Info` (informational, nothing to activate),
 * `Nascent` (announced, not yet available to activate). Work is `Invocable`
 * with the date ahead, plus `Pending` inside the last release cycle, where
 * the org can still test and activate before enforcement lands. Older
 * `Pending` rows are counted by {@link pastDuePending}. `NumCompSteps` comes
 * back as -1 on most rows; that is "not reported", never a step count.
 */
export function openReleaseUpdates(
  rows: ReleaseUpdateRow[],
  now = Date.now(),
): { row: ReleaseUpdateRow; daysToDue: number; stepsLeft: number | null }[] {
  const open: { row: ReleaseUpdateRow; daysToDue: number; stepsLeft: number | null }[] = [];
  for (const row of rows) {
    const daysToDue = daysUntil(row.DueDate, now);
    if (daysToDue === null) continue;
    const status = statusOf(row);
    const actionable =
      (status === 'invocable' && daysToDue >= 0) ||
      (status === 'pending' && daysToDue < 0 && daysToDue >= -RELEASE_CYCLE_DAYS);
    if (!actionable) continue;
    const stepsLeft =
      row.NumSteps === null || row.NumCompSteps === null || row.NumCompSteps < 0 || row.NumSteps < 0
        ? null
        : Math.max(0, row.NumSteps - row.NumCompSteps);
    open.push({ row, daysToDue, stepsLeft });
  }
  return open.sort((a, b) => a.daysToDue - b.daysToDue);
}

/** One Salesforce release cycle, roughly: a Pending update older than this was enforced by a past release. */
const RELEASE_CYCLE_DAYS = 120;

/** Pending updates past their date by more than a release cycle: enforced by Salesforce, nothing left to activate. */
export function pastDuePending(rows: ReleaseUpdateRow[], now = Date.now()): number {
  return rows.filter((row) => {
    const days = daysUntil(row.DueDate, now);
    return statusOf(row) === 'pending' && days !== null && days < -RELEASE_CYCLE_DAYS;
  }).length;
}

/** Updates announced but not yet available to activate. */
export function nascentUpdates(rows: ReleaseUpdateRow[]): number {
  return rows.filter((row) => statusOf(row) === 'nascent').length;
}

function statusOf(row: ReleaseUpdateRow): string {
  return (row.Status ?? '').toLowerCase();
}

function daysUntil(date: string | null, now: number): number | null {
  if (!date) return null;
  const due = Date.parse(date);
  return Number.isNaN(due) ? null : Math.floor((due - now) / 86_400_000);
}

/** UTC hour of the next fire time, or null when it is unknown. */
export function fireHour(next: string | null | undefined): number | null {
  if (!next) return null;
  const t = Date.parse(next);
  return Number.isNaN(t) ? null : new Date(t).getUTCHours();
}

/** Hours of the day with at least `threshold` scheduled jobs. */
export function stackedHours(
  jobs: { name: string; next: string | null }[],
  threshold = STACKED_JOBS_PER_HOUR,
): { hour: number; jobs: string[] }[] {
  const byHour = new Map<number, string[]>();
  for (const job of jobs) {
    const hour = fireHour(job.next);
    if (hour === null) continue;
    byHour.set(hour, [...(byHour.get(hour) ?? []), job.name]);
  }
  return [...byHour.entries()]
    .filter(([, names]) => names.length >= threshold)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([hour, names]) => ({ hour, jobs: names }));
}

/** Login types that are API sessions rather than a browser. */
export function isApiLogin(loginType: string | null | undefined): boolean {
  const t = (loginType ?? '').toLowerCase();
  if (!t) return false;
  if (t === 'application' || t.includes('sso') || t.includes('communities')) return false;
  return (
    t.includes('api') ||
    t.includes('remote access') ||
    t.includes('partner') ||
    t.includes('data loader') ||
    t.includes('bulk') ||
    t.includes('integration')
  );
}

/** The flow a paused or failed interview belongs to — the label minus the timestamp Salesforce appends. */
export function interviewFlowName(label: string | null | undefined): string {
  if (!label) return 'Unknown flow';
  return label.replace(/\s+\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?$/i, '').trim() || label;
}

/* -------------------------------------------------------------------------- */

export const opsAnalyzer: Analyzer = {
  id: 'ops',
  label: 'Ops',

  async *run(ctx: AnalyzerContext): AsyncGenerator<Phase, AnalyzerOutput, void> {
    const warnings: string[] = [];
    const skip = (reason: string) => warnings.push(reason);
    const outcomes: RuleOutcome[] = [];
    let examined = 0;

    const userNames = new Map<string, UserRow>();
    const loadUsers = async (ids: Iterable<string>): Promise<void> => {
      const wanted = [...new Set([...ids])].filter((id) => /^005[A-Za-z0-9]{12,15}$/.test(id) && !userNames.has(id));
      for (let i = 0; i < wanted.length; i += 200) {
        const chunk = wanted.slice(i, i + 200);
        const rows = await tryQuery(
          () => ctx.client.query<UserRow>(`SELECT Id, Name, IsActive FROM User WHERE Id IN ('${chunk.join("','")}')`),
          skip,
          'User lookup',
        );
        for (const row of rows?.records ?? []) userNames.set(row.Id, row);
      }
    };

    /* --- Async Apex ---------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading Apex jobs', fraction: 0.1 };
    const asyncJobs = await tryQuery(
      () =>
        ctx.client.query<AsyncJobRow>(
          'SELECT Id, ApexClass.Name, MethodName, JobType, Status, NumberOfErrors, ExtendedStatus, CompletedDate, CreatedDate ' +
            `FROM AsyncApexJob WHERE CreatedDate = LAST_N_DAYS:${RECENT_DAYS} AND JobType IN ('BatchApex','Queueable','Future','ScheduledApex') ` +
            "AND (Status = 'Failed' OR NumberOfErrors > 0)",
        ),
      skip,
      'Apex job history',
    );
    if (!asyncJobs) {
      outcomes.push(inconclusive('ops', RULES.asyncFailures, 'AsyncApexJob could not be queried.'));
    } else {
      examined += asyncJobs.records.length;
      const byClass = groupBy(asyncJobs.records, (j) => j.ApexClass?.Name ?? j.MethodName ?? 'Unknown class');
      outcomes.push(
        finding(
          'ops',
          RULES.asyncFailures,
          [...byClass.entries()].map(([name, jobs]) => {
            const latest = jobs.reduce((a, b) => ((a.CompletedDate ?? a.CreatedDate) > (b.CompletedDate ?? b.CreatedDate) ? a : b));
            return {
              name,
              setupUrl: setupUrl(ctx.lightningHost, 'AsyncApexJobs/home'),
              evidence: {
                'Failed jobs': jobs.filter((j) => j.Status === 'Failed').length,
                'Jobs with errors': jobs.filter((j) => (j.NumberOfErrors ?? 0) > 0).length,
                'Job type': latest.JobType,
                'Last failure': latest.CompletedDate ?? latest.CreatedDate,
                Error: (latest.ExtendedStatus ?? '').slice(0, 120) || null,
              },
            };
          }),
        ),
      );
    }

    /* --- Scheduled jobs ------------------------------------------------ */
    checkCancelled(ctx);
    yield { phase: 'Reading scheduled jobs', fraction: 0.3 };
    const cron = await tryQuery(
      () =>
        ctx.client.query<CronRow>(
          'SELECT Id, CronJobDetail.Name, CronJobDetail.JobType, State, NextFireTime, PreviousFireTime, TimesTriggered, OwnerId, CronExpression FROM CronTrigger',
        ),
      skip,
      'Scheduled jobs',
    );
    if (!cron) {
      outcomes.push(inconclusive('ops', RULES.cronErrors, 'CronTrigger could not be queried.'));
      outcomes.push(inconclusive('ops', RULES.cronOrphaned, 'CronTrigger could not be queried.'));
      outcomes.push(inconclusive('ops', RULES.cronStacked, 'CronTrigger could not be queried.'));
    } else {
      const jobs = cron.records;
      examined += jobs.length;
      const jobName = (j: CronRow) => j.CronJobDetail?.Name ?? j.Id;
      const jobType = (j: CronRow) => CRON_JOB_TYPE[j.CronJobDetail?.JobType ?? ''] ?? j.CronJobDetail?.JobType ?? 'Unknown';
      const link = setupUrl(ctx.lightningHost, 'ScheduledJobs/home');

      outcomes.push(
        finding(
          'ops',
          RULES.cronErrors,
          jobs
            .filter((j) => j.State === 'ERROR')
            .map((j) => ({
              id: j.Id,
              name: jobName(j),
              setupUrl: link,
              evidence: { State: j.State, Type: jobType(j), 'Last fired': j.PreviousFireTime, 'Times run': j.TimesTriggered },
            })),
        ),
      );

      await loadUsers(jobs.map((j) => j.OwnerId));
      const orphaned = jobs.filter((j) => userNames.get(j.OwnerId)?.IsActive === false);
      if (userNames.size === 0 && jobs.length > 0) {
        outcomes.push(inconclusive('ops', RULES.cronOrphaned, 'Job owners could not be looked up on the User object.'));
      } else {
        outcomes.push(
          finding(
            'ops',
            RULES.cronOrphaned,
            orphaned.map((j) => ({
              id: j.Id,
              name: jobName(j),
              setupUrl: link,
              evidence: { Owner: userNames.get(j.OwnerId)?.Name ?? j.OwnerId, Type: jobType(j), State: j.State, 'Next run': j.NextFireTime },
            })),
          ),
        );
      }

      outcomes.push(
        finding(
          'ops',
          RULES.cronStacked,
          stackedHours(jobs.filter((j) => j.State !== 'DELETED').map((j) => ({ name: jobName(j), next: j.NextFireTime }))).map((h) => ({
            name: `${String(h.hour).padStart(2, '0')}:00 UTC`,
            setupUrl: link,
            evidence: { Jobs: h.jobs.length, Names: h.jobs.slice(0, 6).join(', ') + (h.jobs.length > 6 ? ', …' : '') },
          })),
        ),
      );
    }

    /* --- Flow interviews ----------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading flow interviews', fraction: 0.5 };
    let interviews = await tryQuery(
      () =>
        ctx.client.query<FlowInterviewRow>(
          'SELECT Id, InterviewLabel, CurrentElement, PauseLabel, InterviewStatus, CreatedDate, CreatedById FROM FlowInterview',
        ),
      () => undefined,
      'Flow interviews',
    );
    let hasStatus = true;
    if (!interviews) {
      // Older API versions have no InterviewStatus; everything then is paused.
      hasStatus = false;
      interviews = await tryQuery(
        () =>
          ctx.client.query<FlowInterviewRow>(
            'SELECT Id, InterviewLabel, CurrentElement, PauseLabel, CreatedDate, CreatedById FROM FlowInterview',
          ),
        skip,
        'Flow interviews',
      );
    }
    if (!interviews) {
      outcomes.push(inconclusive('ops', RULES.interviewsFailed, 'FlowInterview could not be queried.'));
      outcomes.push(inconclusive('ops', RULES.interviewsPaused, 'FlowInterview could not be queried.'));
    } else {
      const rows = interviews.records;
      examined += rows.length;
      const link = setupUrl(ctx.lightningHost, 'Pausedflows/home');
      const failed = rows.filter(
        (r) => hasStatus && (r.InterviewStatus ?? '').toLowerCase() === 'error' && (daysSince(r.CreatedDate) ?? 0) <= RECENT_DAYS,
      );
      const paused = rows.filter(
        (r) => (!hasStatus || (r.InterviewStatus ?? 'Paused').toLowerCase() !== 'error') && (daysSince(r.CreatedDate) ?? 0) > PAUSED_STALE_DAYS,
      );
      const summarise = (group: FlowInterviewRow[]) => {
        const ages = group.map((r) => daysSince(r.CreatedDate) ?? 0);
        const latest = group.reduce((a, b) => (a.CreatedDate > b.CreatedDate ? a : b));
        return {
          Interviews: group.length,
          'Oldest (days)': Math.max(...ages),
          'Latest element': latest.CurrentElement ?? latest.PauseLabel ?? null,
        };
      };
      if (hasStatus) {
        outcomes.push(
          finding(
            'ops',
            RULES.interviewsFailed,
            [...groupBy(failed, (r) => interviewFlowName(r.InterviewLabel)).entries()].map(([name, group]) => ({
              name,
              setupUrl: link,
              evidence: summarise(group),
            })),
          ),
        );
      } else {
        outcomes.push(
          inconclusive('ops', RULES.interviewsFailed, 'This API version does not expose FlowInterview.InterviewStatus, so failed interviews cannot be told from paused ones.'),
        );
      }
      outcomes.push(
        finding(
          'ops',
          RULES.interviewsPaused,
          [...groupBy(paused, (r) => interviewFlowName(r.InterviewLabel)).entries()]
            .map(([name, group]) => ({ name, setupUrl: link, evidence: summarise(group) }))
            .sort((a, b) => Number(b.evidence.Interviews) - Number(a.evidence.Interviews)),
        ),
      );
    }

    /* --- Approvals ----------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading pending approvals', fraction: 0.7 };
    const approvals = await tryQuery(
      () =>
        ctx.client.query<ProcessInstanceRow>(
          'SELECT Id, Status, CreatedDate, TargetObjectId, ProcessDefinition.Name, ' +
            "(SELECT Id, ActorId, OriginalActorId, CreatedDate FROM Workitems) FROM ProcessInstance WHERE Status = 'Pending'",
        ),
      skip,
      'Pending approvals',
    );
    if (!approvals) {
      outcomes.push(inconclusive('ops', RULES.approvalsStale, 'ProcessInstance could not be queried.'));
      outcomes.push(inconclusive('ops', RULES.approvalsOrphaned, 'ProcessInstance could not be queried.'));
    } else {
      const pending = approvals.records;
      examined += pending.length;
      const actorIds = pending.flatMap((p) => (p.Workitems?.records ?? []).map((w) => w.ActorId));
      await loadUsers(actorIds);
      /** Actors the user lookup could not resolve — a failed query, not a missing user. */
      const unresolvedActors = actorIds.filter((id) => /^005[A-Za-z0-9]{12,15}$/.test(id) && !userNames.has(id));
      const item = (p: ProcessInstanceRow, extra: Record<string, string | number | null>) => {
        const actors = (p.Workitems?.records ?? []).map((w) => userNames.get(w.ActorId)?.Name ?? w.ActorId);
        return {
          id: p.Id,
          name: p.TargetObjectId,
          label: p.ProcessDefinition?.Name ?? undefined,
          setupUrl: recordUrl(ctx.lightningHost, p.TargetObjectId),
          evidence: { Process: p.ProcessDefinition?.Name ?? null, 'Days pending': daysSince(p.CreatedDate), Approver: actors.join(', ') || null, ...extra },
        } satisfies FindingItem;
      };
      outcomes.push(
        finding(
          'ops',
          RULES.approvalsStale,
          pending
            .filter((p) => (daysSince(p.CreatedDate) ?? 0) > APPROVAL_STALE_DAYS)
            .sort((a, b) => a.CreatedDate.localeCompare(b.CreatedDate))
            .map((p) => item(p, {})),
        ),
      );
      // "No approval is waiting on a deactivated user" needs every approver
      // resolved. With the lookup failed, the predicate is false for every
      // row and the rule used to report clean.
      outcomes.push(
        unresolvedActors.length > 0
          ? inconclusive(
              'ops',
              RULES.approvalsOrphaned,
              `${unresolvedActors.length} approver${unresolvedActors.length === 1 ? '' : 's'} could not be looked up, so approvals waiting on a deactivated user cannot be identified.`,
            )
          : finding(
              'ops',
              RULES.approvalsOrphaned,
              pending
                .filter((p) => (p.Workitems?.records ?? []).some((w) => userNames.get(w.ActorId)?.IsActive === false))
                .map((p) => item(p, { 'Approver status': 'Deactivated' })),
            ),
      );
    }

    /* --- API logins ---------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading login history', fraction: 0.85 };
    const logins = await tryQuery(
      () =>
        ctx.client.query<LoginRow>(
          `SELECT UserId, Application, LoginType, COUNT(Id) n FROM LoginHistory WHERE LoginTime = LAST_N_DAYS:${RECENT_DAYS} GROUP BY UserId, Application, LoginType`,
        ),
      skip,
      'Login history',
    );
    let apiLoginTotal = 0;
    if (!logins) {
      outcomes.push(inconclusive('ops', RULES.apiLogins, 'LoginHistory could not be queried (needs Manage Users or View Setup).'));
    } else {
      const api = logins.records.filter((r) => isApiLogin(r.LoginType));
      apiLoginTotal = api.reduce((n, r) => n + Number(r.n ?? 0), 0);
      await loadUsers(api.map((r) => r.UserId));
      const byUser = groupBy(api, (r) => r.UserId);
      outcomes.push(
        finding(
          'ops',
          RULES.apiLogins,
          [...byUser.entries()]
            .map(([userId, rows]) => {
              const total = rows.reduce((n, r) => n + Number(r.n ?? 0), 0);
              const apps = [...new Set(rows.map((r) => r.Application ?? r.LoginType ?? 'unknown'))];
              return {
                id: userId,
                name: userNames.get(userId)?.Name ?? userId,
                setupUrl: setupUrl(ctx.lightningHost, 'OrgLoginHistory/home'),
                evidence: {
                  'API logins': total,
                  Applications: apps.slice(0, 4).join(', ') + (apps.length > 4 ? ', …' : ''),
                  Active: userNames.get(userId)?.IsActive ?? null,
                },
              };
            })
            .sort((a, b) => Number(b.evidence['API logins']) - Number(a.evidence['API logins']))
            .slice(0, API_USERS_SHOWN),
        ),
      );
    }

    /* --- Release updates ----------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading release updates', fraction: 0.9 };
    const releaseUpdates = await tryQuery(
      () =>
        ctx.client.query<ReleaseUpdateRow>(
          'SELECT DurableId, Title, Category, DueDate, IsReleased, NumCompSteps, NumSteps, ReleaseLabel, Status FROM ReleaseUpdate',
          { tooling: true },
        ),
      skip,
      'Release updates',
    );
    if (!releaseUpdates) {
      outcomes.push(inconclusive('ops', RULES.releaseUpdates, 'ReleaseUpdate could not be read through the Tooling API.'));
    } else {
      examined += releaseUpdates.records.length;
      outcomes.push(
        finding(
          'ops',
          RULES.releaseUpdates,
          openReleaseUpdates(releaseUpdates.records).map((u) => ({
            id: u.row.DurableId,
            name: u.row.Title ?? u.row.DurableId,
            setupUrl: setupUrl(ctx.lightningHost, 'ReleaseUpdates/home'),
            evidence: {
              Due: u.row.DueDate?.slice(0, 10) ?? null,
              'Days left': u.daysToDue,
              Steps: u.stepsLeft === null ? 'not reported' : `${u.stepsLeft} of ${u.row.NumSteps} left`,
              Status: u.row.Status,
              Release: u.row.ReleaseLabel,
              Category: u.row.Category,
            },
          })),
        ),
      );
    }

    /* --- Custom buttons and links -------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading custom buttons and links', fraction: 0.93 };
    const links = await tryQuery(
      () =>
        ctx.client.query<WebLinkRow>(
          'SELECT Id, Name, Url, LinkType, OpenType, NamespacePrefix, ManageableState, EntityDefinition.DurableId FROM WebLink',
          { tooling: true, maxRecords: 5000 },
        ),
      skip,
      'Custom buttons and links',
    );
    let javascriptButtons: number | null = null;
    if (!links) {
      outcomes.push(inconclusive('ops', RULES.hardcodedUrls, 'WebLink could not be read through the Tooling API.'));
    } else {
      const linksInScope = links.records.filter((l) => ctx.includeManaged || !l.NamespacePrefix);
      examined += linksInScope.length;
      javascriptButtons = linksInScope.filter((l) => (l.LinkType ?? '').toLowerCase() === 'javascript').length;
      // The key-prefix catalogue costs a call; only fetch it when some URL
      // carries something that could be a 15-character id.
      const mayHoldIds = linksInScope.some((l) => /\b(?=[a-zA-Z0-9]*[0-9])[a-zA-Z0-9]{15}\b/.test(l.Url ?? ''));
      const keyPrefixes = mayHoldIds ? await readKeyPrefixes(ctx, skip) : null;
      const linkItems: FindingItem[] = [];
      for (const link of linksInScope) {
        const url = link.Url ?? '';
        const hosts = hardcodedHostsIn(url);
        const ids = hardcodedIdsIn(url, keyPrefixes);
        if (hosts.length === 0 && ids.length === 0) continue;
        const object = link.EntityDefinition?.DurableId ?? null;
        linkItems.push({
          id: link.Id,
          name: link.Name,
          setupUrl: object
            ? setupUrl(ctx.lightningHost, `ObjectManager/${object}/ButtonsLinksActions/${link.Id}/view`)
            : setupUrl(ctx.lightningHost, 'ObjectManager/home'),
          evidence: {
            Object: object,
            'Hard-coded host': hosts.join(', ') || null,
            'Hard-coded ids': ids.length || null,
            Type: link.LinkType,
            Opens: link.OpenType,
          },
        });
      }
      if (links.truncated) warnings.push('Only the first 5,000 custom buttons and links were read.');
      outcomes.push(finding('ops', RULES.hardcodedUrls, linkItems));
    }

    /* --- Daily API usage, from the limits endpoint --------------------- */
    let apiUsed: { value: number | string; sub?: string; meter?: number } = { value: '—', sub: 'limits not readable' };
    try {
      const limits = await ctx.client.getLimits();
      const daily = limits.DailyApiRequests;
      if (daily) {
        const used = daily.Max - daily.Remaining;
        apiUsed = { value: used.toLocaleString(), sub: `of ${daily.Max.toLocaleString()} calls`, meter: daily.Max ? used / daily.Max : 0 };
      }
    } catch {
      /* the metric is a courtesy */
    }

    const summary = summarise(RULES, outcomes);
    if (summary.unevaluated.length > 0) {
      warnings.push(
        `${summary.unevaluated.length} check(s) in this area could not be evaluated and are not reflected in the findings: ${summary.unevaluated.join(', ')}. The score is held back accordingly.`,
      );
    }

    const count = (id: string) => summary.findings.find((f) => f.id === id)?.items.length ?? 0;
    const metrics: AnalyzerOutput['metrics'] = {
      'Scheduled jobs': { value: cron?.records.length ?? '—' },
      [`Failed Apex jobs (${RECENT_DAYS}d)`]: { value: asyncJobs?.records.length ?? '—' },
      'Failed interviews': { value: hasStatus && interviews ? count(RULES.interviewsFailed.id) : '—', sub: 'flows affected' },
      'Paused interviews': { value: interviews?.records.length ?? '—' },
      'Pending approvals': { value: approvals?.records.length ?? '—' },
      [`API logins (${RECENT_DAYS}d)`]: { value: logins ? apiLoginTotal : '—' },
      'Release updates open': { value: releaseUpdates ? count(RULES.releaseUpdates.id) : '—', sub: 'can be activated now' },
      'Enforced while pending': {
        value: releaseUpdates ? pastDuePending(releaseUpdates.records) : '—',
        sub: 'never activated here',
      },
      'Announced, not yet available': { value: releaseUpdates ? nascentUpdates(releaseUpdates.records) : '—' },
      'JavaScript buttons': { value: javascriptButtons ?? '—', sub: 'Classic only' },
      'API used, last 24 hours': apiUsed,
    };

    return {
      metrics,
      findings: summary.findings,
      coverage: summary.coverage,
      warnings,
      // Ops rules count rows, not components; the score's denominator is the
      // number of jobs, interviews and approvals looked at, floored so that an
      // org with nothing running is graded on what could be checked.
      examined: Math.max(examined, 1),
    };
  },
};
