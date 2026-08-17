# @promptci/core

Scanner engine behind [`promptci`](https://www.npmjs.com/package/promptci): detectors,
scoring, and report generation for AI coding instruction files (`CLAUDE.md`, `AGENTS.md`,
`.cursorrules`, Copilot instructions, and more).

Deterministic and rule-based — no LLM calls, no network access, identical output for
identical input. `callLlm` is exported as an optional helper for callers that layer LLM
features on top; the scanner itself never uses it.

## Usage

```ts
import { scan } from '@promptci/core';

const report = await scan({ repoPath: '/path/to/repo' });
console.log(report.healthScore, report.issues.length);
```

Most consumers want the CLI instead:

```bash
npx promptci scan
```

Full documentation: https://github.com/SeriousGeese/PromptCI

## License

Apache-2.0
