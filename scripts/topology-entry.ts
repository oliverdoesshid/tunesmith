/**
 * Print the CPU topology the affinity planner will use.
 *
 * Game mode pins games to specific logical processors, so a user must be able to audit
 * *why* a particular set was chosen. On a hybrid CPU this is also the quickest way to
 * confirm that the efficiency classes match reality before trusting a profile.
 */
import { detectTopology } from '../src/main/platform/game/topology';

export async function main(): Promise<number> {
  try {
    const topology = await detectTopology({ force: true });

    console.log('');
    console.log('CPU topology');
    console.log(`  logical processors  ${topology.logicalProcessors}`);
    console.log(`  physical cores     ${topology.physicalCores}`);
    console.log(`  hybrid             ${topology.hybrid ? 'yes' : 'no'}`);
    console.log(`  source             ${topology.source}`);
    console.log(`  class ordering     ${topology.higherEfficiencyIsFaster ? 'higher is faster' : 'lower is faster'}`);
    console.log('');

    const rows = topology.efficiencyClasses.map(
      (value, index) => `LP${index} core ${topology.coreIndices[index] ?? index} class ${value}`,
    );
    console.log(rows.join('\n'));
    console.log('');
    return 0;
  } catch (error) {
    console.error('Topology detection failed:', error instanceof Error ? error.message : error);
    return 1;
  }
}
