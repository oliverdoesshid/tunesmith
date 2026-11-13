/**
 * Text redaction for exported diagnostics.
 *
 * This is deliberately conservative: known identity strings are replaced first, then
 * Windows user-profile paths and UNC user shares are collapsed. It cannot make a
 * minidump anonymous; the export UI requires an explicit opt-in for binary dumps.
 */

export interface RedactionIdentity {
  username: string;
  homeDir: string;
  hostname: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createRedactor(identity: RedactionIdentity): (text: string) => string {
  const boundedUsername = identity.username.trim().slice(0, 128);
  const boundedHome = identity.homeDir.trim().slice(0, 1_024);
  const boundedHost = identity.hostname.trim().slice(0, 128);
  const rules: { pattern: RegExp; replacement: string }[] = [];

  if (boundedHome.length > 0) {
    rules.push({ pattern: new RegExp(escapeRegex(boundedHome), 'gi'), replacement: '%USERPROFILE%' });
  }
  if (boundedUsername.length > 0) {
    rules.push({ pattern: new RegExp(escapeRegex(boundedUsername), 'gi'), replacement: '%USERNAME%' });
  }
  if (boundedHost.length > 0) {
    rules.push({ pattern: new RegExp(escapeRegex(boundedHost), 'gi'), replacement: '%COMPUTERNAME%' });
  }
  // Fallback for paths that mention a different local account (for example a log line
  // from a helper process). Keep the drive letter so the surrounding stack remains useful.
  rules.push({ pattern: /\b([A-Za-z]:\\Users\\)[^\\\s",;]+/gi, replacement: '$1%USERNAME%' });
  rules.push({ pattern: /\\\\[^\\\s"]+\\Users\\[^\\\s",;]+/gi, replacement: '\\\\%COMPUTERNAME%\\Users\\%USERNAME%' });

  return (text: string): string => {
    let output = text;
    for (const rule of rules) output = output.replace(rule.pattern, rule.replacement);
    return output;
  };
}
