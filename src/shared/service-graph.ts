/**
 * Read-only service dependency graph.
 *
 * The SCM registry is the source of truth for `DependOnService` and
 * `DependOnGroup`. This module only reshapes that data; it never mutates a
 * service and it is not consulted by the executor. A graph is built specifically
 * for the plan preview so a user can see what might fail before disabling a
 * service. The executor still captures and restores through SCM, and policy still
 * hard-blocks protected services.
 */
import { protectedServiceReason } from './preset/policy';
import type { ServiceStartupMode } from './types';

export type ServiceGraphStart = 'Boot' | 'System' | 'Auto' | 'Manual' | 'Disabled' | 'Unknown';

/** A normalised row from `HKLM\SYSTEM\CurrentControlSet\Services`. */
export interface ServiceRegistryEntry {
  name: string;
  displayName: string;
  start: ServiceGraphStart;
  dependsOn: string[];
  dependsOnGroups: string[];
}

export interface ServiceGraphNode {
  name: string;
  kind: 'service' | 'group';
  displayName: string;
  start: ServiceGraphStart;
  protected: boolean;
  protectedReason: string | null;
  missing: boolean;
  /** A cycle was encountered; children are intentionally omitted. */
  cycle: boolean;
  /** The tree hit its depth, branch or node cap here. */
  truncated: boolean;
  children: ServiceGraphNode[];
}

export interface ServiceDependencyTarget {
  name: string;
  displayName: string;
  exists: boolean;
  start: ServiceGraphStart;
  startup: ServiceStartupMode | null;
  delayedStart: boolean;
  stop: boolean;
  /** A disable or stop action can strand dependents. */
  risky: boolean;
  protected: boolean;
  protectedReason: string | null;
  /** Services this target needs. */
  requires: ServiceGraphNode[];
  /** Services that transitively require this target. */
  requiredBy: ServiceGraphNode[];
  /** Distinct service names in the required-by tree. */
  affectedCount: number;
  /** Protected services in the required-by tree, with the policy reason. */
  criticalAffected: { name: string; reason: string }[];
  truncated: boolean;
}

export interface ServiceDependencyGraph {
  targets: ServiceDependencyTarget[];
  servicesRead: number;
  missingTargets: string[];
  truncated: boolean;
  warnings: string[];
}

export interface ServiceDependencyAction {
  name: string;
  startup?: ServiceStartupMode;
  delayedStart?: boolean;
  stop?: boolean;
}

const MAX_TREE_DEPTH = 6;
const MAX_TREE_NODES = 160;
const MAX_BRANCH = 24;

const key = (name: string): string => name.trim().toLowerCase();
const byName = (a: string, b: string): number => a.localeCompare(b, 'en', { sensitivity: 'base' });

interface BuildContext {
  byName: Map<string, ServiceRegistryEntry>;
  dependents: Map<string, string[]>;
  nodes: number;
  truncated: boolean;
}

type Direction = 'requires' | 'requiredBy';

function serviceNames(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const name = value.trim();
    const normalized = key(name);
    if (name.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(name);
  }
  return out.sort(byName);
}

function baseNode(name: string, kind: 'service' | 'group', ctx: BuildContext): ServiceGraphNode {
  const record = kind === 'service' ? ctx.byName.get(key(name)) : undefined;
  const reason = kind === 'service' ? protectedServiceReason(name) : null;
  return {
    name: record?.name ?? name.trim(),
    kind,
    displayName: record?.displayName ?? name.trim(),
    start: record?.start ?? 'Unknown',
    protected: reason !== null,
    protectedReason: reason,
    missing: kind === 'service' && record === undefined,
    cycle: false,
    truncated: false,
    children: [],
  };
}

function groupNode(name: string, ctx: BuildContext): ServiceGraphNode {
  ctx.nodes += 1;
  return baseNode(name, 'group', ctx);
}

function branch<T>(items: readonly T[], ctx: BuildContext): T[] {
  if (items.length > MAX_BRANCH) ctx.truncated = true;
  return items.slice(0, MAX_BRANCH);
}

function requiresChildren(
  record: ServiceRegistryEntry,
  depth: number,
  path: Set<string>,
  ctx: BuildContext,
): ServiceGraphNode[] {
  const nodes: ServiceGraphNode[] = [];
  for (const dependency of branch(serviceNames(record.dependsOn), ctx)) {
    nodes.push(treeServiceNode(dependency, 'requires', depth, path, ctx));
  }
  for (const group of branch(serviceNames(record.dependsOnGroups), ctx)) {
    if (ctx.nodes >= MAX_TREE_NODES) {
      ctx.truncated = true;
      break;
    }
    nodes.push(groupNode(group, ctx));
  }
  return nodes;
}

function requiredByChildren(name: string, depth: number, path: Set<string>, ctx: BuildContext): ServiceGraphNode[] {
  const dependents = branch(ctx.dependents.get(key(name)) ?? [], ctx);
  return dependents.map((dependent) => treeServiceNode(dependent, 'requiredBy', depth, path, ctx));
}

function treeServiceNode(
  name: string,
  direction: Direction,
  depth: number,
  path: Set<string>,
  ctx: BuildContext,
): ServiceGraphNode {
  const node = baseNode(name, 'service', ctx);
  const normalized = key(node.name);

  if (path.has(normalized)) {
    node.cycle = true;
    return node;
  }
  if (node.missing) return node;
  if (ctx.nodes >= MAX_TREE_NODES) {
    ctx.truncated = true;
    node.truncated = true;
    return node;
  }

  ctx.nodes += 1;
  if (depth >= MAX_TREE_DEPTH) {
    if (direction === 'requires') {
      const record = ctx.byName.get(normalized);
      if (record !== undefined && (record.dependsOn.length > 0 || record.dependsOnGroups.length > 0)) {
        ctx.truncated = true;
        node.truncated = true;
      }
    } else if ((ctx.dependents.get(normalized)?.length ?? 0) > 0) {
      ctx.truncated = true;
      node.truncated = true;
    }
    return node;
  }

  const nextPath = new Set(path);
  nextPath.add(normalized);
  if (direction === 'requires') {
    const record = ctx.byName.get(normalized);
    if (record !== undefined) node.children = requiresChildren(record, depth + 1, nextPath, ctx);
  } else {
    node.children = requiredByChildren(node.name, depth + 1, nextPath, ctx);
  }
  return node;
}

function collectAffected(
  nodes: readonly ServiceGraphNode[],
  affected: Set<string>,
  critical: Map<string, string>,
): void {
  for (const node of nodes) {
    if (node.cycle) continue;
    if (node.kind === 'service') {
      affected.add(key(node.name));
      if (node.protected && node.protectedReason !== null) critical.set(key(node.name), node.protectedReason);
    }
    collectAffected(node.children, affected, critical);
  }
}

function countGroups(nodes: readonly ServiceGraphNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.kind === 'group') count += 1;
    count += countGroups(node.children);
  }
  return count;
}

/**
 * Build the bounded tree for each service action. If a service is absent from
 * the registry, the target is still returned with `exists: false`: apply-time
 * capture remains responsible for refusing an unknown service.
 */
export function buildServiceDependencyGraph(
  records: readonly ServiceRegistryEntry[],
  actions: readonly ServiceDependencyAction[],
): ServiceDependencyGraph {
  const byNameMap = new Map<string, ServiceRegistryEntry>();
  for (const record of records) {
    const normalized = key(record.name);
    if (normalized.length > 0 && !byNameMap.has(normalized)) byNameMap.set(normalized, record);
  }

  const dependents = new Map<string, string[]>();
  for (const record of byNameMap.values()) {
    for (const dependency of serviceNames(record.dependsOn)) {
      const normalized = key(dependency);
      if (!dependents.has(normalized)) dependents.set(normalized, []);
      dependents.get(normalized)?.push(record.name);
    }
  }
  for (const [name, names] of dependents) {
    dependents.set(name, serviceNames(names));
  }

  const actionsByName = new Map<string, ServiceDependencyAction>();
  for (const action of actions) {
    if (action.name.trim().length > 0) actionsByName.set(key(action.name), action);
  }

  const targets: ServiceDependencyTarget[] = [];
  const missingTargets: string[] = [];
  let anyTruncated = false;
  let groupsShown = 0;

  for (const action of actionsByName.values()) {
    const normalized = key(action.name);
    const record = byNameMap.get(normalized);
    const ctx: BuildContext = { byName: byNameMap, dependents, nodes: 0, truncated: false };

    const requires = record === undefined ? [] : requiresChildren(record, 1, new Set([normalized]), ctx);
    const requiredBy = requiredByChildren(action.name, 1, new Set([normalized]), ctx);
    const affected = new Set<string>();
    const critical = new Map<string, string>();
    collectAffected(requiredBy, affected, critical);

    const target: ServiceDependencyTarget = {
      name: record?.name ?? action.name.trim(),
      displayName: record?.displayName ?? action.name.trim(),
      exists: record !== undefined,
      start: record?.start ?? 'Unknown',
      startup: action.startup ?? null,
      delayedStart: action.delayedStart === true,
      stop: action.stop === true,
      risky: action.startup === 'Disabled' || action.stop === true,
      protected: protectedServiceReason(action.name) !== null,
      protectedReason: protectedServiceReason(action.name),
      requires,
      requiredBy,
      affectedCount: affected.size,
      criticalAffected: [...critical.entries()]
        .map(([name, reason]) => ({ name: byNameMap.get(name)?.name ?? name, reason }))
        .sort((a, b) => byName(a.name, b.name)),
      truncated: ctx.truncated,
    };

    if (record === undefined) missingTargets.push(target.name);
    if (ctx.truncated) anyTruncated = true;
    groupsShown += countGroups(requires);
    targets.push(target);
  }

  const warnings: string[] = [];
  if (missingTargets.length > 0) {
    warnings.push(
      `${missingTargets.length} service target(s) are not present in the SCM registry; apply-time capture will refuse them rather than guess.`,
    );
  }
  if (targets.some((target) => target.protected)) {
    warnings.push('One or more targets are protected by policy; the plan is blocked before execution.');
  }
  if (targets.some((target) => target.criticalAffected.length > 0)) {
    warnings.push(
      'Protected services appear in one or more dependent trees; review the red cascade warnings before applying.',
    );
  }
  if (groupsShown > 0) {
    warnings.push(
      `${groupsShown} service-group dependency item(s) are shown as group nodes. They are not individual services and cannot be traversed further.`,
    );
  }
  if (anyTruncated) {
    warnings.push(
      `The dependency map was capped at ${MAX_TREE_NODES} nodes and ${MAX_TREE_DEPTH} levels; it shows the closest relationships only.`,
    );
  }

  return {
    targets,
    servicesRead: byNameMap.size,
    missingTargets,
    truncated: anyTruncated,
    warnings,
  };
}
