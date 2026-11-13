/**
 * Marketplace publishing DTOs.
 *
 * Publishing is a reviewed submission, not an instant catalog write: the main process
 * validates the preset, scans the exact bytes at VirusTotal, and only then opens a pull
 * request against the marketplace repository. The renderer receives metadata and the PR
 * URL, never an API key that it can persist or reuse.
 */
import type { Preset } from '../preset/schema';

export interface PublishCandidate {
  /** Single-use token that names the pending file in main. */
  token: string;
  id: string;
  name: string;
  version: string;
  description: string;
  risk: Preset['risk'];
  tags: string[];
  authors: string[];
  license: string;
  fileName: string;
  byteSize: number;
  sha256: string;
}

export interface VirusTotalStats {
  malicious: number;
  suspicious: number;
  undetected: number;
  harmless: number;
  timeout: number;
  failure: number;
}

export interface PublishScan {
  provider: 'virustotal';
  verdict: 'clean';
  stats: VirusTotalStats;
  reportUrl: string;
  sha256: string;
}

export interface PublishResult {
  presetId: string;
  version: string;
  sha256: string;
  branch: string;
  pullRequestUrl: string;
  pullRequestNumber: number;
  scan: PublishScan;
}

export interface PublishConfig {
  repository: string;
  branch: string;
  virusTotalConfigured: boolean;
  githubConfigured: boolean;
  hint: string;
}

export const PUBLISH_CONFIG_HINT =
  'Publishing needs a VirusTotal API key and a GitHub token with Contents and Pull requests write access. Set VIRUSTOTAL_API_KEY and TUNESMITH_GITHUB_TOKEN, or enter them below for this submission.';
