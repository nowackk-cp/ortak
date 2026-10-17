// "Telefondan aç" dialog: turn phone access on, show the QR code (it carries the key) and the
// address, list the devices that connected. GET/PUT /api/remote, POST /api/remote/rotate.
// On the phone itself it only says it is connected and offers to sign out.
import { fill, h, icon, spinner } from './dom.js';
import { api, toast } from './api.js';
import { qrSvg } from './qr.js';

const POLL_MS = 4000;

const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'şimdi';
  if (s < 3600) return `${Math.round(s / 60)} dk önce`;
  if (s < 86400) return `${Math.round(s / 3600)} sa önce`;
  return new Date(ts).toLocaleDateString('tr-TR');
};

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} kopyalandı`, 'success', 1500);
  } catch {
    toast('Kopyalanamadı; elle seçip kopyala.', 'error');
  }
}

export function openPhoneDialog() {
  const prevFocus = document.activeElement;
  let st = null;
  let pick = 0; // which address the QR code shows
  let busy = false;
  let timer = 0;

  const body = h('div', { class: 'phone-body' }, h('div', { class: 'sb-empty' }, spinner('sm'), 'Yükleniyor…'));
  const close = () => {
    clearInterval(timer);
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    prevFocus?.focus?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };

  let shown = '';
  async function load(quiet = true) {
    try {
      const next = await api('/api/remote', { quiet });
      // repaint only when something changed (keeps the help section open between polls)
      const sig = JSON.stringify({ ...next, devices: (next.devices || []).map((d) => [d.name, d.ip, ago(d.at)]) });
      st = next;
      if (sig !== shown) { shown = sig; paint(); }
    } catch { if (!st) close(); }
  }

  async function setEnabled(on) {
    if (busy) return;
    busy = true;
    paint();
    try {
      st = await api('/api/remote', { method: 'PUT', body: { enabled: on } });
      if (on && st.error) toast(st.error, 'error');
    } catch { /* toast shown */ }
    busy = false;
    paint();
  }

  async function rotate() {
    if (!confirm('Yeni anahtar oluşturulsun mu? Bağlı telefonların bağlantısı kesilir; yeni QR kodu okutman gerekir.')) return;
    try {
      st = await api('/api/remote/rotate', { method: 'POST' });
      toast('Yeni anahtar oluşturuldu', 'success', 1800);
      paint();
    } catch { /* toast shown */ }
  }

  async function signOut() {
    try { await fetch('/telefon/cikis', { method: 'POST' }); } catch { /* reload anyway */ }
    location.replace('/');
  }

  const step = (n, ...text) => h('li', { class: 'ph-step' }, h('span', { class: 'ph-n', text: String(n) }), h('span', {}, ...text));

  function connectedView() {
    const links = st.links || [];
    if (!links.length) {
      return h('div', { class: 'setup-note warn' }, icon('warn'),
        'Bilgisayarın bir ağa bağlı görünmüyor. Wi-Fi ya da kablolu ağa bağlanınca bu pencereyi yeniden aç.');
    }
    pick = Math.min(pick, links.length - 1);
    const cur = links[pick];
    const qr = h('div', { class: 'ph-qr', title: 'Telefonun kamerasıyla okut' });
    qr.innerHTML = qrSvg(cur.link, { title: 'Ortak bağlantı QR kodu' });
    const devices = st.devices || [];
    return h('div', { class: 'ph-on' },
      h('div', { class: 'ph-main' },
        qr,
        h('div', { class: 'ph-info' },
          h('ol', { class: 'ph-steps' },
            step(1, cur.kind === 'tailscale' ? 'Telefonda Tailscale açık olsun (aynı hesap).' : 'Telefon bilgisayarla aynı Wi-Fi’da olsun.'),
            step(2, 'Telefonun kamerasıyla QR kodu okut ve bağlantıyı aç.'),
            step(3, 'Tarayıcı menüsünden ', h('b', { text: 'Ana ekrana ekle' }), ': Ortak uygulama gibi açılır.')),
          h('div', { class: 'ph-field' },
            h('div', { class: 'ph-label', text: 'Adres' }),
            h('div', { class: 'ph-val' },
              h('code', { text: cur.url }),
              h('button', { type: 'button', class: 'icon-btn sm', title: 'Adresi kopyala', 'aria-label': 'Adresi kopyala', onclick: () => copy(cur.url, 'Adres') }, icon('copy')))),
          h('div', { class: 'ph-field' },
            h('div', { class: 'ph-label', text: 'Anahtar' }),
            h('div', { class: 'ph-val' },
              h('code', { class: 'ph-key', text: st.key || '' }),
              h('button', { type: 'button', class: 'btn btn-ghost btn-sm', title: 'Bağlı telefonların bağlantısını keser', onclick: rotate }, icon('refresh'), 'Yeni anahtar'))),
          h('div', { class: 'ph-hint', text: 'QR kodu okutamazsan adresi telefonun tarayıcısına yaz; açılan sayfada anahtarı gir.' }))),
      links.length > 1 && h('div', { class: 'ph-addrs' },
        h('div', { class: 'ph-label', text: 'Bilgisayarın adresleri' }),
        h('div', { class: 'seg ph-seg' }, links.map((l, i) => h('button', {
          type: 'button', class: `seg-btn${i === pick ? ' active' : ''}`, title: l.url,
          onclick: () => { pick = i; paint(); },
        }, l.label)))),
      h('div', { class: 'ph-devices' },
        h('div', { class: 'ph-label', text: 'Bağlanan cihazlar' }),
        devices.length
          ? devices.map((d) => h('div', { class: 'ph-dev' }, icon('phone'), h('span', { class: 'ph-dev-n', text: d.name }), h('span', { class: 'ph-dev-m', text: `${d.ip} · ${ago(d.at)}` })))
          : h('div', { class: 'ph-hint', text: 'Henüz bağlanan yok. Telefon bağlanınca burada görünür.' })),
      h('details', { class: 'ph-help' },
        h('summary', {}, icon('chevron', 'adv-chev'), 'Telefon bağlanamıyor mu?'),
        h('ul', {},
          h('li', {}, 'Ortak ilk açıldığında Windows Güvenlik Duvarı “Node.js” için izin isteyebilir: ', h('b', { text: 'Özel ağlar' }), ' kutusu işaretliyken İzin ver’e bas.'),
          h('li', {}, 'Wi-Fi ağın “Ortak (Public)” profildeyse: Ayarlar → Ağ ve İnternet → Wi-Fi → ağın adı → ', h('b', { text: 'Özel ağ' }), '.'),
          h('li', {}, 'Misafir ağları ve bazı modemler cihazların birbirini görmesini engeller; telefonu ana Wi-Fi’a bağla.'),
          h('li', {}, 'Evin dışından kullanmak için bilgisayara ve telefona ücretsiz ', h('b', { text: 'Tailscale' }), ' kur ve aynı hesapla gir; burada “Tailscale — her yerden” adresi çıkar.'))),
      h('div', { class: 'ph-warn' }, icon('warn'), h('span', {},
        'QR kodu ve anahtarı kimseyle paylaşma: bu adresi açan kişi bilgisayarında ajan çalıştırabilir (Tam yetki dahil). Ev Wi-Fi’ı dışında Tailscale kullan.')));
  }

  function paint() {
    if (!st) return;
    if (st.viaPhone) {
      fill(body, h('div', { class: 'ph-phone' },
        h('div', { class: 'ph-big' }, icon('check'), 'Bu cihaz Ortak’a telefondan bağlı.'),
        h('p', { class: 'ph-hint', text: 'Erişimi kapatmak ya da anahtarı değiştirmek yalnızca bilgisayardan yapılır. Tarayıcı menüsünden “Ana ekrana ekle” ile Ortak’ı uygulama gibi açabilirsin.' }),
        h('button', { type: 'button', class: 'btn btn-sm', onclick: signOut }, 'Bu cihazdan çıkış yap')));
      return;
    }
    const on = st.enabled;
    fill(body, 
      h('div', { class: 'perf-row' },
        h('div', { class: 'perf-text' },
          h('div', { class: 'perf-label', text: 'Telefondan erişim' }),
          h('div', { class: 'perf-hint', text: 'Açıkken telefonun, anahtarla Ortak’ı açabilir: çalışma başlatır, ajanları izler, çalışırken mesaj yazar. Kapalıyken Ortak yalnızca bu bilgisayardan açılır.' })),
        h('label', { class: 'perf-switch' },
          h('input', { type: 'checkbox', checked: on, disabled: busy, onchange: (e) => setEnabled(e.target.checked) }),
          h('span', { text: busy ? '…' : on ? 'Açık' : 'Kapalı' }))),
      on && st.error && h('div', { class: 'setup-note warn' }, icon('warn'), st.error),
      on && st.listening && connectedView());
  }

  const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(); } },
    h('div', { class: 'modal phone-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Telefondan aç' },
      h('div', { class: 'modal-head' },
        h('strong', { text: 'Telefondan aç' }),
        h('button', { type: 'button', class: 'icon-btn', title: 'Kapat', 'aria-label': 'Kapat', onclick: close }, icon('x'))),
      body,
      h('div', { class: 'modal-foot' },
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: close }, 'Tamam'))));

  document.body.append(back);
  document.addEventListener('keydown', onKey, true);
  back.querySelector('.modal')?.focus?.();
  load(false);
  // the device list shows a phone the moment it connects
  timer = setInterval(() => { if (st?.enabled && !st.viaPhone && !busy) load(); }, POLL_MS);
}
