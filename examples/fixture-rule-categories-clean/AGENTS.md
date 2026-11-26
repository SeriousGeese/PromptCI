# Fixture: rule categories, clean

Near misses the rule-category checks must leave alone.

## Secrets

AWS access key IDs start with AKIA and GitHub tokens with ghp_. The AWS docs use
`AKIAIOSFODNN7EXAMPLE`. Put yours in `.env` as `GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
and read it with `process.env` (or `import.meta.env` in Vite). Never paste a key here.

## Review

- Is a "the repo always does X" claim actually checked across the repo?
- Every "the repo always/never does X" claim: did you grep the other cases?

## Commands

- Install: `npm install`
- Test: `npm test`
