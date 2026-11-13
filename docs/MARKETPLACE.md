# Community marketplace: signatures, ratings and telemetry

The in-app marketplace consumes a signed catalog envelope; `TUNESMITH_MARKET_URL` or
`market/config.json` can point it at one. A stock build trusts the pinned publisher key and
the public Pages catalog by default; an empty or explicitly configured trust store never
means "trust everything". The same Pages deployment also publishes the static discovery
catalog in `market/index.json`; see §6.

## 1. Trust model

Two independent checks protect every entry:

1. **Catalog signature.** The publisher signs
   `tunesmith-catalog-v1:` + canonical JSON of the catalog with an Ed25519 key.
   Verification uses a key from the pinned ring; an unknown `keyId` aborts the refresh.
2. **Entry attestation.** Each entry carries `sha256` of the canonical preset JSON and a
   detached Ed25519 signature over `tunesmith-entry-v1:<sha256>`. A preset whose digest or
   signature fails is excluded from the browser, not shown with a warning.

Installation re-downloads the catalog, recomputes the payload's SHA-256 and re-verifies
the entry's Ed25519 signature in main before writing exactly the canonical bytes that were
signed. It writes them into the writable community directory
(`<userData>/presets/community`), rebuilds `index.json`, and awaits an immediate repository
re-index, so the preset loader's digest check keeps covering the file after install.
Nothing in this path bypasses preview, policy or consent — installing only adds a preset
to the library.

The browser's compatibility badges are compiled in main against the detected machine;
the renderer receives the verdict and reasons but cannot change them.

### Canonical JSON

Object keys are sorted recursively; arrays keep their order; `undefined` members are
dropped; non-finite numbers are refused. Signature verification happens in the main
process (`src/main/market/verify.ts`), never in the renderer.

### Keys

The key ring comes from `TUNESMITH_MARKET_KEYS`:

```json
{
  "tunesmith-2026": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA...\n-----END PUBLIC KEY-----\n"
}
```

or from `market/config.json` next to the app:

```json
{
  "catalogUrl": "https://market.example/v1/catalog.json",
  "telemetryUrl": "https://telemetry.example/v1/events",
  "keys": { "tunesmith-2026": "-----BEGIN PUBLIC KEY-----\n..." }
}
```

When neither the environment nor `market/config.json` supplies a ring, the app uses the
pinned publisher key from `src/main/security/keys.ts` (`tunesmith-presets-2026`), which also
signs the bundled presets and the default Pages catalog. An explicit ring replaces the
default; it is not merged. Only `https:` URLs are accepted; `http://localhost` is allowed for
development. At most eight keys are loaded, each must parse as an Ed25519 SPKI public key.

## 2. Publishing a catalog

1. Author presets normally (see `PRESET-AUTHORING.md`) and collect them under `entries`.
2. Sign the catalog:

   ```bash
   node scripts/sign-marketplace.mjs \
     --catalog unsigned-catalog.json \
     --key ed25519-private.pem \
     --key-id tunesmith-2026 \
     --out catalog.json
   ```

3. Upload `catalog.json` behind the configured URL. Keep the private key offline; rotating
   it means adding the new public key to the ring and re-signing.

This repository's default endpoint is generated from `presets/community/` by
`npm run market:catalog -- --key tmp/preset-signing-key.pem` and verified without the private
key by `npm run market:catalog:check`.

Catalog limits: 100 entries, 2 MiB response body, no unknown fields, ISO timestamps.

### In-app submissions

**Publish preset** in the Community marketplace opens a reviewed submission flow. It never
writes directly to the live catalog.

1. The native picker selects a `.json` preset. Main re-parses it with the authoritative zod
   schema, evaluates policy, refuses block-severity findings, normalizes it to LF/2-space JSON
   and computes the SHA-256 of those exact bytes.
2. Main checks whether `presets/community/<id>.json` already exists in the target repository.
   A duplicate id is refused before any scan request is spent.
3. The exact bytes are sent to VirusTotal. A known hash is reused only when it carries
   `last_analysis_stats`; otherwise the file is uploaded and the analysis is polled. Any
   malicious or suspicious engine blocks the submission and no GitHub write occurs.
4. A branch, commit and pull request are created with the preset JSON. The PR body records the
   SHA-256, VirusTotal counts and report URL.

Nothing becomes installable until a maintainer reviews the PR, signs the preset with the
offline publisher key, regenerates `market/index.json` and `market/catalog.json`, and merges.

Configuration:

- `VIRUSTOTAL_API_KEY` enables the scan. The key can also be pasted into the dialog for one
  submission; it is held in main-process memory, never written to disk or returned to the
  renderer. A missing key blocks submission.
- `TUNESMITH_GITHUB_TOKEN` (or `GITHUB_TOKEN`) authorizes the pull request. A fine-grained
  token needs **Contents: write** and **Pull requests: write** on the marketplace repository.
- `TUNESMITH_MARKET_REPO` and `TUNESMITH_MARKET_BRANCH` can point a fork at its own repository
  and base branch. Defaults: `oliverdoesshid/tunesmith`, `main`.

VirusTotal's public API is limited to 4 requests per minute and 500 per day. The scanner polls
at most every 45 seconds and stops after ten attempts; a timeout leaves the picked file in
place so it can be retried. The public API is for non-commercial use, and submitted files are
added to VirusTotal's public dataset — do not submit confidential content.

## 3. Safety score

`src/shared/market/score.ts` computes 0..100 from a neutral base:

| Signal | Effect |
|---|---|
| Signature verified | +25 |
| Low risk preset | +6 |
| Aggressive risk preset | −14 |
| Community votes (≥ 3) | up to ±12 by positive ratio |
| Local crash rate (≥ 5 applies) | −1 per percentage point, capped at −35 |
| Successful crash recovery | +8 |

Labels: `safe` ≥ 80, `good` ≥ 60, `caution` ≥ 40, otherwise `risky`. A new preset with no
votes and no telemetry is **not** labelled safe. The card shows the strongest reasons so
the number is never a black box.

## 4. Telemetry

Recorded locally whether or not consent is enabled (it powers the local crash numbers):

```json
{ "at": "2026-11-10T12:00:00.000Z", "presetId": "example", "presetVersion": "1.2.0", "appVersion": "0.2.1", "kind": "apply-ok" }
```

Kinds: `apply-ok`, `apply-failed`, `session-interrupted`, `session-recovered`. There is no
hardware signature, path, user name, session id or free-text field in the schema.

- **Consent is off by default** and stored in `userData/market/telemetry.json`.
- Uploads only when consent is on **and** `TUNESMITH_TELEMETRY_URL` is configured.
- Batches of at most 50, 8 s timeout, no retry loop; failed batches stay queued.
- Interrupted sessions are detected from `applying` manifests at startup, and a successful
  rollback of one records `session-recovered`.

## 5. Where files live

```
userData/
  market/
    telemetry.json            consent + queued events
    presets/                  installed presets (indexed by the loader)
      <preset-id>.json
      index.json
```

Bundled presets always win when ids collide, so a catalog cannot shadow a preset that
shipped with the app.

## 6. Static GitHub Pages catalog

`market/` is a standalone storefront deployed at
`https://oliverdoesshid.github.io/tunesmith/market/`. It serves both the static storefront
and the signed `catalog.json` envelope the app fetches by default.

- `market/index.json` is generated from `presets/community/` by `npm run market:index`
  (`scripts/generateMarketIndex.ts`).
- `market/catalog.json` is generated by `npm run market:catalog`
  (`scripts/generateMarketCatalog.ts`) with the offline publisher key. Each entry signs the
  SHA-256 of its canonical preset, and the envelope signs the canonical catalog. Both use
  `tunesmith-presets-2026`, the key pinned in `src/main/security/keys.ts`.
- Each entry contains `id`, `name`, `version`, `author`, `description`, `hardwareSignature`,
  `sha256`, `signature` and a `downloadUrl` pointing at the raw GitHub preset file. The digest
  is over the exact file bytes; `signature` is the detached Ed25519 `.sig` over those same
  bytes.
- The generator validates each preset with the authoritative zod schema, requires a `.sig`,
  verifies it against the pinned preset key, rejects duplicate ids/files and CR bytes, and
  writes a deterministic (timestamp-free, id-sorted) catalog. `.gitattributes` checks signed
  presets out with LF so the raw GitHub bytes match the published digest and signature.
- `.github/workflows/publish-market.yml` runs the typecheck, regenerates the index, fails when
  `market/index.json` differs, verifies the committed signed catalog with
  `npm run market:catalog:check`, stages `market/` under `/market/`, and deploys it to GitHub
  Pages.
- The page is dependency-free HTML/CSS/JS. Install buttons use
  `tunesmith://install?preset=<id>&url=<raw>&sha256=<digest>&signature=<sig>`; each card also
  offers the raw `.json` and `.sig` downloads for manual installation in
  `<userData>/presets/community`. Manual copies load as `unverified`: that folder has no
  signed catalog entry, so the app preserves the signature but does not grant marketplace
  trust. The Electron app does not yet register the `tunesmith://` scheme; the links are a
  forward-compatible contract and the page exposes the manual fallback.
- This static catalog is not consumed by the in-app signed-catalog browser. It is the public
  discovery/install surface and a stable contract for deep-link handling.

Publishing changes: edit a preset, re-sign it with `scripts/sign-presets.mjs`, run
`npm run market:index`, and commit both the preset and the regenerated catalog.

## 7. Limitations

- The Pages catalog is signed with the same publisher key as the bundled presets. Rebuilding
  it requires that offline key; a fork that changes presets must re-sign it or configure its
  own `TUNESMITH_MARKET_KEYS` ring and endpoint. Tests also generate an ephemeral Ed25519 key
  pair for verifier coverage.
- Community vote counts and `ratings.crashes` are publisher-supplied metadata. They are
  signature-covered (not tamperable in transit) but not proof of anything; the local crash
  rate is the signal the app measures itself.
- Telemetry is aggregate and anonymous by construction, but it is not a substitute for a
  code review of a preset.
