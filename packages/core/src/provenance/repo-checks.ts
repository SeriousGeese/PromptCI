import type { CheckProvenance, ProvenanceSource, SourceStance } from './types.js';

/**
 * Provenance for the repository-facing checks (pcic-kvv3.1, issue #162): dead references,
 * command validity, manifest consistency, dependency staleness, CI alignment, conflicts,
 * stale instructions, action pinning, the security pack and the framework packs.
 *
 * Backfilled by an agent run that read each page listed below; the records are pending human
 * review. A `repo-fact` is a statement about the scanned repository and needs no source. A
 * `tool-fact` or `opinion` with no page found says `unverified: true` instead of citing one.
 */

const READ_ON = '2026-11-13';
const VERIFIED = { date: '2026-11-13', by: 'Claude agent backfill (pcic-kvv3.1), pending human review' } as const;

const src = (url: string, title: string, stance: SourceStance, note: string): ProvenanceSource => ({
  url,
  title,
  readOn: READ_ON,
  stance,
  note,
});

// ── Package managers and workspaces ───────────────────────────────────────────

const NPM_RUN = src(
  'https://docs.npmjs.com/cli/v11/commands/npm-run',
  'npm run documentation',
  'supports',
  'Lists run-script among the aliases of run, says npm run puts node_modules/.bin on the PATH of a script, and says run is used by the test, start, restart and stop commands.',
);
const PNPM_RUN = src(
  'https://pnpm.io/cli/run',
  'pnpm run documentation',
  'supports',
  'Lists run-script as an alias, says pnpm <script> is shorthand for pnpm run <script> only when the name is not a pnpm command, and says a built-in command runs instead of a same-named script; the page does not list the built-ins.',
);
const YARN_RUN = src(
  'https://yarnpkg.com/cli/run',
  'Yarn run documentation',
  'supports',
  'Says yarn run checks package.json scripts first and then runs a dependency binary of the same name, and shows yarn <name> as the same thing without the run keyword.',
);
const BUN_RUN = src(
  'https://bun.sh/docs/runtime',
  'bun run documentation',
  'supports',
  'Says bun <script> works without run, that a built-in bun command takes precedence over a same-named script, and that bun run resolves binaries from project packages.',
);
const PNPM_FILTER = src(
  'https://pnpm.io/filtering',
  'pnpm filtering documentation',
  'context',
  'Documents --filter and -F as the workspace selector; it does not define -r or --recursive, so the detector treating pnpm -r as running in every workspace package is not covered by this page.',
);
const NPM_WORKSPACES = src(
  'https://docs.npmjs.com/cli/v11/using-npm/workspaces',
  'npm workspaces documentation',
  'supports',
  'Documents the workspaces field of package.json, -w and --workspace to target one workspace, and --workspaces to run in all of them; the -ws short form is not mentioned on the page.',
);
const PNPM_WORKSPACE_YAML = src(
  'https://pnpm.io/settings',
  'pnpm-workspace.yaml documentation',
  'contradicts',
  'Says pnpm reads workspaces only from pnpm-workspace.yaml and not from the workspaces field of the root package.json, while workspace-manifests.ts merges package.json workspaces globs with pnpm-workspace.yaml globs for every repository whatever its package manager.',
);
const GNU_MAKE_NAMES = src(
  'https://www.gnu.org/software/make/manual/html_node/Makefile-Names.html',
  'GNU make manual, makefile names',
  'supports',
  'Says GNU make looks for GNUmakefile, then makefile, then Makefile, and that -f disables the search.',
);
const NPM_PACKAGE_JSON = src(
  'https://docs.npmjs.com/cli/v11/configuring-npm/package-json',
  'npm package.json documentation',
  'supports',
  'Documents engines.node as the Node.js versions a package works on and says the field is advisory unless engine-strict is set; it documents packageManager only under devEngines, not as a top-level field.',
);
const COREPACK = src(
  'https://github.com/nodejs/corepack',
  'Corepack README',
  'supports',
  'Says to set the package manager with the packageManager field of package.json in name@version form and lists yarn, npm and pnpm as permitted values; bun is not among them.',
);

// ── Python ────────────────────────────────────────────────────────────────────

const POETRY_PYPROJECT = src(
  'https://python-poetry.org/docs/pyproject/',
  'Poetry pyproject.toml documentation',
  'supports',
  'Documents the [tool.poetry] table, the [project] table with requires-python, and the python dependency constraint that Poetry uses for locking; it does not explain caret syntax.',
);
const PYPA_PYPROJECT = src(
  'https://packaging.python.org/en/latest/specifications/pyproject-toml/',
  'PyPA pyproject.toml specification',
  'supports',
  'Lists requires-python as a [project] key giving the Python version requirements, and says the [tool] table holds per-tool configuration such as [tool.flit].',
);
const PIPENV_PIPFILE = src(
  'https://pipenv.pypa.io/en/latest/pipfile.html',
  'Pipenv Pipfile documentation',
  'supports',
  'Describes the Pipfile as the TOML dependency manifest that Pipenv uses in place of requirements.txt.',
);
const CONDA_ENVIRONMENTS = src(
  'https://docs.conda.io/projects/conda/en/stable/user-guide/tasks/manage-environments.html',
  'conda environment management',
  'supports',
  'Says environments are created from a YAML file such as environment.yml, and that conda env create --file still works but conda create --file is now preferred.',
);
const PYTEST_START = src(
  'https://docs.pytest.org/en/stable/getting-started.html',
  'pytest getting started',
  'supports',
  'Shows that running pytest finds test_*.py or *_test.py files and reports which tests passed or failed.',
);
const PYTHON_DEVGUIDE = src(
  'https://devguide.python.org/versions/',
  'Python developer guide, status of Python versions',
  'supports',
  'Lists Python 2.7 end of life on 2020-01-01, 3.8 on 2024-10-07 and 3.9 on 2025-10-31, and also lists 3.10 as end of life on 2026-10-01, which the detector does not flag.',
);

// ── Node, Next.js, React, Angular ─────────────────────────────────────────────

const NODE_RELEASES = src(
  'https://nodejs.org/en/about/previous-releases',
  'Node.js previous releases',
  'supports',
  'Lists every Node.js release line up to v20 and v25 as EOL, including v12, v14 and v16; v18 is also EOL, so the detector cut-off of 16 understates what is end of life.',
);
const NEXT_SERVER_CLIENT = src(
  'https://nextjs.org/docs/app/getting-started/server-and-client-components',
  'Next.js server and client components',
  'supports',
  'Says layouts and pages in the App Router are Server Components by default and that the use client directive marks a Client Component boundary.',
);
const NEXT_MIGRATION = src(
  'https://nextjs.org/docs/app/guides/migrating/app-router-migration',
  'Next.js migrating from Pages to the App Router',
  'contradicts',
  'Says the app directory is intentionally designed to work simultaneously with the pages directory for incremental migration and that the two routers can be used together, which contradicts treating pages router and app router as mutually exclusive; it also says getServerSideProps, getStaticProps and getInitialProps are replaced inside app.',
);
const NEXT_MIGRATION_SUPPORTS = src(
  'https://nextjs.org/docs/app/guides/migrating/app-router-migration',
  'Next.js migrating from Pages to the App Router',
  'supports',
  'Says data fetching functions such as getServerSideProps and getStaticProps have been replaced by a new API inside app, and that getInitialProps is replaced too.',
);
const NEXT_GET_INITIAL_PROPS = src(
  'https://nextjs.org/docs/pages/api-reference/functions/get-initial-props',
  'Next.js getInitialProps',
  'supports',
  'Documents getInitialProps as a legacy Pages Router API usable only in top-level files under pages, and points to the App Router for component-level data fetching.',
);
const NEXT_CONFIG = src(
  'https://nextjs.org/docs/app/api-reference/config/next-config-js',
  'Next.js next.config.js reference',
  'supports',
  'Accepts next.config.js in the project root, next.config.mjs for ES modules and next.config.ts for TypeScript, and says the .cjs and .cts extensions are not supported.',
);
const NEXT_STRUCTURE = src(
  'https://nextjs.org/docs/app/getting-started/project-structure',
  'Next.js project structure',
  'supports',
  'Lists app as the App Router folder and pages as the Pages Router folder at the top level, allows an optional src folder for application code, and names page and layout as the routing files.',
);
const REACT_19 = src(
  'https://react.dev/blog/2024/04/25/react-19-upgrade-guide',
  'React 19 upgrade guide',
  'supports',
  'Says ReactDOM.render was deprecated in 18.0.0 and removed in React 19, with createRoot from react-dom/client as the replacement.',
);
const REACT_18 = src(
  'https://react.dev/blog/2022/03/08/react-18-upgrade-guide',
  'React 18 upgrade guide',
  'supports',
  'Says ReactDOM.render is deprecated in React 18, warns and runs the app in React 17 mode, and that createRoot enables the concurrent renderer.',
);
const ANGULAR_COMPONENTS = src(
  'https://angular.dev/guide/components',
  'Angular components guide',
  'contradicts',
  'Says components are standalone by default and that in versions before 19.0.0 the standalone option defaults to false, while the detector treats Angular 17 and 18 as already standalone by default; the page does not say what ng new generated in those versions.',
);
const ANGULAR_NGMODULES = src(
  'https://angular.dev/guide/ngmodules/overview',
  'Angular NgModules overview',
  'supports',
  'Says the Angular team recommends standalone components instead of NgModule for all new code and bootstrapApplication instead of bootstrapModule.',
);

// ── Deprecated packages ───────────────────────────────────────────────────────

const MOMENT_STATUS = src(
  'https://momentjs.com/docs/#/-project-status/',
  'Moment.js project status',
  'supports',
  'States that Moment.js is a legacy project in maintenance mode.',
);
const TSLINT_README = src(
  'https://github.com/palantir/tslint',
  'TSLint repository README',
  'supports',
  'Says TSLint is deprecated, points to ESLint as the replacement, and shows the repository archived on 2021-03-25.',
);
const LIBSASS_DEPRECATED = src(
  'https://sass-lang.com/blog/libsass-is-deprecated/',
  'Sass blog, LibSass is deprecated',
  'contradicts',
  'Says LibSass and Node Sass are deprecated and Dart Sass is the replacement, but also says LibSass and Node Sass will continue to be maintained indefinitely on a best-effort basis, which contradicts the detector wording that LibSass is no longer maintained.',
);
const REQUEST_ISSUE = src(
  'https://github.com/request/request/issues/3142',
  'request issue 3142, consider deprecating',
  'context',
  'Shows the maintainers discussing maintenance mode and deprecation and an npm warning that request has been deprecated quoted in an October 2022 comment; no 2020 deprecation date appears on the page.',
);
const REQUEST_NPM = src(
  'https://registry.npmjs.org/request/latest',
  'npm registry entry for the latest request release',
  'supports',
  'The registry marks the latest release deprecated with the message: request has been deprecated, see https://github.com/request/request/issues/3142.',
);
const CRA_SUNSET = src(
  'https://react.dev/blog/2025/02/14/sunsetting-create-react-app',
  'React blog, sunsetting Create React App',
  'supports',
  'Announces on 2025-02-14 that Create React App is deprecated for new apps and in maintenance mode; the page never names the react-scripts package.',
);
const ENZYME_README = src(
  'https://github.com/enzymejs/enzyme',
  'Enzyme repository README',
  'context',
  'Lists adapters only up to enzyme-adapter-react-16 and states no maintenance status or React 17 or 18 adapter, so it neither confirms nor refutes that Enzyme is unmaintained.',
);
const VUE2_EOL = src(
  'https://v2.vuejs.org/',
  'Vue 2 documentation',
  'supports',
  'States that Vue 2 has reached EOL and is no longer actively maintained, without giving a date on the page.',
);

// ── Rust, Go, .NET, Unity ─────────────────────────────────────────────────────

const CARGO_RUST_VERSION = src(
  'https://doc.rust-lang.org/cargo/reference/rust-version.html',
  'Cargo rust-version reference',
  'supports',
  'Says rust-version sets the minimum supported Rust version, must be a bare version number without operators, and makes Cargo error on an older toolchain.',
);
const CARGO_TEST = src(
  'https://doc.rust-lang.org/cargo/commands/cargo-test.html',
  'cargo test reference',
  'supports',
  'Says cargo test compiles and runs a package unit, integration and documentation tests.',
);
const CLIPPY_USAGE = src(
  'https://doc.rust-lang.org/clippy/usage.html',
  'Clippy usage',
  'supports',
  'Says Clippy can be used as a cargo subcommand or directly with the clippy-driver binary; the page does not state in one sentence what Clippy is for.',
);
const CARGO_FMT = src(
  'https://doc.rust-lang.org/cargo/commands/cargo-fmt.html',
  'cargo fmt reference',
  'context',
  'Documents cargo fmt as formatting the bin and lib files of a crate, shipped as an optional toolchain component that may need installing separately.',
);
const CARGO_SEMVER_ZERO = src(
  'https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html',
  'Cargo specifying dependencies',
  'supports',
  'Says for versions below 1.0 the left-most non-zero component decides compatibility, so ^0.2.3 allows >=0.2.3 and <0.3.0, which backs treating a 0.2 to 0.3 change as significant for crates such as tokio and axum.',
);
const RUST_EDITIONS = src(
  'https://doc.rust-lang.org/edition-guide/editions/index.html',
  'Rust edition guide, what are editions',
  'context',
  'Says each crate chooses its edition in Cargo.toml and that crates of different editions interoperate; the fetched page names only the 2018 edition, so the year values the detector compares are not listed on it.',
);
const GO_MOD_REF = src(
  'https://go.dev/ref/mod',
  'Go modules reference',
  'supports',
  'Says a module is defined by a go.mod file in its root directory and that the go directive sets the minimum Go version and changes behaviour at thresholds such as go 1.14, 1.16 and 1.17.',
);
const GO_TEST = src(
  'https://pkg.go.dev/cmd/go#hdr-Test_packages',
  'go command, test packages',
  'supports',
  'Says go test compiles each named package with its _test.go files, runs the test binary and prints a summary; the visible text does not define the ./... pattern.',
);
const GO_118 = src(
  'https://go.dev/doc/go1.18',
  'Go 1.18 release notes',
  'supports',
  'Says Go 1.18 includes an implementation of generics as described by the type parameters proposal.',
);
const DOTNET_FRAMEWORKS = src(
  'https://learn.microsoft.com/en-us/dotnet/standard/frameworks',
  'Target frameworks in SDK-style projects',
  'supports',
  'Lists net5.0 and later and netcoreapp3.1 as target framework monikers, specified with the TargetFramework element in the project file.',
);
const DOTNET_POLICY = src(
  'https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core',
  '.NET support policy',
  'supports',
  'Lists .NET 5 as ended on 2022-05-10 and .NET Core 3.1 on 2022-12-13, and also lists .NET 6, 7, 8 and 9 as ended, so the detector cut-off at .NET 5 understates what is out of support.',
);
const DOTNET_BUILD = src(
  'https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-build',
  'dotnet build command',
  'context',
  'Says dotnet build accepts a project file or a solution file with a .sln or .slnx extension; the detector recognises .sln and .csproj but not .slnx.',
);
const DOTNET_TEST = src(
  'https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-test',
  'dotnet test command',
  'supports',
  'Says dotnet test builds the solution and runs the tests with VSTest or Microsoft Testing Platform.',
);
const UNITY_MONOBEHAVIOUR_MANUAL = src(
  'https://docs.unity.com/en-us/engine/6000.6/manual/scripting/get-started/fundamental-unity-types/class-mono-behaviour',
  'Unity manual, MonoBehaviour',
  'supports',
  'Warns that defining a constructor for a MonoBehaviour interferes with the normal operation of Unity, and describes Start and Update as the initialisation and per-frame hooks; it says nothing about empty methods costing performance.',
);
const UNITY_MONOBEHAVIOUR_REF = src(
  'https://docs.unity.com/en-us/engine/6000.6/script-reference/unityengine/monobehaviour',
  'Unity script reference, MonoBehaviour',
  'supports',
  'Says a MonoBehaviour always exists as a Component of a GameObject and can be instantiated with GameObject.AddComponent; it does not explicitly forbid new and does not mention empty event methods.',
);
const UNITY_SERIALIZE_FIELD = src(
  'https://docs.unity.com/en-us/engine/6000.6/script-reference/unityengine/serializefield',
  'Unity script reference, SerializeField',
  'supports',
  'Says SerializeField forces Unity to serialize a private field and that Unity only serializes public fields by default; the page does not mention the Inspector.',
);
const UNITY_META = src(
  'https://docs.unity.com/en-us/engine/6000.6/manual/assets-and-media/import-assets/asset-metadata',
  'Unity manual, asset metadata',
  'supports',
  'Says Unity creates a .meta file per asset holding its unique ID and import settings, that losing it breaks references to the asset, and that moving an asset outside Unity requires moving its .meta file too; it does not say never to edit it.',
);
const UNITY_TEST_FRAMEWORK = src(
  'https://docs.unity3d.com/Packages/com.unity.test-framework@1.4/manual/index.html',
  'Unity Test Framework manual',
  'supports',
  'Says the Unity Test Framework tests code in Edit Mode and Play Mode and was previously called the Unity Test Runner; the menu path is not given on the page.',
);

// ── Git, GitHub Actions, security ─────────────────────────────────────────────

const GITIGNORE = src(
  'https://git-scm.com/docs/gitignore',
  'gitignore documentation',
  'supports',
  'Says the last matching pattern decides, lower-level .gitignore files override higher ones, a trailing slash matches only directories, and it is not possible to re-include a file if a parent directory is excluded.',
);
const GIT_PUSH = src(
  'https://git-scm.com/docs/git-push',
  'git push documentation',
  'context',
  'Says --force can cause the remote repository to lose commits and describes --force-with-lease as saying you expect the remote to hold the history you are replacing; the page does not recommend one over the other.',
);
const GH_SECURE_USE = src(
  'https://docs.github.com/en/actions/reference/security/secure-use',
  'GitHub Actions secure use reference',
  'supports',
  'Says pinning an action to a full-length commit SHA mitigates a backdoor being added to the action repository and that a tag can be moved or deleted if a bad actor gains access to the repository.',
);
const GH_WORKFLOW_SYNTAX = src(
  'https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax',
  'GitHub Actions workflow syntax',
  'supports',
  'Says the commit SHA of a released action version is the safest for stability and security, a branch reference is risky, ./ refers to an action in the same repository, and docker:// references use image tags.',
);
const SUPABASE_KEYS = src(
  'https://supabase.com/docs/guides/getting-started/api-keys',
  'Supabase API keys',
  'supports',
  'Says the secret and service_role key bypasses every Row Level Security policy and must never be put in a browser, a shipped application or source control.',
);
const OWASP_SECRETS = src(
  'https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html',
  'OWASP Secrets Management Cheat Sheet',
  'supports',
  'Advises avoiding checking secrets into code, says secrets should never be logged, and warns against hardcoding them; it has no blanket rule about printing to a console.',
);
const OWASP_UPLOAD = src(
  'https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html',
  'OWASP File Upload Cheat Sheet',
  'supports',
  'Recommends an allowlist of extensions, not trusting the Content-Type header and setting a file size limit for uploads.',
);
const CURSOR_IGNORE = src(
  'https://cursor.com/docs/reference/ignore-file',
  'Cursor ignore files',
  'contradicts',
  'Says Cursor ignores files in .gitignore and also a default ignore list (.env*, *.lock, node_modules/, .git/) and blocks Agent and Tab access to files in .cursorignore, so it skips more than gitignored paths; terminal and MCP tools are not blocked.',
);
const CLAUDE_SETTINGS_REFERENCE = src(
  'https://code.claude.com/docs/en/settings-reference',
  'Claude Code settings reference',
  'context',
  'Lists respectGitignore only as keeping gitignored files out of the @ file picker and shows no setting making gitignore govern file reads, which are controlled by permissions.deny rules.',
);
const CLAUDE_MEMORY = src(
  'https://code.claude.com/docs/en/memory',
  'Claude Code memory and CLAUDE.md',
  'supports',
  'Says CLAUDE.md files import other files with @path/to/import syntax, relative paths resolve against the importing file, imports nest to a depth of four, and code spans and fenced blocks are skipped.',
);
const CLAUDE_BEST_PRACTICES = src(
  'https://code.claude.com/docs/en/best-practices',
  'Claude Code best practices',
  'supports',
  'Says that when a repo already has a check, the single most useful line in CLAUDE.md is the command that runs it, because Claude otherwise has no way to verify its own work.',
);
const TS_NOEMIT = src(
  'https://www.typescriptlang.org/tsconfig/#noEmit',
  'TypeScript tsconfig reference, noEmit',
  'supports',
  'Says noEmit stops the compiler producing output files and leaves TypeScript for editor integration and type checking.',
);

export const REPO_CHECKS_PROVENANCE: readonly CheckProvenance[] = [
  // ── dead-references ─────────────────────────────────────────────────────────
  {
    id: 'dead-references',
    detector: 'dead-references',
    title: 'Dead file and directory references',
    kind: 'repo-fact',
    claim:
      'A link, @-reference or code-span path in an instruction file that names a file or directory absent from the scanned repository is a dead reference.',
    appliesTo: 'all',
    sources: [],
    thresholds: [
      {
        name: 'MAX_UNANCHORED_DEPTH',
        value: 2,
        unit: 'missing path levels below a first segment that exists',
        where: 'dead-references.ts:MAX_UNANCHORED_DEPTH',
        source: 'unverified',
      },
      {
        name: 'MIN_CONFIDENCE',
        value: 0.45,
        unit: 'confidence score',
        where: 'dead-references.ts:MIN_CONFIDENCE',
        source: 'unverified',
      },
      {
        name: 'minimum path segments for a code-span directory',
        value: 2,
        unit: 'path segments',
        where: 'dead-references.ts:BACKTICK_DIR_RE',
        source: 'unverified',
      },
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'dead-references/at-imports',
    detector: 'dead-references',
    title: 'At-sign file imports',
    kind: 'tool-fact',
    claim:
      'An @path reference in a CLAUDE.md file is a file import that Claude Code resolves relative to the importing file, so a missing target is a broken instruction.',
    appliesTo: ['claude-code'],
    sources: [CLAUDE_MEMORY],
    lastVerified: VERIFIED,
  },
  {
    id: 'dead-references/gitignore-matching',
    detector: 'dead-references',
    title: 'Gitignored paths are expected to be absent',
    kind: 'tool-fact',
    claim:
      'A path that the repository gitignore rules exclude is expected to be missing from a checkout, with the last matching rule winning, deeper gitignore files overriding shallower ones and files under an ignored directory ignored.',
    appliesTo: 'n/a',
    sources: [GITIGNORE],
    lastVerified: VERIFIED,
  },
  {
    id: 'dead-references/credential-paths',
    detector: 'dead-references',
    title: 'Credential and local-config paths are expected to be absent',
    kind: 'opinion',
    claim:
      'A referenced .env file, secrets file, local-override config, private key or certificate is deliberately kept out of the repository, so its absence is not a stale reference.',
    appliesTo: 'all',
    sources: [],
    unverified: true,
    lastVerified: VERIFIED,
  },

  // ── command-validity ────────────────────────────────────────────────────────
  {
    id: 'command-validity',
    detector: 'command-validity',
    title: 'Documented commands name scripts, files and targets that exist',
    kind: 'repo-fact',
    claim:
      'A command in an instruction file that names a package script, file path or make target that the scanned repository does not define will fail when run.',
    appliesTo: 'all',
    sources: [],
    thresholds: [
      { name: 'MAX_MANIFEST_DIRS', value: 400, unit: 'directories', where: 'command-validity.ts:MAX_MANIFEST_DIRS', source: 'unverified' },
      { name: 'MAX_MANIFEST_DEPTH', value: 5, unit: 'directory levels', where: 'command-validity.ts:MAX_MANIFEST_DEPTH', source: 'unverified' },
      { name: 'MAX_HINT_LINES', value: 80, unit: 'lines above a command', where: 'command-validity.ts:MAX_HINT_LINES', source: 'unverified' },
      { name: 'MAX_HINT_DIRS', value: 24, unit: 'directories', where: 'command-validity.ts:MAX_HINT_DIRS', source: 'unverified' },
      { name: 'MAX_HINT_LINES_AFTER_HEADING', value: 10, unit: 'lines', where: 'command-validity.ts:MAX_HINT_LINES_AFTER_HEADING', source: 'unverified' },
      { name: 'MAX_WORKSPACE_MANIFESTS', value: 200, unit: 'package.json files', where: 'workspace-manifests.ts:MAX_WORKSPACE_MANIFESTS', source: 'unverified' },
      { name: 'CLOSE_MATCH_MAX_DISTANCE', value: 2, unit: 'edits', where: 'close-match.ts:CLOSE_MATCH_MAX_DISTANCE', source: 'unverified' },
      { name: 'CLOSE_MATCH_MIN_LENGTH', value: 4, unit: 'characters', where: 'close-match.ts:CLOSE_MATCH_MIN_LENGTH', source: 'unverified' },
      { name: 'MECHANICAL_TWO_EDIT_MIN_LENGTH', value: 8, unit: 'characters', where: 'close-match.ts:MECHANICAL_TWO_EDIT_MIN_LENGTH', source: 'unverified' },
      { name: 'MECHANICAL_SEGMENT_MIN_LENGTH', value: 5, unit: 'characters', where: 'close-match.ts:MECHANICAL_SEGMENT_MIN_LENGTH', source: 'unverified' },
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'command-validity/package-manager-scripts',
    detector: 'command-validity',
    title: 'How npm, pnpm, yarn and bun resolve a script name',
    kind: 'tool-fact',
    claim:
      'npm and pnpm treat run-script as an alias of run, pnpm and yarn and bun also run a script or an installed binary through the bare form, and a built-in command takes precedence over a same-named script.',
    appliesTo: 'n/a',
    sources: [NPM_RUN, PNPM_RUN, YARN_RUN, BUN_RUN],
    lastVerified: VERIFIED,
  },
  {
    id: 'command-validity/workspaces',
    detector: 'command-validity',
    title: 'Workspace selectors and where workspace packages come from',
    kind: 'tool-fact',
    claim:
      'pnpm --filter, npm -w and --workspace, and the workspaces globs of package.json or pnpm-workspace.yaml decide which workspace package a script command runs in, with conventional apps, packages and libs roots assumed when none are declared.',
    appliesTo: 'n/a',
    sources: [PNPM_FILTER, NPM_WORKSPACES, PNPM_WORKSPACE_YAML],
    lastVerified: VERIFIED,
  },
  {
    id: 'command-validity/make-targets',
    detector: 'command-validity',
    title: 'Which Makefile make reads and what counts as a target',
    kind: 'tool-fact',
    claim:
      'GNU make reads GNUmakefile, then makefile, then Makefile when no -f is given, and a target can come from an explicit rule, a .PHONY name, a pattern rule or a built-in implicit rule.',
    appliesTo: 'n/a',
    sources: [GNU_MAKE_NAMES],
    lastVerified: VERIFIED,
  },

  // ── manifest-consistency ────────────────────────────────────────────────────
  {
    id: 'manifest-consistency',
    detector: 'manifest-consistency',
    title: 'Instructions agree with the repository manifests',
    kind: 'repo-fact',
    claim:
      'An instruction file that names a Python or Node.js version, a library major version, a package manager, a script or a test tool that differs from what pyproject.toml, package.json or the lockfile declares disagrees with the repository.',
    appliesTo: 'all',
    sources: [],
    thresholds: [
      { name: 'Python library intent window before', value: 80, unit: 'characters', where: 'manifest-consistency.ts:hasCompatibilityIntent', source: 'unverified' },
      { name: 'Python library intent window after', value: 120, unit: 'characters', where: 'manifest-consistency.ts:hasCompatibilityIntent', source: 'unverified' },
      { name: 'JavaScript library intent window before', value: 100, unit: 'characters', where: 'manifest-consistency.ts:hasJsVersionIntent', source: 'unverified' },
      { name: 'JavaScript library intent window after', value: 140, unit: 'characters', where: 'manifest-consistency.ts:hasJsVersionIntent', source: 'unverified' },
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'manifest-consistency/package-manager-and-engines',
    detector: 'manifest-consistency',
    title: 'packageManager field, lockfiles and engines.node',
    kind: 'tool-fact',
    claim:
      'The packageManager field of package.json names the project package manager as name@version, the lockfile is the fallback signal, and engines.node states the Node.js versions the package works on.',
    appliesTo: 'n/a',
    sources: [COREPACK, NPM_PACKAGE_JSON],
    lastVerified: VERIFIED,
  },
  {
    id: 'manifest-consistency/python-manifest',
    detector: 'manifest-consistency',
    title: 'Python version and Poetry projects in pyproject.toml',
    kind: 'tool-fact',
    claim:
      'A pyproject.toml states the required Python version in requires-python or in the Poetry python dependency, and a Poetry project is installed from pyproject.toml rather than from a requirements.txt.',
    appliesTo: 'n/a',
    sources: [POETRY_PYPROJECT, PYPA_PYPROJECT],
    lastVerified: VERIFIED,
  },

  // ── dependency-staleness ────────────────────────────────────────────────────
  {
    id: 'dependency-staleness',
    detector: 'dependency-staleness',
    title: 'Packages named in instructions that no manifest declares',
    kind: 'repo-fact',
    claim:
      'An npm package named by an install command or import line in an instruction file that no package.json in the scanned repository declares is a missing dependency.',
    appliesTo: 'all',
    sources: [],
    thresholds: [
      { name: 'EXTRA_MANIFEST_LIMIT', value: 200, unit: 'package.json files', where: 'dependency-staleness.ts:EXTRA_MANIFEST_LIMIT', source: 'unverified' },
      { name: 'NgModule file search depth', value: 8, unit: 'directory levels', where: 'dependency-staleness.ts:hasNgModuleFiles', source: 'unverified' },
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'dependency-staleness/deprecated-packages',
    detector: 'dependency-staleness',
    title: 'Packages their maintainers have deprecated or stopped maintaining',
    kind: 'tool-fact',
    claim:
      'moment is in maintenance mode, request, tslint and node-sass are deprecated, react-scripts belongs to the deprecated Create React App, and enzyme has no adapter for current React versions.',
    appliesTo: 'n/a',
    sources: [MOMENT_STATUS, REQUEST_NPM, REQUEST_ISSUE, TSLINT_README, LIBSASS_DEPRECATED, CRA_SUNSET, ENZYME_README],
    lastVerified: VERIFIED,
  },
  {
    id: 'dependency-staleness/version-gated-apis',
    detector: 'dependency-staleness',
    title: 'APIs that a framework major version removed or replaced',
    kind: 'tool-fact',
    claim:
      'ReactDOM.render was deprecated in React 18 and removed in React 19, and getInitialProps belongs to the Next.js Pages Router only.',
    appliesTo: 'n/a',
    sources: [REACT_19, REACT_18, NEXT_GET_INITIAL_PROPS, NEXT_MIGRATION_SUPPORTS],
    thresholds: [
      { name: 'ReactDOM.render warning at React major', value: 18, unit: 'major version', where: 'dependency-staleness.ts:checkReactRender', source: REACT_18 },
      { name: 'ReactDOM.render removed at React major', value: 19, unit: 'major version', where: 'dependency-staleness.ts:checkReactRender', source: REACT_19 },
    ],
    lastVerified: VERIFIED,
  },

  {
    id: 'dependency-staleness/angular-standalone-default',
    refuted: true,
    detector: 'dependency-staleness',
    title: 'Angular standalone components by default',
    kind: 'tool-fact',
    claim: 'Angular 17 and later projects default to standalone components rather than NgModules.',
    appliesTo: 'n/a',
    sources: [ANGULAR_COMPONENTS, { ...ANGULAR_NGMODULES, stance: 'context' }],
    thresholds: [
      { name: 'NgModule guidance stale from Angular major (the detector value; the standalone default arrives in 19.0.0)', value: 17, unit: 'major version', where: 'dependency-staleness.ts:checkNgModule', source: 'unverified' },
    ],
    lastVerified: VERIFIED,
  },

  // ── ci-alignment ────────────────────────────────────────────────────────────
  {
    id: 'ci-alignment',
    detector: 'ci-alignment',
    title: 'CI runs checks the instructions do not mention',
    kind: 'repo-fact',
    claim:
      'A GitHub workflow that runs lint, typecheck, test, build or format while no instruction file tells the agent to run it, or that uses a different package manager than the instructions, is out of step with the instructions.',
    appliesTo: 'all',
    sources: [],
    lastVerified: VERIFIED,
  },
  {
    id: 'ci-alignment/package-scripts',
    detector: 'ci-alignment',
    title: 'Package-manager command forms used to recognise CI tasks',
    kind: 'tool-fact',
    claim:
      'npm, pnpm, yarn and bun run a package script through the run form, and npm test, start, stop and restart are built-in lifecycle commands rather than user scripts.',
    appliesTo: 'n/a',
    sources: [NPM_RUN, PNPM_RUN, YARN_RUN, BUN_RUN],
    lastVerified: VERIFIED,
  },
  {
    id: 'ci-alignment/typecheck-vs-build',
    detector: 'ci-alignment',
    title: 'tsc --noEmit is a typecheck and bare tsc is a build',
    kind: 'tool-fact',
    claim:
      'Running tsc with --noEmit type-checks without writing output files, while running tsc without it emits compiled output as a build.',
    appliesTo: 'n/a',
    sources: [TS_NOEMIT],
    lastVerified: VERIFIED,
  },

  // ── conflicts ───────────────────────────────────────────────────────────────
  {
    id: 'conflicts',
    detector: 'conflicts',
    title: 'Contradictory directives in instruction files',
    kind: 'repo-fact',
    claim:
      'Two instruction sections that carry opposite directives such as use against do not use, or always against never, about the same or a highly similar subject contradict each other.',
    appliesTo: 'all',
    sources: [],
    thresholds: [
      { name: 'subject word overlap for a partial match', value: 0.5, unit: 'Jaccard similarity', where: 'conflicts.ts:detectConflicts', source: 'unverified' },
      { name: 'minimum confidence to report', value: 0.4, unit: 'confidence score', where: 'conflicts.ts:detectConflicts', source: 'unverified' },
      { name: 'confidence at which severity becomes high', value: 0.7, unit: 'confidence score', where: 'conflicts.ts:detectConflicts', source: 'unverified' },
      { name: 'subject words kept after a directive', value: 3, unit: 'words', where: 'conflicts.ts:extractSubjectWords', source: 'unverified' },
      { name: 'subject words kept before a directive', value: 4, unit: 'words', where: 'conflicts.ts:extractSubjectWordsBefore', source: 'unverified' },
      { name: 'minimum tokens per side for a partial match', value: 2, unit: 'words', where: 'conflicts.ts:detectConflicts', source: 'unverified' },
      { name: 'MIN_SECTION_LENGTH', value: 1, unit: 'characters', where: 'conflicts.ts:MIN_SECTION_LENGTH', source: 'unverified' },
    ],
    lastVerified: VERIFIED,
  },

  // ── version-conflicts ───────────────────────────────────────────────────────
  {
    id: 'version-conflicts',
    detector: 'version-conflicts',
    title: 'Instruction files state different versions of one framework',
    kind: 'repo-fact',
    claim:
      'Two different instruction files that each positively state a different version of the same framework or runtime disagree with each other.',
    appliesTo: 'all',
    sources: [],
    thresholds: [
      { name: 'minimum instruction files', value: 2, unit: 'files', where: 'conflicts.ts:detectVersionConflicts', source: 'unverified' },
      { name: 'finding confidence', value: 0.75, unit: 'confidence score', where: 'conflicts.ts:detectVersionConflicts', source: 'unverified' },
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'version-conflicts/version-significance',
    detector: 'version-conflicts',
    title: 'Which version differences are significant',
    kind: 'tool-fact',
    claim:
      'A difference in major version is significant for most frameworks, a difference in Go minor version is significant, and for Rust crates below 1.0 a change of minor version is a compatibility break.',
    appliesTo: 'n/a',
    sources: [CARGO_SEMVER_ZERO, GO_MOD_REF, RUST_EDITIONS],
    lastVerified: VERIFIED,
  },

  // ── competing-tech-conflicts ────────────────────────────────────────────────
  {
    id: 'competing-tech-conflicts',
    detector: 'competing-tech-conflicts',
    title: 'Mutually exclusive technology choices',
    kind: 'opinion',
    claim:
      'Instruction files that recommend competing options for one dimension, such as redux against zustand, kebab-case against camelCase file names or pip against poetry, leave an agent unable to choose.',
    appliesTo: 'all',
    sources: [],
    unverified: true,
    thresholds: [
      { name: 'minimum instruction files', value: 2, unit: 'files', where: 'conflicts.ts:detectCompetingTechConflicts', source: 'unverified' },
      { name: 'finding confidence', value: 0.6, unit: 'confidence score', where: 'conflicts.ts:detectCompetingTechConflicts', source: 'unverified' },
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'competing-tech-conflicts/nextjs-routers',
    refuted: true,
    detector: 'competing-tech-conflicts',
    title: 'Pages Router and App Router treated as exclusive',
    kind: 'tool-fact',
    claim:
      'The Next.js Pages Router and App Router are mutually exclusive routing strategies, so instruction files recommending one and the other conflict.',
    appliesTo: 'n/a',
    sources: [NEXT_MIGRATION],
    lastVerified: VERIFIED,
  },

  // ── stale-instructions ──────────────────────────────────────────────────────
  {
    id: 'stale-instructions',
    detector: 'stale-instructions',
    title: 'Past years, cleanup markers and deprecated notes',
    kind: 'opinion',
    claim:
      'An instruction section that names a calendar year from the last seven, a workaround or temporary fix marker, a dated TODO comment or a deprecated tool is likely out of date.',
    appliesTo: 'all',
    sources: [],
    unverified: true,
    thresholds: [
      { name: 'STALE_YEAR_WINDOW', value: 7, unit: 'years before the current year', where: 'stale-instructions.ts:STALE_YEAR_WINDOW', source: 'unverified' },
      { name: 'negation context lookback', value: 80, unit: 'characters', where: 'stale-instructions.ts:isVersionInNegationContext', source: 'unverified' },
      { name: 'deprecated-near-tool window', value: 60, unit: 'characters', where: 'stale-instructions.ts:DEPRECATED_NEAR_VERSION_RE', source: 'unverified' },
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'stale-instructions/end-of-life-runtimes',
    detector: 'stale-instructions',
    title: 'End-of-life runtime versions',
    kind: 'tool-fact',
    claim:
      'Node.js 16 and earlier, Python 3.9 and earlier, Python 2, .NET 5 and earlier and Vue 2 are past end of life, and Go 1.17 and earlier pre-date generics.',
    appliesTo: 'n/a',
    sources: [NODE_RELEASES, PYTHON_DEVGUIDE, DOTNET_POLICY, VUE2_EOL, GO_118],
    thresholds: [
      { name: 'Node.js newest flagged major', value: 16, unit: 'major version', where: 'stale-instructions.ts:OLD_VERSION_PATTERNS', source: NODE_RELEASES },
      { name: 'Python newest flagged 3.x minor', value: 9, unit: 'minor version of 3', where: 'stale-instructions.ts:OLD_VERSION_PATTERNS', source: PYTHON_DEVGUIDE },
      { name: '.NET newest flagged major', value: 5, unit: 'major version', where: 'stale-instructions.ts:OLD_VERSION_PATTERNS', source: DOTNET_POLICY },
      { name: 'Go newest flagged 1.x minor', value: 17, unit: 'minor version of 1', where: 'stale-instructions.ts:OLD_VERSION_PATTERNS', source: GO_118 },
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'stale-instructions/old-framework-majors',
    detector: 'stale-instructions',
    title: 'Old framework and tool majors',
    kind: 'tool-fact',
    claim:
      'React 16 and earlier, Next.js 9 and earlier, Angular 9 and earlier, Webpack 3 and earlier, Babel 6 and earlier, TypeScript 3 and earlier and Unity 2019 and earlier are old enough that instructions naming them are stale.',
    appliesTo: 'n/a',
    sources: [],
    unverified: true,
    thresholds: [
      { name: 'React newest flagged major', value: 16, unit: 'major version', where: 'stale-instructions.ts:OLD_VERSION_PATTERNS', source: 'unverified' },
      { name: 'Next.js newest flagged major', value: 9, unit: 'major version', where: 'stale-instructions.ts:OLD_VERSION_PATTERNS', source: 'unverified' },
      { name: 'Angular newest flagged major', value: 9, unit: 'major version', where: 'stale-instructions.ts:OLD_VERSION_PATTERNS', source: 'unverified' },
      { name: 'Webpack newest flagged major', value: 3, unit: 'major version', where: 'stale-instructions.ts:OLD_VERSION_PATTERNS', source: 'unverified' },
      { name: 'Babel newest flagged major', value: 6, unit: 'major version', where: 'stale-instructions.ts:OLD_VERSION_PATTERNS', source: 'unverified' },
      { name: 'TypeScript newest flagged major', value: 3, unit: 'major version', where: 'stale-instructions.ts:OLD_VERSION_PATTERNS', source: 'unverified' },
      { name: 'Unity newest flagged year', value: 2019, unit: 'release year', where: 'stale-instructions.ts:OLD_VERSION_PATTERNS', source: 'unverified' },
    ],
    lastVerified: VERIFIED,
  },

  // ── action-pinning ──────────────────────────────────────────────────────────
  {
    id: 'action-pinning',
    detector: 'action-pinning',
    title: 'Tag and branch action references are mutable',
    kind: 'tool-fact',
    claim:
      'A GitHub Actions uses reference pinned to a tag or branch can be moved by whoever controls the action repository, while a full commit SHA cannot be repointed.',
    appliesTo: 'n/a',
    sources: [GH_SECURE_USE, GH_WORKFLOW_SYNTAX],
    thresholds: [
      { name: 'SHA-1 commit id length', value: 40, unit: 'hex characters', where: 'action-pinning.ts:FULL_SHA_RE', source: 'unverified' },
      { name: 'SHA-256 commit id length', value: 64, unit: 'hex characters', where: 'action-pinning.ts:FULL_SHA_RE', source: 'unverified' },
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'action-pinning/exempt-references',
    detector: 'action-pinning',
    title: 'Local and container action references have no git ref to pin',
    kind: 'tool-fact',
    claim:
      'A local ./ action lives in the same repository and a docker:// action names an image rather than a git ref, so a commit SHA pin does not apply to either.',
    appliesTo: 'n/a',
    sources: [GH_WORKFLOW_SYNTAX],
    lastVerified: VERIFIED,
  },
  {
    id: 'action-pinning/first-party-owners',
    detector: 'action-pinning',
    title: 'GitHub-maintained actions carry a lower risk',
    kind: 'opinion',
    claim:
      'An unpinned action owned by the actions or github organisations is a lower risk than an unpinned third-party action, though still a mutable pointer.',
    appliesTo: 'all',
    sources: [],
    unverified: true,
    lastVerified: VERIFIED,
  },

  // ── security-pack ───────────────────────────────────────────────────────────
  {
    id: 'security-pack',
    detector: 'security-pack',
    title: 'Security signals in the repository',
    kind: 'repo-fact',
    claim:
      'A repository that has an env file, a Supabase dependency, upload code or a .promptci directory while no instruction file carries the matching safeguard wording lacks that safeguard in its instructions.',
    appliesTo: 'all',
    sources: [],
    lastVerified: VERIFIED,
  },
  {
    id: 'security-pack/secret-handling',
    unverified: true,
    detector: 'security-pack',
    title: 'Instructions should say never to print or commit secrets',
    kind: 'opinion',
    claim:
      'A repository that uses environment variables should tell the agent in its instructions never to print, log or commit secrets, API keys or credentials.',
    appliesTo: 'all',
    sources: [{ ...OWASP_SECRETS, stance: 'context' }],
    lastVerified: VERIFIED,
  },
  {
    id: 'security-pack/supabase-service-role',
    detector: 'security-pack',
    title: 'Supabase service role key stays server-side',
    kind: 'tool-fact',
    claim:
      'The Supabase service role key bypasses Row Level Security and must only be used server-side, never in browser code, logs or committed files.',
    appliesTo: 'n/a',
    sources: [SUPABASE_KEYS],
    lastVerified: VERIFIED,
  },
  {
    id: 'security-pack/upload-validation',
    unverified: true,
    detector: 'security-pack',
    title: 'Instructions should define upload validation',
    kind: 'opinion',
    claim:
      'A repository with file upload code should document allowed file types, a size limit and validation steps for user-provided files in its instructions.',
    appliesTo: 'all',
    sources: [{ ...OWASP_UPLOAD, stance: 'context' }],
    lastVerified: VERIFIED,
  },
  {
    id: 'security-pack/destructive-commands',
    unverified: true,
    detector: 'security-pack',
    title: 'Destructive commands need safety language',
    kind: 'opinion',
    claim:
      'An instruction file that names rm -rf, drop table or git push --force should carry nearby language such as ask before running or confirm before, so an agent does not run it unprompted.',
    appliesTo: 'all',
    sources: [GIT_PUSH],
    lastVerified: VERIFIED,
  },
  {
    id: 'security-pack/gitignore-semantics',
    detector: 'security-pack',
    title: 'How gitignore matches and re-includes paths',
    kind: 'tool-fact',
    claim:
      'A gitignore negation cannot re-include a file under an excluded parent directory, so ignoring .promptci with a carve-out needs .promptci/* rather than .promptci/, and a line ignores a directory only when a path segment matches its name exactly.',
    appliesTo: 'n/a',
    sources: [GITIGNORE],
    lastVerified: VERIFIED,
  },
  {
    id: 'security-pack/generated-directories',
    refuted: true,
    detector: 'security-pack',
    title: 'Unignored generated directories reach AI tools',
    kind: 'tool-fact',
    claim:
      'Directories such as coverage, dist, build and .next that are not gitignored can be read into the context of AI coding tools, which inflates token cost, because tools such as Cursor skip only gitignored paths.',
    appliesTo: ['cursor', 'claude-code'],
    sources: [CURSOR_IGNORE, CLAUDE_SETTINGS_REFERENCE],
    lastVerified: VERIFIED,
  },

  // ── framework-packs ─────────────────────────────────────────────────────────
  {
    id: 'framework-packs/nextjs',
    detector: 'framework-packs',
    title: 'Next.js pack',
    kind: 'tool-fact',
    claim:
      'In Next.js the app directory is the App Router whose layouts and pages are Server Components by default, getStaticProps and getServerSideProps and getInitialProps are Pages Router APIs, and the config file is next.config.js, .mjs or .ts.',
    appliesTo: 'n/a',
    sources: [NEXT_SERVER_CLIENT, NEXT_MIGRATION_SUPPORTS, NEXT_GET_INITIAL_PROPS, NEXT_CONFIG, NEXT_STRUCTURE],
    lastVerified: VERIFIED,
  },
  {
    id: 'framework-packs/python',
    detector: 'framework-packs',
    title: 'Python pack',
    kind: 'tool-fact',
    claim:
      'A Pipfile marks a Pipenv project, an environment.yml marks a Conda environment, a [tool.poetry] table marks a Poetry project, and pytest runs tests by discovering test_*.py or *_test.py files.',
    appliesTo: 'n/a',
    sources: [PIPENV_PIPFILE, CONDA_ENVIRONMENTS, POETRY_PYPROJECT, PYTEST_START],
    lastVerified: VERIFIED,
  },
  {
    id: 'framework-packs/rust',
    detector: 'framework-packs',
    title: 'Rust pack',
    kind: 'tool-fact',
    claim:
      'The rust-version key of Cargo.toml is the minimum supported Rust version, and cargo test, cargo clippy and cargo fmt are the standard Rust verification commands.',
    appliesTo: 'n/a',
    sources: [CARGO_RUST_VERSION, CARGO_TEST, CLIPPY_USAGE, CARGO_FMT],
    lastVerified: VERIFIED,
  },
  {
    id: 'framework-packs/go',
    detector: 'framework-packs',
    title: 'Go pack',
    kind: 'tool-fact',
    claim:
      'A go.mod file in the root directory defines a Go module, and go test with the three-dot package pattern runs the tests of every package in it.',
    appliesTo: 'n/a',
    sources: [GO_MOD_REF, GO_TEST],
    lastVerified: VERIFIED,
  },
  {
    id: 'framework-packs/dotnet',
    detector: 'framework-packs',
    title: '.NET pack',
    kind: 'tool-fact',
    claim:
      'A .sln or .csproj file marks a .NET project, its TargetFramework is a moniker such as net8.0, netcoreapp3.1 and net5.0 are out of support, and dotnet build and dotnet test are the validation commands.',
    appliesTo: 'n/a',
    sources: [DOTNET_FRAMEWORKS, DOTNET_POLICY, DOTNET_BUILD, DOTNET_TEST],
    lastVerified: VERIFIED,
  },
  {
    id: 'framework-packs/unity',
    detector: 'framework-packs',
    title: 'Unity pack',
    kind: 'tool-fact',
    claim:
      'A MonoBehaviour is attached to a GameObject rather than created with a constructor, SerializeField makes Unity serialize a private field, a missing .meta file breaks asset references, and the Unity Test Framework runs Edit Mode and Play Mode tests.',
    appliesTo: 'n/a',
    sources: [
      UNITY_MONOBEHAVIOUR_MANUAL,
      UNITY_MONOBEHAVIOUR_REF,
      UNITY_SERIALIZE_FIELD,
      UNITY_META,
      UNITY_TEST_FRAMEWORK,
    ],
    lastVerified: VERIFIED,
  },
  {
    id: 'framework-packs/verification-guidance',
    unverified: true,
    detector: 'framework-packs',
    title: 'Instructions should name the verification command',
    kind: 'opinion',
    claim:
      'Instructions for a repository that uses a framework should name its verification commands so an agent runs them before declaring work complete.',
    appliesTo: ['claude-code'],
    sources: [{ ...CLAUDE_BEST_PRACTICES, stance: 'context' }],
    lastVerified: VERIFIED,
  },
];
