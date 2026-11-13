/**
 * Reviewed marketplace submissions.
 *
 * Flow:
 *   1. read and structurally/policy-validate a preset selected through the native picker;
 *   2. refuse a preset id that already exists in the marketplace repository;
 *   3. scan the exact normalized bytes at VirusTotal and refuse malicious/suspicious files;
 *   4. create a branch, commit the preset and open a pull request.
 *
 * Nothing is written to the live catalog. A maintainer reviews the PR, signs the preset
 * with the offline publisher key and regenerates the market artifacts. Tokens are used
 * only for the request in flight and are never logged or returned to the renderer.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { TuneSmithError, describeError } from '../../shared/errors';
import type {
  PublishCandidate,
  PublishConfig,
  PublishResult,
  PublishScan,
  VirusTotalStats,
} from '../../shared/market/publish';
import { PUBLISH_CONFIG_HINT } from '../../shared/market/publish';
import { evaluatePresetPolicy } from '../../shared/preset/policy';
import {
  formatZodIssues,
  PRESET_LIMITS,
  presetSchema,
  type Preset,
} from '../../shared/preset/schema';

export const VIRUSTOTAL_API_BASE = 'https://www.virustotal.com/api/v3';
export const VIRUSTOTAL_KEY_ENV = 'VIRUSTOTAL_API_KEY';
export const GITHUB_TOKEN_ENV = 'TUNESMITH_GITHUB_TOKEN';
export const GITHUB_TOKEN_FALLBACK_ENV = 'GITHUB_TOKEN';
export const GITHUB_API_BASE = 'https://api.github.com';
export const DEFAULT_PUBLISH_REPOSITORY = 'oliverdoesshid/tunesmith';
export const DEFAULT_PUBLISH_BRANCH = 'main';

const CANDIDATE_TTL_MS = 15 * 60 * 1000;
const CANDIDATE_LIMIT = 5;
const REQUEST_TIMEOUT_MS = 20_000;
const VT_POLL_INTERVAL_MS = 45_000;
const VT_POLL_LIMIT = 10;
const MAX_VT_RESPONSE_BYTES = 512 * 1024;
const MAX_GITHUB_RESPONSE_BYTES = 512 * 1024;

export type PublishFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface MarketPublisherOptions {
  repository?: string;
  branch?: string;
  fetchImpl?: PublishFetch;
  now?: () => number;
  /** Test seam; production uses timers through `sleep`. */
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

interface PendingCandidate {
  preset: Preset;
  bytes: Buffer;
  candidate: PublishCandidate;
  expiresAt: number;
}

const vtStatsSchema = z.object({
  malicious: z.number().int().min(0).default(0),
  suspicious: z.number().int().min(0).default(0),
  undetected: z.number().int().min(0).default(0),
  harmless: z.number().int().min(0).default(0),
  timeout: z.number().int().min(0).default(0),
  failure: z.number().int().min(0).default(0),
});

const vtAnalysisSchema = z.object({
  data: z.object({
    id: z.string().min(1).max(500),
    attributes: z.object({
      status: z.string().max(40).optional(),
      stats: vtStatsSchema.optional(),
    }),
  }),
});

const vtUploadSchema = z.object({
  data: z.object({ id: z.string().min(1).max(500) }),
});

const vtFileSchema = z.object({
  data: z.object({
    attributes: z.object({
      last_analysis_stats: vtStatsSchema.optional(),
    }),
  }),
});

const githubRefSchema = z.object({
  object: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/) }),
});

const githubCommitSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40,64}$/),
});

const githubBlobSchema = z.object({
  sha: z.string().min(1).max(100),
});

const githubPullSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
});

function shortError(error: unknown): string {
  return describeError(error).replace(/\s+/g, ' ').slice(0, 240);
}

function repositoryFrom(value: string | undefined): string | null {
  const candidate = value?.trim();
  return candidate !== undefined && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate)
    ? candidate
    : null;
}

function branchFrom(value: string | undefined): string | null {
  const candidate = value?.trim();
  return candidate !== undefined &&
    candidate.length > 0 &&
    !candidate.includes('..') &&
    /^[A-Za-z0-9._/-]{1,200}$/.test(candidate)
    ? candidate
    : null;
}

function statsOf(value: z.infer<typeof vtStatsSchema> | undefined): VirusTotalStats {
  return {
    malicious: value?.malicious ?? 0,
    suspicious: value?.suspicious ?? 0,
    undetected: value?.undetected ?? 0,
    harmless: value?.harmless ?? 0,
    timeout: value?.timeout ?? 0,
    failure: value?.failure ?? 0,
  };
}

function reportUrl(sha256: string): string {
  return `https://www.virustotal.com/gui/file/${sha256}/detection`;
}

function verdict(stats: VirusTotalStats): 'clean' | 'risky' {
  return stats.malicious > 0 || stats.suspicious > 0 ? 'risky' : 'clean';
}

async function readBounded(response: Response, limit: number, what: string): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) {
    throw new TuneSmithError('parse-failed', `${what} returned an oversized response.`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw new TuneSmithError('parse-failed', `${what} returned an oversized response.`);
  }
  return text;
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TuneSmithError('parse-failed', `${what} returned malformed JSON.`);
  }
}

function normalizeBytes(preset: Preset): Buffer {
  return Buffer.from(`${JSON.stringify(preset, null, 2)}\n`, 'utf8');
}

/** Validate one file before it can be scanned or submitted. */
export async function readPublishPreset(filePath: string): Promise<{ preset: Preset; bytes: Buffer }> {
  const absolute = path.resolve(filePath);
  let bytes: Buffer;
  try {
    bytes = await readFile(absolute);
  } catch (error) {
    throw new TuneSmithError('unavailable', `The preset file could not be read: ${shortError(error)}`);
  }

  if (bytes.byteLength > PRESET_LIMITS.maxFileBytes) {
    throw new TuneSmithError(
      'preset-invalid',
      `The preset is ${bytes.byteLength} bytes; the limit is ${PRESET_LIMITS.maxFileBytes}.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new TuneSmithError('preset-invalid', `The preset is not valid JSON: ${shortError(error)}`);
  }

  const parsed = presetSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = formatZodIssues(parsed.error)
      .slice(0, 4)
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join('; ');
    throw new TuneSmithError('preset-invalid', `The preset failed validation: ${issues}`);
  }

  const findings = evaluatePresetPolicy(parsed.data);
  const blockers = findings.filter((finding) => finding.severity === 'block');
  if (blockers.length > 0) {
    throw new TuneSmithError(
      'preset-invalid',
      `The preset is blocked by policy: ${blockers.map((finding) => finding.message).slice(0, 3).join('; ')}`,
    );
  }

  return { preset: parsed.data, bytes: normalizeBytes(parsed.data) };
}

export class VirusTotalScanner {
  constructor(
    private readonly fetchImpl: PublishFetch,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly log: (line: string) => void,
  ) {}

  async scan(bytes: Buffer, sha256: string, apiKey: string, fileName: string): Promise<PublishScan> {
    const headers = { 'x-apikey': apiKey, Accept: 'application/json' };

    // A known hash saves requests; an unknown file is uploaded once.
    let stats: VirusTotalStats | null = await this.lookup(sha256, headers);
    if (stats === null) {
      const analysisId = await this.upload(bytes, fileName, headers);
      stats = await this.poll(analysisId, headers);
    }

    const admitted = statsOf(stats);
    if (
      admitted.malicious + admitted.suspicious + admitted.undetected + admitted.harmless ===
      0
    ) {
      throw new TuneSmithError(
        'unavailable',
        'VirusTotal returned no engine results. The preset was not submitted.',
      );
    }
    const outcome = verdict(admitted);
    if (outcome === 'risky') {
      throw new TuneSmithError(
        'integrity-failed',
        `VirusTotal flagged this preset (${admitted.malicious} malicious, ${admitted.suspicious} suspicious). Nothing was uploaded to GitHub.`,
      );
    }

    this.log(`VirusTotal clean: ${admitted.malicious} malicious, ${admitted.suspicious} suspicious`);
    return {
      provider: 'virustotal',
      verdict: 'clean',
      stats: admitted,
      reportUrl: reportUrl(sha256),
      sha256,
    };
  }

  private async lookup(sha256: string, headers: Record<string, string>): Promise<VirusTotalStats | null> {
    const response = await this.request(`${VIRUSTOTAL_API_BASE}/files/${sha256}`, { headers });
    if (response.status === 404) return null;
    await this.expectOk(response, 'VirusTotal file lookup');
    const parsed = vtFileSchema.safeParse(
      parseJson(await readBounded(response, MAX_VT_RESPONSE_BYTES, 'VirusTotal'), 'VirusTotal'),
    );
    const stats = parsed.success ? parsed.data.data.attributes.last_analysis_stats : undefined;
    // A report without stats, or with no engine results at all, is not evidence of a
    // clean file; force a fresh upload.
    if (stats === undefined) return null;
    const total = stats.malicious + stats.suspicious + stats.undetected + stats.harmless;
    return total === 0 ? null : statsOf(stats);
  }

  private async upload(bytes: Buffer, fileName: string, headers: Record<string, string>): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/json' }), fileName);
    const response = await this.request(`${VIRUSTOTAL_API_BASE}/files`, {
      method: 'POST',
      headers,
      body: form,
    });
    await this.expectOk(response, 'VirusTotal upload');
    const parsed = vtUploadSchema.safeParse(
      parseJson(await readBounded(response, MAX_VT_RESPONSE_BYTES, 'VirusTotal'), 'VirusTotal'),
    );
    if (!parsed.success) {
      throw new TuneSmithError('parse-failed', 'VirusTotal did not return an analysis id.');
    }
    return parsed.data.data.id;
  }

  private async poll(analysisId: string, headers: Record<string, string>): Promise<VirusTotalStats> {
    for (let attempt = 0; attempt < VT_POLL_LIMIT; attempt += 1) {
      if (attempt > 0) await this.sleep(VT_POLL_INTERVAL_MS);
      const response = await this.request(
        `${VIRUSTOTAL_API_BASE}/analyses/${encodeURIComponent(analysisId)}`,
        { headers },
      );
      await this.expectOk(response, 'VirusTotal analysis');
      const parsed = vtAnalysisSchema.safeParse(
        parseJson(await readBounded(response, MAX_VT_RESPONSE_BYTES, 'VirusTotal'), 'VirusTotal'),
      );
      if (parsed.success && parsed.data.data.attributes.status === 'completed') {
        const stats = parsed.data.data.attributes.stats;
        if (stats === undefined) {
          throw new TuneSmithError('parse-failed', 'VirusTotal completed the analysis without results.');
        }
        return statsOf(stats);
      }
    }
    throw new TuneSmithError(
      'unavailable',
      'VirusTotal did not finish analysing the preset in time. Try again in a few minutes.',
    );
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new TuneSmithError('unavailable', `VirusTotal could not be reached: ${shortError(error)}`);
    }
  }

  private async expectOk(response: Response, what: string): Promise<void> {
    if (response.ok) return;
    if (response.status === 401 || response.status === 403) {
      throw new TuneSmithError('unavailable', `${what} was rejected. Check the VirusTotal API key.`);
    }
    if (response.status === 429) {
      throw new TuneSmithError('unavailable', `${what} hit the VirusTotal rate limit. Try again later.`);
    }
    throw new TuneSmithError('unavailable', `${what} failed (HTTP ${response.status}).`);
  }
}

export class GitHubPublisher {
  constructor(
    private readonly fetchImpl: PublishFetch,
    private readonly repository: string,
    private readonly branch: string,
    private readonly log: (line: string) => void,
  ) {}

  async ensureAvailable(presetId: string, token: string): Promise<void> {
    const response = await this.request(
      `/repos/${this.repository}/contents/presets/community/${encodeURIComponent(`${presetId}.json`)}?ref=${encodeURIComponent(this.branch)}`,
      token,
      { method: 'GET' },
    );
    if (response.status === 404) return;
    if (response.ok) {
      throw new TuneSmithError(
        'invalid-request',
        `A preset with the id "${presetId}" already exists in the marketplace. Bump the id or version before submitting.`,
      );
    }
    await this.fail(response, 'GitHub could not check the marketplace repository');
  }

  async openPullRequest(
    candidate: PublishCandidate,
    preset: Preset,
    bytes: Buffer,
    scan: PublishScan,
    token: string,
  ): Promise<{ branch: string; url: string; number: number }> {
    const baseSha = await this.baseCommit(token);
    const content = bytes.toString('base64');

    const blob = await this.post(`/repos/${this.repository}/git/blobs`, token, {
      content,
      encoding: 'base64',
    });
    const blobSha = githubBlobSchema.safeParse(blob);
    if (!blobSha.success) throw new TuneSmithError('parse-failed', 'GitHub did not return a blob id.');

    const tree = await this.post(`/repos/${this.repository}/git/trees`, token, {
      base_tree: baseSha,
      tree: [
        {
          path: `presets/community/${candidate.fileName}`,
          mode: '100644',
          type: 'blob',
          sha: blobSha.data.sha,
        },
      ],
    });
    const treeSha = z.object({ sha: z.string().min(1).max(100) }).safeParse(tree);
    if (!treeSha.success) throw new TuneSmithError('parse-failed', 'GitHub did not return a tree id.');

    const commit = await this.post(`/repos/${this.repository}/git/commits`, token, {
      message: `Add community preset: ${preset.name} v${preset.version}`,
      tree: treeSha.data.sha,
      parents: [baseSha],
    });
    const commitSha = githubCommitSchema.safeParse(commit);
    if (!commitSha.success) throw new TuneSmithError('parse-failed', 'GitHub did not return a commit id.');

    const branch = `market-submission/${candidate.id}-${Date.now().toString(36)}`;
    await this.post(`/repos/${this.repository}/git/refs`, token, {
      ref: `refs/heads/${branch}`,
      sha: commitSha.data.sha,
    });

    const body = [
      'Automated marketplace submission from TuneSmith.',
      '',
      `- Preset: **${preset.name}** v${preset.version}`,
      `- Id: \`${preset.id}\``,
      `- Risk: \`${preset.risk}\``,
      `- SHA-256: \`${scan.sha256}\``,
      `- VirusTotal: clean (${scan.stats.malicious} malicious, ${scan.stats.suspicious} suspicious, ${scan.stats.undetected} undetected)`,
      `- Report: ${scan.reportUrl}`,
      '',
      'Schema and policy validation passed before the scan. This PR adds only the preset JSON.',
      'Before merging, a maintainer must sign the preset with the offline publisher key, regenerate',
      '`market/index.json` and `market/catalog.json`, and commit those artifacts.',
    ].join('\n');

    const pull = await this.post(`/repos/${this.repository}/pulls`, token, {
      title: `Marketplace: ${preset.name} v${preset.version}`,
      head: branch,
      base: this.branch,
      body,
      maintainer_can_modify: true,
    });
    const parsed = githubPullSchema.safeParse(pull);
    if (!parsed.success) throw new TuneSmithError('parse-failed', 'GitHub did not return a pull request.');
    this.log(`opened marketplace pull request #${parsed.data.number}`);
    return { branch, url: parsed.data.html_url, number: parsed.data.number };
  }

  private async baseCommit(token: string): Promise<string> {
    const response = await this.request(
      `/repos/${this.repository}/git/ref/heads/${encodeURIComponent(this.branch)}`,
      token,
      { method: 'GET' },
    );
    await this.expectOk(response, 'GitHub could not read the marketplace branch');
    const text = await readBounded(response, MAX_GITHUB_RESPONSE_BYTES, 'GitHub');
    const parsed = githubRefSchema.safeParse(parseJson(text, 'GitHub'));
    if (!parsed.success) throw new TuneSmithError('parse-failed', 'GitHub returned an unreadable branch.');
    return parsed.data.object.sha;
  }

  private async post(endpoint: string, token: string, body: unknown): Promise<unknown> {
    const response = await this.request(endpoint, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await this.expectOk(response, 'GitHub rejected the marketplace submission');
    return parseJson(await readBounded(response, MAX_GITHUB_RESPONSE_BYTES, 'GitHub'), 'GitHub');
  }

  private request(endpoint: string, token: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(`${GITHUB_API_BASE}${endpoint}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2026-03-10',
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch((error: unknown) => {
      throw new TuneSmithError('unavailable', `GitHub could not be reached: ${shortError(error)}`);
    });
  }

  private async expectOk(response: Response, what: string): Promise<void> {
    if (response.ok) return;
    await this.fail(response, what);
  }

  private async fail(response: Response, what: string): Promise<never> {
    let detail = '';
    try {
      const text = await readBounded(response, MAX_GITHUB_RESPONSE_BYTES, 'GitHub');
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === 'string') detail = `: ${parsed.message.slice(0, 200)}`;
    } catch {
      // The status alone is still useful.
    }
    if (response.status === 401 || response.status === 403) {
      throw new TuneSmithError('unavailable', `${what} (HTTP ${response.status}). Check the GitHub token permissions${detail}.`);
    }
    throw new TuneSmithError('unavailable', `${what} (HTTP ${response.status})${detail}.`);
  }
}

export class MarketPublisher {
  private readonly pending = new Map<string, PendingCandidate>();
  private readonly fetchImpl: PublishFetch;
  private readonly repository: string;
  private readonly branch: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sleep: (ms: number) => Promise<void>;
  private publishing = false;

  constructor(options: MarketPublisherOptions = {}) {
    const env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.repository =
      options.repository ?? repositoryFrom(env.TUNESMITH_MARKET_REPO) ?? DEFAULT_PUBLISH_REPOSITORY;
    this.branch = options.branch ?? branchFrom(env.TUNESMITH_MARKET_BRANCH) ?? DEFAULT_PUBLISH_BRANCH;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
    this.env = env;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  config(): PublishConfig {
    const virusTotalConfigured = this.virusTotalKey() !== null;
    const githubConfigured = this.githubToken() !== null;
    return {
      repository: this.repository,
      branch: this.branch,
      virusTotalConfigured,
      githubConfigured,
      hint: PUBLISH_CONFIG_HINT,
    };
  }

  async prepare(filePath: string): Promise<PublishCandidate> {
    const { preset, bytes } = await readPublishPreset(filePath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const token = randomUUID();
    const fileName = `${preset.id}.json`;
    const candidate: PublishCandidate = {
      token,
      id: preset.id,
      name: preset.name,
      version: preset.version,
      description: preset.description,
      risk: preset.risk,
      tags: preset.tags,
      authors: preset.authors.map((author) => author.handle),
      license: preset.license,
      fileName,
      byteSize: bytes.byteLength,
      sha256,
    };

    this.prune();
    this.pending.set(token, {
      preset,
      bytes,
      candidate,
      expiresAt: this.now() + CANDIDATE_TTL_MS,
    });
    return candidate;
  }

  async publish(request: {
    token: string;
    virusTotalKey?: string | undefined;
    githubToken?: string | undefined;
  }): Promise<PublishResult> {
    if (this.publishing) {
      throw new TuneSmithError('locked', 'Another marketplace submission is already in progress.');
    }
    // Keep the candidate until a submission succeeds so a rate limit, bad token or
    // flagged scan does not force the user to pick the file again.
    const pending = this.getPending(request.token);
    const virusTotalKey = request.virusTotalKey?.trim() || this.virusTotalKey();
    const githubToken = request.githubToken?.trim() || this.githubToken();
    if (virusTotalKey === null) {
      throw new TuneSmithError('unavailable', 'VirusTotal is not configured. Add an API key before publishing.');
    }
    if (githubToken === null) {
      throw new TuneSmithError('unavailable', 'GitHub is not configured. Add a token before publishing.');
    }

    this.publishing = true;
    try {
      const github = new GitHubPublisher(this.fetchImpl, this.repository, this.branch, this.log);
      await github.ensureAvailable(pending.preset.id, githubToken);

      const scanner = new VirusTotalScanner(this.fetchImpl, this.sleep, this.log);
      const scan = await scanner.scan(
        pending.bytes,
        pending.candidate.sha256,
        virusTotalKey,
        pending.candidate.fileName,
      );

      const pull = await github.openPullRequest(
        pending.candidate,
        pending.preset,
        pending.bytes,
        scan,
        githubToken,
      );

      this.pending.delete(request.token);

      return {
        presetId: pending.preset.id,
        version: pending.preset.version,
        sha256: pending.candidate.sha256,
        branch: pull.branch,
        pullRequestUrl: pull.url,
        pullRequestNumber: pull.number,
        scan,
      };
    } catch (error) {
      this.log(`marketplace submission failed: ${shortError(error)}`);
      throw error;
    } finally {
      this.publishing = false;
    }
  }

  private getPending(token: string): PendingCandidate {
    this.prune();
    const pending = this.pending.get(token);
    if (pending === undefined) {
      throw new TuneSmithError('invalid-request', 'Choose the preset file again before publishing.');
    }
    return pending;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(token);
    }
    while (this.pending.size >= CANDIDATE_LIMIT) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }

  private virusTotalKey(): string | null {
    const value = this.env[VIRUSTOTAL_KEY_ENV]?.trim();
    return value !== undefined && value.length > 0 ? value : null;
  }

  private githubToken(): string | null {
    const value =
      this.env[GITHUB_TOKEN_ENV]?.trim() || this.env[GITHUB_TOKEN_FALLBACK_ENV]?.trim() || '';
    return value.length > 0 ? value : null;
  }
}
