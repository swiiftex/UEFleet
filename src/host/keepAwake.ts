// Agents on a linked machine run unattended, so it mustn't go to sleep under them.
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';

const ES_CONTINUOUS = 0x80000000;
const ES_SYSTEM_REQUIRED = 0x1;
const ES_DISPLAY_REQUIRED = 0x2;

// Windows only offers this through an API plain Node can't call, so a hidden helper holds the request.
// It waits on this process and exits with it, however that happens, and Windows then lets go.
// On many laptops the screen going off is itself what starts standby, so a laptop keeps its screen on.
function helperScript(parent: number) {
  const desktop = (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0;
  const laptop = (ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED) >>> 0;
  return `
$api = Add-Type -Namespace Fleet -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);' -PassThru
$laptop = [bool](Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue)
$flags = if ($laptop) { [uint32]${laptop} } else { [uint32]${desktop} }
if ($api::SetThreadExecutionState($flags) -eq 0) { exit 1 }
[Console]::Out.WriteLine($(if ($laptop) { 'laptop' } else { 'desktop' }))
[Console]::Out.Flush()
Wait-Process -Id ${parent} -ErrorAction SilentlyContinue
`;
}

// 0 means "do nothing". The value for plugged in and on battery are the only 0x numbers in the output.
export function lidActions(powercfgOutput: string): number[] {
  return [...powercfgOutput.matchAll(/0x([0-9a-f]+)/gi)].map((m) => parseInt(m[1], 16));
}

function closingLidSleeps(): boolean {
  try {
    const out = execFileSync('powercfg', ['/query', 'SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return lidActions(out).some((v) => v !== 0);
  } catch {
    return false;
  }
}

export function keepAwake(log: (...a: unknown[]) => void) {
  if (process.platform !== 'win32') return;
  const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const helper = spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', helperScript(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let holding = false;
  const failed = () => { log(holding ? 'Stopped keeping this machine awake, so it may sleep during a task.' : "Couldn't keep this machine awake, so it may sleep during a task."); };
  helper.on('error', failed);
  helper.on('exit', failed);
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (kind: string) => {
    if (holding) return;
    holding = true;
    if (kind.trim() === 'laptop') {
      log('Keeping this laptop and its screen awake while the host runs.');
      if (closingLidSleeps()) log('Closing the lid will still put it to sleep. To change that: Control Panel > Power Options > Choose what closing the lid does > Do nothing.');
    } else {
      log('Keeping this machine awake while the host runs.');
    }
  });
}
