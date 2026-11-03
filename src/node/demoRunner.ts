// A scripted stand-in for a real agent. Lets the whole UI and the attention flow be exercised
// without spending tokens or booting Unreal: run with FLEET_DEMO=1, or in the automated tests.
import type { AgentEvent, AgentOptions, AgentSpawn, ImageAttachment } from '../shared/protocol';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DemoRunner {
  private seq = 0;
  private stopped = false;
  private waiters = new Map<string, () => void>();
  running = true;

  constructor(private spawn: AgentSpawn, private emit: (ev: AgentEvent) => void, private askMaster: (question: string) => Promise<string> = async () => '') {}

  private id(p: string) { return `${p}-${this.spawn.id}-${++this.seq}`; }

  start(initial?: { text: string; images?: ImageAttachment[] }) {
    if (initial?.text) this.emit({ k: 'item', item: { kind: 'user', id: this.id('u'), at: Date.now(), text: initial.text } });
    this.emit({ k: 'session', sessionId: `demo-${this.spawn.id}`, model: this.spawn.model });
    void this.script(this.spawn.demo ?? 'clean');
  }

  private async say(text: string) {
    if (this.stopped) return;
    const id = this.id('a');
    this.emit({ k: 'item', item: { kind: 'assistant', id, at: Date.now(), text: '', streaming: true } });
    this.emit({ k: 'activity', status: 'working', bucket: 'thinking' });
    this.emit({ k: 'usage', usage: { context: 40_000 + this.seq * 5000 } });
    this.emit({ k: 'tokens', n: 30_000 });
    for (const word of text.split(/(?<= )/)) {
      if (this.stopped) return;
      this.emit({ k: 'delta', id, text: word });
      this.emit({ k: 'tokens', n: 40 });
      await sleep(25);
    }
    this.emit({ k: 'item', item: { kind: 'assistant', id, at: Date.now(), text } });
  }

  private async useTool(name: string, input: unknown, result: string, status: 'tools' | 'coding' | 'building' | 'testing' = 'tools', ms = 700) {
    if (this.stopped) return;
    const id = this.id('t');
    const at = Date.now();
    this.emit({ k: 'item', item: { kind: 'tool', id, at, name, input, state: 'running' } });
    this.emit({ k: 'activity', status, bucket: status, detail: name });
    await sleep(ms);
    this.emit({ k: 'item', item: { kind: 'tool', id, at, name, input, state: this.stopped ? 'error' : 'done', result, ms: Date.now() - at } });
  }

  private waitFor(id: string) {
    return new Promise<void>((r) => this.waiters.set(id, r));
  }

  private async script(kind: string) {
    await sleep(300);
    await this.say('Looking at how this is set up in the project.');
    this.emit({ k: 'progress', percent: 15 });
    await this.useTool('Read', { file_path: 'Source/Game/Garden/SprinklerComponent.cpp' }, '… 212 lines …');
    this.emit({ k: 'progress', percent: 30 });
    await this.useTool('Edit', { file_path: 'Source/Game/Garden/SprinklerComponent.cpp' }, 'Updated.', 'coding');
    this.emit({ k: 'progress', percent: 50 });
    if (kind === 'long') { await this.keepBusy(); return; }
    if (kind === 'blocked') {
      await this.useTool('mcp__fleet__check_packages', { paths: ['/Game/Garden/BP_Sprinkler'] }, 'Locked: Content/Garden/BP_Sprinkler.uasset');
      await this.say("The sprinkler's timing is in a Blueprint someone else has locked, and nothing else can change it.");
      this.emit({ k: 'blocked', locks: [{ path: 'Content/Garden/BP_Sprinkler.uasset', by: 'sam@example.com', branch: '/main/sam', destination: '/main', status: 'Retained', changeset: '812' }], why: 'The timing is only in this Blueprint.' });
      this.emit({ k: 'turn-end' });
      return;
    }

    if (kind === 'ask') {
      const answer = await this.askMaster('What does ticket GARDEN-12 say about the sprinkler?');
      await this.say(`The master says: ${answer}`);
    }
    if (kind === 'permission') {
      const id = this.id('p');
      this.emit({ k: 'item', item: { kind: 'permission', id, at: Date.now(), tool: 'Bash', input: { command: 'git clean -fdx Intermediate' }, canAlways: true, reason: 'Deletes untracked files.' } });
      this.emit({ k: 'attention', kind: 'permission', text: 'Wants to use Bash', ref: id });
      this.emit({ k: 'activity', status: 'attention', bucket: 'waiting' });
      await this.waitFor(id);
    }
    if (kind === 'question') {
      const id = this.id('q');
      const question = 'Should the sprinkler soak visitors, or only the flowerbeds?';
      this.emit({ k: 'item', item: { kind: 'question', id, at: Date.now(), questions: [{ question, header: 'Sprinkler', options: [{ label: 'Soak visitors', description: 'Leaves them damp for 1.5 seconds.' }, { label: 'Flowerbeds only', description: 'No state change.' }] }] } });
      this.emit({ k: 'attention', kind: 'question', text: question, ref: id });
      this.emit({ k: 'activity', status: 'attention', bucket: 'waiting' });
      await this.waitFor(id);
    }
    await this.useTool('mcp__fleet__ue_build', {}, 'BUILD SUCCEEDED in 41s', 'building', 1200);
    this.emit({ k: 'progress', percent: 70 });
    await this.useTool('mcp__fleet__ue_call', { tool_name: 'StartPIE' }, 'PIE running', 'testing', 900);
    this.emit({ k: 'progress', percent: 90 });

    if (kind === 'testing') {
      await this.say('The sprinkler now only runs during the morning cycle. I tested the timing in PIE, but how the mist looks needs a person.');
      this.emit({ k: 'final', report: {
        summary: 'The greenhouse sprinkler now only runs at dawn, and walking past it no longer sets it off.',
        verified: ['Compiled with no errors', 'Automation test Garden.Sprinkler passes', 'Water events fire only during the morning cycle in PIE'],
        needsTesting: [
          { what: 'Walk past the sprinkler at the last moment', how: 'Open Greenhouse_2 and press Play. Stand still until the sprinkler is one step away, then sidestep.', expect: 'It stays off until dawn and doesn\'t react to you walking past.', why: 'Whether it looks right depends on timing I can\'t judge' },
          { what: 'Standing under it while it runs', how: 'In the same map, set the time to dawn with the console command SetTime 6, then stand under the sprinkler.', expect: 'A light mist falls for about ten seconds, then stops.', why: 'Mist density is a look-and-feel call' },
        ],
        at: Date.now(),
      } });
      this.emit({ k: 'turn-end' });
      return;
    }
    if (kind === 'reply') {
      await this.say('I found two possible causes. Do you want me to fix both, or only the one that shows up at night?');
      this.emit({ k: 'turn-end' });
      return;
    }
    await this.say('Reproduced the crash, fixed the null pointer, and confirmed it no longer happens.');
    this.emit({ k: 'final', report: { summary: 'Fixed the crash when a paper lantern lands after its owner is destroyed.', verified: ['Reproduced the crash in PIE before the fix', 'Same steps no longer crash after the fix'], needsTesting: [], at: Date.now() } });
    this.emit({ k: 'turn-end' });
  }

  private async keepBusy() {
    let percent = 50;
    while (!this.stopped) {
      await this.say('Still working through the remaining call sites. ');
      await this.useTool('Grep', { pattern: 'WaterPlants' }, '14 matches', 'tools', 1500);
      percent = Math.min(95, percent + 5);
      this.emit({ k: 'progress', percent });
    }
  }

  send(text: string, _images?: ImageAttachment[], broadcastId?: string) {
    this.emit({ k: 'item', item: { kind: 'user', id: this.id('u'), at: Date.now(), text, broadcastId } });
    this.emit({ k: 'attention-clear' });
    this.stopped = false;
    void (async () => {
      await this.say(`Got it: "${text.slice(0, 60)}". Taking that into account.`);
      this.emit({ k: 'turn-end' });
    })();
  }
  decide(itemId: string, _d: string) { this.emit({ k: 'attention-clear', ref: itemId }); this.waiters.get(itemId)?.(); this.waiters.delete(itemId); }
  answer(itemId: string, _a: Record<string, string>) { this.emit({ k: 'attention-clear', ref: itemId }); this.waiters.get(itemId)?.(); this.waiters.delete(itemId); }
  async setOptions(_o: AgentOptions) {}
  useCredits(_apiKey: string | null, carryOn?: string) { if (carryOn) this.send(carryOn); }
  async interrupt() { this.stopped = true; this.emit({ k: 'turn-end', interrupted: true }); }
  stop() { this.stopped = true; }
}
