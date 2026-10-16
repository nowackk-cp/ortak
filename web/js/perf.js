// "Ayarlar" dialog (performance + internet tools): GET/PUT /api/settings. Every change is saved immediately.
import { h, icon, spinner } from './dom.js';
import { api, toast } from './api.js';

// Presets: "Hafif" for a busy machine (games, many apps open), "Varsayılan" = server defaults.
const LIGHT = {
  maxConcurrent: 1,
  lowPriority: true,
  geminiIdleMinutes: 5,
  antigravityAutoStart: true,
  antigravityIdleMinutes: 15,
  limitsRefreshMinutes: 15,
};

const minutes = (n, off = 'Kapatma') => (n ? `${n} dk` : off);

const FIELDS = [
  {
    key: 'maxConcurrent',
    label: 'Aynı anda çalışan ajan',
    hint: 'Claude Code, Codex, Copilot gibi uygulamalar her tur için ayrı bir program başlatır; fazlası sıraya girer. API ajanları (Groq, OpenRouter, EVREN) bu sınıra takılmaz.',
    options: [1, 2, 3, 4, 5, 6, 8, 0].map((v) => [v, v ? String(v) : 'Sınırsız']),
  },
  {
    key: 'lowPriority',
    label: 'Ajanları düşük öncelikte çalıştır',
    hint: 'Ajanlar ve Ortak’ın açtığı pencereler işlemciyi diğer programlara (oyun, tarayıcı) bırakır. Yük altında bile bilgisayar akıcı kalır.',
    type: 'bool',
  },
  {
    key: 'geminiIdleMinutes',
    label: 'Gemini penceresini boşta kalınca kapat',
    hint: 'Ortak’ın Gemini penceresi bu süre kullanılmazsa kapanır; sonraki turda simge durumunda yeniden açılır.',
    options: [0, 5, 10, 30, 60].map((v) => [v, minutes(v)]),
  },
  {
    key: 'antigravityAutoStart',
    label: 'Antigravity’yi gerektiğinde aç',
    hint: 'Antigravity’yi kapalı tutabilirsin: bir tur ona ihtiyaç duyunca Ortak açar.',
    type: 'bool',
  },
  {
    key: 'antigravityIdleMinutes',
    label: 'Ortak’ın açtığı Antigravity’yi boşta kalınca kapat',
    hint: 'Sadece Ortak’ın açtığı Antigravity, bu süre hiçbir Ortak turu çalışmazsa normal şekilde kapatılır. O pencerede kendin çalışıyorsan kapalı bırak.',
    options: [0, 10, 15, 30, 60].map((v) => [v, minutes(v)]),
  },
  {
    key: 'webTools',
    label: 'Ajanlar internete erişebilsin',
    hint: 'Kendi aracı olmayan modeller (Groq, OpenRouter, Gemini web…) web’de arama yapıp sayfa okuyabilir (dokümantasyon, hata mesajları). Yerel ağ adreslerine erişim her zaman kapalıdır.',
    type: 'bool',
  },
  {
    key: 'limitsRefreshMinutes',
    label: 'Limitleri otomatik yenile',
    hint: 'Limit okumak her ajan için kısa bir program çalıştırır. Pencere arka plandayken hiç yenilenmez.',
    options: [0, 5, 15, 30].map((v) => [v, v ? `${v} dk` : 'Sadece elle']),
  },
];

/** Opens the dialog. `onChange(settings)` runs after every successful save. */
export function openPerfDialog({ onChange } = {}) {
  const prevFocus = document.activeElement;
  let settings = null;
  let defaults = null;

  const body = h('div', { class: 'perf-body' }, h('div', { class: 'sb-empty' }, spinner('sm'), 'Ayarlar yükleniyor…'));
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    prevFocus?.focus?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };

  async function save(patch, msg = 'Kaydedildi') {
    try {
      const r = await api('/api/settings', { method: 'PUT', body: patch });
      settings = r.settings;
      defaults = r.defaults;
      paint();
      onChange?.(settings);
      toast(msg, 'success', 1500);
    } catch { paint(); /* error toast shown by api() */ }
  }

  function control(f) {
    const v = settings[f.key];
    if (f.type === 'bool') {
      return h('label', { class: 'perf-switch' },
        h('input', { type: 'checkbox', checked: !!v, onchange: (e) => save({ [f.key]: e.target.checked }) }),
        h('span', { text: v ? 'Açık' : 'Kapalı' }));
    }
    return h('select', { class: 'input perf-select', 'aria-label': f.label, onchange: (e) => save({ [f.key]: Number(e.target.value) }) },
      ...f.options.map(([val, text]) => h('option', { value: String(val), selected: val === v }, text)));
  }

  function paint() {
    if (!settings) return;
    body.replaceChildren(
      h('div', { class: 'perf-presets' },
        h('button', { type: 'button', class: 'btn btn-sm', title: 'Yoğun bir bilgisayar için: tek ajan, kısa uyku süreleri', onclick: () => save(LIGHT, 'Hafif mod açıldı') }, icon('sparkle'), 'Hafif mod'),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => save({ ...defaults }, 'Varsayılanlara dönüldü') }, 'Varsayılanlar')),
      ...FIELDS.map((f) => h('div', { class: 'perf-row' },
        h('div', { class: 'perf-text' },
          h('div', { class: 'perf-label', text: f.label }),
          h('div', { class: 'perf-hint', text: f.hint })),
        control(f))));
  }

  const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(); } },
    h('div', { class: 'modal perf-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Ayarlar' },
      h('div', { class: 'modal-head' },
        h('strong', { text: 'Ayarlar' }),
        h('button', { type: 'button', class: 'icon-btn', title: 'Kapat', 'aria-label': 'Kapat', onclick: close }, icon('x'))),
      body,
      h('div', { class: 'modal-foot' },
        h('span', { class: 'perf-foot-note', text: 'Değişiklikler hemen uygulanır.' }),
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: close }, 'Tamam'))));

  document.body.append(back);
  document.addEventListener('keydown', onKey, true);
  back.querySelector('.modal')?.focus?.();

  api('/api/settings').then((r) => {
    settings = r.settings;
    defaults = r.defaults;
    paint();
  }).catch(() => close());
}
