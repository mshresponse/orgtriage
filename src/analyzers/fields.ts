/**
 * Field usage — custom fields nothing appears to reference.
 *
 * Salesforce Optimizer answers this by sampling how many records have the field
 * populated. That is a different question and a better one, but it requires
 * reading records, and this extension does not read record data. So the
 * question asked here is narrower and stated as such: **is this field
 * referenced anywhere in the org's metadata?**
 *
 * A field with no reference in any page layout, Lightning page, report, flow or
 * Apex class is not proven unused — an integration can write to it over the API
 * and a formula elsewhere can read it — but it is the strongest signal
 * available without touching data, and it is the list a cleanup starts from.
 * Every finding says so, and the remediation begins with "confirm before
 * deleting" rather than "delete".
 *
 * The reference sources deliberately do **not** include the Dependency API.
 * `MetadataComponentDependency` is still Beta, caps at 2,000 rows with no
 * pagination escape, and excludes reports entirely — truncation there produces
 * false "unused" verdicts, which is the single most dangerous error this
 * analyzer could make.
 */

import type { FindingItem } from '@/shared/types';
import { hardcodedIdsIn } from '@/shared/salesforceIds';
// The key-prefix catalogue is what makes a 15-character candidate trustworthy;
// flows reads the same list for the same reason.
import { readKeyPrefixes } from './flows';
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

/** Objects whose fields are inspected, most-used first. */
const MAX_OBJECTS = 40;
/** Fields listed per rule before the list is capped. */
const MAX_ITEMS = 200;

/**
 * How many Tooling bodies (flow and validation-rule metadata) to retrieve.
 *
 * `Metadata` cannot be selected in a multi-row query, so each body is a
 * composite subrequest. This bounds what a reference scan will spend; the cap
 * is reported when it bites, because a partial reference list makes
 * "unreferenced" less certain rather than more.
 */
const MAX_METADATA_BODIES = 400;
/** A field created more recently than this is too new to call unused. */
const GRACE_DAYS = 90;

interface FieldRow {
  QualifiedApiName: string;
  Label: string | null;
  EntityDefinitionId: string;
  DataType: string | null;
  IsCalculated: boolean;
  NamespacePrefix: string | null;
  Description: string | null;
}

interface EntityRow {
  DurableId: string;
  QualifiedApiName: string;
  Label: string | null;
  IsCustomSetting: boolean;
}

interface ToolingFieldRow {
  Id: string;
  DeveloperName: string;
  TableEnumOrId: string;
  CreatedDate: string;
  NamespacePrefix: string | null;
  ManageableState: string | null;
}

const RULES = {
  unreferenced: {
    id: 'fields.unreferenced',
    severity: 'info',
    title: (n) => `${n} custom ${n === 1 ? 'field is' : 'fields are'} referenced by no Apex, flow or validation rule`,
    rationale:
      'Every custom field costs something permanently: a row in the object’s storage, a line in every ' +
      'describe call, an entry in every page-layout editor, and a decision for whoever next has to work out ' +
      'what the object means. Fields nothing references are the ones paying that cost for nothing. This is a ' +
      'metadata-reference check over Apex bodies, active flow definitions and validation rules only — page ' +
      'layouts, Lightning pages and report columns are not read, so a field used only there appears here too. ' +
      'It is not a data check: a field written only by an integration will appear here and is not necessarily ' +
      'unused. A field name is matched wherever it appears, on any object, which errs toward missing an unused ' +
      'field rather than accusing a used one.',
    remediation:
      'Confirm before deleting. Check the field’s API name against integration code and external tools, then ' +
      'set it to hidden on every layout for a release before removing it — a deleted field takes its data ' +
      'with it after the recycle period.',
    docUrl:
      // "Manage Deleted Fields in Lightning Experience" — the recycle-period
      // behaviour the remediation depends on. The previous id did not exist.
      'https://help.salesforce.com/s/articleView?id=platform.fields_manage_deleted_fields_lex.htm&type=5',
    weight: 6,
  },
  validationHardcodedIds: {
    id: 'fields.validation-hardcoded-ids',
    severity: 'warning',
    title: (n) =>
      `${n} validation ${n === 1 ? 'rule contains' : 'rules contain'} a hard-coded record id`,
    rationale:
      'Record ids are unique to one org. An id compiled into a validation rule formula — a record type, a ' +
      'profile, a queue, a specific account — matches in the org it was written in and matches nothing ' +
      'anywhere else. The rule does not error on deployment; it simply stops guarding what it was written ' +
      'to guard, or starts blocking saves it should allow, in every sandbox and in the next org this ' +
      'metadata reaches.',
    remediation:
      'Replace the id with something stable: $RecordType.DeveloperName rather than a record type id, ' +
      '$Profile.Name or a custom permission rather than a profile id, and Custom Metadata for anything ' +
      'else, so each org supplies its own value. Then re-test the rule in a sandbox, because a validation ' +
      'rule that silently stopped firing usually has records behind it that never met the condition.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_prep_bestpractices.htm&type=5',
    weight: 12,
  },
  undocumented: {
    id: 'fields.undocumented',
    severity: 'info',
    title: (n) => `${n} custom ${n === 1 ? 'field has' : 'fields have'} no description`,
    rationale:
      'A field’s description is the only place its meaning can live where the next admin will find it. ' +
      'Without one, "which of these three date fields is the real close date" costs an afternoon and a ' +
      'guess. Salesforce surfaces the description in the field editor, in reports, and in the schema.',
    remediation:
      'Write one sentence per field: what it holds, who or what sets it, and what it is used for. Do it for ' +
      'the fields people actually use first.',
    weight: 3,
  },
} satisfies Record<string, RuleSpec>;

export const FIELDS_RULE_IDS: string[] = Object.values(RULES).map((r) => r.id);

/**
 * Every custom-field API name mentioned anywhere in a blob of metadata.
 *
 * Deliberately a text scan rather than a structural walk. The same field is
 * referenced in a dozen shapes across layouts, FlexiPages, report metadata,
 * flow definitions and Apex source, and a parser for each is a parser for each
 * to keep working. What matters here is only whether the name appears at all,
 * and a false *positive* reference is safe — it keeps a field off the list.
 * A false negative would be the dangerous direction, so the match is
 * deliberately loose.
 */
export function referencedFieldNames(sources: string[]): Set<string> {
  const found = new Set<string>();
  const pattern = /\b([A-Za-z][A-Za-z0-9_]*__c)\b/g;
  for (const source of sources) {
    if (!source) continue;
    for (const match of source.matchAll(pattern)) {
      if (match[1]) found.add(match[1].toLowerCase());
    }
  }
  return found;
}

/** `Account.Legacy_Tax_Id__c` → `legacy_tax_id__c`, for comparison. */
export function fieldKey(qualifiedApiName: string): string {
  const parts = qualifiedApiName.split('.');
  return (parts[parts.length - 1] ?? qualifiedApiName).toLowerCase();
}

export const fieldsAnalyzer: Analyzer = {
  id: 'fields',
  label: 'Fields',

  async *run(ctx: AnalyzerContext): AsyncGenerator<Phase, AnalyzerOutput, void> {
    const warnings: string[] = [];
    const outcomes: RuleOutcome[] = [];
    const skip = (reason: string) => warnings.push(reason);
    let truncated: AnalyzerOutput['truncated'];

    /* --- Which objects to look at ---------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Listing custom objects and fields', fraction: 0.1 };

    const entities = await tryQuery(
      () =>
        ctx.client.query<EntityRow>(
          "SELECT DurableId, QualifiedApiName, Label, IsCustomSetting FROM EntityDefinition WHERE IsCustomizable = true AND IsQueryable = true ORDER BY QualifiedApiName",
          { tooling: true },
        ),
      skip,
      'Object inventory',
    );

    if (!entities) {
      for (const rule of Object.values(RULES)) {
        outcomes.push(inconclusive('fields', rule, 'EntityDefinition could not be queried.'));
      }
      const summary = summarise(RULES, outcomes);
      return {
        metrics: { 'Custom fields': { value: '—' } },
        findings: summary.findings,
        coverage: summary.coverage,
        warnings,
        examined: 1,
      };
    }

    const objects = entities.records.filter((e) => !e.IsCustomSetting).slice(0, MAX_OBJECTS);
    const objectNameByDurableId = new Map(entities.records.map((e) => [e.DurableId, e.QualifiedApiName]));
    if (entities.records.length > objects.length) {
      truncated = {
        reason: `Fields were inspected on the first ${MAX_OBJECTS} customisable objects.`,
        examined: objects.length,
        total: entities.records.length,
      };
    }

    /* --- The fields themselves ------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading field definitions', fraction: 0.35 };

    const fields: FieldRow[] = [];
    for (const object of objects) {
      checkCancelled(ctx);
      const page = await tryQuery(
        () =>
          ctx.client.query<FieldRow>(
            'SELECT QualifiedApiName, Label, EntityDefinitionId, DataType, IsCalculated, NamespacePrefix, Description ' +
              `FROM FieldDefinition WHERE EntityDefinitionId = '${object.QualifiedApiName}'`,
            { tooling: true },
          ),
        skip,
        `Fields on ${object.QualifiedApiName}`,
      );
      for (const row of page?.records ?? []) {
        if (!row.QualifiedApiName.endsWith('__c')) continue;
        if (!ctx.includeManaged && isManaged(row, ctx.orgNamespace)) continue;
        fields.push(row);
      }
    }

    /* --- Everything that could mention a field --------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Collecting metadata references', fraction: 0.7 };

    const sources: string[] = [];
    /** Reference families that could not be read at all. */
    const referenceGaps: string[] = [];
    /** Validation rules kept as rows, so a finding can name the rule it is in. */
    const validationRules: Array<{ ValidationName?: string; Metadata?: unknown }> = [];
    const collect = async (label: string, soql: string, tooling = true) => {
      const result = await tryQuery(
        () => ctx.client.query<Record<string, unknown>>(soql, { tooling, maxRecords: 2000 }),
        skip,
        label,
      );
      if (!result) {
        warnings.push(
          `${label} could not be read, so a field referenced only there would be reported as unreferenced. Treat this run's list as provisional.`,
        );
        referenceGaps.push(label);
        return;
      }
      if (result.truncated) {
        warnings.push(
          `${label} was capped at 2,000 rows; a field referenced only beyond that is not counted.`,
        );
      }
      for (const row of result.records) sources.push(JSON.stringify(row));
    };

    /**
     * Fetch `Metadata` for a Tooling object.
     *
     * `Metadata` and `FullName` cannot be selected in a query that returns more
     * than one row — Salesforce answers MALFORMED_QUERY, "the query
     * qualifications must specify no more than one row for retrieval". So the
     * ids come from a normal query and the bodies from a composite retrieve,
     * which is the same shape the flows analyzer uses.
     *
     * Capped: this is a reference scan, and an org with a thousand validation
     * rules should not spend a hundred composite calls proving that a field is
     * referenced. A cap that bites is reported, because a partial reference
     * list makes "unreferenced" less certain, never more.
     */
    const collectMetadata = async (
      label: string,
      listSoql: string,
      objectType: string,
      cap: number,
    ): Promise<Array<Record<string, unknown>>> => {
      const list = await tryQuery(
        () => ctx.client.query<{ Id: string }>(listSoql, { tooling: true, maxRecords: cap }),
        skip,
        label,
      );
      if (!list) {
        warnings.push(
          `${label} could not be read, so a field referenced only there would be reported as unreferenced. Treat this run's list as provisional.`,
        );
        referenceGaps.push(label);
        return [];
      }
      const ids = list.records.map((r) => r.Id).filter(Boolean);
      if (ids.length === 0) return [];
      if (list.truncated) {
        warnings.push(`${label} was capped at ${cap}; fields referenced only beyond that are not counted.`);
      }

      const fetched = await ctx.client.retrieveMany<Record<string, unknown>>(objectType, ids, {
        tooling: true,
        // A single Metadata body is large; 8 per composite is what the flows
        // analyzer settled on against a live org.
        chunkSize: 8,
      });
      if (fetched.failedChunks > 0) {
        warnings.push(
          `${fetched.failedChunks} of ${fetched.chunks} ${label.toLowerCase()} batches failed, so that part of the reference scan is incomplete.`,
        );
      }
      const rows = [...fetched.records.values()];
      for (const row of rows) sources.push(JSON.stringify(row));
      return rows;
    };

    // Local code includes the org's own namespace, if it has one.
    const ownNamespace = ctx.orgNamespace && /^[A-Za-z][A-Za-z0-9_]{0,14}$/.test(ctx.orgNamespace) ? ctx.orgNamespace : null;
    const ownCode = ownNamespace
      ? `WHERE (NamespacePrefix = null OR NamespacePrefix = '${ownNamespace}')`
      : 'WHERE NamespacePrefix = null';
    await collect('Apex class bodies', `SELECT Body FROM ApexClass ${ownCode}`);
    await collect('Apex trigger bodies', `SELECT Body FROM ApexTrigger ${ownCode}`);
    await collectMetadata(
      'Flow definitions',
      "SELECT Id FROM Flow WHERE Status = 'Active'",
      'Flow',
      MAX_METADATA_BODIES,
    );
    validationRules.push(
      ...((await collectMetadata(
        'Validation rules',
        'SELECT Id FROM ValidationRule',
        'ValidationRule',
        MAX_METADATA_BODIES,
      )) as Array<{ ValidationName?: string; Metadata?: unknown }>),
    );
    // Not read, and the finding says so: layout structure, Lightning page
    // metadata and report columns. Two earlier "collects" fetched only the
    // *names* of reports and layouts — which cannot mention a field — while
    // the evidence claimed both had been checked. A field used only on a
    // layout was reported as unreferenced on the strength of that.

    const referenced = referencedFieldNames(sources);

    /* --- Verdicts --------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Comparing fields against references', fraction: 0.9 };

    const created = await tryQuery(
      () =>
        ctx.client.query<ToolingFieldRow>(
          'SELECT Id, DeveloperName, TableEnumOrId, CreatedDate, NamespacePrefix, ManageableState FROM CustomField',
          { tooling: true, maxRecords: 5000 },
        ),
      skip,
      'Field creation dates',
    );
    // Keyed by object *and* field: `Status__c` exists on a dozen objects, and
    // keying by field name alone let one object's creation date stand in for
    // another's. `TableEnumOrId` is an API name for standard objects and a
    // durable id for custom ones, so both spellings are resolved.
    const createdByName = new Map<string, string>();
    for (const row of created?.records ?? []) {
      const objectName = objectNameByDurableId.get(row.TableEnumOrId) ?? row.TableEnumOrId;
      createdByName.set(`${objectName}.${row.DeveloperName}__c`.toLowerCase(), row.CreatedDate);
    }

    const unreferenced: FindingItem[] = [];
    const undocumented: FindingItem[] = [];

    for (const field of fields) {
      const key = fieldKey(field.QualifiedApiName);
      const createdDate = createdByName.get(`${field.EntityDefinitionId}.${key}`.toLowerCase());
      const age = daysSince(createdDate);
      const objectName = field.EntityDefinitionId;

      if (!field.Description) {
        undocumented.push({
          name: `${objectName}.${field.QualifiedApiName}`,
          label: field.Label ?? undefined,
          setupUrl: setupUrl(ctx.lightningHost, 'ObjectManager/home'),
          evidence: { Object: objectName, Type: field.DataType, Label: field.Label },
        });
      }

      if (referenced.has(key)) continue;
      // A field created last month has not had time to be used.
      if (age !== null && age < GRACE_DAYS) continue;
      // A formula field is referenced by its own definition, which the scan
      // above does not read; excluding them avoids a whole class of false calls.
      if (field.IsCalculated) continue;

      unreferenced.push({
        name: `${objectName}.${field.QualifiedApiName}`,
        label: field.Label ?? undefined,
        setupUrl: setupUrl(ctx.lightningHost, 'ObjectManager/home'),
        evidence: {
          Object: objectName,
          Type: field.DataType,
          Created: createdDate ? `${age} days ago` : 'unknown',
          Checked: 'Apex, flows, validation rules',
          'Not checked': 'layouts, Lightning pages, report columns',
        },
      });
    }

    // "Nothing references this field" is only a verdict when every family that
    // could reference it was actually read.
    outcomes.push(
      referenceGaps.length > 0
        ? inconclusive(
            'fields',
            RULES.unreferenced,
            `${referenceGaps.join(', ')} could not be read, so "unreferenced" cannot be concluded for any field.`,
          )
        : finding(
            'fields',
            RULES.unreferenced,
            capped(unreferenced, MAX_ITEMS, (dropped) =>
              warnings.push(`${dropped} further unreferenced fields are not listed.`),
            ),
          ),
    );
    outcomes.push(
      finding(
        'fields',
        RULES.undocumented,
        capped(undocumented, MAX_ITEMS, (dropped) =>
          warnings.push(`${dropped} further undescribed fields are not listed.`),
        ),
      ),
    );

    /* --- Hard-coded ids in validation rules ------------------------------ */
    // The rules were already fetched above for the reference scan, so this
    // costs nothing but the key-prefix catalogue: one query, shared with the
    // same check in flows.
    if (validationRules.length === 0) {
      outcomes.push(
        inconclusive(
          'fields',
          RULES.validationHardcodedIds,
          'Validation rules could not be read, so none was checked for hard-coded ids.',
        ),
      );
    } else {
      const keyPrefixes = await readKeyPrefixes(ctx, skip);
      if (!keyPrefixes) {
        warnings.push(
          'The object key-prefix catalogue could not be read, so 15-character ids in validation rules ' +
            'were skipped. Eighteen-character ids are still found by checksum.',
        );
      }
      const withIds: FindingItem[] = [];
      for (const rule of validationRules) {
        const metadata = rule.Metadata as { errorConditionFormula?: string } | undefined;
        const formula = metadata?.errorConditionFormula;
        if (typeof formula !== 'string') continue;
        const ids = hardcodedIdsIn(formula, keyPrefixes);
        if (ids.length === 0) continue;
        withIds.push({
          name: rule.ValidationName ?? '(unnamed)',
          evidence: {
            Ids: ids.slice(0, 4).join(', '),
            Count: ids.length,
            Heuristic: 'yes',
          },
        });
      }
      outcomes.push(finding('fields', RULES.validationHardcodedIds, withIds));
    }

    warnings.push(
      'This area answers "is anything referencing this field", not "does this field hold data". A field written only by an integration appears here and may be in daily use — confirm each before deleting.',
    );

    const summary = summarise(RULES, outcomes);
    const count = (id: string) => summary.findings.find((f) => f.id === id)?.items.length ?? 0;

    return {
      metrics: {
        'Custom fields': { value: fields.length },
        'Objects inspected': { value: objects.length },
        Unreferenced: { value: count(RULES.unreferenced.id) },
        'No description': { value: count(RULES.undocumented.id) },
        'References seen': { value: referenced.size, sub: 'distinct field names in metadata' },
      },
      findings: summary.findings,
      coverage: summary.coverage,
      warnings,
      examined: Math.max(1, fields.length),
      truncated,
    };
  },
};
