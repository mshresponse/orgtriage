/**
 * Layouts, Lightning pages, and SLDS conformance.
 *
 * Three sources, three different shapes:
 *
 *  - **Page layouts** — enumerated from the Tooling `Layout` object, then
 *    structured through `GET /sobjects/{type}/describe/layouts`, which returns
 *    the full section→row→item→component tree without a Metadata API call.
 *  - **Lightning pages** — Tooling `FlexiPage`, with the component tree in the
 *    `Metadata` field (single-record only, so batched through `/composite`).
 *    The one *documented* hard limit is 100 components per region, and its
 *    counting rules are non-obvious: a two-column Field Section counts as three
 *    components, and a three-tab Tabs component counts as four.
 *  - **SLDS conformance** — the custom Aura and LWC stylesheets in the org,
 *    checked against the rules the official `@salesforce-ux/slds-linter`
 *    enforces. This is the part Setup cannot tell an admin: SLDS 2 (Cosmos, GA
 *    Winter '26) dropped `--slds-c-*` component hooks and design tokens, so
 *    components using them will drift visually as orgs move over.
 *
 * Salesforce documents **no** maximum field or section count for a page layout,
 * so those thresholds are labelled as OrgTriage recommendations everywhere they
 * appear.
 */

import type { Finding, FindingItem } from '@/shared/types';
import {
  fitLinear,
  fitProvenance,
  formatMs,
  isQuotable,
  savedMs,
  type Point,
} from '@/shared/savings';
import {
  capped,
  checkCancelled,
  summarise,
  type RuleOutcome,
  finding,
  inconclusive,
  isFinding,
  isManaged,
  setupUrl,
  tryQuery,
  type Analyzer,
  type AnalyzerContext,
  type AnalyzerOutput,
  type Phase,
  type RuleSpec,
} from './framework';

/** Documented: "A Lightning page region can contain up to 100 components." */
const FLEXIPAGE_REGION_LIMIT = 100;
const FLEXIPAGE_REGION_WARN = 75;

/** Documented layout limit. */
const RELATED_LIST_LIMIT = 100;
const RELATED_LIST_WARN = 80;

/** OrgTriage recommendations — Salesforce publishes no equivalent limits. */
const LAYOUT_FIELD_RECOMMENDATION = 60;
/**
 * Components a Lightning page loads before the user can interact with it.
 *
 * Salesforce's App Builder shows a performance analysis but publishes no
 * number, so this is an OrgTriage recommendation and is labelled as one. It is
 * set where it is because a record page assembling forty components before
 * first interaction is doing so on every open, for every user, all day.
 */
const EAGER_COMPONENT_RECOMMENDATION = 40;
/** Below this a page is too small for deferring anything to be worth the churn. */
const DEFER_OPPORTUNITY_FLOOR = 20;
/** A page with at least this share of its components eager has deferred nothing. */
const DEFER_OPPORTUNITY_SHARE = 0.8;
const LAYOUT_SECTION_FIELD_RECOMMENDATION = 25;

interface LayoutRow {
  Id: string;
  Name: string;
  TableEnumOrId: string;
  LayoutType: string;
  NamespacePrefix: string | null;
  ManageableState: string | null;
}

interface FlexiPageRow {
  Id: string;
  DeveloperName: string;
  MasterLabel: string;
  Type: string;
  EntityDefinitionId: string | null;
  NamespacePrefix: string | null;
  ManageableState: string | null;
  Description: string | null;
}

interface DescribeLayoutComponent {
  value?: string;
  type?: string;
}
interface DescribeLayoutItem {
  label?: string;
  required?: boolean;
  placeholder?: boolean;
  layoutComponents?: DescribeLayoutComponent[];
}
interface DescribeLayoutSection {
  heading?: string;
  columns?: number;
  rows?: number;
  layoutRows?: { layoutItems?: DescribeLayoutItem[] }[];
}
interface DescribeLayout {
  id?: string;
  detailLayoutSections?: DescribeLayoutSection[];
  relatedLists?: unknown[];
}
interface DescribeLayoutResult {
  layouts?: DescribeLayout[];
}

/**
 * `FlexiPage.Metadata`, as a live org actually returns it.
 *
 * The shape drove three counting bugs, so it is worth being explicit:
 *
 *  - `flexiPageRegions` is **flat**. A tab's contents, a field section's
 *    columns and a column's body are not nested inside the component that owns
 *    them — they are separate top-level entries with `type: 'Facet'`, referenced
 *    by name. Only `type: 'Region'` entries are page regions in the sense the
 *    100-component limit means.
 *  - A component property's `value` is a **string**, and for a container that
 *    string is the *name of a facet*: `flexipage:fieldSection` has
 *    `columns: "Facet-8d9ed198-…"`, `flexipage:tabset` has `tabs: "maintabs"`,
 *    `flexipage:tab` and `flexipage:column` have `body: "<facet name>"`.
 *  - `valueList` was null on every property of every component inspected.
 *    Reading `columns` as a number and `tabs`/`sections` as arrays — which is
 *    what the previous code did — yielded 1 for a three-tab tabset (expected 4)
 *    and 2 for a two-column field section (expected 3).
 */
export interface FlexiPageRegion {
  name?: string;
  /** `Region` for a real page region, `Facet` for referenced content. */
  type?: string;
  mode?: string;
  itemInstances?: FlexiPageItem[];
}

interface FlexiPageItem {
  componentInstance?: {
    componentName?: string;
    componentInstanceProperties?: { name?: string; value?: string; valueList?: unknown[] }[];
  };
  fieldInstance?: unknown;
}

export interface FlexiPageMetadata {
  masterLabel?: string;
  type?: string;
  flexiPageRegions?: FlexiPageRegion[];
}

interface StyleResource {
  /** Display name for the component. */
  name: string;
  /** `Aura` or `LWC`. */
  kind: string;
  source: string;
  managed: boolean;
}

const RULES = {
  regionOverloaded: {
    id: 'flexipage.region-over-limit',
    severity: 'critical',
    title: (n) => `${n} Lightning page ${n === 1 ? 'region exceeds' : 'regions exceed'} the 100-component limit`,
    rationale:
      'Salesforce documents a hard limit of 100 components per Lightning page region. Past it, the page may ' +
      'fail to save or fail to render. Note the counting rules: a two-column Field Section counts as three ' +
      'components and a three-tab Tabs component counts as four, so the visible count understates the real one.',
    remediation: 'Move components into tabs or accordion sections in a different region, or split the page.',
    docUrl: 'https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_flexipage.htm',
    weight: 26,
  },
  regionHeavy: {
    id: 'flexipage.region-heavy',
    severity: 'warning',
    title: (n) => `${n} Lightning page ${n === 1 ? 'region is' : 'regions are'} approaching the component limit`,
    rationale:
      `More than ${FLEXIPAGE_REGION_WARN} components in one region is within the documented limit of 100 but ` +
      'close enough that the next few additions will break it — and every component adds to page load time.',
    remediation: 'Prune unused components now, before someone hits the ceiling mid-project.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.lightning_app_builder_limitations.htm&type=5',
    weight: 10,
  },
  pageEagerHeavy: {
    id: 'flexipage.page-load-heavy',
    severity: 'warning',
    title: (n) =>
      `${n} Lightning ${n === 1 ? 'page loads' : 'pages load'} more than ${EAGER_COMPONENT_RECOMMENDATION} components before the user can interact`,
    rationale:
      'Lightning page speed tracks what the page assembles *before* it is usable, not what it contains. ' +
      'Everything but the first tab of a Tabs component, and every closed accordion section, loads only when ' +
      'opened — so the number that predicts a slow page is the eagerly loaded count. These pages pay their ' +
      'full cost on every open, for every user, all day. Salesforce publishes no component budget — ' +
      `${EAGER_COMPONENT_RECOMMENDATION} loaded up front is an OrgTriage recommendation, and App Builder’s ` +
      'own Analyze panel is the authority for a specific page.',
    remediation:
      'In Lightning App Builder, move lower-priority components and field sections into tabs or accordion ' +
      'sections other than the first. Use the Analyze panel in App Builder to see Salesforce’s own reading ' +
      'after each change.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=000390330&type=1',
    weight: 12,
  },
  pageDeferOpportunity: {
    id: 'flexipage.page-defer-opportunity',
    severity: 'info',
    title: (n) => `${n} Lightning ${n === 1 ? 'page defers' : 'pages defer'} almost nothing to a tab or accordion`,
    rationale:
      'These pages are large enough to be worth splitting but load nearly everything at once. Deferring the ' +
      'secondary content is the cheapest performance change available on a record page — it is configuration, ' +
      'not code, and it does not remove anything from the page.',
    remediation:
      'Decide what a user needs in the first three seconds and leave that on the first tab. Everything else — ' +
      'related lists, history, secondary field sections — moves behind a tab.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=000390330&type=1',
    weight: 5,
  },
  slowPages: {
    id: 'flexipage.measured-slow',
    severity: 'warning',
    title: (n) => `${n} ${n === 1 ? 'page is' : 'pages are'} slow for real users`,
    rationale:
      'This is measured, not estimated: it comes from the Lightning Usage app’s own record of how long pages ' +
      'took for the people using them. A page that is heavy on paper but fast in practice needs nothing; a ' +
      'page that is slow here is costing every user who opens it, whatever its component count.',
    remediation:
      'Start with the pages highest in this list. Defer secondary content into tabs, remove components nobody ' +
      'uses, and re-check the Lightning Usage app after the next full day of traffic.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=sf.technical_requirements_measuring_ept.htm&type=5',
    weight: 10,
  },
  layoutFieldHeavy: {
    id: 'layouts.field-heavy',
    severity: 'warning',
    title: (n) => `${n} page ${n === 1 ? 'layout carries' : 'layouts carry'} a very large number of fields`,
    rationale:
      `Salesforce recommends fewer than ${LAYOUT_FIELD_RECOMMENDATION} fields on the Record Detail component. ` +
      'Above that, layouts take longer to render and are difficult to use, and long single-column layouts make ' +
      'people scroll past what matters.',
    remediation:
      'Split rarely-used fields into collapsible sections, or move them to a Lightning page tab.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.lightning_page_performance.htm&type=5',
    weight: 12,
  },
  layoutSectionHeavy: {
    id: 'layouts.section-heavy',
    severity: 'info',
    title: (n) => `${n} layout ${n === 1 ? 'section holds' : 'sections hold'} an unusually large field block`,
    rationale:
      `A single section with more than ${LAYOUT_SECTION_FIELD_RECOMMENDATION} fields is a wall of inputs with no ` +
      'visual grouping. An OrgTriage recommendation, not a platform limit.',
    remediation: 'Break the section into labelled groups that match how the record is actually filled in.',
    weight: 5,
  },
  relatedLists: {
    id: 'layouts.related-lists',
    severity: 'warning',
    title: (n) => `${n} ${n === 1 ? 'layout approaches' : 'layouts approach'} the 100 related-list limit`,
    rationale:
      'Salesforce allows at most 100 related lists on a page layout. Each one the record page renders is ' +
      'another set of rows to fetch, so a layout near the limit is a slow record open. The exception is a ' +
      'related list on a tab nobody has opened yet: those load lazily, which is the basis of the fix.',
    remediation:
      'Remove the related lists nobody uses, and move the rest to a second tab on the Lightning page so they ' +
      'load only when someone opens it. Salesforce\'s own guidance is to keep the primary tab to the few that ' +
      'matter, using Related List — Single, and to put Related List Quick Links there for the others.',
    docUrl:
      'https://help.salesforce.com/s/articleView?id=platform.customize_layoutcustomize_ple.htm&language=en_US&type=5',
    weight: 12,
  },
  noUsageRecorded: {
    id: 'flexipage.no-usage-recorded',
    severity: 'info',
    title: (n) => `${n} Lightning ${n === 1 ? 'page has' : 'pages have'} no recorded usage`,
    rationale:
      'These pages do not appear in LightningUsageByFlexiPageMetrics. That means no usage was recorded — which ' +
      'is a strong hint that the page is unassigned, but is not proof it is unused. Metrics are sampled and ' +
      'newly-created pages will not appear yet.',
    remediation:
      'Check the page’s activation in Lightning App Builder before deleting anything.',
    docUrl:
      'https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_lightning_usagebyflexipagemetrics.htm',
    weight: 4,
  },
  reportCharts: {
    id: 'flexipage.report-charts',
    severity: 'warning',
    title: (n) => `${n} Lightning ${n === 1 ? 'page runs' : 'pages run'} report charts on every view`,
    rationale:
      'Report charts on pages have their own documented refresh allowance, and it is small: 100 refreshes per ' +
      'user per hour and 3,000 across the org per hour. A chart on a record page for a busy object is opened ' +
      'far more often than a dashboard is, so these pages are where the allowance goes — and once it is spent ' +
      'the chart does not fail loudly, it quietly serves stale data with a notice, which is worse for anyone ' +
      'making a decision on it.',
    remediation:
      'Move the chart to a dashboard the page links to, or onto a tab of the page that is opened on demand rather ' +
      'than loaded with it; make sure the source report is tightly filtered.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=sf.reports_embed_limits.htm&type=5',
    weight: 8,
  },
  sldsUnsupportedHooks: {
    id: 'slds.unsupported-component-hooks',
    severity: 'warning',
    title: (n) => `${n} custom ${n === 1 ? 'stylesheet uses' : 'stylesheets use'} SLDS 1 component styling hooks`,
    rationale:
      'Component styling hooks (--slds-c-*) exist only in SLDS 1. SLDS 2 with the Cosmos theme went GA in ' +
      'Winter ’26 and does not support them, so these components will not pick up the new theme and will drift ' +
      'visually from the rest of the org as it migrates.',
    remediation:
      'Replace --slds-c-* with the global equivalents (--slds-g-*), which work in both SLDS 1 and SLDS 2. ' +
      'Salesforce offers a second route for components that genuinely need per-component control: stay on ' +
      'SLDS 1 for now — support for it continues — and revisit when component-level styling lands in SLDS 2, ' +
      'which Salesforce has said it is working on. That is a decision to record, not a reason to skip the work.',
    docUrl:
      'https://developer.salesforce.com/docs/platform/lwc/guide/create-components-css-slds1-slds2.html',
    weight: 14,
  },
  sldsPrivateVars: {
    id: 'slds.private-hooks',
    severity: 'critical',
    title: (n) => `${n} custom ${n === 1 ? 'stylesheet references' : 'stylesheets reference'} private SLDS variables`,
    rationale:
      'Variables named --slds-s-* or --_slds-* are Salesforce-internal. Their use is explicitly prohibited, they ' +
      'carry no compatibility guarantee, and they can be renamed or removed in any release without notice.',
    remediation: 'Replace every private variable with a public global styling hook (--slds-g-*).',
    docUrl:
      'https://v1.lightningdesignsystem.com/platforms/lightning/new-global-styling-hooks-guidance/',
    weight: 22,
  },
  sldsLwcTokens: {
    id: 'slds.lwc-design-tokens',
    severity: 'warning',
    title: (n) => `${n} custom ${n === 1 ? 'stylesheet uses' : 'stylesheets use'} deprecated --lwc design tokens`,
    rationale:
      'Design tokens are not supported in SLDS 2. The official SLDS linter reports --lwc-* usage as an error ' +
      '(rule lwc-token-to-slds-hook).',
    remediation: 'Replace each --lwc-* token with the corresponding --slds-g-* global styling hook.',
    docUrl: 'https://developer.salesforce.com/docs/platform/slds-linter/guide/reference-rules.html',
    weight: 12,
  },
  sldsBem: {
    id: 'slds.deprecated-bem-syntax',
    severity: 'warning',
    title: (n) => `${n} ${n === 1 ? 'file uses' : 'files use'} the retired double-dash SLDS BEM syntax`,
    rationale:
      'SLDS moved from `slds-block--modifier` to `slds-block_modifier`. The double-dash form is flagged as an ' +
      'error by the official linter (rule enforce-bem-usage) and is not guaranteed to resolve in SLDS 2.',
    remediation: 'Replace `--` with `_` in SLDS class names. `slds-linter --fix` can do this automatically.',
    docUrl: 'https://developer.salesforce.com/docs/platform/slds-linter/guide/reference-rules.html',
    weight: 10,
  },
  sldsOverrides: {
    id: 'slds.class-overrides',
    severity: 'warning',
    title: (n) => `${n} custom ${n === 1 ? 'stylesheet overrides' : 'stylesheets override'} SLDS classes directly`,
    rationale:
      'Redefining `.slds-*` selectors reaches inside the design system rather than theming it. Those internals ' +
      'change between SLDS releases, so the override silently stops working — or starts affecting components it ' +
      'was never meant to.',
    remediation: 'Use styling hooks on your own selector instead of redefining the SLDS class.',
    docUrl: 'https://developer.salesforce.com/docs/platform/lwc/guide/create-components-css-antipatterns.html',
    weight: 10,
  },
  sldsHardcoded: {
    id: 'slds.hardcoded-values',
    severity: 'info',
    title: (n) => `${n} custom ${n === 1 ? 'stylesheet hardcodes' : 'stylesheets hardcode'} colour values`,
    rationale:
      'Hard-coded colours ignore the org’s theme and both SLDS light and dark modes, and they are the main ' +
      'reason custom components look wrong after a theme change.',
    remediation: 'Replace literal colours with global styling hooks such as --slds-g-color-surface-1.',
    docUrl: 'https://developer.salesforce.com/docs/platform/slds-linter/guide/reference-rules.html',
    weight: 6,
  },
  sldsNoFallback: {
    id: 'slds.hooks-without-fallback',
    severity: 'info',
    title: (n) => `${n} custom ${n === 1 ? 'stylesheet uses' : 'stylesheets use'} SLDS hooks with no fallback value`,
    rationale:
      'A `var(--slds-g-…)` with no fallback renders as nothing if the hook is unavailable in the context the ' +
      'component is used. The official linter treats this as an error (no-slds-var-without-fallback).',
    remediation: 'Give every hook a sensible fallback: `var(--slds-g-color-surface-1, #fff)`.',
    docUrl: 'https://developer.salesforce.com/docs/platform/slds-linter/guide/reference-rules.html',
    weight: 5,
  },
} satisfies Record<string, RuleSpec>;

/** Every rule id this analyzer can raise — the playbook is checked against it. */
export const LAYOUT_RULE_IDS: string[] = Object.values(RULES).map((r) => r.id);

export const layoutsAnalyzer: Analyzer = {
  id: 'layouts',
  label: 'Layouts',

  async *run(ctx: AnalyzerContext): AsyncGenerator<Phase, AnalyzerOutput, void> {
    const warnings: string[] = [];
    const skip = (reason: string) => warnings.push(reason);
    const outcomes: RuleOutcome[] = [];

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading page layouts', fraction: 0.05 };

    const layoutResult = await tryQuery(
      () =>
        ctx.client.query<LayoutRow>(
          'SELECT Id, Name, TableEnumOrId, LayoutType, NamespacePrefix, ManageableState FROM Layout',
          { tooling: true },
        ),
      skip,
      'Page layout inventory',
    );
    const layouts = (layoutResult?.records ?? []).filter(
      (l) => ctx.includeManaged || !isManaged(l, ctx.orgNamespace),
    );

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Describing layout structure', fraction: 0.2 };

    const objectNames = await resolveObjects(ctx, layouts, skip);
    const describables = capped(
      [...new Set(layouts.map((l) => objectNames.get(l.TableEnumOrId) ?? l.TableEnumOrId))].filter(
        (name) => /^[A-Za-z][A-Za-z0-9_]*$/.test(name),
      ),
      Math.max(20, Math.floor(ctx.detailBudget / 2)),
      (dropped) =>
        warnings.push(`Layout structure was described for the first objects only; ${dropped} objects were skipped.`),
    );

    const layoutDescribe = await describeLayouts(ctx, describables, skip);
    const layoutStructure = layoutDescribe.results;

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading Lightning pages', fraction: 0.4 };

    const flexiResult = await tryQuery(
      () =>
        ctx.client.query<FlexiPageRow>(
          'SELECT Id, DeveloperName, MasterLabel, Type, EntityDefinitionId, NamespacePrefix, ' +
            'ManageableState, Description FROM FlexiPage',
          { tooling: true },
        ),
      skip,
      'Lightning page inventory',
    );
    const flexiPages = (flexiResult?.records ?? []).filter(
      (p) => ctx.includeManaged || !isManaged(p, ctx.orgNamespace),
    );

    const flexiTargets = capped(flexiPages, ctx.detailBudget, (dropped) =>
      warnings.push(`Component counts were read for the first ${ctx.detailBudget} Lightning pages; ${dropped} skipped.`),
    );
    const flexiFetch = await fetchFlexiPageMetadata(ctx, flexiTargets, skip);
    const flexiMetadata = flexiFetch.results;

    /* Measured page time, if this org's Lightning Usage schema exposes it. The
       object is described first rather than queried blind — see
       findDurationFields. */
    const usageDescribe = await tryQuery(
      () =>
        ctx.client.get<{ fields?: DescribeField[] }>(
          '/sobjects/LightningUsageByPageMetrics/describe',
        ),
      skip,
      'Lightning Usage page metrics describe',
    );
    const durationFields = usageDescribe ? findDurationFields(usageDescribe.fields ?? []) : null;
    const durationUnit = durationFields ? durationUnitOf(durationFields.sum) : null;
    // One row per page per day. Read them all (one call up to 2,000 rows) and
    // aggregate per page, rather than the top 200 by total — a total across
    // loads says nothing about a page until it is divided by the loads.
    const pageTimings = durationFields
      ? await tryQuery(
          () =>
            ctx.client.query<Record<string, unknown>>(
              `SELECT ${durationFields.page}, ${durationFields.sum}, ${durationFields.count} ` +
                'FROM LightningUsageByPageMetrics',
              { maxRecords: 2000 },
            ),
          skip,
          'Lightning Usage page metrics',
        )
      : null;
    const pageAverages =
      durationFields && durationUnit && pageTimings
        ? averagePageTimes(pageTimings.records, durationFields, durationUnit)
        : null;

    const usage = await tryQuery(
      () =>
        ctx.client.query<{ FlexiPageNameOrId: string; TotalCount: number }>(
          'SELECT FlexiPageNameOrId, FlexiPageType, TotalCount FROM LightningUsageByFlexiPageMetrics',
        ),
      skip,
      'Lightning page usage metrics',
    );

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Scanning custom component styles', fraction: 0.65 };

    const styleRead = await readStyleResources(ctx, skip);
    const styles = styleRead.resources;

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Evaluating rules', fraction: 0.9 };

    /* --- Page layout rules ------------------------------------------- */
    const fieldHeavy: FindingItem[] = [];
    const sectionHeavy: FindingItem[] = [];
    const relatedListHeavy: FindingItem[] = [];

    for (const [objectName, result] of layoutStructure) {
      for (const layout of result.layouts ?? []) {
        const stats = measureLayout(layout);
        const layoutMeta = layouts.find((l) => l.Id === layout.id);
        const displayName = layoutMeta?.Name ?? layout.id ?? objectName;

        if (stats.fields > LAYOUT_FIELD_RECOMMENDATION) {
          fieldHeavy.push({
            id: layout.id,
            name: displayName,
            label: objectName,
            evidence: {
              Fields: stats.fields,
              Required: stats.required,
              Sections: stats.sections,
              'Related lists': stats.relatedLists,
            },
          });
        }
        if (stats.largestSection > LAYOUT_SECTION_FIELD_RECOMMENDATION) {
          sectionHeavy.push({
            id: layout.id,
            name: displayName,
            label: `${objectName} · ${stats.largestSectionName}`,
            evidence: { 'Fields in section': stats.largestSection, 'Total fields': stats.fields },
          });
        }
        if (stats.relatedLists > RELATED_LIST_WARN) {
          relatedListHeavy.push({
            id: layout.id,
            name: displayName,
            label: objectName,
            evidence: { 'Related lists': stats.relatedLists, Limit: RELATED_LIST_LIMIT },
          });
        }
      }
    }

    // A verdict on layouts needs layouts: a failed inventory used to become an
    // empty list and three clean rules, and a failed describe an empty map and
    // the same. Partial describes are reported by `describeLayouts` itself.
    const layoutGap = !layoutResult
      ? 'The page layout inventory could not be read.'
      : layouts.length > 0 && !layoutDescribe.ran
        ? 'Layout structure could not be described, so no layout was measured.'
        : null;
    if (layoutGap) {
      for (const rule of [RULES.layoutFieldHeavy, RULES.layoutSectionHeavy, RULES.relatedLists]) {
        outcomes.push(inconclusive('layouts', rule, layoutGap));
      }
    } else {
      outcomes.push(finding('layouts', RULES.layoutFieldHeavy, sortByEvidence(fieldHeavy, 'Fields')));
      outcomes.push(finding('layouts', RULES.layoutSectionHeavy, sectionHeavy));
      outcomes.push(finding('layouts', RULES.relatedLists, relatedListHeavy));
    }

    /* --- Lightning page rules ---------------------------------------- */
    const overloaded: FindingItem[] = [];
    const heavy: FindingItem[] = [];
    const reportCharts: FindingItem[] = [];
    const eagerHeavy: FindingItem[] = [];
    const deferOpportunity: FindingItem[] = [];
    /* Paired observations for the cost-per-component fit: one point per page
       that has both a measured time and a component count. */
    const points: Point[] = [];
    const pageEagerByName = new Map<string, number>();

    for (const page of flexiTargets) {
      const metadata = flexiMetadata.get(page.Id);
      if (!metadata) continue;
      const charts = countComponentsNamed(metadata, REPORT_CHART_COMPONENTS);
      if (charts > 0) {
        reportCharts.push({
          id: page.Id,
          name: page.DeveloperName,
          label: page.MasterLabel,
          setupUrl: setupUrl(ctx.lightningHost, `FlexiPageList/page?address=%2F${page.Id}`),
          evidence: { 'Report charts': charts, 'Page type': page.Type },
        });
      }
      const { regions, byName } = pageRegions(metadata);

      // Page-level weight: what loads before the user can act, against what the
      // page holds in total. The gap between the two is the opportunity.
      let pageTotal = 0;
      let pageEager = 0;
      for (const region of regions) {
        pageTotal += countRegionComponents(region, byName);
        pageEager += countEagerComponents(region, byName);
      }
      const deferred = Math.max(0, pageTotal - pageEager);
      const pageItem = (extra: Record<string, string | number | null>): FindingItem => ({
        id: page.Id,
        name: page.DeveloperName,
        label: page.MasterLabel,
        setupUrl: setupUrl(ctx.lightningHost, `FlexiPageList/page?address=%2F${page.Id}`),
        evidence: {
          'Loaded up front (estimate)': pageEager,
          'Components in total': pageTotal,
          'Deferred to a tab': deferred,
          'Page type': page.Type,
          ...extra,
        },
      });

      pageEagerByName.set(page.DeveloperName.toLowerCase(), pageEager);
      if (page.MasterLabel) pageEagerByName.set(page.MasterLabel.toLowerCase(), pageEager);

      if (pageEager > EAGER_COMPONENT_RECOMMENDATION) {
        eagerHeavy.push(pageItem({ Recommendation: EAGER_COMPONENT_RECOMMENDATION }));
      } else if (
        pageTotal >= DEFER_OPPORTUNITY_FLOOR &&
        pageEager / Math.max(1, pageTotal) >= DEFER_OPPORTUNITY_SHARE
      ) {
        deferOpportunity.push(
          pageItem({ 'Share loaded up front': `${Math.round((pageEager / pageTotal) * 100)}%` }),
        );
      }

      for (const region of regions) {
        const count = countRegionComponents(region, byName);
        if (count <= FLEXIPAGE_REGION_WARN) continue;
        const item: FindingItem = {
          id: page.Id,
          name: page.DeveloperName,
          label: `${page.MasterLabel} · ${region.name ?? 'region'}`,
          setupUrl: setupUrl(ctx.lightningHost, `FlexiPageList/page?address=%2F${page.Id}`),
          evidence: {
            'Components (counted)': count,
            Region: region.name,
            'Page type': page.Type,
            Limit: FLEXIPAGE_REGION_LIMIT,
          },
        };
        if (count > FLEXIPAGE_REGION_LIMIT) overloaded.push(item);
        else heavy.push(item);
      }
    }

    /* The cost of a component, in this org.
       Measured page times are joined to component counts by page name; the fit
       is only used if it is strong enough to quote (see shared/savings.ts), and
       where it is not, no saving is shown anywhere. */
    if (pageAverages) {
      for (const [name, page] of pageAverages) {
        const eager = pageEagerByName.get(name);
        if (eager === undefined || page.loads < MIN_LOADS_FOR_TIMING) continue;
        points.push({ x: eager, y: page.averageMs });
      }
    } else if (durationFields && pageTimings) {
      warnings.push(
        `Measured page times were read from ${durationFields.sum}, but the unit of that field has not ` +
          'been verified, so no time savings are estimated from it.',
      );
    }
    const fit = fitLinear(points);
    if (points.length > 0 && !isQuotable(fit)) {
      // `isQuotable` is a type guard, so TypeScript narrows `fit` to never in
      // this branch; the weak-fit message needs the numbers, hence the local.
      const weak = fit as ReturnType<typeof fitLinear>;
      warnings.push(
        weak === null
          ? `Only ${points.length} page(s) had both a measured time and a component count, too few to estimate what a component costs in this org. No time savings are shown.`
          : `Component count explains only ${Math.round(weak.r2 * 100)}% of the variation in page time across ${weak.n} pages here, so something else is driving it. No time savings are shown.`,
      );
    }

    /* Attach the saving to each heavy page, with its provenance. */
    if (isQuotable(fit)) {
      for (const item of eagerHeavy) {
        const eager = Number(item.evidence?.['Loaded up front (estimate)'] ?? 0);
        const deferrable = Math.max(0, eager - EAGER_COMPONENT_RECOMMENDATION);
        const ms = savedMs(fit, deferrable);
        if (ms === null || item.evidence === undefined) continue;
        item.evidence['If deferred to a tab'] = `about ${formatMs(ms)} faster`;
        item.evidence['Estimate basis'] = fitProvenance(fit);
      }
      warnings.push(
        `Time savings on this tab are estimated from this org's own pages: ${fitProvenance(fit)}. They are a planning figure, not a promise — re-check the Lightning Usage app after a day of real traffic.`,
      );
    }

    const pageGap = !flexiResult
      ? 'The Lightning page inventory could not be read.'
      : flexiTargets.length > 0 && !flexiFetch.ran
        ? 'Lightning page structure could not be read, so no page was measured.'
        : null;
    const pageRules = [
      [RULES.regionOverloaded, overloaded],
      [RULES.regionHeavy, heavy],
      [RULES.pageEagerHeavy, sortByEvidence(eagerHeavy, 'Loaded up front (estimate)')],
      [RULES.pageDeferOpportunity, sortByEvidence(deferOpportunity, 'Loaded up front (estimate)')],
      [
        RULES.reportCharts,
        reportCharts.sort((a, b) => Number(b.evidence?.['Report charts']) - Number(a.evidence?.['Report charts'])),
      ],
    ] as const;
    for (const [rule, items] of pageRules) {
      outcomes.push(pageGap ? inconclusive('layouts', rule, pageGap) : finding('layouts', rule, items));
    }
    /* Measured page time. The threshold is Salesforce's own: their guidance for
       Lightning performance treats page time above three seconds as the point
       users notice. */
    if (!durationFields) {
      outcomes.push(
        inconclusive(
          'layouts',
          RULES.slowPages,
          usageDescribe
            ? 'LightningUsageByPageMetrics in this org exposes no page-duration field, so measured page time could not be read.'
            : 'LightningUsageByPageMetrics could not be described. The Lightning Usage app must be available and readable.',
        ),
      );
    } else if (!pageTimings) {
      outcomes.push(inconclusive('layouts', RULES.slowPages, 'LightningUsageByPageMetrics could not be queried.'));
    } else if (!durationUnit || !pageAverages) {
      // Better no verdict than one off by a factor of a thousand. See
      // durationUnitOf for why the unit is not guessed from the value.
      outcomes.push(
        inconclusive(
          'layouts',
          RULES.slowPages,
          `Page times were read from ${durationFields.sum}, but the unit of that field has not been verified ` +
            'against the Lightning Usage app, so no page is called slow on the strength of it.',
        ),
      );
    } else {
      const SLOW_MS = 3000;
      outcomes.push(
        finding(
          'layouts',
          RULES.slowPages,
          [...pageAverages.values()]
            // A page loaded once at 5 s is an anecdote; the minimum is ours.
            .filter((p) => p.loads >= MIN_LOADS_FOR_TIMING && p.averageMs >= SLOW_MS)
            .sort((a, b) => b.averageMs - a.averageMs)
            .slice(0, 40)
            .map((p) => ({
              name: p.name,
              setupUrl: setupUrl(ctx.lightningHost, 'FlexiPageList/home'),
              evidence: {
                'Average page time': `${(p.averageMs / 1000).toFixed(1)} s`,
                Loads: p.loads,
                Source: `Lightning Usage app · ${durationFields.sum} ÷ ${durationFields.count}`,
                Target: 'under 3 s',
                'Minimum loads (OrgTriage)': MIN_LOADS_FOR_TIMING,
              },
            })),
        ),
      );
    }

    if (usage) {
      const used = new Set(usage.records.map((r) => r.FlexiPageNameOrId));
      outcomes.push(
        finding(
          'layouts',
          RULES.noUsageRecorded,
          flexiPages
            .filter((p) => p.Type === 'RecordPage' || p.Type === 'AppPage' || p.Type === 'HomePage')
            .filter((p) => !used.has(p.DeveloperName) && !used.has(p.Id))
            .map((p) => ({
              id: p.Id,
              name: p.DeveloperName,
              label: p.MasterLabel,
              evidence: { Type: p.Type, 'Usage records': 0 },
            })),
        ),
      );
    } else {
      outcomes.push(
        inconclusive(
          'layouts',
          RULES.noUsageRecorded,
          'LightningUsageByFlexiPageMetrics was not readable, so page usage could not be checked.',
        ),
      );
    }

    /* --- SLDS conformance -------------------------------------------- */
    const sldsRules = [
      RULES.sldsPrivateVars,
      RULES.sldsUnsupportedHooks,
      RULES.sldsLwcTokens,
      RULES.sldsBem,
      RULES.sldsOverrides,
      RULES.sldsHardcoded,
      RULES.sldsNoFallback,
    ];
    if (!styleRead.lwcRead && !styleRead.auraRead) {
      for (const rule of sldsRules) {
        outcomes.push(inconclusive('layouts', rule, 'Neither LWC nor Aura stylesheets could be read.'));
      }
    } else {
      // Both families read and nothing found is a clean bill: an org with no
      // custom CSS has no SLDS debt. One family unread is handled below.
      const checks = styles.map((resource) => ({ resource, result: lintSlds(resource.source) }));
      const collect = (
        predicate: (r: SldsLintResult) => number,
        label: string,
      ): FindingItem[] =>
        checks
          .filter(({ result }) => predicate(result) > 0)
          .sort((a, b) => predicate(b.result) - predicate(a.result))
          .map(({ resource, result }) => ({
            name: resource.name,
            label: resource.kind,
            evidence: {
              [label]: predicate(result),
              Examples: sampleOf(result, label),
              Type: resource.kind,
            },
          }));

      outcomes.push(finding('layouts', RULES.sldsPrivateVars, collect((r) => r.privateVars.length, 'Occurrences')));
      outcomes.push(
        finding('layouts', RULES.sldsUnsupportedHooks, collect((r) => r.componentHooks.length, 'Occurrences')),
      );
      outcomes.push(finding('layouts', RULES.sldsLwcTokens, collect((r) => r.lwcTokens.length, 'Occurrences')));
      outcomes.push(finding('layouts', RULES.sldsBem, collect((r) => r.bemDoubleDash.length, 'Occurrences')));
      outcomes.push(finding('layouts', RULES.sldsOverrides, collect((r) => r.classOverrides.length, 'Occurrences')));
      outcomes.push(finding('layouts', RULES.sldsHardcoded, collect((r) => r.hardcodedColors.length, 'Occurrences')));
      outcomes.push(finding('layouts', RULES.sldsNoFallback, collect((r) => r.hooksWithoutFallback.length, 'Occurrences')));

      if (!styleRead.lwcRead || !styleRead.auraRead) {
        const missing = styleRead.lwcRead ? 'Aura' : 'LWC';
        warnings.push(`${missing} stylesheets could not be read; SLDS findings cover ${styleRead.lwcRead ? 'LWC' : 'Aura'} components only.`);
        // What was found stands. What was *not* found has only half its evidence.
        const sldsIds = new Set(sldsRules.map((r) => r.id));
        for (let i = 0; i < outcomes.length; i++) {
          const outcome = outcomes[i];
          if (outcome && !isFinding(outcome) && sldsIds.has(outcome.cleanRuleId)) {
            const rule = sldsRules.find((r) => r.id === outcome.cleanRuleId)!;
            outcomes[i] = inconclusive('layouts', rule, `${missing} stylesheets could not be read, so this rule saw only part of the org's custom CSS.`);
          }
        }
      }
    }

    /* ---------------------------------------------------------------- */
    const totalFields = [...layoutStructure.values()]
      .flatMap((r) => r.layouts ?? [])
      .reduce((sum, l) => sum + measureLayout(l).fields, 0);
    const describedLayouts = [...layoutStructure.values()].reduce(
      (sum, r) => sum + (r.layouts?.length ?? 0),
      0,
    );

    const metrics: AnalyzerOutput['metrics'] = {
      'Page layouts': { value: layouts.length, sub: `${describedLayouts} described` },
      'Lightning pages': { value: flexiPages.length },
      'Avg fields / layout': {
        value: describedLayouts > 0 ? Math.round(totalFields / describedLayouts) : 0,
        sub: `recommendation ≤ ${LAYOUT_FIELD_RECOMMENDATION}`,
      },
      'Regions over limit': { value: overloaded.length, sub: `limit ${FLEXIPAGE_REGION_LIMIT}/region` },
      'Stylesheets scanned': { value: styles.length, sub: 'Aura + LWC' },
      'SLDS 2 blockers': {
        value: styles.filter((s) => {
          const r = lintSlds(s.source);
          return r.componentHooks.length > 0 || r.privateVars.length > 0 || r.lwcTokens.length > 0;
        }).length,
        sub: 'files needing migration',
      },
    };

    const summary = summarise(RULES, outcomes);
    if (summary.unevaluated.length > 0) {
      warnings.push(
        `${summary.unevaluated.length} check(s) in this area could not be evaluated and are not ` +
          `reflected in the findings: ${summary.unevaluated.join(', ')}. The score is held back ` +
          'accordingly.',
      );
    }

    return {
      metrics,
      findings: summary.findings,
      coverage: summary.coverage,
      warnings,
      examined: layouts.length + flexiPages.length + styles.length,
      truncated:
        flexiTargets.length < flexiPages.length
          ? {
              reason: 'The per-page component-count budget was reached.',
              examined: flexiTargets.length,
              total: flexiPages.length,
            }
          : undefined,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Layout measurement                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Count fields, required fields, sections, and related lists on one layout.
 * Placeholder items are blank grid cells, not fields, and are skipped.
 */
function measureLayout(layout: DescribeLayout): {
  fields: number;
  required: number;
  sections: number;
  relatedLists: number;
  largestSection: number;
  largestSectionName: string;
} {
  let fields = 0;
  let required = 0;
  let largestSection = 0;
  let largestSectionName = '';

  for (const section of layout.detailLayoutSections ?? []) {
    let sectionFields = 0;
    for (const row of section.layoutRows ?? []) {
      for (const item of row.layoutItems ?? []) {
        if (item.placeholder) continue;
        const components = item.layoutComponents ?? [];
        if (components.length === 0) continue;
        sectionFields += 1;
        if (item.required) required += 1;
      }
    }
    fields += sectionFields;
    if (sectionFields > largestSection) {
      largestSection = sectionFields;
      largestSectionName = section.heading ?? 'Untitled section';
    }
  }

  return {
    fields,
    required,
    sections: (layout.detailLayoutSections ?? []).length,
    relatedLists: (layout.relatedLists ?? []).length,
    largestSection,
    largestSectionName,
  };
}

/**
 * How many components a region really holds, following facet references.
 *
 * Salesforce's limit is on components per region, and everything a tab or a
 * field section contains lives in a separate facet region. Counting only the
 * items directly under the region therefore undercounts every page built with
 * tabs or Dynamic Forms — which is to say every modern record page — and the
 * pages nearest the limit are the ones it undercounts most.
 *
 * Any property value that names another region is followed, which handles
 * `tabset.tabs`, `tab.body`, `fieldSection.columns`, `column.body` and
 * `accordion.sections` without special-casing component names. `seen` guards
 * against a malformed page whose facets reference each other in a cycle.
 */
export function countRegionComponents(
  region: FlexiPageRegion,
  regionsByName: Map<string, FlexiPageRegion>,
  seen: Set<string> = new Set(),
): number {
  const name = region.name ?? '';
  if (name && seen.has(name)) return 0;
  if (name) seen.add(name);

  let count = 0;
  for (const item of region.itemInstances ?? []) {
    const instance = item.componentInstance;
    if (!instance) {
      count += 1; // a bare field instance — one component on the page
      continue;
    }
    count += 1;

    for (const prop of instance.componentInstanceProperties ?? []) {
      const value = prop.value;
      if (typeof value !== 'string' || value === '') continue;
      const target = regionsByName.get(value);
      // Only a value that names a *different* region is a facet reference;
      // "false", "3" and "Standard.Tab.detail" are ordinary property values.
      if (target && target !== region) {
        count += countRegionComponents(target, regionsByName, seen);
      }
    }
  }
  return count;
}

/**
 * The page's real regions, and a lookup for resolving facet references.
 *
 * A facet is only ever content *of* a region, so counting facets as regions in
 * their own right both inflates the region count and reports the same
 * components twice.
 */
/** Containers whose non-first child is deferred until the user opens it. */
const DEFERRING_CONTAINERS = new Set(['flexipage:tabset', 'flexipage:accordion']);

/**
 * Components the user waits for before the page is usable.
 *
 * Salesforce's own performance guidance for Lightning pages is to move
 * lower-priority content into tabs or accordion sections, because everything
 * but the first tab lazy-loads. So the number that predicts a slow page is not
 * the total component count — a page with sixty components behind five tabs can
 * be faster than one with twenty all on the first screen.
 *
 * This walks the page the same way {@link countRegionComponents} does, but when
 * it meets a tabset or an accordion it follows only the first child's body and
 * counts the remaining tabs as headers alone. That is an approximation of what
 * the framework actually defers, and it is labelled an estimate wherever it is
 * shown.
 */
export function countEagerComponents(
  region: FlexiPageRegion,
  regionsByName: Map<string, FlexiPageRegion>,
  seen: Set<string> = new Set(),
): number {
  const name = region.name ?? '';
  if (name && seen.has(name)) return 0;
  if (name) seen.add(name);

  let count = 0;
  for (const item of region.itemInstances ?? []) {
    const instance = item.componentInstance;
    if (!instance) {
      count += 1;
      continue;
    }
    count += 1;

    const defers = DEFERRING_CONTAINERS.has(instance.componentName ?? '');
    for (const prop of instance.componentInstanceProperties ?? []) {
      const value = prop.value;
      if (typeof value !== 'string' || value === '') continue;
      const target = regionsByName.get(value);
      if (!target || target === region) continue;

      if (!defers) {
        count += countEagerComponents(target, regionsByName, seen);
        continue;
      }

      // A tabset's facet holds one entry per tab. The first tab's body is on
      // screen at load; the rest are a header each until the user clicks.
      const children = target.itemInstances ?? [];
      children.forEach((child, index) => {
        count += 1;
        if (index !== 0) return;
        for (const childProp of child.componentInstance?.componentInstanceProperties ?? []) {
          const childValue = childProp.value;
          if (typeof childValue !== 'string' || childValue === '') continue;
          const body = regionsByName.get(childValue);
          if (body && body !== target) count += countEagerComponents(body, regionsByName, seen);
        }
      });
    }
  }
  return count;
}

export function pageRegions(metadata: FlexiPageMetadata): {
  regions: FlexiPageRegion[];
  byName: Map<string, FlexiPageRegion>;
} {
  const all = metadata.flexiPageRegions ?? [];
  const byName = new Map<string, FlexiPageRegion>();
  for (const region of all) {
    if (region.name) byName.set(region.name, region);
  }
  // Older pages omit `type`; treat an untyped region as a real one, since a
  // facet is always explicitly typed.
  const regions = all.filter((r) => (r.type ?? 'Region') !== 'Facet');
  return { regions, byName };
}


/* -------------------------------------------------------------------------- */
/* Measured page time                                                         */
/* -------------------------------------------------------------------------- */

/** Field names that carry a page duration, best first. */
/** Field names that identify the page a row is about. */
const PAGE_NAME_FIELD = /^(pagename|name|flexipagenameorid|apppagename)$/i;
/** Fewer loads than this and an average page time is an anecdote. Ours, not Salesforce's. */
export const MIN_LOADS_FOR_TIMING = 3;

interface DescribeField {
  name?: string;
  type?: string;
  filterable?: boolean;
}

/**
 * Work out, at run time, whether this org's Lightning Usage objects expose a
 * page duration and what the field is called.
 *
 * The schema of the Lightning Usage objects is not something to hard-code from
 * memory: the fields differ by release, and a wrong field name would make this
 * rule fail on every org rather than on none. Describing the object costs one
 * call and turns a guess into a fact — and when the field genuinely is not
 * there, the rule reports itself unevaluated instead of silently passing.
 */
/**
 * The unit a `LightningUsageByPageMetrics` sum-of-time field is expressed in.
 *
 * A field earns an entry only once its values have been measured in a real
 * org. The previous code guessed from magnitude — "under 100 must be
 * seconds" — which turns a 50 ms page into a 50-second one and a 120-second
 * page into 0.12 s, and then called the result "measured".
 *
 * `SumEPT`: **milliseconds**, measured 2026‑09‑09 (docs/FACTS.md, "Measured").
 * `SumEPT ÷ RecordCountEPT` for single-load rows came to 436, 491, 711 and
 * 805 on real pages; per-load figures that size fit no unit but milliseconds
 * — as seconds they are seven-minute page loads, as microseconds they are
 * faster than a network round trip. Anything not listed here is unknown, and
 * a rule built on an unknown unit is reported as not evaluated.
 */
export const VERIFIED_DURATION_UNITS: Readonly<Record<string, 'ms' | 's'>> = { SumEPT: 'ms' };

export function durationUnitOf(field: string): 'ms' | 's' | null {
  return VERIFIED_DURATION_UNITS[field] ?? null;
}

export function toMilliseconds(value: number, unit: 'ms' | 's'): number {
  return unit === 's' ? value * 1000 : value;
}

export interface DurationFields {
  /** The page identifier column. */
  page: string;
  /** Total experienced page time across the row's loads. */
  sum: string;
  /** How many loads that total covers. */
  count: string;
}

/**
 * The pair of fields a per-load page time can be computed from.
 *
 * Explicit names, matched case-insensitively, rather than a pattern: the
 * object also carries `EptBin*` histogram counts and `RecordCountEPT`, all of
 * which match a loose `/ept/`, and the old pattern took whichever the describe
 * listed first — a *count of loads* read as a duration. `SumEPT` alone is not
 * a page time either; it is a total across every load in the row.
 */
export function findDurationFields(fields: DescribeField[]): DurationFields | null {
  const named = (name: string) => fields.find((f) => typeof f.name === 'string' && f.name.toLowerCase() === name.toLowerCase())?.name;
  const sum = named('SumEPT');
  const count = named('RecordCountEPT');
  const page = fields.find((f) => typeof f.name === 'string' && PAGE_NAME_FIELD.test(f.name!))?.name;
  if (!sum || !count || !page) return null;
  return { page, sum, count };
}

export interface PageTiming {
  name: string;
  loads: number;
  averageMs: number;
}

/**
 * Per-page average load time from the daily rows, keyed by lower-cased page
 * name for the join to component counts. Rows with no loads contribute
 * nothing: a zero-count row is a page that was rendered but not timed.
 */
export function averagePageTimes(
  rows: Array<Record<string, unknown>>,
  fields: DurationFields,
  unit: 'ms' | 's',
): Map<string, PageTiming> {
  const totals = new Map<string, { name: string; sum: number; loads: number }>();
  for (const row of rows) {
    const name = String(row[fields.page] ?? '').trim();
    const loads = Number(row[fields.count] ?? 0);
    const sum = Number(row[fields.sum] ?? 0);
    if (!name || !(loads > 0) || !Number.isFinite(sum)) continue;
    const key = name.toLowerCase();
    const entry = totals.get(key) ?? { name, sum: 0, loads: 0 };
    entry.sum += sum;
    entry.loads += loads;
    totals.set(key, entry);
  }
  const out = new Map<string, PageTiming>();
  for (const [key, t] of totals) {
    out.set(key, { name: t.name, loads: t.loads, averageMs: toMilliseconds(t.sum / t.loads, unit) });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* SLDS linting                                                               */
/* -------------------------------------------------------------------------- */

export interface SldsLintResult {
  /** `--slds-c-*` — SLDS 1 only, unsupported under SLDS 2 / Cosmos. */
  componentHooks: string[];
  /** `--slds-s-*` and `--_slds-*` — private, prohibited. */
  privateVars: string[];
  /** `--lwc-*` design tokens — unsupported in SLDS 2. */
  lwcTokens: string[];
  /** `slds-block--modifier` — retired BEM syntax. */
  bemDoubleDash: string[];
  /** Rules that redefine `.slds-*` selectors. */
  classOverrides: string[];
  /** Literal colours where a hook belongs. */
  hardcodedColors: string[];
  /** `var(--slds-…)` with no fallback. */
  hooksWithoutFallback: string[];
}

/**
 * Static SLDS conformance checks over one stylesheet or template.
 *
 * These mirror rules the official `@salesforce-ux/slds-linter` enforces, so an
 * admin can act on the output without arguing about whether it counts. Comments
 * are stripped first so a commented-out example is not reported as live code.
 */
export function lintSlds(source: string): SldsLintResult {
  // Order matters. Comments go first, then string and url() contents are
  // blanked (length-preserving, so nothing else shifts): without this,
  // `content: "#abc"` was reported as a hardcoded colour and
  // `url(/resource/slds-icons--v2/…)` as retired BEM syntax.
  const css = blankStringsAndUrls(
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, ''),
  );

  const all = (pattern: RegExp): string[] => [...new Set(css.match(pattern) ?? [])];

  // Fallback values inside `var()` are the remediation `hooksWithoutFallback`
  // recommends, so flagging the colour inside one contradicts the advice this
  // same lint gives. Blank the fallback argument before looking for colours.
  const cssOutsideVarFallbacks = css.replace(
    /var\(\s*--[a-zA-Z0-9-]+\s*,([^()]*(?:\([^()]*\)[^()]*)*)\)/g,
    (match, fallback: string) => match.slice(0, match.length - fallback.length - 1) + ' '.repeat(fallback.length) + ')',
  );

  return {
    componentHooks: all(/--slds-c-[a-z0-9-]+/gi),
    privateVars: all(/--(?:_slds|slds-s)-[a-z0-9-]+/gi),
    lwcTokens: all(/--lwc-[a-zA-Z0-9-]+/g),
    bemDoubleDash: all(/\bslds-[a-z0-9]+(?:-[a-z0-9]+)*--[a-z0-9-]+/gi),
    // `.slds-scope` is the documented container that scopes SLDS inside
    // Visualforce and Aura. Using it is the supported pattern, not an override.
    classOverrides: all(/(?:^|[\s,>+~])\.slds-[a-z0-9_-]+(?=[\s,{:.[])/gim)
      .map((match) => match.trim())
      .filter((selector) => !SLDS_SCOPE_CLASSES.has(selector)),
    // Hex literals and rgb()/hsl() functions. `currentColor`, `transparent`,
    // `inherit`, and the like are intentionally not flagged. The `rgb()` form
    // allows one level of nesting so `rgba(var(--x), .5)` matches whole rather
    // than stopping at the first `)`.
    hardcodedColors: [
      ...new Set(
        cssOutsideVarFallbacks.match(
          /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\([^()]*(?:\([^()]*\)[^()]*)*\)/gi,
        ) ?? [],
      ),
    ],
    hooksWithoutFallback: all(/var\(\s*--slds-[a-z0-9-]+\s*\)/gi),
  };
}

/** Selectors that scope SLDS rather than override it. */
const SLDS_SCOPE_CLASSES = new Set(['.slds-scope', '.slds-vf-scope']);

/**
 * Replace the contents of quoted strings and `url()` arguments with spaces.
 *
 * Length-preserving so every other offset in the sheet stays valid. This is
 * what stops `content: "#abc"` reading as a colour literal and
 * `url(/resource/slds-icons--v2/x.svg)` reading as retired BEM syntax.
 */
function blankStringsAndUrls(css: string): string {
  return css.replace(
    /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\burl\(\s*[^)]*\)/g,
    (match) => {
      if (/^url\(/i.test(match)) return `url(${' '.repeat(match.length - 5)})`;
      return match[0] + ' '.repeat(match.length - 2) + match[0];
    },
  );
}

function sampleOf(result: SldsLintResult, _label: string): string {
  const pools = [
    result.privateVars,
    result.componentHooks,
    result.lwcTokens,
    result.bemDoubleDash,
    result.classOverrides,
    result.hardcodedColors,
    result.hooksWithoutFallback,
  ];
  const first = pools.find((p) => p.length > 0) ?? [];
  return first.slice(0, 3).join(', ');
}

/* -------------------------------------------------------------------------- */
/* Fetch helpers                                                              */
/* -------------------------------------------------------------------------- */

async function resolveObjects(
  ctx: AnalyzerContext,
  layouts: LayoutRow[],
  skip: (reason: string) => void,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const needsLookup = layouts.some((l) => /^[a-zA-Z0-9]{15,18}$/.test(l.TableEnumOrId));
  for (const layout of layouts) {
    if (!/^[a-zA-Z0-9]{15,18}$/.test(layout.TableEnumOrId)) {
      names.set(layout.TableEnumOrId, layout.TableEnumOrId);
    }
  }
  if (!needsLookup) return names;

  const result = await tryQuery(
    () =>
      ctx.client.query<{ DurableId: string; QualifiedApiName: string }>(
        // See the note in apex.ts: EntityDefinition requires a LIMIT and
        // caps at a single 2,000-row batch.
        'SELECT DurableId, QualifiedApiName FROM EntityDefinition LIMIT 2000',
        { tooling: true },
      ),
    skip,
    'Object name lookup',
  );
  for (const row of result?.records ?? []) names.set(row.DurableId, row.QualifiedApiName);
  return names;
}

/**
 * What a batched read produced, and — separately — whether it ran at all.
 * A map that is empty because nothing was asked and one that is empty because
 * every request failed are different facts, and the rules downstream need
 * both. `failed` counts individual subrequests, not just whole chunks.
 */
interface BatchRead<T> {
  results: Map<string, T>;
  ran: boolean;
  attempted: number;
  failed: number;
}

/** Describe layout structure for many objects, 25 per composite call. */
async function describeLayouts(
  ctx: AnalyzerContext,
  objectNames: string[],
  skip: (reason: string) => void,
): Promise<BatchRead<DescribeLayoutResult>> {
  const out = new Map<string, DescribeLayoutResult>();
  if (objectNames.length === 0) return { results: out, ran: true, attempted: 0, failed: 0 };

  const version = ctx.client.apiVersion;
  const subrequests = objectNames.map((name, index) => ({
    method: 'GET' as const,
    url: `/services/data/v${version}/sobjects/${name}/describe/layouts`,
    referenceId: `l${index}`,
  }));

  // `sobjects/{obj}/describe/layouts` **is** an eligible composite subrequest —
  // verified against a live org, where it returns 200 inside a composite while
  // an Analytics describe in the same composite returns 404. Ten per call
  // rather than 25: each subresponse carries every layout for the object with
  // its full section tree, and Account/Case/Opportunity run to hundreds of KB
  // against a fixed 25-second abort.
  const outcome = await tryQuery(
    () => ctx.client.composite<DescribeLayoutResult>(subrequests, { chunkSize: 10 }),
    skip,
    'Layout structure describe',
  );
  if (!outcome) return { results: out, ran: false, attempted: objectNames.length, failed: objectNames.length };

  outcome.responses.forEach((sub, ref) => {
    const name = objectNames[Number(ref.slice(1))];
    if (name && sub.httpStatusCode >= 200 && sub.httpStatusCode < 300) out.set(name, sub.body);
  });
  // Counted by object, not by chunk: a 403 inside an otherwise successful
  // composite is a subresponse, and used to vanish without a word.
  const failed = objectNames.length - out.size;
  if (failed > 0) {
    skip(
      `Layout structure could not be described for ${failed} of ${objectNames.length} objects` +
        `${outcome.error ? ` (${outcome.error.message})` : ''}; their layouts were not measured.`,
    );
  }
  return { results: out, ran: true, attempted: objectNames.length, failed };
}

async function fetchFlexiPageMetadata(
  ctx: AnalyzerContext,
  pages: FlexiPageRow[],
  skip: (reason: string) => void,
): Promise<BatchRead<FlexiPageMetadata>> {
  const out = new Map<string, FlexiPageMetadata>();
  if (pages.length === 0) return { results: out, ran: true, attempted: 0, failed: 0 };

  const outcome = await tryQuery(
    () =>
      ctx.client.retrieveMany<{ Metadata?: FlexiPageMetadata }>(
        'FlexiPage',
        pages.map((p) => p.Id),
        { tooling: true, chunkSize: 10 },
      ),
    skip,
    'Lightning page structure',
  );
  if (!outcome) return { results: out, ran: false, attempted: pages.length, failed: pages.length };

  for (const [id, record] of outcome.records) {
    if (record?.Metadata) out.set(id, record.Metadata);
  }
  const failed = pages.length - out.size;
  if (failed > 0) {
    skip(
      `Structure could not be read for ${failed} of ${pages.length} Lightning pages` +
        `${outcome.error ? ` (${outcome.error.message})` : ''}; those pages were not measured.`,
    );
  }
  return { results: out, ran: true, attempted: pages.length, failed };
}

/**
 * Read the org's custom Aura and LWC stylesheets.
 *
 * `Source` is a textarea. It is not documented as carrying the single-record
 * restriction that `Metadata` and `FullName` do, so the cheap bulk query is
 * attempted first; if the org rejects it, the ids are fetched and the sources
 * retrieved through composite instead.
 */
async function readStyleResources(
  ctx: AnalyzerContext,
  skip: (reason: string) => void,
): Promise<{ resources: StyleResource[]; lwcRead: boolean; auraRead: boolean }> {
  const resources: StyleResource[] = [];

  /* --- LWC ---------------------------------------------------------- */
  const lwc = await tryQuery(
    () =>
      ctx.client.query<{
        Id: string;
        FilePath: string;
        Format: string;
        Source: string;
        ManageableState: string | null;
      }>(
        "SELECT Id, FilePath, Format, Source, ManageableState FROM LightningComponentResource WHERE Format = 'css'",
        { tooling: true },
      ),
    skip,
    'LWC stylesheets',
  );

  for (const row of lwc?.records ?? []) {
    const managed = isManaged(row, ctx.orgNamespace);
    if (managed && !ctx.includeManaged) continue;
    if (!row.Source) continue;
    resources.push({
      // FilePath looks like `lwc/myComponent/myComponent.css`.
      name: row.FilePath?.split('/').slice(-2).join('/') ?? row.Id,
      kind: 'LWC',
      source: row.Source,
      managed,
    });
  }

  /* --- Aura --------------------------------------------------------- */
  const aura = await tryQuery(
    () =>
      ctx.client.query<{
        Id: string;
        AuraDefinitionBundleId: string;
        DefType: string;
        Format: string;
        Source: string;
        ManageableState: string | null;
      }>(
        "SELECT Id, AuraDefinitionBundleId, DefType, Format, Source, ManageableState " +
          "FROM AuraDefinition WHERE Format = 'CSS'",
        { tooling: true },
      ),
    skip,
    'Aura stylesheets',
  );

  const bundleNames = new Map<string, string>();
  if ((aura?.records.length ?? 0) > 0) {
    const bundles = await tryQuery(
      () =>
        ctx.client.query<{ Id: string; DeveloperName: string }>(
          'SELECT Id, DeveloperName FROM AuraDefinitionBundle',
          { tooling: true },
        ),
      skip,
      'Aura bundle names',
    );
    for (const bundle of bundles?.records ?? []) bundleNames.set(bundle.Id, bundle.DeveloperName);
  }

  for (const row of aura?.records ?? []) {
    const managed = isManaged(row, ctx.orgNamespace);
    if (managed && !ctx.includeManaged) continue;
    if (!row.Source) continue;
    resources.push({
      name: bundleNames.get(row.AuraDefinitionBundleId) ?? row.AuraDefinitionBundleId,
      kind: 'Aura',
      source: row.Source,
      managed,
    });
  }

  return { resources, lwcRead: lwc !== null, auraRead: aura !== null };
}

function sortByEvidence(items: FindingItem[], key: string): FindingItem[] {
  return [...items].sort((a, b) => Number(b.evidence?.[key] ?? 0) - Number(a.evidence?.[key] ?? 0));
}

/* -------------------------------------------------------------------------- */
/* Component census                                                            */
/* -------------------------------------------------------------------------- */

/** Components that execute a report when the page renders. */
export const REPORT_CHART_COMPONENTS = new Set(['flexipage:reportChart', 'reportChart']);

/**
 * Count component instances by name across every region and facet of a page.
 * Facets are listed flat in `flexiPageRegions`, so a flat walk sees them all
 * without the transitive resolution the per-region limit needs.
 */
export function countComponentsNamed(metadata: FlexiPageMetadata, names: Set<string>): number {
  let count = 0;
  for (const region of metadata.flexiPageRegions ?? []) {
    for (const item of region.itemInstances ?? []) {
      const name = item.componentInstance?.componentName;
      if (name && names.has(name)) count += 1;
    }
  }
  return count;
}
