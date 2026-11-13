import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRedactor } from '../src/main/diagnostics/redact';
import { createZip } from '../src/main/diagnostics/zip';
import { DiagnosticsService } from '../src/main/diagnostics/reports';
import type { CrashIncident } from '../src/main/diagnostics/crash-collector';
import type { SessionSummary } from '../src/shared/session';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tunesmith-diag-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function readStoredEntries(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const dataStart = offset + 30 + nameLength + extraLength;
    entries.set(name, zip.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return entries;
}

const SESSION: SessionSummary = {
  id: 'session-0001',
  createdAt: '2026-11-13T10:00:00.000Z',
  finishedAt: null,
  presetId: 'test-preset',
  presetName: 'Test preset',
  presetVersion: '1.0.0',
  presetRisk: 'conservative',
  signature: 'sig',
  status: 'applying',
  restorePoint: { attempted: true, ok: true, detail: 'ok' },
  stepCount: 2,
  pendingRollback: 1,
  interrupted: true,
};

describe('diagnostic redaction', () => {
  it('removes the current identity from logs and generic user paths', () => {
    const redact = createRedactor({
      username: 'olive',
      homeDir: 'C:\\Users\\olive',
      hostname: 'MunchersPC',
    });
    const output = redact(
      'opened C:\\Users\\olive\\AppData\\Local\\TuneSmith from MunchersPC; other=D:\\Users\\sam\\x; user=olive',
    );
    expect(output).not.toContain('olive');
    expect(output).not.toContain('MunchersPC');
    expect(output).toContain('%USERPROFILE%');
    expect(output).toContain('%COMPUTERNAME%');
    expect(output).toContain('D:\\Users\\%USERNAME%');
  });
});

describe('local diagnostics bundle', () => {
  it('correlates an incident with a dump and exports redacted text plus opt-in dumps', async () => {
    const root = await tempDir();
    const crashDir = path.join(root, 'crashes');
    const incidentDir = path.join(crashDir, 'incidents');
    const logDir = path.join(root, 'logs');
    await mkdir(incidentDir, { recursive: true });
    await mkdir(logDir, { recursive: true });

    const incident: CrashIncident = {
      schemaVersion: 1,
      id: 'crash-12345678',
      at: new Date().toISOString(),
      kind: 'renderer',
      appVersion: '0.2.1',
      electronVersion: '45.0.0',
      platform: 'win32',
      arch: 'x64',
      reason: 'crashed',
      exitCode: 1,
      details: '{"webContentsId":3}',
    };
    await writeFile(path.join(incidentDir, `${incident.id}.json`), JSON.stringify(incident));
    await writeFile(path.join(crashDir, 'dump-1.dmp'), Buffer.from([1, 2, 3, 4]));
    await writeFile(
      path.join(logDir, 'tunesmith.log'),
      `2026-11-13T10:00:00.000Z ERROR opened C:\\Users\\olive\\AppData\\Roaming\\TuneSmith\n`,
    );

    const service = new DiagnosticsService({
      crashDir,
      logDir,
      identity: { username: 'olive', homeDir: 'C:\\Users\\olive', hostname: 'MunchersPC' },
      getJournal: async () => [SESSION],
    });
    const status = await service.status();
    expect(status.reportCount).toBe(1);
    expect(status.dumpCount).toBe(1);
    expect(status.reports[0]?.dumpFiles[0]?.name).toBe('dump-1.dmp');

    const materialized = await service.materializeReports();
    expect(materialized).toBe(1);
    const onDisk = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(crashDir, 'reports', `${incident.id}.md`), 'utf8'),
    );
    expect(onDisk).toContain('Renderer process crash');
    expect(onDisk).not.toContain('olive');

    const destination = path.join(root, 'bundle.zip');
    const result = await service.exportBundle(
      { reportIds: [incident.id], redact: true, includeDumps: true },
      destination,
    );
    expect(result.saved).toBe(true);
    if (!result.saved) return;
    expect(result.path).toBe(destination);

    const zip = await import('node:fs/promises').then((fs) => fs.readFile(destination));
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const entries = readStoredEntries(zip);
    expect(entries.has(`reports/${incident.id}.md`)).toBe(true);
    expect(entries.has('dumps/dump-1.dmp')).toBe(true);
    const report = entries.get(`reports/${incident.id}.md`)?.toString('utf8') ?? '';
    expect(report).toContain('Renderer process crash');
    expect(report).toContain('session-0001');
    expect(report).not.toContain('olive');
    expect(report).toContain('%USERPROFILE%');
    expect(entries.get('README.txt')?.toString('utf8')).toContain('No data was uploaded');
  });

  it('omits minidumps unless explicitly requested', async () => {
    const root = await tempDir();
    const crashDir = path.join(root, 'crashes');
    const incidentDir = path.join(crashDir, 'incidents');
    await mkdir(incidentDir, { recursive: true });
    await writeFile(
      path.join(incidentDir, 'crash-aaaaaaaa.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'crash-aaaaaaaa',
        at: new Date().toISOString(),
        kind: 'unclean-shutdown',
        appVersion: '0.2.1',
        electronVersion: '45.0.0',
        platform: 'win32',
        arch: 'x64',
      }),
    );
    await writeFile(path.join(crashDir, 'dump-2.dmp'), Buffer.from([9]));

    const service = new DiagnosticsService({
      crashDir,
      logDir: path.join(root, 'logs'),
      getJournal: async () => [],
    });
    const destination = path.join(root, 'no-dumps.zip');
    const result = await service.exportBundle(
      { reportIds: ['crash-aaaaaaaa'], redact: true, includeDumps: false },
      destination,
    );
    expect(result.saved).toBe(true);
    const zip = await import('node:fs/promises').then((fs) => fs.readFile(destination));
    expect(readStoredEntries(zip).has('dumps/dump-2.dmp')).toBe(false);
  });
});

describe('store-only ZIP writer', () => {
  it('writes valid local headers and data', () => {
    const zip = createZip([
      { name: 'a/report.txt', data: Buffer.from('hello') },
      { name: 'b.bin', data: Buffer.from([0, 255, 1]) },
    ]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const entries = readStoredEntries(zip);
    expect(entries.get('a/report.txt')?.toString('utf8')).toBe('hello');
    expect([...(entries.get('b.bin') ?? [])]).toEqual([0, 255, 1]);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
  });

  it('rejects traversal names', () => {
    expect(() => createZip([{ name: '../escape.txt', data: Buffer.from('x') }])).toThrow();
  });
});
