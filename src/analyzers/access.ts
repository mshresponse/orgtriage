/**
 * Access analyzer — who can do what, and who should not be able to any more.
 *
 * This is the area Setup makes hardest to see. "How many people can Modify All
 * Data" has no page: profiles, permission sets and permission set groups each
 * answer a fragment of it, and the answer only exists once the three are joined.
 * Every rule here is that join, done read-only over SOQL.
 *
 * How a permission reaches a user, and how each path is covered:
 *
 *   Profile           Every user has exactly one. Its permissions live in a
 *                     permission set with `IsOwnedByProfile = true`; users are
 *                     matched to it through `User.ProfileId` rather than
 *                     through assignment rows, so the result does not depend
 *                     on whether Salesforce materialises an assignment for the
 *                     profile's own set.
 *   Permission set    A `PermissionSetAssignment` row.
 *   Permission set    An assignment carrying `PermissionSetGroupId`. The group
 *   group             is expanded through `PermissionSetGroupComponent` into
 *                     its member sets, because the dangerous permission is on
 *                     a member, not on the group.
 *
 * Muting permissions inside a group are NOT modelled — a `MutingPermissionSet`
 * can remove a permission the group would otherwise grant, so a user listed
 * here could in principle have it muted. The analyzer says so in a warning
 * rather than quietly over- or under-reporting.
 *
 * No record data is read. The User fields touched are name, username, active
 * flag, licence type, created date and last login — the same fields Setup's
 * user list shows. Licence seat counts come from `UserLicense`, which is the
 * table behind Setup > Company Information; it carries totals, not people.
 */

import type { FindingItem } from '@/shared/types';
import {
  capped,
  checkCancelled,
  daysSince,
  finding,
  inconclusive,
  isManaged,
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

/** Active holders of Modify All Data above this count is sprawl, not staffing. */
const ADMIN_SOFT_CAP = 5;
/** A privileged account unused for this long is an unguarded door. */
const DORMANT_DAYS = 90;
/**
 * An active user created at least this long ago who has never logged in is
 * holding a seat nobody has used, not a seat waiting for its first login.
 */
const NEVER_LOGGED_IN_GRACE_DAYS = 30;
/** Users listed per rule before the list is capped. */
const MAX_ITEMS = 200;
/** Assignment rows read before the scan reports itself truncated. */
const MAX_ASSIGNMENTS = 20_000;
/**
 * Active users read before the scan reports itself truncated.
 *
 * Both caps exist to bound the API cost, which is the only unbounded thing in
 * this analyzer: everything else is a fixed handful of queries. At 2,000 rows
 * per page these are ten calls each in the worst case, and an org that hits
 * either cap is told so rather than shown a quietly partial answer.
 */
const MAX_USERS = 20_000;

interface PermissionSetRow {
  Id: string;
  Name: string;
  Label: string | null;
  Type: string | null;
  NamespacePrefix: string | null;
  IsOwnedByProfile: boolean;
  ProfileId: string | null;
  Profile: { Name: string | null } | null;
  PermissionsModifyAllData: boolean;
  PermissionsViewAllData: boolean;
  PermissionsAuthorApex: boolean;
  PermissionsCustomizeApplication: boolean;
  PermissionsManageUsers: boolean;
  PermissionsPasswordNeverExpires: boolean;
}

interface AssignmentRow {
  Id: string;
  AssigneeId: string;
  PermissionSetId: string;
  PermissionSetGroupId: string | null;
  Assignee: {
    Name: string | null;
    Username: string | null;
    IsActive: boolean;
    UserType: string | null;
    LastLoginDate: string | null;
  } | null;
}

interface GroupComponentRow {
  PermissionSetGroupId: string;
  PermissionSetId: string;
}

interface UserRow {
  Id: string;
  Name: string;
  Username: string;
  IsActive: boolean;
  UserType: string | null;
  LastLoginDate: string | null;
  CreatedDate: string;
  ProfileId: string | null;
  Profile: { Name: string | null; UserLicenseId: string | null } | null;
}

/** One row of Setup > Company Information > User Licenses. Counts only. */
export interface UserLicenseRow {
  Id: string;
  Name: string;
  MasterLabel: string;
  TotalLicenses: number;
  UsedLicenses: number;
  Status: string | null;
}

interface ProfileRow {
  Id: string;
  Name: string;
  UserLicense: { Name: string | null } | null;
}

/** One privileged user, with every route that grants them the permission. */
interface Holder {
  userId: string;
  name: string;
  username: string;
  isActive: boolean;
  lastLoginDate: string | null;
  /** "Profile: System Administrator", "Permission set: Deploy", … */
  via: Set<string>;
}

const RULES = {
  adminSprawl: {
    id: 'access.admin-sprawl',
    severity: 'critical',
    title: (n) => `${n} active ${n === 1 ? 'user has' : 'users have'} Modify All Data`,
    rationale:
      'Modify All Data ignores every sharing rule, field-level security setting and validation-driven ' +
      'process in the org: the holder can read, edit and delete any record of any object, and mass-delete ' +
      'through the API. It is also the permission an attacker needs only one of. Most orgs need it for a ' +
      'handful of people and grant it to dozens because it is bundled into a profile that was cloned once ' +
      'and never trimmed.',
    remediation:
      'List the holders below and, for each, ask what they actually need: View All Data for reporting, ' +
      'View All Users for support, or object-level Modify All on the one object in question. Move the rest ' +
      'onto a profile without it, and grant the exceptions through a named permission set so the grant is ' +
      'visible and revocable.',
    docUrl:
      'https://help.salesforce.com/s/articleView?id=platform.users_profiles_view_all_mod_all.htm&type=5',
    weight: 26,
  },
  adminDormant: {
    id: 'access.admin-dormant',
    severity: 'critical',
    title: (n) =>
      `${n} ${n === 1 ? 'user holds' : 'users hold'} Modify All Data and ${n === 1 ? 'has' : 'have'} not logged in for ${DORMANT_DAYS} days`,
    rationale:
      'A privileged account nobody uses is the one nobody notices being used. Dormant admin accounts are ' +
      'commonly a departed employee whose deactivation was missed, a contractor whose engagement ended, or ' +
      'an integration user whose integration was retired — each still able to export the whole database. ' +
      `Salesforce publishes no dormancy threshold; ${DORMANT_DAYS} days is an OrgTriage recommendation.`,
    remediation:
      'Confirm with the account owner’s manager, then deactivate the user or remove the permission. If it ' +
      'is an integration user, freeze it until the integration is confirmed retired rather than deleting it.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.how_to_deactivate_users.htm&type=5',
    weight: 22,
  },
  passwordNeverExpires: {
    id: 'access.password-never-expires',
    severity: 'critical',
    title: (n) => `${n} active ${n === 1 ? 'user has' : 'users have'} “Password Never Expires”`,
    rationale:
      'The permission exempts the account from the org’s password policy entirely. It is granted to make an ' +
      'integration stop breaking at every rotation, and then stays — usually on an account that also holds ' +
      'broad data access, and whose password was set years ago.',
    remediation:
      'For integrations, move to a connected app with OAuth (JWT bearer flow) and drop the permission. For ' +
      'people, remove it and let the policy apply.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=000386101&type=1',
    weight: 20,
  },
  viewAllData: {
    id: 'access.view-all-data',
    severity: 'warning',
    title: (n) =>
      `${n} active ${n === 1 ? 'user has' : 'users have'} View All Data without Modify All Data`,
    rationale:
      'View All Data bypasses the sharing model for reads across every object. That is the right permission ' +
      'for a small number of analysts and auditors, and the wrong one as a shortcut for "this report should ' +
      'show everything" — it also exposes every other object in the org to that user, including the ones ' +
      'sharing rules were written to protect.',
    remediation:
      'Replace with the narrower grant that solves the actual case: a sharing rule, a report folder shared ' +
      'to a role, or View All on the single object being reported on.',
    docUrl:
      'https://help.salesforce.com/s/articleView?id=platform.users_profiles_view_all_mod_all.htm&type=5',
    weight: 14,
  },
  authorApex: {
    id: 'access.author-apex',
    severity: 'warning',
    title: (n) => `${n} active ${n === 1 ? 'user can' : 'users can'} author Apex`,
    rationale:
      'Author Apex lets the holder write and run code in the org, which is a superset of every other ' +
      'permission — code runs in system mode by default. In a production org it should belong to nobody, ' +
      'because production code arrives by deployment from a sandbox, not by editing.',
    remediation:
      'Remove it from production profiles and permission sets. Developers who need it need it in a sandbox; ' +
      'deployments to production go through a deployment user or a CI service account.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=000386957&type=1',
    weight: 16,
  },
  customizeApplication: {
    id: 'access.customize-application',
    severity: 'warning',
    title: (n) => `${n} active ${n === 1 ? 'user can' : 'users can'} customise the application`,
    rationale:
      'Customize Application allows changes to fields, page layouts, record types, flows and Setup itself, ' +
      'directly in production. Every one of those changes is unversioned, untested and invisible to the ' +
      'deployment pipeline until something breaks.',
    remediation:
      'Restrict it to the admin team, and make configuration changes in a sandbox and deploy them.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=000386451&type=1',
    weight: 12,
  },
  manageUsers: {
    id: 'access.manage-users',
    severity: 'warning',
    title: (n) => `${n} active ${n === 1 ? 'user can' : 'users can'} manage users`,
    rationale:
      'Manage Users can create users, reset passwords, and change the profiles and permission set assignments ' +
      'that decide what everyone else can do — which is a route to putting Modify All Data on an account of ' +
      'their choosing. Treat it as administrative access one step removed. It is frequently delegated to a ' +
      'support team as "just password resets".',
    remediation:
      'Use delegated administration for password resets and user creation within a defined role scope, ' +
      'rather than the org-wide Manage Users permission.',
    docUrl:
      'https://help.salesforce.com/s/articleView?id=platform.admin_delegate.htm&type=5',
    weight: 12,
  },
  inactiveAssignments: {
    id: 'access.inactive-user-permsets',
    severity: 'warning',
    title: (n) =>
      `${n} deactivated ${n === 1 ? 'user still holds' : 'users still hold'} permission set assignments`,
    rationale:
      'Deactivating a user stops the login but leaves every permission set assigned. If the account is ever ' +
      'reactivated — a returning employee, a mistaken bulk change — it comes back with the access it had ' +
      'the day it left, including any that was granted for a one-off task years earlier.',
    remediation:
      'Remove permission set assignments as part of the offboarding checklist, not just the licence.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.perm_sets_manage_assignments.htm&type=5',
    weight: 8,
  },
  unassignedPermSets: {
    id: 'access.permset-unassigned',
    severity: 'info',
    title: (n) => `${n} permission ${n === 1 ? 'set is' : 'sets are'} assigned to nobody`,
    rationale:
      'Permission sets with no assignees are usually abandoned experiments or the remains of a migration. ' +
      'They are harmless until someone assigns one to solve a problem without reading what else it grants.',
    remediation:
      'Delete the ones that are finished with. Keep and document any that exist deliberately for a future ' +
      'rollout, so the next admin knows the difference.',
    weight: 4,
  },
  idleLicenses: {
    id: 'access.license-idle',
    severity: 'warning',
    title: (n) => `${n} licence ${n === 1 ? 'type has' : 'types have'} seats held by users who no longer log in`,
    rationale:
      'A licence is paid for whether or not the user behind it logs in. Seats held by people who left, ' +
      'contractors who finished, or accounts created for a project that never started are the renewal ' +
      'line item nobody can explain. Salesforce shows the seat totals on Company Information but never ' +
      'joins them to login activity; this rule does that join, counting seats, not naming people. Only ' +
      'standard user types are counted: Chatter Free, portal and guest users are left out. Accounts Salesforce ' +
      'itself provisions (integration and agent users) are counted and may need a written exception.',
    remediation:
      'Deactivate or freeze the users behind the idle seats — Setup > Users, filtered by last login — and ' +
      'reassign or release the licences before the next true-up. Where a seat is held by an integration ' +
      'or a break-glass account, note it so the next audit does not raise it again.',
    // No citation yet: the "User Licenses" Help article id has not been opened
    // in a browser, and unverified Help links no longer ship (see the
    // regression test that pins every Help citation to docs/doc-links.json).
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.users_license_types_view.htm&type=5',
    weight: 10,
  },
  unusedProfiles: {
    id: 'access.profile-unused',
    severity: 'info',
    title: (n) => `${n} custom ${n === 1 ? 'profile has' : 'profiles have'} no active users`,
    rationale:
      'Unused custom profiles accumulate from cloning: each clone was made for one person, and stays after ' +
      'they move on. They are the reason "which profile grants this" takes an afternoon to answer.',
    remediation:
      'Delete the ones with no users and no licence attached to them. Where two profiles differ only by a ' +
      'permission or two, consolidate onto one profile plus a permission set.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.users_profiles_cloning.htm&type=5',
    weight: 4,
  },
} satisfies Record<string, RuleSpec>;

export const ACCESS_RULE_IDS: string[] = Object.values(RULES).map((r) => r.id);

/** The permission flags each rule keys off, in one place. */
const PERMISSION_FIELDS = [
  'PermissionsModifyAllData',
  'PermissionsViewAllData',
  'PermissionsAuthorApex',
  'PermissionsCustomizeApplication',
  'PermissionsManageUsers',
  'PermissionsPasswordNeverExpires',
] as const;

type PermissionField = (typeof PERMISSION_FIELDS)[number];

/** Human-readable route for the evidence column, e.g. "Profile: Sales User". */
export function grantLabel(set: PermissionSetRow): string {
  if (set.IsOwnedByProfile) return `Profile: ${set.Profile?.Name ?? set.Name}`;
  return `Permission set: ${set.Label ?? set.Name}`;
}

/**
 * Build the per-user holder map for one permission.
 *
 * Exported for the regression tests: the join is the part worth testing, and it
 * is pure — no client, no clock.
 */
export function holdersOf(
  field: PermissionField,
  sets: PermissionSetRow[],
  assignments: AssignmentRow[],
  groupMembers: Map<string, string[]>,
  usersByProfile: Map<string, UserRow[]>,
): Holder[] {
  const granting = new Map<string, PermissionSetRow>();
  for (const set of sets) if (set[field]) granting.set(set.Id, set);
  if (granting.size === 0) return [];

  const holders = new Map<string, Holder>();
  const add = (
    userId: string,
    facts: { name: string; username: string; isActive: boolean; lastLoginDate: string | null },
    via: string,
  ) => {
    const existing = holders.get(userId);
    if (existing) existing.via.add(via);
    else holders.set(userId, { userId, ...facts, via: new Set([via]) });
  };

  // Route 1 & 3: assignment rows, expanding any group into its member sets.
  for (const row of assignments) {
    const assignee = row.Assignee;
    if (!assignee) continue;
    const viaSets = row.PermissionSetGroupId
      ? (groupMembers.get(row.PermissionSetGroupId) ?? [])
      : [row.PermissionSetId];
    for (const setId of viaSets) {
      const set = granting.get(setId);
      if (!set) continue;
      const label = row.PermissionSetGroupId
        ? `Permission set group → ${set.Label ?? set.Name}`
        : grantLabel(set);
      add(
        row.AssigneeId,
        {
          name: assignee.Name ?? row.AssigneeId,
          username: assignee.Username ?? '',
          isActive: assignee.IsActive,
          lastLoginDate: assignee.LastLoginDate,
        },
        label,
      );
    }
  }

  // Route 2: the profile's own permission set, matched through User.ProfileId.
  for (const set of granting.values()) {
    if (!set.IsOwnedByProfile || !set.ProfileId) continue;
    for (const user of usersByProfile.get(set.ProfileId) ?? []) {
      add(
        user.Id,
        {
          name: user.Name,
          username: user.Username,
          isActive: user.IsActive,
          lastLoginDate: user.LastLoginDate,
        },
        `Profile: ${user.Profile?.Name ?? set.Profile?.Name ?? set.Name}`,
      );
    }
  }

  return [...holders.values()];
}

function holderItem(holder: Holder, lightningHost: string, extra: Record<string, string | number | null> = {}): FindingItem {
  const days = daysSince(holder.lastLoginDate);
  return {
    id: holder.userId,
    name: holder.name,
    label: holder.username || undefined,
    // noredirect=1 keeps a fresh load (new tab) on the Setup user detail page;
    // without it Lightning bounces to the User record page in the Sales app.
    setupUrl: setupUrl(lightningHost, `ManageUsers/page?address=%2F${holder.userId}%3Fnoredirect%3D1`),
    evidence: {
      Username: holder.username || null,
      'Granted by': [...holder.via].sort().join(', '),
      'Last login': holder.lastLoginDate ? `${days} days ago` : 'never',
      ...extra,
    },
  };
}

const byName = (a: FindingItem, b: FindingItem) => a.name.localeCompare(b.name);

/** Seat arithmetic for one licence type, from counts alone. */
export interface LicenseUtilisation {
  license: UserLicenseRow;
  /** Seats bought, or null where Salesforce reports no ceiling. */
  total: number | null;
  /** Salesforce's own count of seats in use (`UsedLicenses`). */
  used: number;
  /** Seats bought and not assigned. */
  free: number | null;
  /** Active users on this licence with no login in {@link DORMANT_DAYS}, never-logged-in ones included. */
  idle: number;
  /** Active users on this licence who have never logged in and were created before the grace period. */
  neverLoggedIn: number;
}

/**
 * Joins the licence table to the active users, by `Profile.UserLicenseId`.
 *
 * Pure so it can be tested on fixtures: given the licence rows and the active
 * users, returns one entry per licence type, sorted by idle seats descending.
 * Users whose profile carries no licence id (a possibility for some platform
 * licences and for a truncated read) are counted under no licence at all
 * rather than guessed.
 */
export function licenseUtilisation(
  licenses: UserLicenseRow[],
  users: Pick<UserRow, 'IsActive' | 'UserType' | 'LastLoginDate' | 'CreatedDate' | 'Profile'>[],
  now = Date.now(),
): LicenseUtilisation[] {
  const idleBy = new Map<string, { idle: number; never: number }>();
  for (const user of users) {
    if (!user.IsActive) continue;
    // Standard users only. Chatter Free (CsnOnly), portal, partner and guest
    // user types sit on licences that are free or priced differently, and a
    // "seat nobody uses" claim about them is noise.
    if ((user.UserType ?? 'Standard') !== 'Standard') continue;
    const licenseId = user.Profile?.UserLicenseId;
    if (!licenseId) continue;
    const age = daysSince(user.CreatedDate, now);
    const sinceLogin = daysSince(user.LastLoginDate, now);
    const neverLoggedIn = user.LastLoginDate === null && age !== null && age >= NEVER_LOGGED_IN_GRACE_DAYS;
    const dormant = sinceLogin !== null && sinceLogin >= DORMANT_DAYS;
    if (!neverLoggedIn && !dormant) continue;
    const bucket = idleBy.get(licenseId) ?? { idle: 0, never: 0 };
    bucket.idle += 1;
    if (neverLoggedIn) bucket.never += 1;
    idleBy.set(licenseId, bucket);
  }
  return licenses
    .map((license) => {
      const total = license.TotalLicenses >= 0 ? license.TotalLicenses : null;
      const counts = idleBy.get(license.Id) ?? { idle: 0, never: 0 };
      return {
        license,
        total,
        used: license.UsedLicenses,
        free: total === null ? null : Math.max(0, total - license.UsedLicenses),
        idle: counts.idle,
        neverLoggedIn: counts.never,
      };
    })
    .sort((a, b) => b.idle - a.idle || a.license.MasterLabel.localeCompare(b.license.MasterLabel));
}

export const accessAnalyzer: Analyzer = {
  id: 'access',
  label: 'Access',

  async *run(ctx: AnalyzerContext): AsyncGenerator<Phase, AnalyzerOutput, void> {
    const warnings: string[] = [];
    const outcomes: RuleOutcome[] = [];
    const skip = (reason: string) => warnings.push(reason);
    let truncated: AnalyzerOutput['truncated'];

    /* --- Permission sets, including the profile-owned ones -------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading profiles and permission sets', fraction: 0.1 };
    const sets = await tryQuery(
      () =>
        ctx.client.query<PermissionSetRow>(
          'SELECT Id, Name, Label, Type, NamespacePrefix, IsOwnedByProfile, ProfileId, Profile.Name, ' +
            `${PERMISSION_FIELDS.join(', ')} FROM PermissionSet`,
        ),
      skip,
      'Permission sets',
    );

    if (!sets) {
      // Without the permission sets nothing in this analyzer can be decided.
      for (const rule of Object.values(RULES)) {
        outcomes.push(
          inconclusive(
            'access',
            rule,
            'PermissionSet could not be queried. This analyzer needs View Setup and Configuration.',
          ),
        );
      }
      const summary = summarise(RULES, outcomes);
      return {
        metrics: { 'Permission sets': { value: '—' }, 'Active users': { value: '—' } },
        findings: summary.findings,
        coverage: summary.coverage,
        warnings,
        examined: 1,
      };
    }

    /* --- Permission set groups, expanded into their members ------------- */
    checkCancelled(ctx);
    yield { phase: 'Expanding permission set groups', fraction: 0.25 };
    const groupMembers = new Map<string, string[]>();
    const components = await tryQuery(
      () =>
        ctx.client.query<GroupComponentRow>(
          'SELECT PermissionSetGroupId, PermissionSetId FROM PermissionSetGroupComponent',
        ),
      skip,
      'Permission set groups',
    );
    if (components) {
      for (const row of components.records) {
        const bucket = groupMembers.get(row.PermissionSetGroupId);
        if (bucket) bucket.push(row.PermissionSetId);
        else groupMembers.set(row.PermissionSetGroupId, [row.PermissionSetId]);
      }
      if (groupMembers.size > 0) {
        warnings.push(
          'Permission set groups are expanded into their member sets. Muting permission sets inside a ' +
            'group are not modelled, so a user listed below could have the permission muted at group level.',
        );
      }
    } else {
      warnings.push(
        'Permission set groups could not be read, so a permission granted only through a group is not counted below.',
      );
    }

    /* --- Assignments ---------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading permission set assignments', fraction: 0.45 };
    const assignments = await tryQuery(
      () =>
        ctx.client.query<AssignmentRow>(
          'SELECT Id, AssigneeId, PermissionSetId, PermissionSetGroupId, Assignee.Name, Assignee.Username, ' +
            'Assignee.IsActive, Assignee.UserType, Assignee.LastLoginDate FROM PermissionSetAssignment',
          { maxRecords: MAX_ASSIGNMENTS },
        ),
      skip,
      'Permission set assignments',
    );
    if (assignments?.truncated) {
      truncated = {
        reason: `Only the first ${MAX_ASSIGNMENTS.toLocaleString()} permission set assignments were read.`,
        examined: assignments.records.length,
        total: assignments.totalSize,
      };
    }

    /* --- Users, for the profile route and the licence picture ----------- */
    checkCancelled(ctx);
    yield { phase: 'Reading users', fraction: 0.65 };
    const users = await tryQuery(
      () =>
        ctx.client.query<UserRow>(
          'SELECT Id, Name, Username, IsActive, UserType, LastLoginDate, CreatedDate, ProfileId, ' +
            'Profile.Name, Profile.UserLicenseId FROM User WHERE IsActive = true',
          { maxRecords: MAX_USERS },
        ),
      skip,
      'Users',
    );
    const usersByProfile = new Map<string, UserRow[]>();
    for (const user of users?.records ?? []) {
      if (!user.ProfileId) continue;
      const bucket = usersByProfile.get(user.ProfileId);
      if (bucket) bucket.push(user);
      else usersByProfile.set(user.ProfileId, [user]);
    }

    if (users?.truncated) {
      truncated = {
        reason: `Only the first ${MAX_USERS.toLocaleString()} active users were read, so a permission held solely through a profile may be undercounted.`,
        examined: users.records.length,
        total: users.totalSize,
      };
    }

    const activeUsers = users?.records.length ?? 0;
    const examined = Math.max(1, activeUsers + sets.records.length);

    /* --- Permission rules ----------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Joining permissions to users', fraction: 0.8 };

    // A permission reaches a user by profile (through `users`) or by
    // assignment (through `assignments`, expanded through groups). With either
    // route unreadable, "who holds this" has no complete answer: this used to
    // proceed with an empty list for the missing route and report the holders
    // it could see as all of them. A truncated assignment list is the same
    // problem in a milder form, and is reported on the negative verdicts below.
    const routesMissing =
      !assignments && !users
        ? 'Neither assignments nor users could be read.'
        : !assignments
          ? 'Permission set assignments could not be read, so holders by assignment are unknown.'
          : !users
            ? 'Users could not be read, so holders by profile are unknown.'
            : !components
              ? 'Permission set groups could not be expanded, so holders through a group are unknown.'
              : null;
    const holdersFor = (field: PermissionField): Holder[] | null => {
      if (routesMissing) return null;
      return holdersOf(field, sets.records, assignments?.records ?? [], groupMembers, usersByProfile);
    };

    const modifyAll = holdersFor('PermissionsModifyAllData');
    if (modifyAll === null) {
      outcomes.push(inconclusive('access', RULES.adminSprawl, routesMissing!));
      outcomes.push(inconclusive('access', RULES.adminDormant, routesMissing!));
    } else {
      const activeAdmins = modifyAll.filter((h) => h.isActive);
      // Below the soft cap this is staffing, not a finding: every org needs
      // administrators, and listing them unconditionally would make the rule
      // fire in every healthy org and teach people to ignore it.
      outcomes.push(
        finding(
          'access',
          RULES.adminSprawl,
          activeAdmins.length > ADMIN_SOFT_CAP
            ? capped(
                activeAdmins.map((h) => holderItem(h, ctx.lightningHost)).sort(byName),
                MAX_ITEMS,
                (dropped) => warnings.push(`${dropped} further Modify All Data holders are not listed.`),
              )
            : [],
        ),
      );
      outcomes.push(
        finding(
          'access',
          RULES.adminDormant,
          activeAdmins
            .filter((h) => {
              const days = daysSince(h.lastLoginDate);
              return h.lastLoginDate === null || (days !== null && days > DORMANT_DAYS);
            })
            .map((h) =>
              holderItem(h, ctx.lightningHost, {
                Status: h.lastLoginDate === null ? 'Never logged in' : 'Dormant',
              }),
            )
            .sort(byName),
        ),
      );
    }

    const simpleRules: [PermissionField, RuleSpec, (holders: Holder[]) => Holder[]][] = [
      [
        'PermissionsPasswordNeverExpires',
        RULES.passwordNeverExpires,
        (holders) => holders.filter((h) => h.isActive),
      ],
      [
        'PermissionsViewAllData',
        RULES.viewAllData,
        (holders) => {
          const admins = new Set((modifyAll ?? []).map((h) => h.userId));
          return holders.filter((h) => h.isActive && !admins.has(h.userId));
        },
      ],
      ['PermissionsAuthorApex', RULES.authorApex, (holders) => holders.filter((h) => h.isActive)],
      [
        'PermissionsCustomizeApplication',
        RULES.customizeApplication,
        (holders) => holders.filter((h) => h.isActive),
      ],
      ['PermissionsManageUsers', RULES.manageUsers, (holders) => holders.filter((h) => h.isActive)],
    ];

    for (const [field, rule, refine] of simpleRules) {
      const holders = holdersFor(field);
      if (holders === null) {
        outcomes.push(inconclusive('access', rule, routesMissing!));
        continue;
      }
      outcomes.push(
        finding(
          'access',
          rule,
          capped(
            refine(holders).map((h) => holderItem(h, ctx.lightningHost)).sort(byName),
            MAX_ITEMS,
            (dropped) => warnings.push(`${dropped} further holders of ${rule.id} are not listed.`),
          ),
        ),
      );
    }

    /* --- Hygiene rules --------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Checking for unused profiles and permission sets', fraction: 0.92 };

    if (!assignments) {
      outcomes.push(inconclusive('access', RULES.unassignedPermSets, 'Assignments could not be read.'));
      outcomes.push(inconclusive('access', RULES.inactiveAssignments, 'Assignments could not be read.'));
    } else if (assignments.truncated) {
      // "No assignee" is a claim about every assignment row; with rows unread
      // it cannot be made. The positive rules above still stand on what was read.
      const reason = `Only the first ${MAX_ASSIGNMENTS.toLocaleString()} of ${assignments.totalSize.toLocaleString()} assignments were read, so a permission set may be assigned beyond that point.`;
      outcomes.push(inconclusive('access', RULES.unassignedPermSets, reason));
      outcomes.push(inconclusive('access', RULES.inactiveAssignments, reason));
    } else {
      const assignedSetIds = new Set(assignments.records.map((a) => a.PermissionSetId));
      for (const [groupId, members] of groupMembers) {
        if (assignments.records.some((a) => a.PermissionSetGroupId === groupId)) {
          for (const id of members) assignedSetIds.add(id);
        }
      }
      outcomes.push(
        finding(
          'access',
          RULES.unassignedPermSets,
          capped(
            sets.records
              .filter(
                (s) =>
                  !s.IsOwnedByProfile &&
                  s.Type !== 'Group' &&
                  !isManaged(s, ctx.orgNamespace) &&
                  !assignedSetIds.has(s.Id),
              )
              .map((s) => ({
                id: s.Id,
                name: s.Label ?? s.Name,
                label: s.Name,
                setupUrl: setupUrl(ctx.lightningHost, 'PermSets/home'),
                evidence: { 'API name': s.Name, Assignees: 0 },
              }))
              .sort(byName),
            MAX_ITEMS,
            (dropped) => warnings.push(`${dropped} further unassigned permission sets are not listed.`),
          ),
        ),
      );

      const inactive = new Map<string, { name: string; username: string; count: number }>();
      for (const row of assignments.records) {
        if (!row.Assignee || row.Assignee.IsActive) continue;
        // A profile-owned set is assigned to every user by construction; only
        // the explicitly granted sets are an offboarding miss.
        const set = sets.records.find((s) => s.Id === row.PermissionSetId);
        if (set?.IsOwnedByProfile) continue;
        const entry = inactive.get(row.AssigneeId);
        if (entry) entry.count += 1;
        else
          inactive.set(row.AssigneeId, {
            name: row.Assignee.Name ?? row.AssigneeId,
            username: row.Assignee.Username ?? '',
            count: 1,
          });
      }
      outcomes.push(
        finding(
          'access',
          RULES.inactiveAssignments,
          capped(
            [...inactive.entries()]
              .map(([userId, entry]) => ({
                id: userId,
                name: entry.name,
                label: entry.username || undefined,
                setupUrl: setupUrl(ctx.lightningHost, `ManageUsers/page?address=%2F${userId}%3Fnoredirect%3D1`),
                evidence: { Username: entry.username || null, 'Permission sets still assigned': entry.count },
              }))
              .sort((a, b) => Number(b.evidence['Permission sets still assigned']) - Number(a.evidence['Permission sets still assigned'])),
            MAX_ITEMS,
            (dropped) => warnings.push(`${dropped} further deactivated users with assignments are not listed.`),
          ),
        ),
      );
    }

    const profiles = await tryQuery(
      () => ctx.client.query<ProfileRow>('SELECT Id, Name, UserLicense.Name FROM Profile'),
      skip,
      'Profiles',
    );
    // `Profile` has no custom flag; the profile's own permission set row does.
    // Standard profiles cannot be deleted, so without this flag the rule would
    // list Standard User, Read Only and every portal profile as clean-up work.
    const customFlags = await tryQuery(
      () =>
        ctx.client.query<{ ProfileId: string | null; IsCustom: boolean }>(
          'SELECT ProfileId, IsCustom FROM PermissionSet WHERE IsOwnedByProfile = true',
        ),
      skip,
      'Profile custom flags',
    );
    const isCustomProfile = new Map<string, boolean>();
    for (const row of customFlags?.records ?? []) {
      if (row.ProfileId) isCustomProfile.set(row.ProfileId, row.IsCustom === true);
    }
    if (!profiles || !users) {
      outcomes.push(
        inconclusive('access', RULES.unusedProfiles, 'Profiles or users could not be read.'),
      );
    } else if (!customFlags) {
      outcomes.push(
        inconclusive(
          'access',
          RULES.unusedProfiles,
          'Whether a profile is custom could not be read (PermissionSet.IsCustom), and standard profiles cannot be deleted.',
        ),
      );
    } else {
      outcomes.push(
        finding(
          'access',
          RULES.unusedProfiles,
          capped(
            profiles.records
              .filter((p) => isCustomProfile.get(p.Id) === true)
              .filter((p) => (usersByProfile.get(p.Id)?.length ?? 0) === 0)
              .map((p) => ({
                id: p.Id,
                name: p.Name,
                setupUrl: setupUrl(ctx.lightningHost, 'EnhancedProfiles/home'),
                evidence: { Licence: p.UserLicense?.Name ?? null, 'Active users': 0 },
              }))
              .sort(byName),
            MAX_ITEMS,
            (dropped) => warnings.push(`${dropped} further unused profiles are not listed.`),
          ),
        ),
      );
    }

    /* --- Licence seats ------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading licence counts', fraction: 0.9 };
    const licenses = await tryQuery(
      () =>
        ctx.client.query<UserLicenseRow>(
          'SELECT Id, Name, MasterLabel, TotalLicenses, UsedLicenses, Status FROM UserLicense',
        ),
      skip,
      'User licences',
    );
    let utilisation: LicenseUtilisation[] | null = null;
    if (!licenses || !users) {
      outcomes.push(
        inconclusive('access', RULES.idleLicenses, 'User licences or users could not be read.'),
      );
    } else if (users.truncated) {
      outcomes.push(
        inconclusive(
          'access',
          RULES.idleLicenses,
          `Only the first ${MAX_USERS.toLocaleString()} active users were read, so idle seats cannot be counted for the whole org.`,
        ),
      );
    } else {
      utilisation = licenseUtilisation(licenses.records, users.records);
      outcomes.push(
        finding(
          'access',
          RULES.idleLicenses,
          utilisation
            .filter((u) => u.idle > 0)
            .map((u) => ({
              id: u.license.Id,
              name: u.license.MasterLabel,
              setupUrl: setupUrl(ctx.lightningHost, 'CompanyProfileInfo/home'),
              evidence: {
                Seats: u.total ?? 'no ceiling',
                Assigned: u.used,
                [`Idle ${DORMANT_DAYS}d`]: u.idle,
                'Never logged in': u.neverLoggedIn,
                'Free seats': u.free,
              },
            })),
        ),
      );
    }

    const summary = summarise(RULES, outcomes);
    if (summary.unevaluated.length > 0) {
      warnings.push(
        `${summary.unevaluated.length} check(s) in this area could not be evaluated and are not reflected in the findings: ${summary.unevaluated.join(', ')}. The score is held back accordingly.`,
      );
    }

    const count = (id: string) => summary.findings.find((f) => f.id === id)?.items.length ?? 0;
    const adminCount = modifyAll?.filter((h) => h.isActive).length ?? null;
    const metrics: AnalyzerOutput['metrics'] = {
      'Active users': { value: users ? activeUsers : '—' },
      'Modify All Data': {
        value: adminCount ?? '—',
        sub: adminCount === null ? undefined : `${ADMIN_SOFT_CAP} or fewer is typical`,
        meter: adminCount === null ? undefined : Math.min(1, adminCount / (ADMIN_SOFT_CAP * 3)),
      },
      'Permission sets': { value: sets.records.filter((s) => !s.IsOwnedByProfile).length },
      Profiles: { value: profiles?.records.length ?? '—' },
      'Unused profiles': { value: profiles && users && customFlags ? count(RULES.unusedProfiles.id) : '—', sub: 'custom only' },
      'Dormant admins': { value: modifyAll ? count(RULES.adminDormant.id) : '—', sub: `no login in ${DORMANT_DAYS}d` },
      'Idle licence seats': {
        value: utilisation ? utilisation.reduce((n, u) => n + u.idle, 0) : '—',
        sub: `no login in ${DORMANT_DAYS}d, or never`,
      },
    };

    return {
      metrics,
      findings: summary.findings,
      coverage: summary.coverage,
      warnings,
      examined,
      truncated,
    };
  },
};
