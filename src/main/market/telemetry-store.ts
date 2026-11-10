/**
 * Local telemetry store.
 *
 * Events are recorded locally regardless of consent — that is what powers the local
 * crash-rate view. Upload happens only when the user has opted in, only to a configured
 * endpoint, and only in small batches with no retries. A failed upload keeps the events
 * for the next attempt rather than dropping them silently.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  aggregateEvents,
  isTelemetryEvent,
  TELEMETRY_LIMITS,
  trimEvents,
  type TelemetryEvent,
} from '../../shared/market/telemetry';
import type { TelemetryStats } from '../../shared/market/types';

interface TelemetryFile {
  schemaVersion: 1;
  consent: boolean;
  lastUploadAt: string | null;
  lastUploadError: string | null;
  events: TelemetryEvent[];
}

const EMPTY: TelemetryFile = {
  schemaVersion: 1,
  consent: false,
  lastUploadAt: null,
  lastUploadError: null,
  events: [],
};

export class TelemetryStore {
  private readonly file: string;
  private data: TelemetryFile = { ...EMPTY, events: [] };
  private loaded = false;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'telemetry.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<TelemetryFile>;
      this.data = {
        schemaVersion: 1,
        consent: raw.consent === true,
        lastUploadAt: typeof raw.lastUploadAt === 'string' ? raw.lastUploadAt : null,
        lastUploadError: typeof raw.lastUploadError === 'string' ? raw.lastUploadError : null,
        events: Array.isArray(raw.events)
          ? trimEvents(raw.events.filter(isTelemetryEvent)).map((event) => ({ ...event, at: event.at.slice(0, 40) }))
          : [],
      };
    } catch {
      // A corrupt or missing store is reset; telemetry is not worth failing over.
      this.data = { ...EMPTY, events: [] };
    }
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    await rename(tmp, this.file);
  }

  async snapshot(): Promise<TelemetryFile> {
    await this.load();
    return { ...this.data, events: [...this.data.events] };
  }

  async setConsent(consent: boolean): Promise<void> {
    await this.load();
    this.data.consent = consent;
    await this.save();
  }

  async record(event: TelemetryEvent): Promise<void> {
    await this.load();
    this.data.events = trimEvents([...this.data.events, event]);
    await this.save();
  }

  async stats(): Promise<Map<string, TelemetryStats>> {
    await this.load();
    return aggregateEvents(this.data.events);
  }

  async pending(): Promise<number> {
    await this.load();
    return this.data.events.length;
  }

  /**
   * Upload the oldest batch. No retry loop: the events stay queued if the call fails, and
   * the next natural trigger tries again. Returns the number uploaded.
   */
  async upload(
    url: string,
    fetchImpl: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }> = (input, init) => fetch(input, init),
  ): Promise<number> {
    await this.load();
    if (!this.data.consent) return 0;

    const batch = this.data.events.slice(0, TELEMETRY_LIMITS.maxBatch);
    if (batch.length === 0) return 0;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ schemaVersion: 1, events: batch }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } finally {
        clearTimeout(timer);
      }
      this.data.events = this.data.events.slice(batch.length);
      this.data.lastUploadAt = new Date().toISOString();
      this.data.lastUploadError = null;
      await this.save();
      return batch.length;
    } catch (error) {
      this.data.lastUploadError = error instanceof Error ? error.message : String(error);
      await this.save();
      return 0;
    }
  }
}
