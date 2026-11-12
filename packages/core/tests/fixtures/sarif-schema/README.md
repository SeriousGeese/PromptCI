# Vendored SARIF 2.1.0 schema

`sarif-schema-2.1.0.json` is the official OASIS SARIF 2.1.0 JSON Schema, vendored as a test
fixture so schema validation never makes a network request during `pnpm test` (see the
determinism rule in [AGENTS.md](../../../../../AGENTS.md)).

- Source: `https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/sarif-2.1/schema/sarif-schema-2.1.0.json`
- Upstream commit: `a560296ca8c921f3bdb8d4a8db57ab83dae968a7` (fetched 2026-11-12)
- The schema declares `"$schema": "http://json-schema.org/draft-04/schema#"`, so tests validate
  against it with `ajv-draft-04`, not plain `ajv` (Ajv 8's default export only supports
  draft-07/2019-09/2020-12).

To refresh: re-fetch the URL above, confirm the new commit SHA with
`gh api repos/oasis-tcs/sarif-spec/commits?path=sarif-2.1/schema/sarif-schema-2.1.0.json --jq '.[0].sha'`,
and update this file.
