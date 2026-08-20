import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { detectProjectType, detectProjectTypeFromContent } from '../src/project-type.js';
import type { InstructionFile } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '../../../examples');

describe('detectProjectType', () => {
  it('fixture-unity: detects "unity"', async () => {
    const result = await detectProjectType(path.join(FIXTURES, 'fixture-unity'));
    expect(result).toBe('unity');
  });

  it('fixture-basic: detects "typescript" (has package.json)', async () => {
    const result = await detectProjectType(path.join(FIXTURES, 'fixture-basic'));
    expect(result).toBe('typescript');
  });

  it('empty/unknown directory: returns "unknown" without throwing', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-test-'));
    try {
      const result = await detectProjectType(tmp);
      expect(result).toBe('unknown');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('non-existent directory: returns "unknown" without throwing', async () => {
    const result = await detectProjectType(
      path.join(os.tmpdir(), 'promptci-does-not-exist-xyzzy'),
    );
    expect(result).toBe('unknown');
  });

  it('nextjs: detects "nextjs" when next.config.js is present', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-nextjs-'));
    try {
      await fs.writeFile(path.join(tmp, 'package.json'), '{}');
      await fs.writeFile(path.join(tmp, 'next.config.js'), 'module.exports = {}');
      const result = await detectProjectType(tmp);
      expect(result).toBe('nextjs');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('nextjs: detects "nextjs" via app/ dir alongside package.json', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-nextjs-app-'));
    try {
      await fs.writeFile(path.join(tmp, 'package.json'), '{}');
      await fs.mkdir(path.join(tmp, 'app'));
      const result = await detectProjectType(tmp);
      expect(result).toBe('nextjs');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('nextjs: detects "nextjs" via pages/ dir alongside package.json', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-nextjs-pages-'));
    try {
      await fs.writeFile(path.join(tmp, 'package.json'), '{}');
      await fs.mkdir(path.join(tmp, 'pages'));
      const result = await detectProjectType(tmp);
      expect(result).toBe('nextjs');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('dotnet: detects "dotnet" when a .sln file is present', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-dotnet-'));
    try {
      await fs.writeFile(path.join(tmp, 'MyApp.sln'), '');
      const result = await detectProjectType(tmp);
      expect(result).toBe('dotnet');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('dotnet: detects "dotnet" when a .csproj file is present', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-dotnet-csproj-'));
    try {
      await fs.writeFile(path.join(tmp, 'MyLib.csproj'), '<Project/>');
      const result = await detectProjectType(tmp);
      expect(result).toBe('dotnet');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('typescript: tsconfig.json alone (no package.json) detects "typescript"', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-ts-'));
    try {
      await fs.writeFile(path.join(tmp, 'tsconfig.json'), '{}');
      const result = await detectProjectType(tmp);
      expect(result).toBe('typescript');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // Regression: a root package.json (dropped by JS tooling like husky/prettier)
  // must not shadow the more specific Unity/.NET markers.

  it('unity: package.json + Assets/ProjectVersion.txt detects "unity" (not typescript)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-unity-pkg-'));
    try {
      await fs.writeFile(path.join(tmp, 'package.json'), '{"devDependencies":{"prettier":"*"}}');
      await fs.mkdir(path.join(tmp, 'Assets'));
      await fs.mkdir(path.join(tmp, 'ProjectSettings'));
      await fs.writeFile(
        path.join(tmp, 'ProjectSettings', 'ProjectVersion.txt'),
        'm_EditorVersion: 6000.0.0f1',
      );
      const result = await detectProjectType(tmp);
      expect(result).toBe('unity');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('dotnet: package.json + *.sln detects "dotnet" (not typescript)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-dotnet-pkg-'));
    try {
      await fs.writeFile(path.join(tmp, 'package.json'), '{"devDependencies":{"husky":"*"}}');
      await fs.writeFile(path.join(tmp, 'MyApp.sln'), '');
      const result = await detectProjectType(tmp);
      expect(result).toBe('dotnet');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('typescript: plain package.json (no unity/dotnet markers) detects "typescript"', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promptci-ts-pkg-'));
    try {
      await fs.writeFile(path.join(tmp, 'package.json'), '{"name":"plain"}');
      const result = await detectProjectType(tmp);
      expect(result).toBe('typescript');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('detectProjectTypeFromContent', () => {
  function file(content: string): InstructionFile {
    return {
      path: 'AGENTS.md',
      fileType: 'agents',
      content,
      sections: [],
      lineCount: content.split('\n').length,
      charCount: content.length,
      estimatedTokens: Math.round(content.length / 4),
    };
  }

  // The content fallback must use the same dotnet-before-typescript ordering as
  // the file-system probe: .NET instructions commonly mention JS tooling
  // (npm run, jest for docs sites, husky), and those broad typescript signals
  // must not shadow the specific .NET ones.
  it('classifies a .NET repo that also mentions JS tooling as "dotnet"', () => {
    const result = detectProjectTypeFromContent([
      file('Build with dotnet build MyApp.sln. Run npm run docs for the docs site. Tests use xunit.'),
    ]);
    expect(result).toBe('dotnet');
  });

  it('classifies pure JS tooling content as "typescript"', () => {
    const result = detectProjectTypeFromContent([
      file('Run npm run build and vitest. tsconfig strict mode is required.'),
    ]);
    expect(result).toBe('typescript');
  });
});
