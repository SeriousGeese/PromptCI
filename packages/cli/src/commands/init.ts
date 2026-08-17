import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { detectProjectType, renderPromptCiGitignore, PROJECT_TYPES as CORE_PROJECT_TYPES, type ProjectType } from '@promptci/core';

// Every core project type except 'auto', which is offered implicitly by
// accepting the detected type rather than as a menu entry.
const PROJECT_TYPES: ProjectType[] = CORE_PROJECT_TYPES.filter((t) => t !== 'auto');

const DEFAULT_CONFIG = {
  severityThreshold: 'warning',
  projectType: 'auto',
  apiUrl: 'http://localhost:3000',
};

export interface InitOptions {
  interactive?: boolean;
  answers?: string[];
}

const TEMPLATES: Record<string, string> = {
  nextjs: `# Developer Instructions

## Project Type
Next.js & TypeScript

## Project Rules
- **App Router**: Follow the App Router conventions. Place pages in \`app/page.tsx\` and layout in \`app/layout.tsx\`.
- **React Components**: 
  - Use React Server Components (RSC) by default.
  - Only add the \`'use client'\` directive at the top of a file when using client-side state, event handlers, or React hooks (e.g. \`useState\`, \`useEffect\`).
- **State Constraints**: Prefer local component state, React Context, or lightweight state managers. Ensure server and client state boundaries are clean.
- **TypeScript**:
  - Enforce strict typing. Do not use \`any\` unless absolutely necessary.
  - Export types/interfaces properly.

## Security Rules
- **Secrets**: Never commit API keys, passwords, or raw secrets. Use environment variables.
- **Input Validation**: Sanitize and validate all external parameters to prevent injection.

## Commands & Scripts
- Run local development server: \`pnpm dev\` (or \`npm run dev\` / \`yarn dev\`)
- Run typecheck: \`pnpm typecheck\` (or \`npm run typecheck\`)
- Run linting: \`pnpm lint\` (or \`npm run lint\`)
- Run tests: \`pnpm test\` (or \`npm run test\` using Vitest)
- Build for production: \`pnpm build\` (or \`npm run build\`)

## Verification Loop
Before declaring a task done, follow these verification steps:
1. Run \`pnpm typecheck\` to verify TypeScript type-safety.
2. Run \`pnpm lint\` to check for code style issues.
3. Run \`pnpm test\` to verify all tests pass.
4. Run \`pnpm build\` to ensure production bundle compiles successfully.
`,

  typescript: `# Developer Instructions

## Project Type
TypeScript (General)

## Project Rules
- **TypeScript**: Enforce strict compilation options in \`tsconfig.json\`.
- **Coding Conventions**:
  - Use camelCase for variables/functions and PascalCase for types/interfaces.
  - Prefer modern ES6+ features and async/await syntax.
- **Dependency Management**: Use \`pnpm\` (or \`npm\`/\`yarn\`) as specified in the project.

## Security Rules
- **Secrets**: Never commit API keys, passwords, or raw secrets. Use environment variables.
- **Input Validation**: Sanitize and validate all external parameters to prevent injection.

## Commands & Scripts
- Run development build: \`pnpm dev\`
- Compile TypeScript: \`pnpm build\`
- Run tests: \`pnpm test\`
- Lint code: \`pnpm lint\`

## Verification Loop
Before completing a task:
1. Run \`pnpm lint\` to check styling.
2. Run \`pnpm build\` or \`pnpm typecheck\` to compile without errors.
3. Run \`pnpm test\` to verify all tests pass.
`,

  unity: `# Developer Instructions

## Project Type
Unity & C#

## Project Rules
- **Meta Files**: 
  - Always generate and preserve \`.meta\` files for all assets and directories.
  - Never modify, delete, or commit empty \`.meta\` files manually unless strictly necessary.
- **Assembly References**:
  - Use Assembly Definitions (\`.asmdef\`) to manage compilation dependencies and optimize build times.
  - Avoid creating circular dependencies between assemblies.
- **C# Standards**:
  - Use Microsoft C# coding conventions.
  - Classes, Structs, and Methods: PascalCase.
  - Local variables and parameters: camelCase.
  - Interfaces: Prefix with \`I\` (e.g. \`IEnemy\`).
- **Asset Guidelines**:
  - Organize files in directories under \`Assets/\` (e.g., \`Assets/Scripts\`, \`Assets/Prefabs\`, \`Assets/Textures\`).
  - Do not place loose assets in the root \`Assets/\` directory.

## Security Rules
- **Secrets**: Never commit API keys, passwords, or raw secrets. Use environment variables.
- **Input Validation**: Sanitize and validate all external parameters to prevent injection.

## Commands & Verification
- Compile and verify C# scripts within the Unity Editor or your IDE.
- Ensure no compilation errors exist before saving or committing changes.
`,

  dotnet: `# Developer Instructions

## Project Type
.NET & C#

## Project Rules
- **C# Coding Standards**: Follow official Microsoft C# coding conventions.
- **Project Structure**: Structure solutions with clear separation of concerns using projects and solutions (\`.sln\`, \`...\`, \`.csproj\`).
- **Dependency Management**: Manage packages via NuGet.

## Security Rules
- **Secrets**: Never commit API keys, passwords, or raw secrets. Use environment variables.
- **Input Validation**: Sanitize and validate all external parameters to prevent injection.

## Commands & Scripts
- Build solution: \`dotnet build\`
- Run tests: \`dotnet test\`
- Restore packages: \`dotnet restore\`

## Verification Loop
Before declaring a task done:
1. Run \`dotnet build\` to ensure clean compilation without warnings or errors.
2. Run \`dotnet test\` to execute all tests.
`,

  python: `# Developer Instructions

## Project Type
Python

## Project Rules
- **Environment & Dependency Management**:
  - Use \`poetry\` or \`pipenv\` to manage dependencies.
  - Declare packages in \`pyproject.toml\` or \`Pipfile\`.
- **Formatting & Linting**:
  - Use \`ruff\` or \`black\` and \`isort\` for formatting.
  - Keep line lengths under 88 characters (standard black formatting).
- **Testing**:
  - Write test suites under the \`tests/\` directory.
  - Use \`pytest\` for running and structuring unit tests.

## Security Rules
- **Secrets**: Never commit API keys, passwords, or raw secrets. Use environment variables.
- **Input Validation**: Sanitize and validate all external parameters to prevent injection.

## Commands & Scripts
- Install dependencies: \`poetry install\` (or \`pip install -r requirements.txt\`)
- Run linter/formatter: \`ruff check\` and \`ruff format\`
- Run tests: \`pytest\`

## Verification Loop
Before marking a task as complete:
1. Run \`ruff format\` to auto-format the code.
2. Run \`ruff check\` to lint and check for common issues.
3. Run \`pytest\` to verify all unit tests pass successfully.
`,

  go: `# Developer Instructions

## Project Type
Go (Golang)

## Project Rules
- **Dependency Management**: Manage packages via \`go.mod\`. Ensure all dependencies are cleaned and formatted.
- **Idiomatic Go**:
  - Follow instructions from "Effective Go".
  - Always handle errors returned from functions. Do not ignore errors with \`_\`.
- **Formatting**: Format code strictly with \`go fmt\`.

## Security Rules
- **Secrets**: Never commit API keys, passwords, or raw secrets. Use environment variables.
- **Input Validation**: Sanitize and validate all external parameters to prevent injection.

## Commands & Scripts
- Build the project: \`go build ./...\`
- Run all tests: \`go test ./...\`
- Format code: \`go fmt ./...\`
- Run linter (if applicable): \`golangci-lint run\`

## Verification Loop
Before completing a task, always:
1. Run \`go fmt ./...\` to format code.
2. Run \`go test ./...\` to verify all tests pass.
3. Run \`go build ./...\` to ensure everything compiles.
`,

  rust: `# Developer Instructions

## Project Type
Rust

## Project Rules
- **Code Style**:
  - Enforce idiomatic Rust style.
  - Run \`cargo fmt\` to format all code.
  - Address all warnings reported by \`cargo clippy\`.
- **Safety**: Prefer safe Rust. Use \`unsafe\` blocks only where absolutely necessary and fully document the safety guarantees.
- **Dependency Management**: Manage dependencies inside \`Cargo.toml\`.

## Security Rules
- **Secrets**: Never commit API keys, passwords, or raw secrets. Use environment variables.
- **Input Validation**: Sanitize and validate all external parameters to prevent injection.

## Commands & Scripts
- Format code: \`cargo fmt\`
- Run linter: \`cargo clippy\`
- Build: \`cargo build\`
- Run tests: \`cargo test\`

## Verification Loop
Before finalizing any changes, perform these steps:
1. Run \`cargo fmt -- --check\` to verify code format.
2. Run \`cargo clippy --all-targets -- -D warnings\` to verify zero warnings.
3. Run \`cargo test\` to execute the test suite and ensure all tests pass.
`,

  unknown: `# Developer Instructions

## Guidelines
- **Read First**: Always read the existing codebase and context files before making edits.
- **Plan First**: For complex or multi-file changes, design an implementation plan first.
- **Code Consistency**: Follow the existing styling, naming conventions, and file structures in the repository.
- **Verification**: Enforce a local verification loop by compiling the code and running tests if they exist.

## Security Rules
- **Secrets**: Never commit API keys, passwords, or raw secrets. Use environment variables.
- **Input Validation**: Sanitize and validate all external parameters to prevent injection.

## Commands & Scripts
- Locate any setup, build, and test scripts in the root directory (e.g. \`Makefile\`, \`package.json\`, or shell scripts).
- Run validation commands before considering a task completed.
`
};

export function resolveSafePath(targetPath: string, fileRelativePath: string): string {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedFile = path.resolve(resolvedTarget, fileRelativePath);
  const relative = path.relative(resolvedTarget, resolvedFile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes target directory: ${fileRelativePath}`);
  }
  return resolvedFile;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function runInit(targetPath: string, options?: InitOptions): Promise<void> {
  const dir = resolveSafePath(targetPath, '.promptci');
  const configPath = path.join(dir, 'config.json');

  await fs.mkdir(dir, { recursive: true });

  const isInteractive = options?.interactive ?? false;
  let answerIndex = 0;

  const askQuestion = (query: string): Promise<string> => {
    if (options?.answers && answerIndex < options.answers.length) {
      const ans = options.answers[answerIndex]!;
      answerIndex++;
      console.log(`${query}${ans}`);
      return Promise.resolve(ans);
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(query, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  };

  let selectedType: ProjectType = 'auto';

  // 1. Detect Project Type
  const detectedType = await detectProjectType(targetPath);

  if (isInteractive) {

    // 2. Interactive Prompting for Project Type
    const confirmAns = await askQuestion(`We detected this is a ${detectedType} repository. Confirm? (Y/n): `);
    const confirmed = confirmAns === '' || confirmAns.toLowerCase() === 'y' || confirmAns.toLowerCase() === 'yes';

    if (confirmed) {
      selectedType = detectedType;
    } else {
      let valid = false;
      let attempts = 0;
      while (!valid && attempts < 5) {
        attempts++;
        const menu = PROJECT_TYPES.map((t, i) => `${i + 1}: ${t}`).join('\n');
        const choice = await askQuestion(
          `Select project type:\n` +
          `${menu}\n` +
          `Enter choice (1-${PROJECT_TYPES.length} or name): `
        );
        const num = parseInt(choice, 10);
        if (num >= 1 && num <= PROJECT_TYPES.length) {
          selectedType = PROJECT_TYPES[num - 1]!;
          valid = true;
        } else {
          const cleaned = choice.toLowerCase().trim() as ProjectType;
          if (PROJECT_TYPES.includes(cleaned)) {
            selectedType = cleaned;
            valid = true;
          } else {
            console.log('Invalid selection. Please try again.');
          }
        }
      }

      if (!valid) {
        console.log('No valid selection received. Defaulting to project type: auto');
        selectedType = 'auto';
      }
    }

    // 3. Write config.json
    let configExists = false;
    try {
      await fs.access(configPath);
      configExists = true;
      console.log(`Config already exists: ${configPath}`);
    } catch {
      // file doesn't exist — create it
    }

    if (!configExists) {
      const configObj = {
        ...DEFAULT_CONFIG,
        projectType: selectedType,
      };
      await fs.writeFile(configPath, JSON.stringify(configObj, null, 2) + '\n', 'utf-8');
      console.log(`Created ${configPath}`);
    }

    // 4. Check for Instruction Files
    const potentialFiles = ['AGENTS.md', '.cursorrules', 'CLAUDE.md', '.github/copilot-instructions.md'];
    let hasInstructionFile = false;
    for (const f of potentialFiles) {
      const fullPath = resolveSafePath(targetPath, f);
      if (await fileExists(fullPath)) {
        hasInstructionFile = true;
        break;
      }
    }

    if (!hasInstructionFile) {
      const generateAns = await askQuestion('We did not find any AI instruction files. Would you like to generate a starter template? (Y/n): ');
      const generate = generateAns === '' || generateAns.toLowerCase() === 'y' || generateAns.toLowerCase() === 'yes';

      if (generate) {
        let templateType: string | undefined;
        let templateAttempts = 0;
        while (!templateType && templateAttempts < 5) {
          templateAttempts++;
          const ans = await askQuestion(
            `Which file type would you like to create?\n` +
            `1: AGENTS.md (Recommended for monorepos & multi-agent instructions)\n` +
            `2: .cursorrules (For Cursor users)\n` +
            `3: CLAUDE.md (For Cline/Claude-dev users)\n` +
            `Enter choice (1-3 or name): `
          );
          if (ans === '1' || ans.toLowerCase() === 'agents.md' || ans.toLowerCase() === 'agents') {
            templateType = 'AGENTS.md';
          } else if (ans === '2' || ans.toLowerCase() === '.cursorrules' || ans.toLowerCase() === 'cursorrules') {
            templateType = '.cursorrules';
          } else if (ans === '3' || ans.toLowerCase() === 'claude.md' || ans.toLowerCase() === 'claude') {
            templateType = 'CLAUDE.md';
          } else {
            console.log('Invalid selection. Please try again.');
          }
        }

        if (templateType) {
          const writePath = resolveSafePath(targetPath, templateType);
          if (await fileExists(writePath)) {
            console.log(`Safety Warning: File already exists: ${writePath}. Skip writing.`);
          } else {
            const content = TEMPLATES[selectedType] || TEMPLATES.unknown;
            await fs.mkdir(path.dirname(writePath), { recursive: true });
            await fs.writeFile(writePath, content, 'utf-8');
            console.log(`Created starter template: ${writePath}`);
          }
        } else {
          console.log('No valid template selection received. Skipping template generation.');
        }
      }
    }
  } else {
    // Non-interactive fallback (original behavior)
    try {
      await fs.access(configPath);
      console.log(`Config already exists: ${configPath}`);
      console.log('Remove it first if you want to reinitialize.');
      return;
    } catch {
      // file doesn't exist — create it
    }

    await fs.writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf-8');
    console.log(`Created ${configPath}`);
    console.log('Edit it to set include/exclude patterns, severityThreshold, projectType, and apiUrl.');
  }

  // 5. Gitignore Check
  const gitignorePath = resolveSafePath(targetPath, '.gitignore');
  if (await fileExists(gitignorePath)) {
    const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
    const lines = gitignoreContent.split(/\r?\n/);
    const hasIgnore = lines.some(l => {
      const clean = l.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
      return (
        clean === '.promptci' ||
        clean.startsWith('.promptci/') ||
        clean.endsWith('/.promptci') ||
        clean.includes('/.promptci/')
      );
    });

    if (!hasIgnore) {
      let confirmGitignore = false;
      if (isInteractive) {
        const answer = await askQuestion(
          'Ignore .promptci/ reports in .gitignore (keeping baseline.json and config.json committed)? (recommended) [Y/n]: '
        );
        confirmGitignore = answer === '' || answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
      } else {
        confirmGitignore = true;
      }

      if (confirmGitignore) {
        // BUG-7: ignore the generated reports but keep baseline.json committed —
        // `scan --baseline` / `--fail-on-new` need it readable in CI.
        const lineEnding = gitignoreContent.includes('\r\n') ? '\r\n' : '\n';
        const needsNewline = gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n');
        const appendText = `${needsNewline ? lineEnding : ''}${renderPromptCiGitignore(lineEnding)}`;
        await fs.appendFile(gitignorePath, appendText, 'utf-8');
        console.log('✔ Added .promptci/ report ignore to .gitignore (baseline.json and config.json stay committed)');
      }
    }
  }
}
