// Everything that crosses a process or machine boundary. Node logic (master and remote
// host), the hub, and the UI all speak these types.

export type AgentStatus =
  | 'queued' | 'provisioning' | 'working' | 'tools' | 'coding' | 'building' | 'testing'
  | 'waiting-instance' | 'attention' | 'idle' | 'finished' | 'error' | 'stopped';

export type ActivityBucket = 'thinking' | 'coding' | 'tools' | 'building' | 'testing' | 'waiting';
export const BUCKETS: ActivityBucket[] = ['thinking', 'coding', 'tools', 'building', 'testing', 'waiting'];

export type AttentionKind = 'permission' | 'question' | 'reply' | 'crash' | 'testing' | 'error' | 'all-done';

export interface Attention {
  kind: AttentionKind;
  text: string;
  at: number;
  ref?: string; // transcript item that resolves this, when there is one
}

export interface HumanTest {
  what: string;
  how?: string;
  why?: string;
}

export interface FinalReport {
  summary: string;
  verified: string[];
  needsTesting: HumanTest[];
  at: number;
}

export interface QuestionOption { label: string; description?: string }
export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
}

export type TranscriptItem =
  | { kind: 'user'; id: string; at: number; text: string; images?: string[]; broadcastId?: string }
  | { kind: 'assistant'; id: string; at: number; text: string; streaming?: boolean; sub?: boolean }
  | { kind: 'thinking'; id: string; at: number; text: string; streaming?: boolean }
  | { kind: 'tool'; id: string; at: number; name: string; input: unknown; state: 'running' | 'done' | 'error'; result?: string; images?: string[]; ms?: number; sub?: boolean }
  | { kind: 'permission'; id: string; at: number; tool: string; input: unknown; canAlways: boolean; reason?: string; decided?: 'allow' | 'always' | 'deny' }
  | { kind: 'question'; id: string; at: number; questions: Question[]; answers?: Record<string, string> }
  | { kind: 'system'; id: string; at: number; text: string; tone?: 'info' | 'warn' | 'error' }
  | { kind: 'final'; id: string; at: number; report: FinalReport };

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  context: number;
  costUsd: number;
}

// What one agent reports while it runs; the hub reduces these into a card and a transcript.
export type AgentEvent =
  | { k: 'session'; sessionId: string; model?: string }
  | { k: 'item'; item: TranscriptItem }
  | { k: 'delta'; id: string; text: string }
  | { k: 'activity'; status: AgentStatus; bucket?: ActivityBucket | null; detail?: string }
  | { k: 'usage'; usage: Partial<UsageSnapshot> }
  | { k: 'tokens'; n: number }
  | { k: 'attention'; kind: AttentionKind; text: string; ref?: string }
  | { k: 'attention-clear'; ref?: string }
  | { k: 'final'; report: FinalReport }
  | { k: 'turn-end'; isError?: boolean; interrupted?: boolean; text?: string }
  | { k: 'instance'; slot: SlotInfo | null }
  | { k: 'ended'; reason: string };

export type SlotState = 'empty' | 'syncing' | 'cold' | 'queued' | 'booting' | 'ready' | 'pie' | 'building' | 'testing' | 'crashed';
export type InstanceMode = 'offscreen' | 'headless' | 'windowed';

export interface SlotInfo {
  id: string;
  nodeId: string;
  project: string;
  dir: string;
  port: number;
  state: SlotState;
  agentId?: string;
  detail?: string;
  pid?: number;
  mode?: InstanceMode;
  rssMb?: number;
  progress?: number;
}

export interface EngineInfo {
  id: string;
  version: string;
  root: string;
  hasMcp: boolean;
  source: boolean;
}

export interface ProjectInfo {
  name: string;
  file: string;
  dir: string;
  engineAssociation?: string;
  engineVersion?: string;
  received?: boolean; // sent here by the master, rather than the user's own workspace
}

export interface NodeInfo {
  id: string;
  name: string;
  role: 'master' | 'remote';
  platform: string;
  cpuModel: string;
  threads: number;
  ramGb: number;
  vramGb: number;
  maxInstances: number;
  engines: EngineInfo[];
  unusableEngines?: { root: string; reason: string }[];
  projects: ProjectInfo[];
  claudePath: string | null;
  version: string;
}

export interface NodeStats {
  cpu: number;
  ramUsedGb: number;
  at: number;
}

export interface AgentSpawn {
  id: string;
  prompt: string;
  images?: ImageAttachment[];
  title: string;
  project?: ProjectRef | null;
  model: string;
  effort: string;
  permissionMode: string;
  resumeSessionId?: string;
  instanceMode: InstanceMode;
  demo?: string;
}

export interface ProjectRef {
  name: string;
  file: string;   // on the node that will run the agent
  engineRoot?: string;
}

export interface ImageAttachment { mediaType: string; data: string }

export type ChangeKind = 'modified' | 'added' | 'deleted';
export interface ChangedFile { path: string; kind: ChangeKind; binary: boolean; size?: number; usuallySkipped?: boolean }
export interface ApplyResult {
  applied: string[];
  merged: string[];
  conflicts: { path: string; reason: string }[];
}

// Machine link frames. A request gets exactly one response; events are fire and forget.
export type LinkFrame =
  | { f: 'hello'; hostId: string; key: string; info: NodeInfo; lastSeq?: Record<string, number> }
  | { f: 'pair'; code: string; hostId: string; info: NodeInfo }
  | { f: 'welcome'; key?: string; masterName: string; lastSeq: Record<string, number> }
  | { f: 'denied'; reason: string }
  | { f: 'req'; id: number; method: string; params: unknown }
  | { f: 'res'; id: number; ok: boolean; result?: unknown; error?: string }
  | { f: 'ev'; ev: NodeEvent }
  | { f: 'ping' }
  | { f: 'pong' };

export type NodeEvent =
  | { t: 'agent'; agentId: string; seq: number; ev: AgentEvent }
  | { t: 'slots'; slots: SlotInfo[] }
  | { t: 'stats'; stats: NodeStats }
  | { t: 'info'; info: NodeInfo };

// ---- Hub <-> UI ----

export interface AgentCard {
  id: string;
  index: number;
  title: string;
  nodeId: string;
  project: string | null;
  cwd?: string;
  model: string;
  effort: string;
  permissionMode: string;
  instanceMode: InstanceMode;
  status: AgentStatus;
  detail?: string;
  attention: Attention | null;
  lastText: string;
  lastTextAt: number;
  lastPrompt: string;
  lastPromptAt: number;
  createdAt: number;
  sessionMs: number;
  runningSince: number | null;
  usage: UsageSnapshot;
  tokens: number;
  tps: number;
  spark: number[];
  buckets: Record<ActivityBucket, number>;
  slot: SlotInfo | null;
  final: FinalReport | null;
  sessionId?: string;
  archived?: boolean;
}

export interface BroadcastReply { agentId: string; text: string; at: number }
export interface Broadcast {
  id: string;
  at: number;
  text: string;
  targets: string[];
  replies: Record<string, BroadcastReply>;
}

export interface MachineView {
  info: NodeInfo;
  online: boolean;
  stats: NodeStats | null;
  slots: SlotInfo[];
  lastSeen: number;
}

export interface FleetSnapshot {
  cards: AgentCard[];
  machines: MachineView[];
  broadcasts: Broadcast[];
  pairing: { code: string; port: number; addresses: string[] } | null;
  testList: { agentId: string; title: string; test: HumanTest; done: boolean; key: string }[];
  defaults: NewTaskDefaults;
  hostAppPath: string | null;
  demo: boolean;
}

export interface NewTaskDefaults {
  model: string;
  effort: string;
  permissionMode: string;
  instanceMode: InstanceMode;
  projectFile: string | null;
}

export interface NewTask {
  prompt: string;
  images?: ImageAttachment[];
  projectFile: string | null;
  nodeId: string | 'auto';
  model: string;
  effort: string;
  permissionMode: string;
  instanceMode: InstanceMode;
  demo?: string;
}

export type HubEvent =
  | { e: 'snapshot'; snapshot: FleetSnapshot }
  | { e: 'cards'; cards: AgentCard[] }
  | { e: 'machines'; machines: MachineView[] }
  | { e: 'broadcasts'; broadcasts: Broadcast[] }
  | { e: 'tests'; testList: FleetSnapshot['testList'] }
  | { e: 'transcript'; agentId: string; items: TranscriptItem[]; deltas: { id: string; text: string }[] }
  | { e: 'all-done'; count: number };

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const PERMISSION_MODES = [
  { id: 'default', label: 'Ask for edits and commands' },
  { id: 'acceptEdits', label: 'Accept edits, ask for commands' },
  { id: 'auto', label: 'Auto (classifier decides)' },
  { id: 'bypassPermissions', label: 'Bypass all prompts' },
];
export const INSTANCE_MODES: { id: InstanceMode; label: string; hint: string }[] = [
  { id: 'offscreen', label: 'Offscreen', hint: 'no window, renders' },
  { id: 'headless', label: 'Headless', hint: 'lightest, no rendering' },
  { id: 'windowed', label: 'Windowed', hint: 'normal editor window' },
];
export const modelLabel = (id: string) => MODELS.find((m) => m.id === id)?.label ?? id;
