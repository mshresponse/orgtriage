# Live org check

Runs the real analyzers against a real org, outside the extension, so a rule can
be verified against what Salesforce actually returns rather than against what
the docs imply it returns. Every "verified against a live org" note in
`docs/FACTS.md` was produced this way.

```sh
sf org login web --alias nzc          # once
npx esbuild tools/live-check/runner.ts --bundle --platform=node --format=esm \
  --outfile=tools/live-check/runner.mjs --alias:@=./src
OUT_DIR=/tmp/orgtriage-live node tools/live-check/runner.mjs [apex|flows|reports|layouts]
```

It substitutes a `SalesforceClient`-shaped object that shells out to the
Salesforce CLI, so **no access token is ever read, stored, or handled here** —
the CLI holds the credential and this only asks it to make requests. Everything
below that substitution is the shipping analyzer code, unmodified.

Output is one `ScanResult` JSON per analyzer in `$OUT_DIR`.

This is a diagnostic, not a test. The tests are `npm test`, which runs against
payloads captured from these runs and needs no org.
