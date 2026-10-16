// Static labels shared by several modules.

export const MODES = {
  chat: {
    label: 'Sohbet',
    icon: 'chat',
    desc: 'Tek bir ajanla sohbet edin ve kod yazdırın — Claude Code gibi; takip mesajlarıyla devam eder.',
    placeholder: 'Bir şey sorun ya da bir görev verin…',
  },
  lead: {
    label: 'Yönetici',
    icon: 'crown',
    desc: 'Claude Code gibi, ama işi bir ekip yapar: yönetici model (ör. Opus) görevi böler ve alt ajanlara dağıtır; bağımsız işler aynı anda, bağlı işler sırası gelince çalışır. Raporları ve diff’leri denetler, gerekirse düzeltme ister. Kendisi kod yazmaz.',
    placeholder: 'Ekibin yapacağı işi yazın — yönetici planlayıp alt ajanlara dağıtır…',
  },
  group: {
    label: 'Grup Sohbeti',
    icon: 'chats',
    desc: 'Modeller aynı sohbette sırayla konuşur: birbirine @ad ile hitap eder, katılır, itiraz eder, soru sorar. İstediğiniz an araya girersiniz.',
    placeholder: 'Konuyu yazın — @codex gibi birini anarsanız ilk o konuşur…',
  },
  brainstorm: {
    label: 'Beyin Fırtınası',
    icon: 'bulb',
    desc: 'Tüm modeller soruyu önce bağımsız yanıtlar, sonra birbirini görüp eleştirir; moderatör sentezler.',
    placeholder: 'Tartışılacak soruyu ya da fikri yazın…',
  },
  parallel: {
    label: 'Paralel',
    icon: 'split',
    desc: 'Aynı görevi birkaç ajan kendi git worktree’sinde yapar; diff’leri karşılaştırıp en iyisini uygularsınız.',
    placeholder: 'Tüm ajanların ayrı ayrı yapacağı görevi yazın…',
  },
  team: {
    label: 'Takım',
    icon: 'team',
    desc: 'Planlayıcı görevi böler, çalışanlar sırayla uygular, denetçi inceler (bir düzeltme turu).',
    placeholder: 'Takımın birlikte yapacağı görevi yazın…',
  },
};

export const MODE_IDS = Object.keys(MODES);

// Two surfaces, like Claude's apps: Sohbet (plain conversations with any model, no project folder,
// read-only) and Kod (the coding modes on a project folder).
export const SURFACES = {
  chat: { label: 'Sohbet', icon: 'chat', title: 'Sohbet: herhangi bir modelle konuşun (proje klasörü yok)' },
  code: { label: 'Kod', icon: 'code', title: 'Kod: bir proje klasöründe ajanlarla kod yazın' },
};

export const SURFACE_MODE_IDS = {
  chat: ['chat', 'group', 'brainstorm'],
  code: MODE_IDS,
};

/** Mode texts as shown on the Sohbet surface (overrides MODES[id]). */
export const CHAT_MODES = {
  chat: {
    label: 'Tek model',
    icon: 'chat',
    desc: 'Seçtiğiniz modelle sohbet edin — claude.ai gibi. Proje klasörü yok; model dosyalara ve komutlara dokunmaz.',
    placeholder: 'Bir şey sorun…',
  },
  group: {
    label: 'Grup sohbeti',
    icon: 'chats',
    desc: 'Birkaç model aynı sohbette sırayla konuşur, birbirine @ad ile hitap eder; siz istediğiniz an araya girersiniz.',
    placeholder: 'Konuyu yazın — @copilot gibi birini anarsanız ilk o konuşur…',
  },
  brainstorm: {
    label: 'Beyin fırtınası',
    icon: 'bulb',
    desc: 'Tüm modeller soruyu önce bağımsız yanıtlar, sonra birbirini eleştirir; moderatör tek bir sentez yazar.',
    placeholder: 'Tartışılacak soruyu ya da fikri yazın…',
  },
};

/** Mode texts for a surface. */
export const modeInfo = (mode, surface) => (surface === 'chat' && CHAT_MODES[mode]) || MODES[mode] || MODES.chat;

/** Surface of a run (meta or list item): 'chat' when started from the Sohbet surface. */
export const runSurface = (r) => (r?.config?.surface === 'chat' ? 'chat' : 'code');

export const PERMISSIONS = [
  { id: 'read-only', label: 'Salt okunur', desc: 'Dosyaları okuyabilir, hiçbir şeyi değiştirmez.' },
  { id: 'edit', label: 'Düzenleme', desc: 'Proje klasöründeki dosyaları düzenleyebilir; komutlar yalnızca korumalı alanda.' },
  { id: 'full', label: 'Tam yetki', desc: 'Onay sormadan ve korumasız her komutu çalıştırabilir.' },
];

export const RUN_STATUS = {
  running: 'Çalışıyor',
  waiting: 'Hazır',
  done: 'Tamamlandı',
  error: 'Hata',
  cancelled: 'İptal edildi',
};

export const LANE_STATUS = {
  idle: 'Bekliyor',
  running: 'Çalışıyor',
  done: 'Bitti',
  error: 'Hata',
  cancelled: 'Durduruldu',
};

export const ROLES = {
  participant: 'Katılımcı',
  moderator: 'Moderatör',
  planner: 'Planlayıcı',
  worker: 'Çalışan',
  reviewer: 'Denetçi',
  agent: 'Ajan',
  chat: 'Ajan',
  lead: 'Yönetici',
};

export const roleLabel = (r) => (r ? ROLES[r] || r : '');
