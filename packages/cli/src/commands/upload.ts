import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ScanReportJson } from '@promptci/core';
import { loadConfig } from '../config.js';
import { ensureFreshToken } from '../lib/ensure-fresh-token.js';
import { readGlobalConfig, writeGlobalConfig } from '../global-config.js';

export type UploadOptions = {
  uploadPath?: string;
  url?: string;
};

export async function runUpload(options: UploadOptions): Promise<void> {
  const resolvedPath = path.resolve(options.uploadPath ?? process.cwd());
  const outputDir = path.join(resolvedPath, '.promptci');
  const jsonPath = path.join(outputDir, 'report.json');
  const mdPath = path.join(outputDir, 'latest.md');

  let config;
  try {
    config = await loadConfig(resolvedPath);
  } catch {
    config = {};
  }

  const globalConfig = await readGlobalConfig();

  // Priority: --url flag > PROMPTCI_API_URL env > project config > global config > localhost
  const apiUrl = (
    options.url ??
    process.env.PROMPTCI_API_URL ??
    config.apiUrl ??
    globalConfig.apiUrl ??
    'http://localhost:3000'
  ).replace(/\/$/, '');

  // Persist an explicitly-provided URL so future commands don't need --url
  if (options.url) {
    await writeGlobalConfig({ ...globalConfig, apiUrl });
  }

  // Read report.json
  let reportJson: string;
  try {
    reportJson = await fs.readFile(jsonPath, 'utf-8');
  } catch {
    console.error(`Error: no report found at ${jsonPath}`);
    console.error('Run "promptci scan" first to generate a report.');
    process.exit(1);
  }

  // R1: report.json is the COMPACT shape (ScanReportJson), not the full
  // in-memory ScanReport — filesScanned entries here have no content/sections.
  let report: ScanReportJson;
  try {
    report = JSON.parse(reportJson) as ScanReportJson;
  } catch {
    console.error(`Error: ${jsonPath} contains invalid JSON.`);
    process.exit(1);
  }

  // Read markdown — optional, non-fatal if missing
  let markdown = '';
  try {
    markdown = await fs.readFile(mdPath, 'utf-8');
  } catch {
    // fine
  }

  const repoName = path.basename(report.repoPath) || 'unknown';
  const endpoint = `${apiUrl}/api/upload`;

  // Ensure we have a valid (auto-refreshed) token before uploading
  let token: string;
  try {
    token = await ensureFreshToken();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    if (msg.includes('Not logged in') || msg.includes('Session expired')) {
      console.error(`Run \`promptci login --url ${apiUrl}\` to authenticate.`);
    }
    process.exit(1);
  }

  console.log(`Uploading report for "${repoName}" to ${apiUrl} ...`);

  const TIMEOUT_MS = 15_000;
  const MAX_RETRIES = 2;

  let response: Response | undefined;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Brief back-off before retry (only for network errors)
      await new Promise((r) => setTimeout(r, attempt * 1000));
      console.error(`Retrying… (attempt ${attempt + 1} of ${MAX_RETRIES + 1})`);
    }
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ report, repoName, markdown }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // Non-network errors (4xx/5xx) should not be retried
      break;
    } catch (err) {
      lastErr = err;
      const isTransient =
        err instanceof TypeError ||          // fetch network error
        (err instanceof DOMException && err.name === 'TimeoutError') ||
        (err instanceof Error && err.name === 'AbortError');
      if (!isTransient || attempt === MAX_RETRIES) {
        const msg = err instanceof Error ? err.message : String(err);
        const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
        console.error(
          isTimeout
            ? `Error: request timed out after ${TIMEOUT_MS / 1000}s`
            : `Error: could not reach ${endpoint}`,
        );
        if (!isTimeout) console.error(msg);
        console.error('\nMake sure the dashboard is running or set PROMPTCI_API_URL.');
        process.exit(1);
      }
    }
  }

  if (!response) {
    // Should be unreachable but satisfies type narrowing
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    console.error(`Error: could not reach ${endpoint}\n${msg}`);
    process.exit(1);
  }

  if (!response.ok) {
    let body = '';
    try { body = await response.text(); } catch { /* ignore */ }
    console.error(`Error: upload failed (HTTP ${response.status})`);
    if (body) console.error(body);
    process.exit(1);
  }

  let result: { scanId: string; url: string };
  try {
    result = (await response.json()) as { scanId: string; url: string };
  } catch {
    console.error('Error: unexpected response from server.');
    process.exit(1);
  }

  console.log('\nReport uploaded successfully.');
  console.log(`View at: ${result.url}`);
}
