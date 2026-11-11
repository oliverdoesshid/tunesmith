import type { ReactNode } from 'react';
import type {
  ServiceDependencyGraph,
  ServiceDependencyTarget,
  ServiceGraphNode,
} from '../../shared/service-graph';

function actionLabel(target: ServiceDependencyTarget): string {
  const parts: string[] = [];
  if (target.startup !== null) {
    parts.push(`startup → ${target.startup}${target.delayedStart ? ' (delayed)' : ''}`);
  }
  if (target.stop) parts.push('stop now');
  return parts.join(' · ') || 'no startup change';
}

function nodeMeta(node: ServiceGraphNode): ReactNode {
  return (
    <>
      {node.kind === 'group' && <span className="chip chip-muted tiny">group</span>}
      {node.protected && (
        <span className="chip chip-warn tiny" title={node.protectedReason ?? 'protected by policy'}>
          protected
        </span>
      )}
      {node.missing && <span className="chip chip-warn tiny">not found</span>}
      {node.cycle && <span className="chip chip-muted tiny">cycle</span>}
      {node.truncated && <span className="chip chip-muted tiny">capped</span>}
      {node.kind === 'service' && node.start !== 'Unknown' && (
        <span className="muted small svc-node-start">{node.start}</span>
      )}
    </>
  );
}

function NodeLabel({ node }: { node: ServiceGraphNode }): ReactNode {
  return (
    <span className="svc-node-label">
      <span className="svc-node-name">
        <code>{node.name}</code>
        {node.displayName.length > 0 && node.displayName.toLowerCase() !== node.name.toLowerCase() && (
          <span className="muted small">{node.displayName}</span>
        )}
      </span>
      <span className="svc-node-chips">{nodeMeta(node)}</span>
    </span>
  );
}

function ServiceTreeNode({ node, depth }: { node: ServiceGraphNode; depth: number }): ReactNode {
  if (node.children.length === 0) {
    return (
      <li className={`svc-node ${node.protected ? 'is-protected' : ''}`}>
        <NodeLabel node={node} />
      </li>
    );
  }

  return (
    <li className={`svc-node ${node.protected ? 'is-protected' : ''}`}>
      <details open={depth < 1}>
        <summary>
          <NodeLabel node={node} />
        </summary>
        <ul className="svc-tree">
          {node.children.map((child) => (
            <ServiceTreeNode key={`${child.kind}:${child.name}:${child.cycle ? 'cycle' : ''}`} node={child} depth={depth + 1} />
          ))}
        </ul>
      </details>
    </li>
  );
}

function Tree({
  nodes,
  empty,
}: {
  nodes: ServiceGraphNode[];
  empty: string;
}): ReactNode {
  if (nodes.length === 0) return <p className="muted small svc-empty">{empty}</p>;
  return (
    <ul className="svc-tree svc-tree-root">
      {nodes.map((node) => (
        <ServiceTreeNode key={`${node.kind}:${node.name}:${node.cycle ? 'cycle' : ''}`} node={node} depth={0} />
      ))}
    </ul>
  );
}

function TargetCard({ target }: { target: ServiceDependencyTarget }): ReactNode {
  const risk = target.criticalAffected.length > 0;
  return (
    <article className={`service-target ${risk ? 'is-risk' : ''}`} data-service-target={target.name}>
      <div className="service-target-head">
        <div>
          <h4 className="service-target-name">
            <code>{target.name}</code>
            {target.displayName.toLowerCase() !== target.name.toLowerCase() && (
              <span className="muted small">{target.displayName}</span>
            )}
          </h4>
          <p className="muted small">
            {actionLabel(target)}
            {target.start !== 'Unknown' && ` · registry: ${target.start}`}
          </p>
        </div>
        <div className="chip-row">
          {!target.exists && <span className="chip chip-warn tiny">not found</span>}
          {target.protected && <span className="chip chip-warn tiny">protected target</span>}
          {target.risky && <span className="chip chip-warn tiny">disable/stop</span>}
          <span className={`chip ${risk ? 'chip-danger' : target.affectedCount > 0 ? 'chip-warn' : 'chip-muted'} tiny`}>
            {target.affectedCount} dependent{target.affectedCount === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      {risk && (
        <div className="finding finding-block service-critical" role="alert">
          <strong>Protected dependents may fail</strong>
          <ul>
            {target.criticalAffected.map((entry) => (
              <li key={entry.name}>
                <code>{entry.name}</code>: {entry.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="svc-tree-sections">
        <details open={target.requiredBy.length > 0 || risk}>
          <summary>
            Required by <span className="muted">({target.affectedCount} dependent{target.affectedCount === 1 ? '' : 's'})</span>
          </summary>
          <p className="muted small svc-direction">
            These services can fail if <code>{target.name}</code> is disabled or stopped.
          </p>
          <Tree nodes={target.requiredBy} empty="No dependents declared in the SCM registry." />
        </details>
        <details>
          <summary>
            Requires <span className="muted">({target.requires.length} direct item{target.requires.length === 1 ? '' : 's'})</span>
          </summary>
          <p className="muted small svc-direction">
            These are the target&apos;s own dependencies. Disabling it does not remove them, but they explain its startup chain.
          </p>
          <Tree nodes={target.requires} empty="No declared service dependencies." />
        </details>
      </div>
    </article>
  );
}

export function ServiceDependencyPanel({
  graph,
  error,
}: {
  graph: ServiceDependencyGraph | null;
  error: string | null;
}): ReactNode {
  return (
    <section className="service-graph" aria-labelledby="service-graph-title">
      <div className="section-head">
        <div>
          <h3 className="section-title" id="service-graph-title">
            Service dependency map
          </h3>
          <p className="muted small">
            Read-only view of <code>HKLM\SYSTEM\CurrentControlSet\Services</code>. This map is advisory; apply-time
            capture still refuses any service it cannot read.
          </p>
        </div>
        {graph !== null && (
          <span className="pill pill-muted">
            {graph.servicesRead} service{graph.servicesRead === 1 ? '' : 's'} read
          </span>
        )}
      </div>

      {error !== null && (
        <div className="finding finding-warn market-notice" role="alert">
          <strong>Could not read the service dependency map</strong>
          <p>{error}</p>
          <p className="small">
            The plan is still subject to service policy and apply-time capture, but the dependency cascade is not
            available for this preview.
          </p>
        </div>
      )}

      {graph === null && error === null && (
        <p className="muted small svc-empty">No dependency map was returned for this plan.</p>
      )}

      {graph !== null && graph.targets.length === 0 && (
        <p className="muted small svc-empty">This plan has no service changes to map.</p>
      )}

      {graph !== null && graph.targets.length > 0 && (
        <>
          <div className="service-target-list">
            {graph.targets.map((target) => (
              <TargetCard key={target.name} target={target} />
            ))}
          </div>
          {graph.warnings.length > 0 && (
            <ul className="finding finding-muted service-warnings">
              {graph.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
