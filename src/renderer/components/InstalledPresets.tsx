import { useMemo, useState, type ReactNode } from 'react';
import type { PresetSummary } from '../../shared/ipc';
import { Chip, RiskBadge } from './Chrome';

type Filter = 'all' | 'compatible' | 'gaming' | 'workstation';

function groupText(summary: PresetSummary['summary']): string {
  const parts: string[] = [];
  if (summary.Registry > 0) parts.push(`${summary.Registry} registry`);
  if (summary.Services > 0) parts.push(`${summary.Services} service`);
  if (summary.Priorities > 0) parts.push(`${summary.Priorities} priority`);
  if (summary.Power > 0) parts.push(`${summary.Power} power`);
  return parts.join(' · ') || 'no changes';
}

function PresetCard({
  preset,
  pinned,
  onPreview,
  onApply,
  onPin,
}: {
  preset: PresetSummary;
  pinned: boolean;
  onPreview: (id: string) => void;
  onApply: (id: string) => void;
  onPin: (id: string | null) => void;
}): ReactNode {
  const disabled = preset.blocked || !preset.applicable || preset.stepCount === 0;

  return (
    <article className={`card preset-card ${disabled ? 'is-disabled' : ''}`}>
      <div className="card-top">
        <div>
          <h3>{preset.name}</h3>
          <p className="muted small">
            v{preset.version} · {preset.authors.join(', ')} · {preset.license}
          </p>
        </div>
        <div className="chip-row">
          {pinned && <span className="chip chip-accent">Pinned</span>}
          <RiskBadge risk={preset.risk} />
        </div>
      </div>

      <p className="preset-description">{preset.description}</p>

      <div className="chip-row">
        {preset.tags.slice(0, 3).map((tag) => (
          <Chip key={tag}>{tag}</Chip>
        ))}
        <Chip tone="accent">{groupText(preset.summary)}</Chip>
      </div>

      <div className="match">
        <div className="match-bar" aria-hidden="true">
          <span style={{ width: `${Math.round(preset.matchScore * 100)}%` }} />
        </div>
        <span className="small muted">
          {preset.blocked
            ? 'Blocked by policy'
            : !preset.applicable
              ? 'Not for this hardware'
              : `Hardware match ${Math.round(preset.matchScore * 100)}%`}
        </span>
      </div>

      {preset.blocked && (
        <ul className="finding finding-block">
          {preset.blockers.slice(0, 2).map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}

      {!preset.blocked && !preset.applicable && preset.matchReasons.length > 0 && (
        <ul className="finding finding-muted">
          {preset.matchReasons.slice(0, 2).map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}

      <div className="card-actions">
        <button
          type="button"
          className="button button-ghost"
          onClick={() => onPin(pinned ? null : preset.id)}
          aria-label={pinned ? `Unpin ${preset.name}` : `Pin ${preset.name} for recovery`}
        >
          {pinned ? 'Unpin' : 'Pin for recovery'}
        </button>
        <button type="button" className="button button-ghost" onClick={() => onPreview(preset.id)}>
          Preview changes
        </button>
        <button type="button" className="button button-primary" onClick={() => onApply(preset.id)} disabled={disabled}>
          Apply
        </button>
      </div>
    </article>
  );
}

export function InstalledPresets({
  presets,
  pinnedPresetId,
  onPreview,
  onApply,
  onPin,
  onOpenFolder,
}: {
  presets: PresetSummary[];
  pinnedPresetId: string | null;
  onPreview: (id: string) => void;
  onApply: (id: string) => void;
  onPin: (id: string | null) => void;
  onOpenFolder: () => void;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return presets
      .filter((p) => {
        if (filter === 'compatible') return p.applicable && !p.blocked;
        if (filter === 'gaming') return p.tags.includes('gaming');
        if (filter === 'workstation') return p.tags.includes('workstation');
        return true;
      })
      .filter((p) => q.length === 0 || `${p.name} ${p.description} ${p.tags.join(' ')}`.toLowerCase().includes(q))
      .sort((a, b) => Number(b.applicable) - Number(a.applicable) || b.matchScore - a.matchScore);
  }, [presets, query, filter]);

  return (
    <section className="panel presets">
      <div className="panel-head">
        <h2>Installed presets</h2>
        <div className="preset-tools">
          <input
            type="search"
            placeholder="Search installed presets…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search installed presets"
          />
          <button type="button" className="button button-ghost small" onClick={onOpenFolder}>
            Open folder
          </button>
        </div>
      </div>

      <div className="chip-row filters">
        {(
          [
            ['all', 'All'],
            ['compatible', 'Compatible'],
            ['gaming', 'Gaming'],
            ['workstation', 'Workstation'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`filter ${filter === value ? 'is-active' : ''}`}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="muted empty">No presets match this view.</p>
      ) : (
        <div className="preset-grid">
          {visible.map((preset) => (
            <PresetCard
              key={preset.id}
              preset={preset}
              pinned={preset.id === pinnedPresetId}
              onPreview={onPreview}
              onApply={onApply}
              onPin={onPin}
            />
          ))}
        </div>
      )}
    </section>
  );
}
