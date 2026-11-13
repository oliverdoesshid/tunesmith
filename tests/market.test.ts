import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/shared/market/canonical';
import {
  catalogSigningPayload,
  entrySigningPayload,
  marketEnvelopeSchema,
} from '../src/shared/market/schema';
import { scoreEntry } from '../src/shared/market/score';
import {
  aggregateEvents,
  TELEMETRY_LIMITS,
  trimEvents,
  type TelemetryEvent,
} from '../src/shared/market/telemetry';
import type { MarketEntry } from '../src/shared/market/types';
import { loadPresetDirectory } from '../src/shared/preset/loader';
import type { Preset } from '../src/shared/preset/schema';
import { fetchVerifiedCatalog, type FetchLike } from '../src/main/market/client';
import { loadMarketplaceSettings } from '../src/main/market/config';
import { installVerifiedPreset } from '../src/main/market/install';
import { MarketplaceService } from '../src/main/market/service';
import { TelemetryStore } from '../src/main/market/telemetry-store';
import { sha256Hex } from '../src/main/market/verify';
import { PRESET_SIGNING_KEY_ID, PRESET_SIGNING_PUBLIC_KEY } from '../src/main/security/keys';
import { DEFAULT_MARKET_CATALOG_URL } from '../src/shared/market/defaults';
import { makePreset } from './factories';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const KEYS = new Map([['test-key', PUBLIC_PEM]]);

function signPayload(payload: string): string {
  return sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64');
}

function makeEntry(preset: Preset = makePreset({ id: 'market-test', version: '1.0.0' })): MarketEntry {
  const canonical = canonicalJson(preset);
  const sha256 = sha256Hex(canonical);
  return {
    preset,
    sha256,
    signature: { keyId: 'test-key', sig: signPayload(entrySigningPayload(sha256)) },
    ratings: { up: 0, down: 0, crashes: 0, recoveries: 0 },
    publishedAt: '2026-01-01T00:00:00.000Z',
  };
}

function envelopeFor(entries: MarketEntry[], keyId = 'test-key'): unknown {
  const catalog = { schemaVersion: 1 as const, generatedAt: '2026-01-01T00:00:00.000Z', entries };
  return {
    catalog,
    signature: { keyId, sig: signPayload(catalogSigningPayload(canonicalJson(catalog))) },
  };
}

function fakeFetch(
  payload: unknown,
  options: { status?: number; contentLength?: string } = {},
): FetchLike {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return async () => ({
    ok: (options.status ?? 200) < 400,
    status: options.status ?? 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-length'
          ? (options.contentLength ?? String(Buffer.byteLength(body, 'utf8')))
          : null,
    },
    text: async () => body,
  });
}

const SOURCE = { url: 'https://market.example/catalog.json', keyRing: KEYS };

describe('canonical JSON', () => {
  it('sorts keys recursively but preserves array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: 'x' } })).toBe('{"a":{"c":"x","d":[2,1]},"b":1}');
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('refuses non-finite numbers instead of emitting invalid JSON', () => {
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow();
  });
});

describe('catalog verification', () => {
  it('the published Pages catalog verifies against the pinned publisher key', async () => {
    const body = await readFile(path.resolve('market/catalog.json'), 'utf8');
    const result = await fetchVerifiedCatalog({
      url: DEFAULT_MARKET_CATALOG_URL,
      keyRing: new Map([[PRESET_SIGNING_KEY_ID, PRESET_SIGNING_PUBLIC_KEY]]),
      fetchImpl: fakeFetch(body),
    });
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.rejected).toEqual([]);
    expect(result.entries.map(({ entry }) => entry.preset.id)).toContain(
      'competitive-fps-low-latency',
    );
  });

  it('accepts a correctly signed catalog and entry', async () => {
    const entry = makeEntry();
    const result = await fetchVerifiedCatalog({ ...SOURCE, fetchImpl: fakeFetch(envelopeFor([entry])) });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.entry.preset.id).toBe('market-test');
    expect(result.rejected).toEqual([]);
  });

  it('rejects an entry whose preset no longer matches its digest', async () => {
    const entry = makeEntry();
    const tampered: MarketEntry = { ...entry, preset: { ...entry.preset, name: 'Tampered Preset' } };
    const result = await fetchVerifiedCatalog({ ...SOURCE, fetchImpl: fakeFetch(envelopeFor([tampered])) });
    expect(result.entries).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain('Digest mismatch');
  });

  it('rejects an entry signed by an unknown key without failing the catalog', async () => {
    const entry = makeEntry();
    const unknown: MarketEntry = { ...entry, signature: { keyId: 'ghost-key', sig: entry.signature.sig } };
    const result = await fetchVerifiedCatalog({ ...SOURCE, fetchImpl: fakeFetch(envelopeFor([unknown])) });
    expect(result.entries).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain('unknown key');
  });

  it('refuses a catalog whose signature does not verify', async () => {
    const envelope = envelopeFor([makeEntry()]) as { signature: { keyId: string; sig: string } };
    envelope.signature = { keyId: 'test-key', sig: Buffer.alloc(64).toString('base64') };
    await expect(fetchVerifiedCatalog({ ...SOURCE, fetchImpl: fakeFetch(envelope) })).rejects.toThrow(
      /signature does not verify/i,
    );
  });

  it('rejects a declared body larger than 2 MiB before reading it', async () => {
    await expect(
      fetchVerifiedCatalog({
        ...SOURCE,
        fetchImpl: fakeFetch(envelopeFor([makeEntry()]), { contentLength: '9999999' }),
      }),
    ).rejects.toThrow(/larger than/i);
  });

  it('rejects unknown fields in the catalog envelope', () => {
    const envelope = envelopeFor([makeEntry()]) as Record<string, unknown>;
    expect(marketEnvelopeSchema.safeParse({ ...envelope, extra: true }).success).toBe(false);
  });
});

describe('install', () => {
  it('writes the canonical signed bytes and rebuilds the index the loader requires', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ts-market-'));
    try {
      const preset = makePreset({ id: 'market-test', version: '1.2.3' });
      const entry = makeEntry(preset);
      const canonical = canonicalJson(preset);

      const written = await installVerifiedPreset(entry, canonical, dir);
      expect(written.file).toBe('market-test.json');

      const loaded = await loadPresetDirectory(dir);
      expect(loaded.failures).toEqual([]);
      expect(loaded.presets).toHaveLength(1);
      expect(loaded.presets[0]?.preset.id).toBe('market-test');
      expect(loaded.presets[0]?.trust).toBe('market-verified');

      const bytes = await readFile(path.join(dir, 'market-test.json'), 'utf8');
      expect(sha256Hex(bytes)).toBe(entry.sha256);

      const index = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8')) as {
        presets: { file: string; sha256: string }[];
      };
      expect(index.presets[0]?.sha256).toBe(entry.sha256);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to install a preset whose canonical form changed after verification', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ts-market-'));
    try {
      const entry = makeEntry();
      await expect(installVerifiedPreset(entry, canonicalJson({ nope: true }), dir)).rejects.toThrow(
        /changed after verification/i,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('safety score', () => {
  it('starts conservative for an unvoted preset and rewards verified low-risk entries', () => {
    const entry = makeEntry(makePreset({ risk: 'conservative' }));
    expect(scoreEntry(entry, null).score).toBe(76);
    expect(scoreEntry({ ...entry, preset: makePreset({ risk: 'aggressive' }) }, null).score).toBeLessThan(76);
  });

  it('adds community votes and subtracts measured crashes', () => {
    const entry = makeEntry(makePreset({ risk: 'conservative' }));
    const voted = { ...entry, ratings: { up: 10, down: 0, crashes: 0, recoveries: 0 } };
    const votedScore = scoreEntry(voted, null).score;
    const crashed = scoreEntry(voted, {
      applies: 100,
      failed: 2,
      interrupted: 20,
      recovered: 5,
      crashRate: 0.2,
      recoveryRate: 0.25,
    });
    expect(votedScore).toBe(88);
    expect(crashed.score).toBeLessThan(votedScore);
    expect(crashed.reasons.join(' ')).toContain('Crash rate 20.0%');
  });

  it('labels thresholds deterministically', () => {
    const entry = makeEntry(makePreset({ risk: 'aggressive' }));
    expect(['safe', 'good', 'caution', 'risky']).toContain(scoreEntry(entry, null).label);
  });
});

describe('telemetry', () => {
  function event(kind: TelemetryEvent['kind'], presetId = 'market-test'): TelemetryEvent {
    return {
      at: '2026-01-01T00:00:00.000Z',
      presetId,
      presetVersion: '1.0.0',
      appVersion: '0.1.0',
      kind,
    };
  }

  it('aggregates crash rate from applies and interruptions', () => {
    const stats = aggregateEvents([
      event('apply-ok'),
      event('apply-ok'),
      event('apply-failed'),
      event('session-interrupted'),
      event('session-recovered'),
    ]).get('market-test');

    expect(stats).toMatchObject({ applies: 3, failed: 1, interrupted: 1, recovered: 1 });
    expect(stats?.crashRate).toBeCloseTo(1 / 3);
    expect(stats?.recoveryRate).toBe(1);
  });

  it('keeps the store bounded', () => {
    const many = Array.from({ length: TELEMETRY_LIMITS.maxEvents + 5 }, () => event('apply-ok'));
    expect(trimEvents(many)).toHaveLength(TELEMETRY_LIMITS.maxEvents);
    expect(trimEvents(many)[0]?.at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('upload is a no-op without consent and clears the queue with it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ts-market-'));
    try {
      const store = new TelemetryStore(dir);
      const bodies: string[] = [];
      const upload = async (_url: string, init: { body: string }): Promise<{ ok: boolean; status: number }> => {
        bodies.push(init.body);
        return { ok: true, status: 200 };
      };

      await store.record(event('apply-ok'));
      expect(await store.upload('https://t.example', upload)).toBe(0);
      expect(bodies).toHaveLength(0);

      await store.setConsent(true);
      expect(await store.upload('https://t.example', upload)).toBe(1);
      expect(bodies).toHaveLength(1);
      const payload = JSON.parse(bodies[0] ?? '{}') as { events: Record<string, unknown>[] };
      expect(Object.keys(payload.events[0] ?? {}).sort()).toEqual(['appVersion', 'at', 'kind', 'presetId', 'presetVersion']);
      expect(await store.pending()).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps events after a failed upload instead of dropping them', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ts-market-'));
    try {
      const store = new TelemetryStore(dir);
      await store.setConsent(true);
      await store.record(event('apply-ok'));
      const uploaded = await store.upload('https://t.example', async () => ({ ok: false, status: 503 }));
      expect(uploaded).toBe(0);
      expect(await store.pending()).toBe(1);
      expect((await store.snapshot()).lastUploadError).toContain('503');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('marketplace service', () => {
  it('trusts the pinned publisher key for the default catalog', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ts-market-'));
    const savedUrl = process.env.TUNESMITH_MARKET_URL;
    const savedKeys = process.env.TUNESMITH_MARKET_KEYS;
    delete process.env.TUNESMITH_MARKET_URL;
    delete process.env.TUNESMITH_MARKET_KEYS;
    try {
      const settings = loadMarketplaceSettings('0.0.0', dir, dir);
      expect(settings.catalogUrl).toBe(DEFAULT_MARKET_CATALOG_URL);
      expect(settings.keyRing.get(PRESET_SIGNING_KEY_ID)).toBe(PRESET_SIGNING_PUBLIC_KEY);
    } finally {
      if (savedUrl === undefined) delete process.env.TUNESMITH_MARKET_URL;
      else process.env.TUNESMITH_MARKET_URL = savedUrl;
      if (savedKeys === undefined) delete process.env.TUNESMITH_MARKET_KEYS;
      else process.env.TUNESMITH_MARKET_KEYS = savedKeys;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists verified entries and installs one into the user directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ts-market-'));
    try {
      const entry = makeEntry();
      const service = new MarketplaceService({
        catalogUrl: 'https://market.example/catalog.json',
        telemetryUrl: null,
        keyRing: KEYS,
        installDir: path.join(dir, 'presets'),
        stateDir: dir,
        appVersion: '0.1.0',
        listInstalled: async () => new Map(),
        onInstalled: () => undefined,
        fetchImpl: fakeFetch(envelopeFor([entry])),
      });

      const status = await service.status();
      expect(status.configured).toBe(true);
      expect(status.entries).toHaveLength(1);
      expect(status.entries[0]?.installedVersion).toBeNull();

      const result = await service.install('market-test');
      expect(result.file).toBe('market-test.json');
      expect(result.sha256).toBe(entry.sha256);

      const loaded = await loadPresetDirectory(path.join(dir, 'presets'));
      expect(loaded.presets).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
