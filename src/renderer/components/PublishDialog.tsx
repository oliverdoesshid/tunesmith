import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { PublishCandidate, PublishConfig, PublishResult } from '../../shared/market/publish';
import { errorMessage, getBridge } from '../lib/bridge';

export interface PublishDialogProps {
  onClose: () => void;
}

export function PublishDialog({ onClose }: PublishDialogProps): ReactNode {
  const bridge = getBridge();
  const [config, setConfig] = useState<PublishConfig | null>(null);
  const [candidate, setCandidate] = useState<PublishCandidate | null>(null);
  const [virusTotalKey, setVirusTotalKey] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PublishResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void bridge.market
      .publishConfig()
      .then((next) => {
        if (!cancelled) setConfig(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  const choose = useCallback(async () => {
    setPicking(true);
    setError(null);
    setResult(null);
    try {
      const next = await bridge.market.pickPublishPreset();
      if (next !== null) setCandidate(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPicking(false);
    }
  }, [bridge]);

  const submit = useCallback(async () => {
    if (candidate === null) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const next = await bridge.market.publish({
        token: candidate.token,
        ...(virusTotalKey.trim().length > 0 ? { virusTotalKey: virusTotalKey.trim() } : {}),
        ...(githubToken.trim().length > 0 ? { githubToken: githubToken.trim() } : {}),
      });
      setResult(next);
      setCandidate(null);
      setVirusTotalKey('');
      setGithubToken('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [bridge, candidate, githubToken, virusTotalKey]);

  const virusTotalReady = config?.virusTotalConfigured === true || virusTotalKey.trim().length > 0;
  const githubReady = config?.githubConfigured === true || githubToken.trim().length > 0;
  const canSubmit = candidate !== null && virusTotalReady && githubReady && !busy;

  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="dialog publish-dialog" role="dialog" aria-modal="true" aria-labelledby="publish-title">
        <header className="dialog-head">
          <div>
            <span className="panel-kicker">MARKETPLACE / SUBMISSION</span>
            <h2 id="publish-title">Publish a preset</h2>
            <p className="muted small">
              The preset is validated and scanned before a pull request is opened. Nothing goes live until
              review and merge.
            </p>
          </div>
          <button type="button" className="button button-ghost small" onClick={onClose} disabled={busy}>
            Close
          </button>
        </header>

        <div className="dialog-body publish-body">
          <section>
            <h3 className="section-title">1. Choose the preset</h3>
            <div className="publish-pick">
              <button type="button" className="button button-ghost" onClick={() => void choose()} disabled={picking || busy}>
                {picking ? 'Reading…' : 'Choose preset JSON…'}
              </button>
              {candidate !== null && (
                <div className="publish-candidate">
                  <strong>
                    {candidate.name} <span className="muted">v{candidate.version}</span>
                  </strong>
                  <span className="muted small">
                    {candidate.id} · {candidate.authors.join(', ') || 'unknown author'} ·{' '}
                    {candidate.byteSize.toLocaleString()} bytes
                  </span>
                  <code className="publish-hash">SHA-256 {candidate.sha256}</code>
                </div>
              )}
            </div>
            {candidate === null && (
              <p className="muted small">Pick a `.json` preset. Its schema and policy findings are checked in the main process.</p>
            )}
          </section>

          <section>
            <h3 className="section-title">2. Scan and authenticate</h3>
            <p className="muted small publish-warning">
              VirusTotal receives the exact preset bytes and adds them to its public dataset. Do not submit
              confidential content. A flagged file is never sent to GitHub.
            </p>

            <label className="publish-field">
              <span>VirusTotal API key</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={virusTotalKey}
                onChange={(event) => setVirusTotalKey(event.target.value)}
                placeholder={
                  config?.virusTotalConfigured === true ? 'Using VIRUSTOTAL_API_KEY' : 'Paste a VirusTotal key'
                }
                disabled={busy}
              />
            </label>

            <label className="publish-field">
              <span>GitHub token</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={githubToken}
                onChange={(event) => setGithubToken(event.target.value)}
                placeholder={
                  config?.githubConfigured === true
                    ? 'Using TUNESMITH_GITHUB_TOKEN'
                    : 'Fine-grained token: Contents + Pull requests (write)'
                }
                disabled={busy}
              />
            </label>

            <p className="muted small">
              Target: <code>{config?.repository ?? 'oliverdoesshid/tunesmith'}</code> · base{' '}
              <code>{config?.branch ?? 'main'}</code>. Tokens are held only for this submission and are never
              stored by TuneSmith.
            </p>
          </section>

          {error !== null && (
            <div className="finding finding-block market-notice" role="alert">
              <strong>Submission stopped</strong>
              <p>{error}</p>
            </div>
          )}

          {result !== null && (
            <div className="finding finding-ok publish-result" role="status">
              <strong>Pull request #{result.pullRequestNumber} opened</strong>
              <p>
                VirusTotal: {result.scan.stats.malicious} malicious · {result.scan.stats.suspicious}{' '}
                suspicious · {result.scan.stats.undetected} undetected.
              </p>
              <p className="muted small">
                The preset is not in the marketplace yet. A maintainer must review, sign and merge the pull
                request.
              </p>
              <button
                type="button"
                className="button button-primary small"
                onClick={() => {
                  void bridge.market.openPublishLink(result.pullRequestUrl).catch((err: unknown) => {
                    setError(errorMessage(err));
                  });
                }}
              >
                Open pull request
              </button>
            </div>
          )}
        </div>

        <footer className="dialog-foot publish-foot">
          <span className="muted small">Submission branch: {result?.branch ?? 'created after the scan passes'}</span>
          <button type="button" className="button button-primary" onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? 'Scanning and submitting…' : 'Scan & open pull request'}
          </button>
        </footer>
      </div>
    </div>
  );
}
