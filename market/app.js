(() => {
  'use strict';

  const grid = document.querySelector('#preset-grid');
  const status = document.querySelector('#catalog-status');
  const search = document.querySelector('#preset-search');
  const risk = document.querySelector('#risk-filter');
  const resultCount = document.querySelector('#result-count');
  const emptyState = document.querySelector('#empty-state');
  const installHint = document.querySelector('#install-hint');
  const statTotal = document.querySelector('#stat-total');

  if (
    grid === null ||
    status === null ||
    search === null ||
    risk === null ||
    resultCount === null ||
    emptyState === null ||
    installHint === null ||
    statTotal === null
  ) {
    return;
  }

  let presets = [];

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className.length > 0) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const riskLabel = (value) =>
    value === 'conservative' ? 'CONSERVATIVE' : value === 'aggressive' ? 'AGGRESSIVE' : 'MODERATE';

  const requirementChips = (entry) => {
    const requirements = entry.requirements ?? {};
    const chips = [];
    if (Array.isArray(requirements.cpu) && requirements.cpu.length > 0) {
      chips.push(`CPU ${requirements.cpu.join(' / ')}`);
    }
    if (Array.isArray(requirements.gpu) && requirements.gpu.length > 0) {
      chips.push(`GPU ${requirements.gpu.join(' / ')}`);
    }
    if (typeof requirements.ram === 'string' && requirements.ram.length > 0) {
      chips.push(`RAM ${requirements.ram}`);
    }
    if (Array.isArray(requirements.storage) && requirements.storage.length > 0) {
      chips.push(requirements.storage.join(' / '));
    }
    if (requirements.elevation === true) chips.push('ADMIN');
    if (typeof requirements.restorePoint === 'string' && requirements.restorePoint !== 'none') {
      chips.push(`RESTORE ${requirements.restorePoint.toUpperCase()}`);
    }
    return chips.length > 0 ? chips : ['UNIVERSAL'];
  };

  const installUrl = (entry) => {
    const params = new URLSearchParams();
    params.set('preset', entry.id);
    params.set('url', entry.downloadUrl);
    params.set('sha256', entry.sha256);
    params.set('signature', entry.signature);
    return `tunesmith://install?${params.toString()}`;
  };

  const createCard = (entry) => {
    const article = make('article', 'preset-card');

    const head = make('div', 'card-head');
    const titleWrap = make('div', 'card-title-wrap');
    titleWrap.append(make('h2', 'card-title', entry.name));
    titleWrap.append(
      make('p', 'card-byline', `v${entry.version} · ${entry.author} · ${entry.license}`),
    );
    const verified = make('span', 'verify-badge', '✓ ED25519 + SHA-256');
    verified.title = 'SHA-256 digest and detached Ed25519 signature over the exact preset bytes.';
    head.append(titleWrap, verified);

    const description = make('p', 'card-desc', entry.description);

    const hardware = make('p', 'hardware');
    hardware.append(make('span', 'hardware-label', 'TARGET'), document.createTextNode(entry.hardwareSignature));

    const chipRow = make('div', 'chip-row');
    chipRow.append(make('span', `chip risk-${entry.risk}`, riskLabel(entry.risk)));
    for (const chip of requirementChips(entry)) chipRow.append(make('span', 'chip', chip));
    if (Array.isArray(entry.tags)) {
      for (const tag of entry.tags) chipRow.append(make('span', 'chip chip-tag', `#${tag}`));
    }

    const hashRow = make('div', 'hash-row');
    hashRow.title = entry.sha256;
    hashRow.append(make('span', 'hash-label', 'SHA-256'));
    hashRow.append(make('code', 'hash-value', entry.sha256));
    const copy = make('button', 'copy-button', 'COPY');
    copy.type = 'button';
    copy.title = 'Copy the full SHA-256 digest';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(entry.sha256);
        copy.textContent = 'COPIED';
      } catch {
        copy.textContent = 'UNAVAILABLE';
      }
      window.setTimeout(() => {
        copy.textContent = 'COPY';
      }, 1400);
    });
    hashRow.append(copy);

    const actions = make('div', 'card-actions');
    const install = make('a', 'button button-primary', 'Install in TuneSmith');
    install.href = installUrl(entry);
    install.dataset.install = entry.id;
    install.setAttribute('aria-describedby', 'install-hint');
    const download = make('a', 'button button-ghost', 'Download .json');
    download.href = entry.downloadUrl;
    download.download = entry.file;
    download.target = '_blank';
    download.rel = 'noopener noreferrer';
    const signature = make('a', 'button button-ghost', 'Signature .sig');
    signature.href = `${entry.downloadUrl}.sig`;
    signature.download = `${entry.file}.sig`;
    signature.target = '_blank';
    signature.rel = 'noopener noreferrer';
    actions.append(install, download, signature);

    article.append(head, description, hardware, chipRow, hashRow, actions);
    return article;
  };

  const matches = (entry, query, riskValue) => {
    if (riskValue !== 'all' && entry.risk !== riskValue) return false;
    if (query.length === 0) return true;
    const haystack = [
      entry.id,
      entry.name,
      entry.author,
      entry.description,
      entry.hardwareSignature,
      ...(Array.isArray(entry.tags) ? entry.tags : []),
      ...(Array.isArray(entry.requirements?.cpu) ? entry.requirements.cpu : []),
      ...(Array.isArray(entry.requirements?.gpu) ? entry.requirements.gpu : []),
    ]
      .join(' ')
      .toLowerCase();
    return query
      .split(/\s+/)
      .filter(Boolean)
      .every((term) => haystack.includes(term));
  };

  const render = () => {
    const query = search.value.trim().toLowerCase();
    const filtered = presets.filter((entry) => matches(entry, query, risk.value));
    grid.replaceChildren(...filtered.map(createCard));
    grid.hidden = filtered.length === 0;
    emptyState.hidden = filtered.length !== 0;
    resultCount.textContent = `${filtered.length} of ${presets.length} preset${presets.length === 1 ? '' : 's'}`;
  };

  const isEntryShape = (entry) =>
    entry !== null &&
    typeof entry === 'object' &&
    typeof entry.id === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.version === 'string' &&
    typeof entry.author === 'string' &&
    typeof entry.description === 'string' &&
    typeof entry.hardwareSignature === 'string' &&
    typeof entry.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(entry.sha256) &&
    typeof entry.signature === 'string' &&
    entry.signature.length > 0 &&
    typeof entry.downloadUrl === 'string' &&
    entry.downloadUrl.startsWith('https://raw.githubusercontent.com/') &&
    typeof entry.file === 'string' &&
    typeof entry.risk === 'string' &&
    typeof entry.license === 'string' &&
    entry.requirements !== null &&
    typeof entry.requirements === 'object';

  const setError = (error) => {
    status.hidden = false;
    status.className = 'catalog-status is-error';
    status.replaceChildren();
    status.append(
      document.createTextNode(
        `Could not load the verified catalog: ${error instanceof Error ? error.message : String(error)}. `,
      ),
    );
    const link = make('a', '', 'Open index.json');
    link.href = './index.json';
    status.append(link);
    resultCount.textContent = 'Catalog unavailable';
  };

  const load = async () => {
    try {
      const response = await fetch('./index.json', {
        cache: 'no-cache',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      if (
        data === null ||
        typeof data !== 'object' ||
        data.schemaVersion !== 1 ||
        !Array.isArray(data.presets) ||
        !data.presets.every(isEntryShape)
      ) {
        throw new Error('unsupported catalog format');
      }

      presets = data.presets;
      statTotal.textContent = String(presets.length);
      status.hidden = true;
      grid.hidden = false;
      render();
    } catch (error) {
      setError(error);
    }
  };

  search.addEventListener('input', render);
  risk.addEventListener('change', render);

  grid.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest('[data-install]') === null) return;
    window.setTimeout(() => {
      installHint.hidden = false;
      installHint.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 1200);
  });

  void load();
})();
