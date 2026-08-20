# @promptci/core

Scanner engine behind [`@promptci/cli`](https://www.npmjs.com/package/@promptci/cli): detectors,
scoring, and report generation for AI coding instruction files (`CLAUDE.md`, `AGENTS.md`,
`.cursorrules`, Copilot instructions, and more).

Deterministic and rule-based — no LLM calls, no network access, identical output for
identical input. The package contains no model client, auth, or upload code.

## Usage

```ts
import { scan } from '@promptci/core';

const report = await scan({ repoPath: '/path/to/repo' });
console.log(report.healthScore, report.issues.length);
```

Most consumers want the CLI instead:

```bash
npx @promptci/cli scan
```

Full documentation: https://github.com/SeriousGeese/PromptCI

## License

Apache-2.0
