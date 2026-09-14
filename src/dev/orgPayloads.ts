/**
 * Real API payloads, captured from a live Salesforce org.
 *
 * Every file in `org-payloads/` is a response this extension actually received
 * from an Enterprise Edition org on API v67.0 — trimmed to the fields the
 * analyzers read, never hand-edited. They exist because most of the defects
 * this project has had were *shape* bugs: code written against a plausible
 * reading of the docs, against a response the API does not send.
 *
 * `tools/regression.mjs` asserts the analyzer's pure functions against these,
 * so the specific misreadings that shipped once cannot ship again:
 *
 *  - a report set to All Time reads as filtered;
 *  - default standard filters suppress the full-scan rule;
 *  - a FlexiPage's facets are not walked, so a full region counts as one;
 *  - half of Salesforce's key prefixes fail an id regex;
 *  - a test class looks like a class with no coverage;
 *  - SLDS lint flags the remediation it recommends.
 *
 * Dev-only. Never imported by the extension bundles.
 */

import reportDescribes from './org-payloads/report-describes.json';
import flexiPage from './org-payloads/flexipage-metadata.json';
import apexSymbolTables from './org-payloads/apex-symbol-tables.json';
import keyPrefixes from './org-payloads/key-prefixes.json';
import compositeEligibility from './org-payloads/composite-eligibility.json';
import stylesheets from './org-payloads/stylesheets.json';

export const orgPayloads = {
  /** Nine `/analytics/reports/{id}/describe` responses, `reportMetadata` only. */
  reportDescribes,
  /** One Dynamic Forms record page: 29 flat region entries, 3 real regions. */
  flexiPage,
  /** Symbol tables including a managed test class and a managed null table. */
  apexSymbolTables,
  /** Every key prefix the org reports — 1,003 of 2,000 are not lowercase. */
  keyPrefixes,
  /** HTTP status per subrequest, showing what `/composite` will and will not take. */
  compositeEligibility,
  /** Twelve real Aura/LWC stylesheets that exercise the SLDS rules. */
  stylesheets,
};
