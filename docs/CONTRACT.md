# Ortak — Architecture Contract

Ortak is a local, Claude-Code-like coding app that drives several *agent CLIs* the user
already has logged in on this machine, so their own subscriptions/limits are used:

| Agent id      | Backend                                   | How we drive it                              |
|---------------|-------------------------------------------|----------------------------------------------|
| `claude`      | Claude Code 2.1.x (`claude.exe`)          | `claude -p --output-format stream-json`      |
| `codex`       | OpenAI Codex CLI 0.159 (`codex.cmd`)      | `codex exec --json`                          |
| `antigravity` | Google Antigravity (running desktop app)  | `~/.gemini/antigravity/bin/agentapi.bat`     |
| `gemini`      | gemini.google.com in Ortak's own Chrome   | DevTools protocol (`geminiweb.js`, `cdp.js`) |
| `opencode`    | OpenCode 2.x (`opencode.exe`)             | `opencode run --standalone --format json` (`opencode-core.js`) |
| `kilo`        | Kilo Code CLI 7.x (OpenCode fork)         | `kilo run --format json` (`opencode-core.js`) |
| `copilot`     | GitHub Copilot CLI 1.0.x (`copilot.exe`)  | `copilot --output-format json`; account data via `copilot --headless --stdio` |
| `junie`       | JetBrains Junie CLI                       | `junie --output-format json-stream`; sign-in probe over ACP (`acp.js`) |
| `evren`       | EVREN LLM Gateway (OpenAI-compatible HTTP) | `POST /v1/chat/completions` stream; history kept in `data/evren/<sessionId>.json`, key in `data/evren.json` |
| `openrouter`  | OpenRouter Free (OpenAI-compatible HTTP)   | `POST /v1/chat/completions` stream; history kept in `data/openrouter/<sessionId>.json`, key in `data/openrouter.json` (free models only) |
| `groq`        | Groq Cloud (LPU ultra-fast OpenAI-compatible) | `POST /v1/chat/completions` stream; history kept in `data/groq/<sessionId>.json`, key in `data/groq.json` |
| `mock`        | Fake agent for tests (only with `--mock`) | in-process                                   |

Stack: **Node 24, ESM, zero npm dependencies.** Backend = `node:http` + Server-Sent Events.
Frontend = static vanilla JS modules in `web/` (no build step). UI language: **Turkish**.
Port: `4747` (env `ORTAK_PORT`). Platform: Windows 10 first (must work there), POSIX-friendly.

```
server/
  index.js                HTTP server, static files, REST + SSE         (owner: core)
  runs.js                 Run store: create, append events, persist     (owner: core)
  limits.js               Aggregates adapter.getLimits() with caching   (owner: core)
  errors.js               errorKind(): limit / transient / auth / session / other
  git.js                  worktree/diff/apply helpers                   (owner: core)
  orchestrator/
    index.js              mode dispatch                                 (owner: core)
    chat.js               single agent conversation                     (owner: core)
    brainstorm.js         multi-agent discussion + synthesis            (owner: core)
    parallel.js           same task, N agents, N worktrees, diffs       (owner: core)
    team.js               planner -> workers -> reviewer pipeline       (owner: core)
    lead.js               lead delegates to sub-agents, reviews, loops  (owner: core)
    textcoder.js          READ / SEARCH-REPLACE hands for edit:false agents (owner: core)
  adapters/
    base.js               shared helpers (which, spawnCli, runJsonl)    (owner: lead, read-only for others)
    index.js              registry                                      (owner: lead)
    mock.js               fake adapter                                  (owner: lead)
    claude.js             (owner: adapters-cc)
    codex.js              (owner: adapters-cc)
    antigravity.js        (owner: adapters-agy)
web/
  index.html, app.js, styles.css, + any modules under web/js/       (owner: frontend)
data/                     runtime storage (gitignored)
```

**Only edit files you own.** If you need a change in a file you don't own, write it in your
final report instead.

---

## 1. Adapter interface

Each adapter module `export default` an object:

```js
{
  id: 'claude',                 // stable id
  name: 'Claude Code',          // display name
  capabilities: {
    edit: true,                 // can modify files in an arbitrary `cwd`
    resume: true,               // supports continuing a session via sessionId
    streaming: true,            // emits text-delta events
    cwd: true,                  // honours the `cwd` option
    sandbox: true,              // permission levels are enforced by the CLI itself (false = only guarded; UI warns)
    localProcess: true,         // each turn starts a local CLI process: counts toward the maxConcurrent gate
    editShell: false,           // optional: in 'edit' mode the agent cannot run commands (Claude Code on Windows); lead mode tells the lead
  },

  // Optional: launch the agent's desktop app. POST /api/agents/:id/start. /api/agents reports `startable`.
  async start() -> { ok: boolean, already?: boolean, reason?: string },

  // Optional: start the CLI's own sign-in (terminal window or browser). POST /api/agents/:id/login.
  // /api/agents reports `loginable` and detect()'s `login` hint. Ortak never sees credentials.
  login() -> { ok: boolean, pending?: boolean, message?: string, reason?: string },

  // Fast check (<5s). Never throws. `sleeping`: usable, but its app/window is closed to save
  // resources and the first turn opens it (UI shows "uykuda").
  // `login`: { required: true } = unusable until signed in (UI: "Giriş yap"); { optional: true } = signing in
  // only unlocks more models (UI: "Hesap bağla").
  async detect() -> { available: boolean, sleeping?: boolean, version?: string, reason?: string /* Turkish, shown in UI */,
                      login?: { required?: boolean, optional?: boolean, label?: string, hint?: string } },

  // Models the user can choose. First item or `default: true` = default.
  // `disabled: true` = exists but this account can't use it (shown locked in the UI, rejected by the
  // server); `note` = why, in Turkish (e.g. "Google AI Ultra planı gerekiyor").
  // `group` = optgroup in the picker (long catalogs: "Ücretsiz", "Anthropic", …); `free` = no account needed.
  async listModels() -> [{ id: string, label: string, default?: boolean, disabled?: boolean, note?: string, group?: string, free?: boolean }],

  // Remaining quota / usage. May return null if unknown. Never throws.
  async getLimits() -> null | {
    items: [{ label: string, usedPercent?: number /*0-100*/, resetsAt?: string /*ISO*/, text?: string }],
    note?: string,
  },

  // Run one turn. Resolves when the agent turn is finished.
  async run(opts) -> { text: string, sessionId?: string, usage?: Usage }
}
```

`run(opts)`:

| field        | type                                   | meaning |
|--------------|----------------------------------------|---------|
| `prompt`     | string                                 | user/orchestrator message for this turn |
| `cwd`        | string (abs path)                      | working directory / project root |
| `model`      | string \| undefined                    | model id from `listModels()`; undefined = adapter default |
| `sessionId`  | string \| undefined                    | continue this session if `capabilities.resume` |
| `permission` | `'read-only' \| 'edit' \| 'full'`      | see below |
| `system`     | string \| undefined                    | extra instructions appended to the agent's system prompt (or prepended to prompt if unsupported) |
| `signal`     | AbortSignal                            | abort => kill the process tree, reject with `AbortError` |
| `onEvent`    | (AdapterEvent) => void                 | stream of normalized events |

Permission mapping (adapters must implement it as faithfully as the CLI allows):
- `read-only` — may read files, must not write or run mutating commands (brainstorm, planning, review).
- `edit` — may edit files inside `cwd`; shell commands allowed only if the CLI can sandbox them to `cwd`.
- `full` — no prompts, no sandbox (UI shows a red warning).

The CLIs are non-interactive here: a permission prompt can never be answered, so map to modes
that auto-allow or auto-deny, never to modes that would block waiting for input.

Errors: on non-zero exit / CLI error, emit `{type:'error'}` then **reject** with an `Error` whose
message is short, Turkish where possible, and actionable (e.g. "Codex oturumu yok: `codex login` çalıştırın").

### AdapterEvent (normalized)

```js
{ type: 'text-delta', text }                       // incremental assistant text
{ type: 'message', text }                          // a complete assistant message (replaces deltas of the current message)
{ type: 'thinking', text }                         // optional reasoning summary
{ type: 'tool-start', id, name, input }            // input: short string or object (keep < 4KB)
{ type: 'tool-end', id, output, isError }          // output: string, truncated to ~4KB
{ type: 'status', text }                           // e.g. "Model yükleniyor", "Antigravity bekleniyor"
{ type: 'usage', inputTokens, outputTokens, costUsd? }
{ type: 'error', message }
{ type: 'done', text, sessionId }                  // final; emitted right before run() resolves
```

`Usage = { inputTokens?: number, outputTokens?: number, costUsd?: number }`.

Notes:
- Model id `default` means "let the CLI use its own default model" (no model flag).
- Adapters with `capabilities.streaming: false` (Codex) never send `text-delta`; they send one
  `message` per assistant message. The UI must render `message` without prior deltas.

Helpers in `server/adapters/base.js` (use them; Windows `.cmd` shims and process-tree killing
are already handled there):
- `which(cmd)` → absolute path or null
- `spawnCli(file, args, opts)` → ChildProcess
- `runJsonl({ file, args, cwd, env, stdin, signal, onJson, onLine, onStderr })` → `Promise<{ code, stderr }>`
- `cleanEnv(extra)` → copy of `process.env` without Claude Code nesting vars
- `realCwd(dir)` → long canonical path (expands Windows 8.3 short names like `ADMINI~1`)
- `truncate(str, n)`
- `AbortError`

**Rule:** never pass user text as a command-line argument to a `.cmd`/`.bat` shim on Windows
(cmd.exe will mangle `% ^ & | " < >`). Send prompts on **stdin** whenever the CLI supports it.

**Rule:** never read, print, copy or transmit credential files (`~/.codex/auth.json`,
`~/.claude/.credentials.json`, OAuth tokens). Use what the CLIs themselves expose, local logs,
and local servers of apps the user is running.

---

## 2. Runs & event envelope

Everything the user starts is a **run**. A run has a `mode`, a config, and an append-only list
of events. Events are persisted to `data/runs/<runId>.jsonl`, meta to `data/runs/<runId>.json`.

Envelope (what SSE sends, one JSON per `data:` line):

```js
{ seq: number, ts: number /*ms*/, runId: string, kind: string, ...payload }
```

Kinds:

```js
{ kind: 'run',   status: 'running'|'waiting'|'done'|'error'|'cancelled', error? }   // 'waiting' = idle, accepts follow-up
{ kind: 'lane',  lane, agentId, model, role, title }    // declares a column/participant. lane = unique string id, e.g. "claude", "codex#2", "moderator"
{ kind: 'phase', id, title }                            // section separator: "Tur 1", "Plan", "Uygulama", "İnceleme", "Sentez"
{ kind: 'user',  text, lane? }                          // user message (lane omitted = broadcast to all)
{ kind: 'agent', lane, event: AdapterEvent }            // everything an adapter emitted
{ kind: 'diff',  lane?, diff, stats: { files, additions, deletions } }  // parallel/team modes; lead: whole step, no lane
{ kind: 'note',  text, level?: 'info'|'warn'|'error' } // orchestrator commentary
{ kind: 'result', lane?, text }                         // final answer of the run (synthesis / review summary)
```

Run meta (`GET /api/runs/:id` → `{ meta, events }`):

```js
{ id, mode, title, cwd, createdAt, updatedAt, status, config, lanes: [{lane, agentId, model, role, title, sessionId?}] }
```

---

## 3. HTTP API

All JSON. Errors → `{ error: "Türkçe mesaj" }` with 4xx/5xx.

| method & path                    | body / query | response |
|----------------------------------|--------------|----------|
| `GET  /api/agents`               | | `[{ id, name, available, version, reason, capabilities, models }]` (detect cached 60s; `?refresh=1`) |
| `GET  /api/limits`               | | `{ [agentId]: { ok, items, note, updatedAt, error? } }` (cached 60s; `?refresh=1`) |
| `GET  /api/runs`                 | | `[meta]` newest first |
| `POST /api/agents/:id/login`     | | `{ ok, pending?, message? }` opens the agent's own sign-in |
| `POST /api/runs`                 | RunConfig | `{ runId }` |
| `GET  /api/runs/:id`             | | `{ meta, events }` |
| `GET  /api/runs/:id/events`      | `?since=<seq>` | SSE stream: replays events with seq > since, then live; `: ping` every 15s |
| `POST /api/runs/:id/message`     | `{ text, lane? }` | `{ ok }` follow-up turn (chat: the agent; brainstorm: another round with user input) |
| `POST /api/runs/:id/cancel`      | | `{ ok }` |
| `POST /api/runs/:id/apply`       | `{ lane }` | `{ ok, output }` apply that lane's diff to the real `cwd` (parallel mode) |
| `DELETE /api/runs/:id`           | | `{ ok }` (also removes worktrees) |
| `GET  /api/fs/check`             | `?path=` | `{ exists, isDir, isGit, branch? }` |
| `GET  /api/recent`               | | `{ cwds: [string] }` recently used project folders |
| `GET/PUT /api/settings`          | partial settings | `{ settings, defaults, gate }` performance settings (server/settings.js), saved in data/settings.json |

Static: `/` → `web/index.html`, other paths → files under `web/`.

### RunConfig

`surface: 'chat'` (Sohbet arayüzü) is allowed for `chat`, `group` and `brainstorm`: no `cwd` (runs work in
`data/sohbet`, not added to recents), chat is always `read-only` and accepts agents without `edit`, and every
turn's system prompt gets `CHAT_SURFACE` (plain conversation, no file/shell tools). It is stored as
`config.surface`; the UI lists such runs under *Sohbetler*. Omitted = the Kod surface (everything below).

```js
// Tek ajanla sohbet / kodlama (Claude Code gibi)
{ mode: 'chat', cwd, prompt, agent: { agentId, model }, permission }

// Grup sohbeti: ajanlar tek bir ortak konuşmada sırayla konuşur (salt okunur). Her konuşmacı önceki
// her şeyi görür; @handle (lane id, '#' olmadan: claude, codex2) ile anılan ajan sıradaki konuşmacı
// olur, yoksa sıra döner; ama kimse bir turdan uzun bekletilmez (iki ajan birbirini anıp durursa
// sıra diğerlerine geçer). Her katılımcının son mesajı [UZLAŞI] içerince ya da rounds × katılımcı
// sayısı kadar konuşma olunca durur ('waiting'). Takip mesajı yeni bir konuşma turu başlatır (lane = ilk konuşmacı).
{ mode: 'group', cwd, prompt, participants: [{ agentId, model }] /* en az 2 */, rounds: 2 }

// Beyin fırtınası: herkes bağımsız cevaplar, sonra birbirini görüp eleştirir, moderatör sentezler
{ mode: 'brainstorm', cwd, prompt, participants: [{ agentId, model }], rounds: 2, moderator: { agentId, model } }

// Paralel: aynı görevi N ajan kendi git worktree'sinde yapar, diff'ler karşılaştırılır, kazanan uygulanır
{ mode: 'parallel', cwd, prompt, participants: [{ agentId, model }], permission }

// Takım: planlayıcı görevi böler -> çalışanlar sırayla uygular -> denetçi inceler (1 düzeltme turu)
{ mode: 'team', cwd, prompt, planner: { agentId, model }, workers: [{ agentId, model }], reviewer: { agentId, model }, permission }

// Yönetici: lane 'lead' (salt okunur) bir görev grafiği verir
//   {"tasks":[{"id":"t1","agent":"<handle>","task":"…","files":["…"],"after":["t0"]}],"done":false}  |  {"tasks":[],"done":true,"summary":"…"}
// Bir görev, after'daki görevler bitince ve ajanı boşken başlar (ajan başına aynı anda bir görev);
// bağımsız görevler paralel. Başarısız görevin after-bağımlıları çalıştırılmaz. Yönetici, hiçbir görev
// sürmüyorken ya da bir görev başarısız olunca (diğerleri sürerken) raporlar + son denetimden beri diff ile
// denetler; yeni görevleri hemen grafiğe eklenir. Handle'lar model adından türetilir (sonnet, haiku,
// argon, sol, flash…), state.handles'ta
// saklanır. edit:false alt ajanlar textcoder.js ile çalışır (READ: yol / FILE + SEARCH/REPLACE; Ortak uygular).
// steps = en fazla denetim: 1–12 (varsayılan 8), workers en fazla 8. Bitince 'waiting'; takip mesajı yöneticiye gider,
// lane = bir alt ajan ise o ajan doğrudan yapar. Yönetici limit/geçici/oturum hatası verirse çalışma 'waiting' ile durur;
// state.unseen (görmediği raporlar), state.open (bitmeyen görevler), state.interrupted kaydedilir ve sonraki mesaj
// bunlarla 'kaldığı yerden' devam eder. ctx.turn geçici hataları (çıktı yoksa) 20 sn / 60 sn sonra yeniden dener
// ({type:'status', retry:true} olayı); limit/ağ/giriş hatalarında oturum (sessionId) asla silinmez.
{ mode: 'lead', cwd, prompt, lead: { agentId, model }, workers: [{ agentId, model }], steps: 8, permission }
```

The same agent may appear more than once (e.g. two Claude models); lanes are made unique as
`agentId`, `agentId#2`, …

Agents whose `capabilities.edit` is false may only be used in read-only roles (brainstorm
participant/moderator, planner, reviewer) — and as lead-mode workers, where Ortak edits for them. The server must reject other placements with a
Turkish error.
