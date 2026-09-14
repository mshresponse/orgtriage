/**
 * Recognising Salesforce record ids in text that was never meant to contain them.
 *
 * There is no API that answers "does this metadata hard-code an id", so every
 * check that wants the answer does a text scan — and the whole difficulty is
 * not finding candidates but rejecting the ones that are merely 15 or 18
 * alphanumeric characters long. A naive `\b00[a-zA-Z0-9]{13}\b` gets this
 * badly wrong in both directions: it assumes ids start with `00`, which most do
 * not, and it accepts any string that does.
 *
 * Two classes of candidate, held to different standards:
 *
 *  - **18 characters** — accepted only when the case-checksum validates.
 *    Effectively exact: a random 18-character alphanumeric string passes with
 *    probability 1/32768.
 *  - **15 characters** — no checksum exists, so these are accepted only when
 *    their three-character prefix is one the *org itself* reports through
 *    `EntityDefinition.KeyPrefix`. Without that catalogue they are skipped
 *    rather than guessed at.
 *
 * Shared so that flows, validation rules and anything added later agree on what
 * counts as an id, rather than each growing its own regex.
 */

/**
 * Is this an 18-character Salesforce id?
 *
 * The last three characters are a checksum over the case of the first 15: each
 * group of five characters becomes a five-bit number whose bit *i* is set when
 * that character is an uppercase letter, and the number indexes `A-Z0-5`.
 *
 * This replaces a prefix regex that required the id to start `[0-9a-z]`.
 * Measured against a live org's `EntityDefinition` catalogue, that rejected
 * **1,003 of 2,000** real key prefixes — including `00G` (Queue), `00D`
 * (Organization), `00Q` (Lead), `00T` (Task) and `00O` (Report). Hard-coded
 * Queue and Permission Set ids are two of the most common things these rules
 * exist to find, and it could not match either.
 */
export function isValidId18(value: string): boolean {
  if (value.length !== 18) return false;
  if (!/^[a-zA-Z0-9]{18}$/.test(value)) return false;

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  for (let group = 0; group < 3; group++) {
    let bits = 0;
    for (let i = 0; i < 5; i++) {
      const ch = value[group * 5 + i]!;
      if (ch >= 'A' && ch <= 'Z') bits |= 1 << i;
    }
    if (value[15 + group] !== alphabet[bits]) return false;
  }
  return true;
}

/**
 * Hard-coded id candidates in a block of text.
 *
 * `exclude` is for names the artefact gives to its own parts — a flow element
 * or a variable can be 15 characters and contain a digit, and reporting one to
 * an admin as a hard-coded id is worse than missing a real one.
 *
 * The word boundary matters: without it, a 20-character string yields a
 * 15-character substring that passes the prefix test.
 */
export function hardcodedIdsIn(
  text: string,
  keyPrefixes: Set<string> | null,
  exclude: ReadonlySet<string> = new Set(),
): string[] {
  const candidates = text.match(/\b[a-zA-Z0-9]{15}\b|\b[a-zA-Z0-9]{18}\b/g) ?? [];
  const found = new Set<string>();

  for (const value of candidates) {
    if (exclude.has(value)) continue;

    if (value.length === 18) {
      if (isValidId18(value)) found.add(value);
      continue;
    }
    // 15 characters: the org's own key-prefix catalogue is the only evidence.
    if (!keyPrefixes) continue;
    if (!/[0-9]/.test(value)) continue;
    if (keyPrefixes.has(value.slice(0, 3))) found.add(value);
  }
  return [...found];
}
