import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PUBLISH_REPOSITORY,
  MarketPublisher,
  readPublishPreset,
} from '../src/main/market/publish';
import { makePreset } from './factories';

const CLEAN_STATS = {
  malicious: 0,
  suspicious: 0,
  undetected: 61,
  harmless: 0,
  timeout: 0,
  failure: 0,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function presetFile(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ts-publish-'));
  const file = path.join(dir, 'publish-test.json');
  await writeFile(file, `${JSON.stringify(makePreset({ id: 'publish-test', version: '1.2.0' }), null, 2)}\n`, 'utf8');
  return { dir, file };
}

function githubRoutes(calls: { url: string; init: RequestInit }[]): (url: string, init: RequestInit) => Promise<Response> {
  return async (url, init) => {
    calls.push({ url, init });
    const method = init.method ?? 'GET';
    if (url.includes('/contents/presets/community/')) return json({ message: 'Not Found' }, 404);
    if (url.endsWith('/git/ref/heads/main') && method === 'GET') {
      return json({ object: { sha: 'a'.repeat(40) } });
    }
    if (url.endsWith('/git/blobs') && method === 'POST') return json({ sha: 'b'.repeat(40) });
    if (url.endsWith('/git/trees') && method === 'POST') return json({ sha: 'c'.repeat(40) });
    if (url.endsWith('/git/commits') && method === 'POST') return json({ sha: 'd'.repeat(40) });
    if (url.endsWith('/git/refs') && method === 'POST') return json({ ref: 'refs/heads/submission' });
    if (url.endsWith('/pulls') && method === 'POST') {
      return json({ number: 7, html_url: `https://github.com/${DEFAULT_PUBLISH_REPOSITORY}/pull/7` });
    }
    return json({ message: `unexpected ${method} ${url}` }, 500);
  };
}

describe('marketplace publishing', () => {
  it('accepts validated repository and branch overrides for forks', () => {
    const publisher = new MarketPublisher({
      env: { TUNESMITH_MARKET_REPO: 'fork/tunesmith', TUNESMITH_MARKET_BRANCH: 'market-dev' },
    });
    expect(publisher.config()).toMatchObject({
      repository: 'fork/tunesmith',
      branch: 'market-dev',
      virusTotalConfigured: false,
      githubConfigured: false,
    });

    const invalid = new MarketPublisher({
      env: { TUNESMITH_MARKET_REPO: 'https://evil.example/repo', TUNESMITH_MARKET_BRANCH: '..' },
    });
    expect(invalid.config()).toMatchObject({
      repository: DEFAULT_PUBLISH_REPOSITORY,
      branch: 'main',
    });
  });

  it('scans a clean preset and opens a pull request only after the scan passes', async () => {
    const { dir, file } = await presetFile();
    const calls: { url: string; init: RequestInit }[] = [];
    const github = githubRoutes(calls);
    const publisher = new MarketPublisher({
      env: {},
      sleep: async () => undefined,
      fetchImpl: async (url, init) => {
        if (url.startsWith('https://api.github.com/')) return github(url, init);
        calls.push({ url, init });
        if (url.includes('/files/') && (init.method ?? 'GET') === 'GET') {
          return json({ message: 'Not Found' }, 404);
        }
        if (url.endsWith('/files') && init.method === 'POST') {
          return json({ data: { id: 'analysis-1' } });
        }
        if (url.endsWith('/analyses/analysis-1')) {
          return json({ data: { id: 'analysis-1', attributes: { status: 'completed', stats: CLEAN_STATS } } });
        }
        return json({ message: `unexpected ${url}` }, 500);
      },
    });

    try {
      const candidate = await publisher.prepare(file);
      expect(candidate.id).toBe('publish-test');
      expect(candidate.version).toBe('1.2.0');

      const result = await publisher.publish({
        token: candidate.token,
        virusTotalKey: 'vt-key',
        githubToken: 'gh-token',
      });

      expect(result.presetId).toBe('publish-test');
      expect(result.scan.verdict).toBe('clean');
      expect(result.scan.stats).toMatchObject({ malicious: 0, suspicious: 0 });
      expect(result.pullRequestNumber).toBe(7);
      expect(result.pullRequestUrl).toContain('/pull/7');

      const pull = calls.find((call) => call.url.endsWith('/pulls'));
      expect(pull).toBeDefined();
      const body = JSON.parse(String(pull?.init.body)) as { body: string; head: string };
      expect(body.body).toContain('VirusTotal: clean');
      expect(body.body).toContain('https://www.virustotal.com/gui/file/');
      expect(body.head).toMatch(/^market-submission\/publish-test-/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a VirusTotal positive before any GitHub write', async () => {
    const { dir, file } = await presetFile();
    const calls: { url: string; init: RequestInit }[] = [];
    const publisher = new MarketPublisher({
      env: {},
      sleep: async () => undefined,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        if (url.startsWith('https://api.github.com/')) {
          return json({ message: 'Not Found' }, 404);
        }
        if (url.includes('/files/')) {
          return json({
            data: {
              attributes: {
                last_analysis_stats: { ...CLEAN_STATS, malicious: 3, suspicious: 1 },
              },
            },
          });
        }
        return json({ message: `unexpected ${url}` }, 500);
      },
    });

    try {
      const candidate = await publisher.prepare(file);
      await expect(
        publisher.publish({
          token: candidate.token,
          virusTotalKey: 'vt-key',
          githubToken: 'gh-token',
        }),
      ).rejects.toThrow(/VirusTotal flagged/);

      expect(calls.some((call) => call.url.includes('/git/'))).toBe(false);
      expect(calls.some((call) => call.url.endsWith('/pulls'))).toBe(false);
      expect(calls.filter((call) => call.url.startsWith('https://api.github.com/'))).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not treat a hash report without stats as clean', async () => {
    const { dir, file } = await presetFile();
    const calls: { url: string; init: RequestInit }[] = [];
    const github = githubRoutes(calls);
    const publisher = new MarketPublisher({
      env: {},
      sleep: async () => undefined,
      fetchImpl: async (url, init) => {
        if (url.startsWith('https://api.github.com/')) return github(url, init);
        calls.push({ url, init });
        if (url.includes('/files/') && (init.method ?? 'GET') === 'GET') {
          return json({ data: { attributes: {} } });
        }
        if (url.endsWith('/files') && init.method === 'POST') {
          return json({ data: { id: 'analysis-2' } });
        }
        if (url.endsWith('/analyses/analysis-2')) {
          return json({ data: { id: 'analysis-2', attributes: { status: 'completed', stats: CLEAN_STATS } } });
        }
        return json({ message: `unexpected ${url}` }, 500);
      },
    });

    try {
      const candidate = await publisher.prepare(file);
      const result = await publisher.publish({
        token: candidate.token,
        virusTotalKey: 'vt-key',
        githubToken: 'gh-token',
      });
      expect(calls.some((call) => call.url.endsWith('/files') && call.init.method === 'POST')).toBe(true);
      expect(result.pullRequestNumber).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects an existing preset id before scanning', async () => {
    const { dir, file } = await presetFile();
    const calls: string[] = [];
    const publisher = new MarketPublisher({
      env: {},
      sleep: async () => undefined,
      fetchImpl: async (url) => {
        calls.push(url);
        return json({ message: 'exists' }, 200);
      },
    });

    try {
      const candidate = await publisher.prepare(file);
      await expect(
        publisher.publish({ token: candidate.token, virusTotalKey: 'vt', githubToken: 'gh' }),
      ).rejects.toThrow(/already exists/);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('api.github.com');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to prepare an invalid preset without retaining a candidate', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ts-publish-'));
    const file = path.join(dir, 'broken.json');
    await writeFile(file, '{"schemaVersion":1}\n', 'utf8');
    try {
      await expect(readPublishPreset(file)).rejects.toThrow(/failed validation/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('requires credentials instead of attempting an unauthenticated submission', async () => {
    const { dir, file } = await presetFile();
    const publisher = new MarketPublisher({ env: {}, sleep: async () => undefined });
    try {
      const candidate = await publisher.prepare(file);
      await expect(publisher.publish({ token: candidate.token })).rejects.toThrow(/VirusTotal is not configured/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
