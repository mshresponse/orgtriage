/**
 * Where each metric tile's figure lives in Salesforce.
 *
 * Applied by the panel when a tile is drawn, not by the analyzers when they
 * run, so a result scanned by an older build shows the same links as a fresh
 * one and a link change never waits for a rescan. Keys are the tile labels
 * the analyzers emit; a label with no entry simply has no link.
 *
 * Paths are Setup nodes (`CompanyResourceDisk/home`) or, with a leading
 * slash, any path on the Lightning host (`/lightning/o/Report/home`). Labels
 * are the page names Setup shows.
 */
import type { AnalyzerId } from './types';

type Link = [path: string, label: string];

const STORAGE: Link = ['CompanyResourceDisk/home', 'Storage Usage'];
const SYSTEM_OVERVIEW: Link = ['SystemOverview/home', 'System Overview'];
const DEBUG_LOGS: Link = ['ApexDebugLogs/home', 'Debug Logs'];
const USERS: Link = ['ManageUsers/home', 'Users'];
const PROFILES: Link = ['EnhancedProfiles/home', 'Profiles'];
const RELEASE_UPDATES: Link = ['ReleaseUpdates/home', 'Release Updates'];
// Verified by click 2026-09-11: the Setup node is Pausedflows, not Interviews.
const FLOW_INTERVIEWS: Link = ['Pausedflows/home', 'Flow Interviews'];
const FLOWS: Link = ['Flows/home', 'Flows'];
const APEX_CLASSES: Link = ['ApexClasses/home', 'Apex Classes'];
const APEX_TRIGGERS: Link = ['ApexTriggers/home', 'Apex Triggers'];
const OBJECT_MANAGER: Link = ['ObjectManager/home', 'Object Manager'];
const APP_BUILDER: Link = ['FlexiPageList/home', 'Lightning App Builder'];
const HEALTH_CHECK: Link = ['HealthCheck/home', 'Health Check'];

export const SETUP_LINKS: Record<AnalyzerId, Record<string, Link>> = {
  limits: {
    'Data storage': STORAGE,
    'File storage': STORAGE,
    'Objects counted': STORAGE,
    'API used, last 24 hours': SYSTEM_OVERVIEW,
    'Debug logs': DEBUG_LOGS,
    'Active trace flags': DEBUG_LOGS,
  },
  access: {
    'Active users': USERS,
    'Dormant admins': USERS,
    'Permission sets': ['PermSets/home', 'Permission Sets'],
    Profiles: PROFILES,
    'Unused profiles': PROFILES,
    'Idle licence seats': ['CompanyProfileInfo/home', 'Company Information'],
  },
  ops: {
    'Scheduled jobs': ['ScheduledJobs/home', 'Scheduled Jobs'],
    'Failed Apex jobs (7d)': ['AsyncApexJobs/home', 'Apex Jobs'],
    'API logins (7d)': ['OrgLoginHistory/home', 'Login History'],
    'Failed interviews': FLOW_INTERVIEWS,
    'Paused interviews': FLOW_INTERVIEWS,
    'Release updates open': RELEASE_UPDATES,
    'Enforced while pending': RELEASE_UPDATES,
    'Announced, not yet available': RELEASE_UPDATES,
    'API used, last 24 hours': SYSTEM_OVERVIEW,
  },
  reports: {
    // The tab remembers its last scope (recent, created by me…), and a new
    // admin searching the recent list for a report that is not in it finds
    // nothing. "everything" is the All Reports scope, so the search covers
    // the org.
    Reports: ['/lightning/o/Report/home?queryScope=everything', 'All Reports'],
    Dashboards: ['/lightning/o/Dashboard/home?queryScope=everything', 'All Dashboards'],
  },
  flows: {
    Flows: FLOWS,
    'Record-triggered': FLOWS,
    'Flow versions': FLOWS,
    'Structure analysed': FLOWS,
    'Workflow rules': ['WorkflowRules/home', 'Workflow Rules'],
  },
  apex: {
    Classes: APEX_CLASSES,
    'Org-wide coverage': APEX_CLASSES,
    'Classes ≥75%': APEX_CLASSES,
    'Below API v': APEX_CLASSES,
    Triggers: APEX_TRIGGERS,
    'Objects with >1 trigger': APEX_TRIGGERS,
  },
  apexlint: {
    'Components read': APEX_CLASSES,
  },
  layouts: {
    'Page layouts': OBJECT_MANAGER,
    'Lightning pages': APP_BUILDER,
    'Regions over limit': APP_BUILDER,
  },
  fields: {
    'Custom fields': OBJECT_MANAGER,
    'Objects inspected': OBJECT_MANAGER,
  },
  security: {
    'Health Check score': HEALTH_CHECK,
    'High risk': HEALTH_CHECK,
    'Medium risk': HEALTH_CHECK,
    'Low risk': HEALTH_CHECK,
    'Meets standard': HEALTH_CHECK,
    'Settings compared': HEALTH_CHECK,
  },
};

/** The link for one tile, or null when the label has no page. */
export function setupLinkFor(
  analyzer: AnalyzerId,
  label: string,
  lightningHost: string,
): { label: string; url: string } | null {
  const entry = SETUP_LINKS[analyzer]?.[label];
  if (!entry) return null;
  const [path, name] = entry;
  return {
    label: name,
    url: path.startsWith('/')
      ? `https://${lightningHost}${path}`
      : `https://${lightningHost}/lightning/setup/${path}`,
  };
}
