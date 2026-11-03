// Decides which machine a new task runs on. Work goes to another PC when one is free enough, which
// keeps the master responsive for the person using it. It stays here when nothing else is.
import { resolveEngine } from '../node/machine';
import type { MachineView, ProjectInfo } from '../shared/protocol';

const LOW_CPU_PERCENT = 60;
const BUSY_CPU_PERCENT = 90;
// A running editor uses about 10 GB, so this leaves room for one plus a build.
const FREE_RAM_FOR_A_TASK_GB = 12;

export interface Placement { nodeId: string; reason: string }

const freeRamGb = (m: MachineView) => (m.stats ? m.info.ramGb - m.stats.ramUsedGb : 0);
const describe = (m: MachineView) => (m.stats ? `CPU ${m.stats.cpu}%, ${freeRamGb(m)} GB free` : 'no readings yet');

function hasCopy(m: MachineView, project: ProjectInfo | null) {
  return !project || m.info.role === 'master' || m.info.projects.some((p) => p.name.toLowerCase() === project.name.toLowerCase());
}

function canRun(m: MachineView, project: ProjectInfo | null) {
  if (!m.online || !m.info.claudePath) return false;
  return !project || !!resolveEngine(project, m.info.engines, undefined, project.engineVersion);
}

// CPU readings lag, so tasks just placed have to count, or a burst would all go to one machine.
function load(m: MachineView, agents: number) {
  return Math.max(m.stats?.cpu ?? 100, m.stats ? (100 * m.stats.ramUsedGb) / m.info.ramGb : 100, (100 * agents) / Math.max(1, m.info.maxInstances));
}

export function placeTask(machines: MachineView[], running: (nodeId: string) => number, project: ProjectInfo | null): Placement {
  const master = machines.find((m) => m.info.role === 'master');
  const usable = machines.filter((m) => canRun(m, project));
  const isFree = (m: MachineView) => !!m.stats && m.stats.cpu < LOW_CPU_PERCENT && freeRamGb(m) >= FREE_RAM_FOR_A_TASK_GB && running(m.info.id) < m.info.maxInstances;
  const byLoad = (list: MachineView[]) => [...list].sort((a, b) => load(a, running(a.info.id)) - load(b, running(b.info.id)));
  const others = usable.filter((m) => m !== master);

  const free = byLoad(others.filter((m) => isFree(m) && hasCopy(m, project)))[0];
  if (free) return { nodeId: free.info.id, reason: `${free.info.name} is free (${describe(free)}).` };

  const masterUsable = !!master && usable.includes(master);
  const masterBusy = !master?.stats || master.stats.cpu >= BUSY_CPU_PERCENT || freeRamGb(master) < FREE_RAM_FOR_A_TASK_GB;
  const why = others.length ? `No other machine is free enough (${others.map((m) => `${m.info.name}: ${describe(m)}`).join('; ')})` : 'No other machine can run it';
  if (masterUsable && !masterBusy) return { nodeId: master.info.id, reason: `${why}, so it stays on ${master.info.name}.` };

  // Sending a project takes a while, but it beats piling onto a machine that's already out of room.
  const freeWithoutCopy = byLoad(others.filter(isFree))[0];
  if (freeWithoutCopy) return { nodeId: freeWithoutCopy.info.id, reason: `${master?.info.name ?? 'The master'} is busy and ${freeWithoutCopy.info.name} is free (${describe(freeWithoutCopy)}), though it doesn't have the project yet.` };

  const least = byLoad(usable)[0] ?? master;
  return { nodeId: least?.info.id ?? 'master', reason: least ? `Every machine is busy, and ${least.info.name} is the least busy (${describe(least)}).` : 'No machine is connected.' };
}
