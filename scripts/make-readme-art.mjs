// README'deki animasyonlu sahneleri üretir: node scripts/make-readme-art.mjs → docs/media/*.svg
// GitHub README'de JavaScript çalışmaz; SVG içindeki CSS/SMIL animasyonları <img> olarak da oynar.
// Her sahnenin tek bir süresi (D) var; tüm öğeler aynı döngüde zamanlanır, böylece sahne video gibi baştan başlar.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'media');
mkdirSync(OUT, { recursive: true });

const SANS = `'Segoe UI',system-ui,-apple-system,'Helvetica Neue',Arial,sans-serif`;
const MONO = `ui-monospace,'Cascadia Code',Consolas,'SF Mono',Menlo,monospace`;
const C = {
  bg: '#0d1117', panel: '#161b22', line: '#30363d', soft: '#21262d', text: '#e6edf3', muted: '#8b949e',
  green: '#3fb950', red: '#f85149', blue: '#58a6ff', yellow: '#d29922',
  claude: '#d97757', codex: '#10a37f', gemini: '#4f8df9', ag: '#a371f7', copilot: '#e6edf3',
  opencode: '#e3b341', kilo: '#f0883e', junie: '#21d789', evren: '#ff7b72', groq: '#f55036', openrouter: '#94a3b8',
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Yaklaşık metin genişliği (balonları boyutlamak için).
const sansW = (s, size) => s.length * size * 0.53;
const monoW = (s, size) => s.length * size * 0.61;

class Scene {
  constructor(D) { this.D = D; this.css = []; this.n = 0; }
  p(t) { return `${Math.max(0, Math.min(100, (t / this.D) * 100)).toFixed(2)}%`; }
  #id() { return `k${this.n++}`; }
  #rule(id, frames, extra = '') {
    this.css.push(`@keyframes ${id}{${frames}}.${id}{animation:${id} ${this.D}s infinite both${extra}}`);
    return `class="${id}"`;
  }
  /** t anında belirir (hafif kayarak), `until`a kadar kalır. */
  show(t, { until = this.D - 0.5, dy = 6 } = {}) {
    const q = this.p.bind(this);
    return this.#rule(this.#id(),
      `0%,${q(t)}{opacity:0;transform:translateY(${dy}px)}${q(t + 0.35)},${q(until)}{opacity:1;transform:none}${q(until + 0.3)},100%{opacity:0;transform:none}`);
  }
  /** Daktilo: metnin üstündeki örtüyü t..t+dur arasında sağa kaydırır. */
  type(t, dur, width, steps) {
    const q = this.p.bind(this);
    return this.#rule(this.#id(),
      `0%{transform:translateX(0)}${q(t)}{transform:translateX(0);animation-timing-function:steps(${steps},end)}${q(t + dur)},${q(this.D - 0.01)}{transform:translateX(${width}px)}100%{transform:translateX(0)}`);
  }
  /** İlerleme çubuğu t..t+dur arasında soldan dolar. */
  grow(t, dur) {
    const q = this.p.bind(this);
    return this.#rule(this.#id(),
      `0%,${q(t)}{transform:scaleX(0)}${q(t + dur)},${q(this.D - 0.5)}{transform:scaleX(1)}100%{transform:scaleX(0)}`,
      ';transform-origin:left;transform-box:fill-box');
  }
  /** [t, x, y] noktaları arasında hareket (fare imleci). */
  move(points) {
    const q = this.p.bind(this);
    const frames = points.map(([t, x, y]) => `${q(t)}{transform:translate(${x}px,${y}px)}`).join('');
    const [, x0, y0] = points[0];
    return this.#rule(this.#id(), `0%{transform:translate(${x0}px,${y0}px)}${frames}100%{transform:translate(${x0}px,${y0}px)}`,
      ';animation-timing-function:ease-in-out');
  }
  /** t anında kısa bir "tıklama" halkası. */
  ripple(t) {
    const q = this.p.bind(this);
    return this.#rule(this.#id(),
      `0%,${q(t)}{opacity:0;transform:scale(.3)}${q(t + 0.05)}{opacity:.9;transform:scale(.4)}${q(t + 0.6)},100%{opacity:0;transform:scale(1.6)}`,
      ';transform-origin:center;transform-box:fill-box');
  }
}

const BASE = `text{font-family:${SANS}}.mono{font-family:${MONO}}.muted{fill:${C.muted}}
.flow{stroke-dasharray:5 7;animation:flow 1.1s linear infinite}@keyframes flow{to{stroke-dashoffset:-24}}
.blink{animation:blink 1s steps(1) infinite}@keyframes blink{50%{opacity:0}}
.spin{animation:spin 1s linear infinite;transform-origin:center;transform-box:fill-box}@keyframes spin{to{transform:rotate(360deg)}}
.dots circle{animation:dot 1.2s infinite}.dots circle:nth-child(2){animation-delay:.2s}.dots circle:nth-child(3){animation-delay:.4s}
@keyframes dot{0%,60%,100%{opacity:.25}30%{opacity:1}}`;

function svg(w, h, label, body, scene, { chrome = true, title = '' } = {}) {
  const head = chrome ? `
<circle cx="22" cy="22" r="6" fill="#ff5f57"/><circle cx="42" cy="22" r="6" fill="#febc2e"/><circle cx="62" cy="22" r="6" fill="#28c840"/>
<text x="${w / 2}" y="27" text-anchor="middle" font-size="13" class="muted">${esc(title)}</text>
<line x1="0" y1="44" x2="${w}" y2="44" stroke="${C.soft}"/>` : '';
  // Animasyon yardımcıları da class="..." döndürür; aynı etikette iki class olursa birleştir (XML'de geçersiz).
  const merge = (s) => { let prev; do { prev = s; s = s.replace(/class="([^"]*)"([^<>]*?) class="([^"]*)"/g, 'class="$1 $3"$2'); } while (s !== prev); return s; };
  body = merge(body);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">
<title>${esc(label)}</title>
<style>${BASE}${scene ? scene.css.join('') : ''}</style>
<defs>
<linearGradient id="argon" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f8df9"/><stop offset="1" stop-color="#a371f7"/></linearGradient>
<linearGradient id="brand" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffa657"/><stop offset=".5" stop-color="#f778ba"/><stop offset="1" stop-color="#a371f7"/></linearGradient>
<radialGradient id="glow"><stop offset="0" stop-color="#a371f7" stop-opacity=".35"/><stop offset="1" stop-color="#a371f7" stop-opacity="0"/></radialGradient>
</defs>
<rect width="${w}" height="${h}" rx="14" fill="${C.bg}"/>
<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="14" fill="none" stroke="${C.line}"/>${head}
<g fill="${C.text}">${body}</g>
</svg>
`;
}

const avatar = (x, y, color, letter, r = 13) =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}"/><text x="${x}" y="${y + 4.5}" text-anchor="middle" font-size="${r - 1}" font-weight="700" fill="${C.bg}">${esc(letter)}</text>`;

// ---------------------------------------------------------------- hero
function hero() {
  const W = 960, H = 340, hx = 700, hy = 172, rx = 195, ry = 125;
  const agents = [
    ['Claude Code', C.claude], ['Codex', C.codex], ['Gemini', C.gemini], ['Antigravity', C.ag], ['Copilot', C.copilot],
    ['OpenCode', C.opencode], ['Kilo', C.kilo], ['Junie', C.junie], ['EVREN', C.evren], ['Groq', C.groq], ['OpenRouter', C.openrouter],
  ];
  const N = agents.length, s = new Scene(N);
  let lines = '', nodes = '', packets = '';
  agents.forEach(([name, color], i) => {
    const a = -Math.PI / 2 + (i / agents.length) * Math.PI * 2;
    const x = hx + Math.cos(a) * rx, y = hy + Math.sin(a) * ry;
    const pw = sansW(name, 12) + 26;
    lines += `<path d="M${hx} ${hy} L${x.toFixed(1)} ${y.toFixed(1)}" stroke="${color}" stroke-opacity=".45" stroke-width="1.5" fill="none" class="flow"/>`;
    const k0 = ((i + 0.05) / N).toFixed(3), k1 = ((i + 0.95) / N).toFixed(3);
    packets += `<circle r="4" fill="${color}"><animateMotion dur="${N}s" repeatCount="indefinite" path="M${hx} ${hy} L${x.toFixed(1)} ${y.toFixed(1)}" keyPoints="0;0;1;1" keyTimes="0;${k0};${k1};1" calcMode="linear"/><animate attributeName="opacity" dur="${N}s" repeatCount="indefinite" values="0;1;0" keyTimes="0;${k0};${k1}" calcMode="discrete"/></circle>`;
    nodes += `<g transform="translate(${(x - pw / 2).toFixed(1)} ${(y - 14).toFixed(1)})">
<rect width="${pw.toFixed(1)}" height="28" rx="14" fill="${C.panel}" stroke="${color}" stroke-opacity=".7"/>
<rect width="${pw.toFixed(1)}" height="28" rx="14" fill="${color}" fill-opacity=".22" ${s.show(i + 0.8, { until: i + 1.6, dy: 0 })}/>
<circle cx="14" cy="14" r="4" fill="${color}"/><text x="24" y="18.5" font-size="12">${esc(name)}</text></g>`;
  });
  const body = `
<circle cx="${hx}" cy="${hy}" r="150" fill="url(#glow)"/>
${lines}${packets}
<g transform="translate(${hx - 46} ${hy - 46})"><rect width="92" height="92" rx="22" fill="${C.panel}" stroke="url(#brand)" stroke-width="2"/>
<text x="46" y="55" text-anchor="middle" font-size="22" font-weight="800" fill="url(#brand)">Ortak</text></g>
${nodes}
<text x="48" y="140" font-size="68" font-weight="800" fill="url(#brand)">Ortak</text>
<text x="50" y="186" font-size="21">Bilgisayarındaki yapay zekâ ajanları</text>
<text x="50" y="214" font-size="21">tek masada, <tspan fill="#f778ba" font-weight="700">birlikte</tspan> çalışır.</text>
<text x="50" y="256" font-size="13.5" class="muted">Kendi aboneliklerin · tek arayüz · yerel ve açık kaynak</text>
<g transform="translate(50 276)"><rect width="246" height="30" rx="8" fill="${C.panel}" stroke="${C.line}"/>
<text x="14" y="20" font-size="13" class="mono"><tspan fill="${C.green}">$</tspan> npm start<tspan class="blink" fill="${C.text}"> ▌</tspan></text>
<text x="232" y="20" font-size="12" text-anchor="end" class="muted mono">:4747</text></g>`;
  return svg(W, H, 'Ortak — yapay zekâ ajanlarını tek yerden yöneten uygulama', body, s, { chrome: false });
}

// ---------------------------------------------------------------- sahne 1: eller
function hands() {
  const s = new Scene(18);
  const W = 960, H = 530, X = 72;
  const agentLine = (y, t, cmd, rest = '') => `<g transform="translate(0 ${y})"><g ${s.show(t)}>${avatar(44, 16, 'url(#argon)', 'A')}
<text x="${X}" y="21" font-size="14" class="mono"><tspan fill="#d2a8ff" font-weight="700">${esc(cmd)}</tspan><tspan>${esc(rest)}</tspan></text></g></g>`;
  const card = (y, t, icon, label, detail, color = C.muted) => `<g transform="translate(${X} ${y})"><g ${s.show(t)}>
<rect width="600" height="32" rx="8" fill="${C.panel}" stroke="${C.line}"/>
<text x="14" y="21" font-size="13">${icon}</text>
<text x="38" y="21" font-size="12.5" font-weight="700" class="muted">Ortak: ${esc(label)}</text>
<text x="${38 + sansW('Ortak: ' + label, 12.5) + 14}" y="21" font-size="12.5" class="mono" fill="${color}">${esc(detail)}</text></g></g>`;
  const prompt = 'Testler kırık, düzeltir misin?';
  const pw = sansW(prompt, 15) + 36;
  const body = `
<g transform="translate(${W - 32 - pw} 62)"><g ${s.show(0.2)}>
<rect width="${pw}" height="38" rx="12" fill="#1c2d4a" stroke="#1f6feb" stroke-opacity=".6"/>
<clipPath id="c1"><rect x="0" y="0" width="${pw}" height="38" rx="12"/></clipPath>
<g clip-path="url(#c1)"><text x="18" y="24.5" font-size="15">${esc(prompt)}</text>
<rect x="12" y="4" width="${pw}" height="30" fill="#1c2d4a" ${s.type(0.5, 1.4, pw, prompt.length)}/></g></g></g>
<text x="${W - 32}" y="116" text-anchor="end" font-size="11" class="muted" ${s.show(0.2)}>Sen · Kod modu · Düzenleme yetkisi</text>
${agentLine(128, 2.4, 'GREP: ', 'indirimHesapla')}
${card(164, 3.4, '🔍', 'ara', 'src/fiyat.js:1503  ·  1 eşleşme')}
${agentLine(208, 4.8, 'READ: ', 'src/fiyat.js:1495-1515')}
${card(244, 5.8, '📄', 'oku', 'src/fiyat.js  ·  satır 1495–1515 (3002 satırdan 21’i)')}
<g transform="translate(${X} 290)"><g ${s.show(7.3)}>
<rect width="600" height="66" rx="8" fill="#0b0f14" stroke="${C.line}"/>
<text x="14" y="19" font-size="11" class="muted mono">src/fiyat.js</text>
<rect x="8" y="26" width="584" height="17" fill="${C.red}" fill-opacity=".14"/>
<text x="14" y="39" font-size="13" class="mono" fill="#ffa198">-   return fiyat * oran;</text>
<rect x="8" y="44" width="584" height="17" fill="${C.green}" fill-opacity=".14"/>
<text x="14" y="57" font-size="13" class="mono" fill="#7ee787">+   return fiyat * (1 - oran);</text></g></g>
<g transform="translate(${X} 366)"><g ${s.show(8.8)}>
<rect width="600" height="34" rx="8" fill="#1a2b1f" stroke="${C.green}" stroke-opacity=".5"/>
<text x="14" y="22" font-size="13">✎  <tspan font-weight="700">1 dosya değişti</tspan><tspan class="muted"> — src/fiyat.js</tspan></text>
<rect x="500" y="6" width="88" height="22" rx="6" fill="${C.soft}" stroke="${C.line}"/><text x="544" y="21.5" text-anchor="middle" font-size="12">↶ Geri al</text></g></g>
${agentLine(410, 10.3, 'RUN: ', 'npm test')}
<g transform="translate(${X} 446)"><g ${s.show(11.2)}>
<rect width="600" height="32" rx="8" fill="${C.panel}" stroke="${C.line}"/>
<text x="14" y="21" font-size="13">⌨</text><text x="38" y="21" font-size="12.5" font-weight="700" class="muted">Ortak: komut</text>
<g transform="translate(140 9)"><g ${s.show(11.2, { until: 12.4, dy: 0 })}><circle cx="7" cy="7" r="6" fill="none" stroke="${C.muted}" stroke-width="2" stroke-dasharray="20 18" class="spin"/></g></g>
<text x="140" y="21" font-size="12.5" class="mono" ${s.show(12.5, { dy: 0 })}><tspan fill="${C.green}">✓ 12 test geçti</tspan><tspan class="muted">  ·  çıkış kodu 0  ·  1,8 sn</tspan></text></g></g>
<g transform="translate(0 488)"><g ${s.show(13.6)}>${avatar(44, 16, 'url(#argon)', 'A')}
<text x="${X}" y="21" font-size="14.5">Düzeltildi: indirim oranı <tspan font-weight="700">ters</tspan> uygulanıyordu. Testlerin hepsi geçiyor. ✅</text></g></g>
<g transform="translate(${W - 238} 136)"><g ${s.show(2.4)}><rect width="206" height="96" rx="10" fill="${C.panel}" stroke="${C.line}" stroke-dasharray="4 4"/>
<text x="14" y="24" font-size="12" font-weight="700" fill="#d2a8ff">Gemini 4 Argon</text>
<text x="14" y="44" font-size="11.5" class="muted">kendi aracı yok — sadece yazı</text>
<text x="14" y="64" font-size="11.5" class="muted">Ortak onun <tspan fill="${C.text}" font-weight="700">elleri</tspan> olur:</text>
<text x="14" y="83" font-size="11" class="mono" fill="${C.blue}">LIST READ GREP RUN ✎</text></g></g>`;
  return svg(W, H, 'Sahne: Gemini 4 Argon, Ortak aracılığıyla arar, okur, düzeltir ve testleri çalıştırır', body, s,
    { title: 'Ortak — Kod · Sohbet · Gemini 4 Argon' });
}

// ---------------------------------------------------------------- sahne 2: yönetici
function lead() {
  const s = new Scene(17);
  const W = 960, H = 450;
  const lanes = [
    { x: 32, name: 'Gemini 4 Argon', color: 'url(#argon)', L: 'A', tasks: [['1 · fiyat hesapları', 3.8, 3.4], ['4 · birim testleri', 7.5, 3.2, 'after: 1']] },
    { x: 342, name: 'GPT-6.1 Sol', color: C.codex, L: 'G', tasks: [['2 · API uç noktası', 3.8, 5.6]] },
    { x: 652, name: 'Claude Haiku', color: C.claude, L: 'H', tasks: [['3 · README + belgeler', 3.8, 2.6]] },
  ];
  let lanesSvg = '', spokes = '';
  for (const l of lanes) {
    const cx = l.x + 138;
    spokes += `<path d="M480 136 C480 168 ${cx} 160 ${cx} 196" stroke="${C.claude}" stroke-opacity=".55" stroke-width="1.5" fill="none" class="flow" ${s.show(3.2, { dy: 0 })}/>`;
    let rows = '';
    l.tasks.forEach(([label, t, dur, after], j) => {
      const y = 58 + j * 56;
      rows += `<g transform="translate(16 ${y})"><g ${s.show(t - 0.4)}>
<text x="0" y="0" font-size="13">${esc(label)}${after ? `<tspan class="muted" font-size="11">  (${after})</tspan>` : ''}</text>
<rect x="0" y="12" width="210" height="7" rx="3.5" fill="${C.soft}"/>
<rect x="0" y="12" width="210" height="7" rx="3.5" fill="${C.green}" ${s.grow(t, dur)}/>
<text x="232" y="20" font-size="14" fill="${C.green}" font-weight="700" ${s.show(t + dur, { dy: 0 })}>✓</text></g></g>`;
    });
    lanesSvg += `<g transform="translate(${l.x} 196)"><g ${s.show(3.4)}>
<rect width="276" height="150" rx="12" fill="${C.panel}" stroke="${C.line}"/>
${avatar(26, 26, l.color, l.L, 12)}<text x="46" y="31" font-size="14" font-weight="700">${esc(l.name)}</text>
${rows}</g></g>`;
  }
  const body = `
<g transform="translate(296 62)"><rect width="368" height="74" rx="14" fill="#2a1a14" stroke="${C.claude}" stroke-opacity=".8"/>
${avatar(30, 37, C.claude, 'O', 15)}
<text x="56" y="31" font-size="15" font-weight="700">Yönetici · Claude Opus</text>
<text x="56" y="54" font-size="13" class="muted" ${s.show(0.3, { until: 2.6 })}>Projeyi okuyor<tspan class="dots"> …</tspan></text>
<text x="56" y="54" font-size="13" ${s.show(2.9, { until: 12 })}><tspan fill="${C.yellow}">Plan:</tspan> 4 iş → 3 ajan · bağımsızlar paralel</text>
<text x="56" y="54" font-size="13" ${s.show(12.3)}><tspan fill="${C.green}">✓</tspan> Diff'leri inceledi, hepsi onaylandı</text></g>
${spokes}
${lanesSvg}
<g transform="translate(250 372)"><g ${s.show(13.4)}>
<rect width="460" height="44" rx="22" fill="#1a2b1f" stroke="${C.green}" stroke-opacity=".6"/>
<text x="230" y="27.5" text-anchor="middle" font-size="15"><tspan fill="${C.green}" font-weight="700">✓ Bitti</tspan> — 4/4 iş · 7 dosya · 2 dk 14 sn</text></g></g>
<text x="480" y="436" text-anchor="middle" font-size="11.5" class="muted" ${s.show(3.4)}>Yönetici kod yazmaz: böler, dağıtır, denetler. Bağımlı iş (after) öncekisi biter bitmez başlar.</text>`;
  return svg(W, H, 'Sahne: Yönetici modu — Claude Opus işi böler, alt ajanlar paralel çalışır', body, s,
    { title: 'Ortak — Kod · Yönetici modu' });
}

// ---------------------------------------------------------------- sahne 3: grup sohbeti
function group() {
  const s = new Scene(16);
  const W = 960, H = 470;
  const who = { claude: ['Claude', C.claude, 'C'], codex: ['Codex', C.codex, 'X'], gemini: ['Gemini', C.gemini, 'G'] };
  let y = 62, out = '';
  const me = (t, text) => {
    const w = sansW(text, 15) + 36;
    out += `<g transform="translate(${W - 32 - w} ${y})"><g ${s.show(t)}><rect width="${w}" height="38" rx="12" fill="#1c2d4a" stroke="#1f6feb" stroke-opacity=".6"/>
<text x="18" y="24.5" font-size="15">${esc(text)}</text></g></g>`;
    y += 54;
  };
  const say = (t, k, parts) => {
    const [name, color, L] = who[k];
    const plain = parts.map((p) => (typeof p === 'string' ? p : p[0])).join('');
    const w = sansW(plain, 14.5) + 34;
    const spans = parts.map((p) => (typeof p === 'string' ? esc(p)
      : `<tspan fill="${p[1]}" font-weight="700">${esc(p[0])}</tspan>`)).join('');
    out += `<g transform="translate(32 ${y})"><g ${s.show(t - 1.1, { until: t - 0.15, dy: 0 })}>${avatar(16, 19, color, L)}
<text x="40" y="24" font-size="12.5" class="muted">${name} yazıyor <tspan class="dots"><tspan>•</tspan><tspan>•</tspan><tspan>•</tspan></tspan></text></g>
<g ${s.show(t)}>${avatar(16, 19, color, L)}
<rect x="38" y="0" width="${w}" height="38" rx="12" fill="${C.panel}" stroke="${color}" stroke-opacity=".45"/>
<text x="55" y="24" font-size="14.5">${spans}</text></g></g>`;
    y += 54;
  };
  me(0.3, 'Yerel bir not uygulaması yapıyorum: SQLite mı, Postgres mi?');
  say(2.6, 'claude', ['Tek kullanıcı, tek dosya → SQLite yeter. ', ['@codex', C.codex], ' katılır mısın?']);
  say(5.2, 'codex', ['Katılıyorum; ama senkron eklenirse göç zorlaşır. ', ['@gemini', C.gemini], ' ne dersin?']);
  say(7.8, 'gemini', ['Arada bir yol: SQLite + Drizzle ORM. Postgres’e geçiş tek ayar.']);
  say(10.2, 'claude', ['İkna oldum. ', ['[UZLAŞI]', C.green]]);
  say(11.4, 'codex', [['[UZLAŞI]', C.green], ' — Gemini’nin önerisi en esnek yol.']);
  const body = `${out}
<g transform="translate(220 ${y + 4})"><g ${s.show(12.8)}><rect width="520" height="44" rx="22" fill="#1a2b1f" stroke="${C.green}" stroke-opacity=".6"/>
<text x="260" y="27.5" text-anchor="middle" font-size="15"><tspan fill="${C.green}" font-weight="700">✓ Uzlaşı</tspan> — SQLite + Drizzle ORM · 3/3 ajan</text></g></g>`;
  return svg(W, H, 'Sahne: Grup sohbeti — ajanlar birbirine @ ile hitap edip tartışır ve uzlaşır', body, s,
    { title: 'Ortak — Sohbet · Grup sohbeti' });
}

// ---------------------------------------------------------------- sahne 4: paralel
function parallel() {
  const s = new Scene(14);
  const W = 960, H = 420;
  const cols = [
    { x: 32, name: 'Claude Sonnet', color: C.claude, L: 'S', done: 4.2, stat: '+48 −12 · 4 dosya', bars: [[1, 150], [1, 90], [-1, 120], [1, 180], [1, 60]] },
    { x: 342, name: 'GPT-6.1 Sol', color: C.codex, L: 'G', done: 5.4, stat: '+21 −6 · 2 dosya', bars: [[-1, 110], [1, 170], [1, 130], [1, 70]] },
    { x: 652, name: 'Gemini 4 Argon', color: 'url(#argon)', L: 'A', done: 6.3, stat: '+63 −30 · 5 dosya', bars: [[1, 190], [-1, 140], [-1, 100], [1, 160], [1, 120]] },
  ];
  let out = '';
  for (const [i, c] of cols.entries()) {
    const bars = c.bars.map(([sign, w], j) => `<rect x="16" y="${92 + j * 18}" width="${w}" height="10" rx="3" fill="${sign > 0 ? C.green : C.red}" fill-opacity=".55"/>`).join('');
    const chosen = i === 1;
    out += `<g transform="translate(${c.x} 92)">
<rect width="276" height="236" rx="12" fill="${C.panel}" stroke="${C.line}"/>
${avatar(26, 26, c.color, c.L, 12)}<text x="46" y="31" font-size="14" font-weight="700">${esc(c.name)}</text>
<text x="16" y="62" font-size="11.5" class="muted mono">worktree: ortak/${['sonnet', 'sol', 'argon'][i]}</text>
<g ${s.show(0.6, { until: c.done, dy: 0 })}><g transform="translate(16 74)"><circle cx="7" cy="7" r="6" fill="none" stroke="${C.muted}" stroke-width="2" stroke-dasharray="20 18" class="spin"/></g>
<text x="34" y="86" font-size="12.5" class="muted">çalışıyor…</text></g>
<g ${s.show(c.done)}><text x="16" y="84" font-size="12.5" class="mono"><tspan fill="${C.green}">✓</tspan> ${esc(c.stat)}</text>${bars}</g>
<g transform="translate(16 190)"><g ${s.show(c.done)}><rect width="244" height="32" rx="8" fill="${C.soft}" stroke="${C.line}"/>
<text x="122" y="21" text-anchor="middle" font-size="13">Bunu uygula</text></g></g>
${chosen ? `<g transform="translate(16 190)"><g ${s.show(9.4, { dy: 0 })}><rect width="244" height="32" rx="8" fill="#238636"/>
<text x="122" y="21" text-anchor="middle" font-size="13" font-weight="700" fill="#fff">✓ Uygulandı</text></g></g>` : ''}
</g>`;
  }
  const body = `
<text x="480" y="74" text-anchor="middle" font-size="15">Aynı görev · <tspan font-weight="700">3 ajan</tspan> · her biri kendi <tspan class="mono" fill="${C.blue}">git worktree</tspan>’inde, aynı anda</text>
${out}
<circle cx="480" cy="${92 + 206}" r="18" fill="none" stroke="#fff" stroke-width="2" ${s.ripple(9.2)}/>
<g ${s.move([[0, 470, 400], [7.6, 470, 400], [9.1, 482, 300], [10.5, 482, 300], [12.5, 700, 410]])}>
<path d="M0 0 L0 17 L4.5 13 L7.5 20 L10 19 L7 12 L13 12 Z" fill="#fff" stroke="#000" stroke-width="1"/></g>
<g transform="translate(250 346)"><g ${s.show(10)}><rect width="460" height="42" rx="21" fill="#1a2b1f" stroke="${C.green}" stroke-opacity=".6"/>
<text x="230" y="26.5" text-anchor="middle" font-size="14.5"><tspan fill="${C.green}" font-weight="700">✓</tspan> GPT-6.1 Sol’un çözümü projene uygulandı</text></g></g>`;
  return svg(W, H, 'Sahne: Paralel mod — aynı görev üç ajanda, en iyisi tek tıkla uygulanır', body, s,
    { title: 'Ortak — Kod · Paralel mod' });
}

// ---------------------------------------------------------------- sahne 5: takım
function team() {
  const s = new Scene(19);
  const W = 960, H = 520, X = 110, RW = 740;
  const steps = [
    ['Veri modelini çıkar', 'OpenCode', 'DeepSeek V4.1 Flash', C.opencode],
    ['API katmanını yaz', 'Kilo', 'Otomatik (ücretsiz)', C.kilo],
    ['Form doğrulaması', 'Copilot', 'Otomatik', C.copilot],
    ['Arayüz bileşenleri', 'Antigravity', 'Gemini 3.8 Flash', C.ag],
    ['Birim testleri', 'Groq', 'Qwen 3.8 27B', C.groq, true],
    ['Belgeler', 'EVREN', 'mimo-v2.6-pro', C.evren, true],
  ];
  const T0 = 3.2, STEP = 1.35, FIX = 13.9, FIXED = 15.4;
  const spinner = (x, y, cls) => `<g transform="translate(${x} ${y})"><g ${cls}><circle cx="7" cy="7" r="6" fill="none" stroke="${C.muted}" stroke-width="2" stroke-dasharray="20 18" class="spin"/></g></g>`;
  const check = (x, y, cls) => `<text x="${x}" y="${y}" font-size="15" font-weight="700" fill="${C.green}" ${cls}>✓</text>`;
  let rows = '';
  steps.forEach(([title, agent, model, color, hands], i) => {
    const y = 148 + i * 44, t = T0 + i * STEP, done = t + STEP - 0.15;
    const chip = `${agent} · ${model}`;
    const cw = sansW(chip, 12) + 30;
    const isFix = i === 4;
    rows += `<g transform="translate(${X} ${y})"><g ${s.show(t - 0.3)}>
<rect width="${RW}" height="36" rx="9" fill="${C.panel}" stroke="${C.line}"/>
<circle cx="20" cy="18" r="11" fill="${C.soft}" stroke="${C.line}"/><text x="20" y="22.5" text-anchor="middle" font-size="12" font-weight="700">${i + 1}</text>
<text x="42" y="23" font-size="14">${esc(title)}</text>
${hands ? `<text x="232" y="23" font-size="11.5" fill="#d2a8ff">🤲 Ortak'ın elleriyle</text>` : ''}
<g transform="translate(${RW - 52 - cw} 6)"><rect width="${cw}" height="24" rx="12" fill="${C.bg}" stroke="${color}" stroke-opacity=".7"/>
<circle cx="13" cy="12" r="4" fill="${color}"/><text x="23" y="16.5" font-size="12">${esc(chip)}</text></g>
${spinner(RW - 36, 11, s.show(t, { until: done, dy: 0 }))}
${check(RW - 33, 24, s.show(done, isFix ? { until: FIX, dy: 0 } : { dy: 0 }))}
${isFix ? `${spinner(RW - 36, 11, s.show(FIX + 0.2, { until: FIXED, dy: 0 }))}${check(RW - 33, 24, s.show(FIXED, { dy: 0 }))}
<text x="${RW - 60 - cw}" y="23" font-size="11.5" text-anchor="end" fill="${C.yellow}" ${s.show(FIX + 0.2, { dy: 0 })}>düzeltme turu</text>` : ''}
</g></g>`;
  });
  const afterSteps = T0 + steps.length * STEP;
  const body = `
<g transform="translate(230 58)"><rect width="500" height="62" rx="14" fill="#0f2a22" stroke="${C.codex}" stroke-opacity=".8"/>
${avatar(30, 31, C.codex, 'P', 15)}
<text x="56" y="26" font-size="14.5" font-weight="700">Planlayıcı · OpenAI Codex <tspan class="muted" font-weight="400">GPT-6.1 Sol</tspan></text>
<text x="56" y="47" font-size="13" class="muted" ${s.show(0.3, { until: 2.6 })}>Görevi adımlara bölüyor<tspan class="dots"> …</tspan></text>
<text x="56" y="47" font-size="13" ${s.show(2.8)}><tspan fill="${C.yellow}">Plan:</tspan> 6 adım · çalışanlara sırayla dağıtıldı</text></g>
<path d="M480 120 L480 146" stroke="${C.codex}" stroke-opacity=".6" stroke-width="1.5" class="flow" ${s.show(2.8, { dy: 0 })}/>
${rows}
<path d="M480 412 L480 430" stroke="${C.gemini}" stroke-opacity=".6" stroke-width="1.5" class="flow" ${s.show(afterSteps, { dy: 0 })}/>
<path d="M730 452 C900 452 900 342 ${X + RW - 4} 342" stroke="${C.yellow}" stroke-width="1.6" fill="none" class="flow" ${s.show(FIX, { until: FIXED, dy: 0 })}/>
<g transform="translate(230 430)"><g ${s.show(afterSteps)}>
<rect width="500" height="62" rx="14" fill="#141d33" stroke="${C.gemini}" stroke-opacity=".8"/>
${avatar(30, 31, 'url(#argon)', 'D', 15)}
<text x="56" y="26" font-size="14.5" font-weight="700">Denetçi · Gemini 4 Argon <tspan class="muted" font-weight="400">yüksek düşünme</tspan></text>
<text x="56" y="47" font-size="13" class="muted" ${s.show(afterSteps + 0.1, { until: FIX - 1.1 })}>Diff'i inceliyor<tspan class="dots"> …</tspan></text>
<text x="56" y="47" font-size="13" ${s.show(FIX - 0.9, { until: FIXED + 0.3 })}><tspan fill="${C.yellow}">Düzeltme istedi:</tspan> testlerde boş liste durumu eksik</text>
<text x="56" y="47" font-size="13" ${s.show(FIXED + 0.5)}><tspan fill="${C.green}" font-weight="700">✓ Onaylandı</tspan> — 6 adım · 1 düzeltme turu</text></g></g>`;
  return svg(W, H, 'Sahne: Takım modu — Codex planlar, altı çalışan adımları sırayla uygular, Gemini 4 Argon denetler', body, s,
    { title: 'Ortak — Kod · Takım modu · Tam yetki' });
}

const files = { 'sahne-takim.svg': team(), 'hero.svg': hero(),'sahne-eller.svg': hands(), 'sahne-yonetici.svg': lead(), 'sahne-grup.svg': group(), 'sahne-paralel.svg': parallel() };
for (const [name, content] of Object.entries(files)) writeFileSync(path.join(OUT, name), content);
console.log(Object.keys(files).map((f) => `docs/media/${f}`).join('\n'));
