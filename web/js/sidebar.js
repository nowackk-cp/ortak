// Sidebar: project folder, run history, agents + limits panel.
import { h, icon, spinner } from './dom.js';
import { relTime, resetText, fmtDate, basename, enc } from './util.js';
import { RUN_STATUS, modeInfo, runSurface } from './modes.js';

const $ = (id) => document.getElementById(id);

// ---- project folder --------------------------------------------------------------------------

export function renderCwdStatus(cwd, info, pending) {
  const el = $('cwd-status');
  if (!el) return;
  el.className = 'cwd-status';
  el.title = '';
  if (!cwd) { el.replaceChildren(h('span', { class: 'muted', text: 'Bir proje klasörü yolu girin.' })); return; }
  if (pending) { el.replaceChildren(spinner('sm'), h('span', { class: 'muted', text: 'Kontrol ediliyor…' })); return; }
  if (!info) { el.replaceChildren(); return; }
  if (info.error) { el.classList.add('bad'); el.replaceChildren(icon('warn'), h('span', { text: info.error })); return; }
  if (!info.exists) { el.classList.add('bad'); el.replaceChildren(icon('warn'), h('span', { text: 'Klasör bulunamadı' })); return; }
  if (!info.isDir) { el.classList.add('bad'); el.replaceChildren(icon('warn'), h('span', { text: 'Bu bir klasör değil' })); return; }
  if (info.isGit) {
    el.classList.add('ok');
    el.title = info.root && info.root !== info.path ? `Git kökü: ${info.root}` : '';
    el.replaceChildren(icon('branch'), h('span', { text: `git ✓ ${info.branch || ''}`.trim() }),
      info.hasCommits === false ? h('span', { class: 'warn-text', text: '· henüz commit yok' }) : '');
  } else {
    el.replaceChildren(icon('folder'), h('span', { class: 'muted', text: 'git yok' }));
  }
}

export function renderRecentMenu(recent, current, onPick) {
  const menu = $('cwd-menu');
  if (!menu) return;
  const norm = (s) => String(s).toLowerCase().replace(/[\\/]+$/, '');
  const items = (recent || []).filter((c) => norm(c) !== norm(current)).slice(0, 8);
  if (!items.length) { menu.replaceChildren(); menu.hidden = true; return false; }
  menu.replaceChildren(
    h('div', { class: 'cwd-menu-t', text: 'Son klasörler' }),
    ...items.map((c) => h('button', {
      type: 'button',
      class: 'cwd-opt',
      title: c,
      onmousedown: (e) => { e.preventDefault(); onPick(c); },
    }, icon('folder'), h('span', { class: 'cwd-opt-name', text: basename(c) }), h('span', { class: 'cwd-opt-path', text: c }))));
  return true;
}

// ---- run history -----------------------------------------------------------------------------

export function renderRuns(runs, activeId, { onDelete, loaded, emptyText }) {
  const el = $('runs');
  if (!el) return;
  if (!loaded) { el.replaceChildren(h('div', { class: 'sb-empty' }, spinner('sm'), 'Yükleniyor…')); return; }
  if (!runs.length) {
    el.replaceChildren(h('div', { class: 'sb-empty', text: emptyText || 'Henüz çalışma yok. Bir mod seçip görevinizi yazarak başlayın.' }));
    return;
  }
  el.replaceChildren(...runs.map((r) => {
    const mode = modeInfo(r.mode, runSurface(r));
    const status = r.status || 'done';
    const title = r.title || r.config?.prompt || 'Adsız çalışma';
    const del = h('button', { type: 'button', class: 'icon-btn run-del', title: 'Sil', 'aria-label': 'Çalışmayı sil' }, icon('trash'));
    let armed = 0;
    del.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!armed) {
        del.classList.add('armed');
        del.replaceChildren(h('span', { text: 'Sil?' }));
        armed = setTimeout(() => { armed = 0; del.classList.remove('armed'); del.replaceChildren(icon('trash')); }, 3000);
        return;
      }
      clearTimeout(armed);
      onDelete(r.id);
    });
    return h('a', {
      class: `run-item${r.id === activeId ? ' active' : ''}`,
      href: `#/run/${enc(r.id)}`,
      title: `${title}\n${mode.label} · ${RUN_STATUS[status] || status} · ${fmtDate(r.createdAt)}${r.cwd ? '\n' + r.cwd : ''}`,
    },
    h('span', { class: 'run-ico' }, icon(mode.icon)),
    h('span', { class: 'run-main' },
      h('span', { class: 'run-title', text: title }),
      h('span', { class: 'run-meta' },
        h('span', { class: `sdot s-${status}`, title: RUN_STATUS[status] || status }),
        h('span', { text: relTime(r.updatedAt || r.createdAt) }),
        r.cwd && runSurface(r) !== 'chat' && h('span', { class: 'run-cwd', text: basename(r.cwd) }))),
    del);
  }));
}

// ---- agents + limits -------------------------------------------------------------------------

function limitsEl(lim) {
  if (!lim) return null;
  if (lim.ok === false || lim.error) {
    return h('div', { class: 'limit-note', text: lim.error || 'Limit bilgisi alınamadı.' });
  }
  const items = (Array.isArray(lim.items) ? lim.items : []).map((it) => {
    const pct = typeof it.usedPercent === 'number' && Number.isFinite(it.usedPercent) ? Math.max(0, Math.min(100, it.usedPercent)) : null;
    const sub = [it.text, it.resetsAt && resetText(it.resetsAt)].filter(Boolean).join(' · ');
    return h('div', { class: 'limit' },
      h('div', { class: 'limit-top' },
        h('span', { class: 'limit-label', text: it.label || '' }),
        pct != null && h('span', { class: 'limit-pct', text: `%${Math.round(pct)}` })),
      pct != null && h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': String(Math.round(pct)), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': it.label || 'Kullanım' },
        h('div', { class: `bar-fill${pct >= 90 ? ' crit' : pct >= 70 ? ' warn' : ''}`, style: { width: `${pct}%` } })),
      sub && h('div', { class: 'limit-sub', title: it.resetsAt ? `Sıfırlanma: ${fmtDate(it.resetsAt)}` : '', text: sub }));
  });
  if (!items.length && !lim.note) return null;
  return h('div', { class: 'limits' }, items, lim.note && h('div', { class: 'limit-note', text: lim.note }));
}

export function renderAgents(agents, limits, { loaded, loading, starting, onStart, loggingIn, onLogin }) {
  const body = $('ap-body');
  const btn = $('ap-refresh');
  if (btn) btn.classList.toggle('spinning', !!loading);
  if (!body) return;
  if (!loaded) { body.replaceChildren(h('div', { class: 'sb-empty' }, spinner('sm'), 'Ajanlar yükleniyor…')); return; }
  if (!agents.length) {
    body.replaceChildren(h('div', { class: 'sb-empty', text: 'Hiç ajan bulunamadı. Claude Code, Codex, OpenCode, Kilo Code, Copilot, Junie veya Antigravity kurulu olmalı.' }));
    return;
  }
  const summary = $('ap-count');
  if (summary) summary.textContent = `${agents.filter((a) => a.available).length}/${agents.length}`;
  body.replaceChildren(...agents.map((a) => {
    const tip = a.available ? `${a.name}${a.version ? ' · ' + a.version : ''} — kullanılabilir` : a.reason || 'Kullanılamıyor';
    return h('div', { class: `agent${a.available ? ' on' : ' off'}`, title: tip },
      h('div', { class: 'agent-line' },
        h('span', { class: 'dot', 'aria-label': a.available ? 'kullanılabilir' : 'kullanılamıyor' }),
        h('span', { class: 'agent-name', text: a.name || a.id }),
        a.version && h('span', { class: 'agent-ver', text: a.version }),
        a.available && a.capabilities && a.capabilities.edit === false && h('span', { class: 'agent-tag', title: 'Kendi dosya araçları yok: Ortak onun yerine klasörlerde gezer, dosya okur, değişiklikleri uygular ve terminal komutlarını çalıştırır.', text: 'Ortak eli' }),
        a.sleeping && h('span', { class: 'agent-tag agent-sleep', title: 'Kaynak harcamamak için kapalı. İlk turda Ortak kendisi açar (Performans ayarları).' }, icon('moonzz'), 'uykuda')),
      !a.available && a.reason && h('div', { class: 'agent-reason', text: a.reason }),
      a.available && a.warning && h('div', { class: 'agent-reason warn-text agent-warning', role: 'status' }, icon('warn'), h('span', { text: a.warning })),
      !a.available && a.startable && h('button', {
        type: 'button',
        class: 'btn btn-sm agent-start',
        disabled: !!starting?.has(a.id),
        title: `${a.name || a.id} uygulamasını başlat`,
        onclick: () => onStart?.(a.id),
      }, ...(starting?.has(a.id) ? [spinner('sm'), 'Başlatılıyor…'] : [icon('play'), 'Başlat'])),
      // Sign in (required: the agent is unusable without it) / connect an account (optional: more models).
      a.loginable && a.login && (a.login.required ? !a.available : a.available) && h('button', {
        type: 'button',
        class: `btn btn-sm ${a.login.required ? 'agent-start' : 'btn-ghost agent-login'}`,
        disabled: !!loggingIn?.has(a.id),
        title: a.login.hint || `${a.name || a.id} için oturum açın`,
        onclick: () => onLogin?.(a.id),
      }, ...(loggingIn?.has(a.id) ? [spinner('sm'), 'Giriş bekleniyor…'] : [icon('key'), a.login.label || 'Giriş yap'])),
      a.available && a.capabilities?.sandbox === false && h('div', { class: 'agent-reason warn-text', text: 'İzinler zorunlu değil; komutlar sandbox’lı değil.' }),
      a.available && limitsEl(limits?.[a.id]));
  }));
}
