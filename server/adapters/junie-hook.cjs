// PreToolUse hook for Junie runs started by Ortak (see junie.js). Junie's batch host fires this
// before every tool call with `{ hook_event_name, tool_name, tool_input, project_path, … }` on
// stdin; printing `{"decision":"deny"}` blocks the call, printing nothing allows it.
//
// This is how Ortak enforces its permission levels on Junie, which otherwise auto-approves
// everything in non-interactive mode:
//   read-only → only the read/search/plan tools below
//   edit      → everything except shell commands
//   full      → Ortak doesn't install the hook at all
// CommonJS on purpose: hooks are plain `node <file>` commands, outside the app's ESM graph.
const LEVEL = process.env.ORTAK_JUNIE_PERMISSION || 'read-only';

// Tool names as the model sees them (verified with junie 26.10: Read, Write, powershell, submit).
const SHELL = /^(powershell|pwsh|bash|sh|zsh|shell|cmd|terminal|run_|exec|process)/i;
const READ_ONLY_OK = /^(read|grep|glob|search|find|list|ls|fetch|web|think|plan|todo|submit|ask|get|view|open)/i;

function decide(name) {
  if (LEVEL === 'full') return null;
  if (SHELL.test(name)) return 'Ortak bu çalışmada komut çalıştırmaya izin vermiyor.';
  if (LEVEL === 'edit') return null;
  // read-only: anything that is not a known read/search/plan tool is refused.
  return READ_ONLY_OK.test(name) ? null : 'Ortak bu çalışmayı salt okunur başlattı: dosya değiştirilemez.';
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let name = '';
  try { name = String(JSON.parse(input).tool_name || ''); } catch { /* unparsable: treat as unknown */ }
  const reason = decide(name);
  // Allow = exit 0 with no output (any non-JSON stdout would be fed to the model as context).
  if (!reason) return;
  // Exit code 2 blocks the tool on its own; the JSON carries the reason to the model. Exiting from
  // the write callback keeps Windows from truncating the pipe before it is flushed.
  process.stdout.write(JSON.stringify({ decision: 'deny', reason }), () => process.exit(2));
});
