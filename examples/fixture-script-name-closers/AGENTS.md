# Script Name Closers Fixture

Detector corpus for pcic-1ik0.12: a script name quoted inside prose or config
text keeps the closing quote, backtick or bracket on its last token. The quote
closes the surrounding text and is not part of the name.

## Clean

These scripts all exist, so none of these lines may be reported:

The desktop build runs `beforeBuildCommand: "npm run build:renderer && npm run build-frontend"` first.

```bash
npm run "build-frontend"
npm run 'typecheck' -- --watch
```

A bracketed or braced word is a placeholder, not a script name, so these stay
clean too:

```bash
npm run [script]
npm run {name}
```

## Advisory

This script does not exist. It is reported under its bare name, and because
the name is quoted the finding carries no edit, so nothing rewrites the quotes:

```bash
npm run "build-frontedn"
```
