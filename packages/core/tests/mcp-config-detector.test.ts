import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { detectMcpConfig } from '../src/mcp-config-detector.js';
import { makeTempRepo, writeFile, ctx } from './ai-config-helpers.js';

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function repo(): string {
  const dir = makeTempRepo();
  cleanups.push(dir);
  return dir;
}

describe('detectMcpConfig', () => {
  it('is silent with no .mcp.json', () => {
    expect(detectMcpConfig(ctx(repo()))).toEqual([]);
  });

  it('accepts a well-formed server using a bare binary (npx not verified)', () => {
    const dir = repo();
    writeFile(dir, '.mcp.json', JSON.stringify({
      mcpServers: { fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] } },
    }));
    expect(detectMcpConfig(ctx(dir))).toEqual([]);
  });

  it('flags invalid JSON', () => {
    const dir = repo();
    writeFile(dir, '.mcp.json', '{ "mcpServers": { }');
    const issues = detectMcpConfig(ctx(dir));
    expect(issues.some((i) => i.title.includes('not valid JSON'))).toBe(true);
  });

  it('flags duplicate server names', () => {
    const dir = repo();
    writeFile(dir, '.mcp.json', [
      '{',
      '  "mcpServers": {',
      '    "db": { "command": "npx", "args": ["a"] },',
      '    "db": { "command": "npx", "args": ["b"] }',
      '  }',
      '}',
    ].join('\n'));
    const issues = detectMcpConfig(ctx(dir));
    const dup = issues.find((i) => i.title.includes('Duplicate MCP server name'));
    expect(dup).toBeDefined();
    expect(dup!.evidence.join(' ')).toContain('db');
  });

  it('flags placeholder env values but not passthrough refs', () => {
    const dir = repo();
    writeFile(dir, '.mcp.json', JSON.stringify({
      mcpServers: {
        api: {
          command: 'npx',
          args: ['server'],
          env: { API_KEY: '<your-key>', REGION: 'us-east-1', TOKEN: '${TOKEN}' },
        },
      },
    }));
    const issues = detectMcpConfig(ctx(dir));
    const placeholders = issues.filter((i) => i.title.includes('unfilled placeholder'));
    expect(placeholders.length).toBe(1);
    expect(placeholders[0]!.evidence.join(' ')).toContain('API_KEY');
  });

  it('flags a server with neither command nor url', () => {
    const dir = repo();
    writeFile(dir, '.mcp.json', JSON.stringify({ mcpServers: { broken: { args: ['x'] } } }));
    const issues = detectMcpConfig(ctx(dir));
    expect(issues.some((i) => i.title.includes('neither a command nor a url'))).toBe(true);
  });

  it('flags a missing local command path but not when it exists', () => {
    const dir = repo();
    writeFile(dir, '.mcp.json', JSON.stringify({
      mcpServers: {
        gone: { command: 'node', args: ['./servers/gone.js'] },
        here: { command: 'node', args: ['./servers/here.js'] },
      },
    }));
    writeFile(dir, 'servers/here.js', 'console.log("ok")');
    const issues = detectMcpConfig(ctx(dir));
    const missing = issues.filter((i) => i.title.includes('command path does not exist'));
    expect(missing.length).toBe(1);
    expect(missing[0]!.evidence.join(' ')).toContain('./servers/gone.js');
  });

  it('accepts a remote (url) server', () => {
    const dir = repo();
    writeFile(dir, '.mcp.json', JSON.stringify({
      mcpServers: { remote: { type: 'http', url: 'https://mcp.example.com' } },
    }));
    expect(detectMcpConfig(ctx(dir))).toEqual([]);
  });
});
