// All orchestrator prompt templates (Turkish). Keep them short and explicit.
import { clip } from '../util.js';
import { COMMAND_TIMEOUT_MS, shell } from '../commands.js';

const LANG = 'Kullanıcının yazdığı dilde cevap ver.';
const READ_ONLY = 'Hiçbir dosyayı oluşturma, değiştirme veya silme ve sistemi değiştiren komut çalıştırma; gerekirse dosyaları yalnızca oku.';
const SUMMARY_LINE = 'Bitirdiğinde en son satıra "ÖZET: <yaptıklarının tek cümlelik özeti>" yaz.';

const ANSWER_MAX = 8000;
const DIFF_MAX = 60_000;

/** "### Claude Code · Opus\n<text>" blocks. `items` = [{ title, text }] */
export function labelled(items, max = ANSWER_MAX) {
  return items.map((it) => `### ${it.title}\n${clip(String(it.text || '').trim() || '(boş cevap)', max)}`).join('\n\n');
}

function diffBlock(diff) {
  if (diff == null) return '(Proje bir git deposu değil; diff yok. Gerekirse dosyaları doğrudan oku.)';
  if (!String(diff).trim()) return '(Hiçbir dosya değişmedi.)';
  return '```diff\n' + clip(diff, DIFF_MAX) + '\n```';
}

// ---- chat -------------------------------------------------------------------------------------

/** Appended to every system prompt of a run started from the Sohbet arayüzü (surface 'chat'). */
export const CHAT_SURFACE =
  'Bu konuşma Ortak\'ın Sohbet arayüzünde geçiyor: ortada bir yazılım projesi yok, çalışma klasörün boş ve önemsiz. ' +
  'Kullanıcıyla bir sohbet asistanı gibi doğal, net ve yardımsever konuş; kod gerekiyorsa cevabın içinde kod bloğu olarak yaz. ' +
  'Dosya okuma/yazma ve komut çalıştırma araçlarını kullanma; güncel bilgi gerekiyorsa web araması yapabilirsin. ' + LANG;

/** Used when the adapter cannot resume a session: rebuild context from a compact transcript. */
export function chatWithTranscript(history, text) {
  const lines = history.map((h) => `[${h.role === 'user' ? 'Kullanıcı' : 'Sen'}]: ${h.text}`).join('\n\n');
  return `Bu, süren bir konuşmanın devamı. Önceki mesajlar (uzun olanlar kısaltıldı):\n\n${lines}\n\n---\nYeni mesaj:\n${text}`;
}

// ---- brainstorm -------------------------------------------------------------------------------

export const brainstormSystem =
  `Birden fazla yapay zekâ ajanının katıldığı bir beyin fırtınası oturumundasın. ${LANG} ${READ_ONLY}`;

export const moderatorSystem =
  `Bir beyin fırtınası oturumunun moderatörüsün; katılımcıların cevaplarını tarafsızca sentezlersin. ${LANG} ${READ_ONLY}`;

export function brainstormFirst(question) {
  return `Soru / görev:\n${question}\n\n` +
    'Diğer katılımcılardan bağımsız olarak kendi en iyi cevabını ver. Gerekirse proje dosyalarını incele. ' +
    'Varsayımlarını, gerekçelerini ve risklerini kısaca belirt.';
}

const CRITIQUE_ASK =
  'Bu cevapları eleştirel gözle değerlendir: hatalı veya zayıf noktaları belirt, iyi fikirleri benimse ve ' +
  'geliştirilmiş, kendi başına okunabilir tam bir cevap ver. Önce kısa bir "Değerlendirme", ardından "Güncel cevap" bölümü yaz.';

/** Critique round when the agent's session already contains the question and its own answer. */
export function critiqueResume(round, others) {
  return `Tur ${round}. Diğer katılımcıların önceki turdaki cevapları:\n\n${labelled(others)}\n\n${CRITIQUE_ASK}`;
}

export function critiqueFresh(round, question, own, others) {
  return `Soru / görev:\n${question}\n\nSenin önceki cevabın:\n${clip(own || '(yok)', ANSWER_MAX)}\n\n` +
    `Tur ${round}. Diğer katılımcıların önceki turdaki cevapları:\n\n${labelled(others)}\n\n${CRITIQUE_ASK}`;
}

export function synthesis(question, answers, userText) {
  return `Soru / görev:\n${question}\n\n` +
    (userText ? `Kullanıcının son mesajı:\n${userText}\n\n` : '') +
    `Katılımcıların son cevapları:\n\n${labelled(answers)}\n\n` +
    'Bunları sentezle ve şu başlıklarla yaz:\n' +
    '1. **Ortak noktalar**\n2. **Ayrışmalar** (kim neyi savunuyor, hangisi neden daha güçlü)\n' +
    '3. **Önerilen yol / plan** (somut, sıralı adımlar)\n' +
    'Cevapları tekrar etme; kısa ve net ol.';
}

export function synthesisResume(userText, answers) {
  return `Kullanıcı yeni bir mesaj yazdı:\n${userText}\n\nKatılımcıların güncel cevapları:\n\n${labelled(answers)}\n\n` +
    'Sentezi buna göre güncelle (Ortak noktalar / Ayrışmalar / Önerilen yol). Kısa ve net ol.';
}

export function brainstormFollowResume(userText, synthesisText) {
  return 'Kullanıcı yeni bir mesaj yazdı:\n' + userText + '\n\n' +
    (synthesisText ? `Moderatörün son sentezi:\n${clip(synthesisText, ANSWER_MAX)}\n\n` : '') +
    'Bunu dikkate alarak güncel ve tam cevabını ver.';
}

export function brainstormFollowFresh(question, own, synthesisText, userText) {
  return `Soru / görev:\n${question}\n\n` +
    (own ? `Senin önceki cevabın:\n${clip(own, ANSWER_MAX)}\n\n` : '') +
    (synthesisText ? `Moderatörün son sentezi:\n${clip(synthesisText, ANSWER_MAX)}\n\n` : '') +
    `Kullanıcının yeni mesajı:\n${userText}\n\nBunu dikkate alarak güncel ve tam cevabını ver.`;
}

export function moderatorDirect(question, synthesisText, userText) {
  return `Soru / görev:\n${question}\n\n` +
    (synthesisText ? `Senin son sentezin:\n${clip(synthesisText, ANSWER_MAX)}\n\n` : '') +
    `Kullanıcı sana doğrudan şunu soruyor:\n${userText}`;
}

// ---- group (agents talking to each other in one shared conversation) --------------------------

export const CONSENSUS = '[UZLAŞI]';
const GROUP_MSG_MAX = 4000;

/** `people` = [{ handle, title, self }] */
export function groupSystem(people) {
  const list = people.map((p) => `@${p.handle} (${p.title})${p.self ? ' — bu sensin' : ''}`).join(', ');
  return 'Bir grup sohbetindesin: kullanıcı ve birkaç yapay zekâ ajanı aynı konuşmada sırayla konuşuyor. ' +
    `Katılımcılar: ${list}.\n` +
    'Kurallar:\n' +
    '- Diğer ajanlarla gerçekten konuş: onlara @ad ile hitap et, fikirlerine katıl ya da gerekçeyle itiraz et, soru sor, sana sorulan soruları cevapla.\n' +
    '- Belirli birinin cevap vermesini istiyorsan onu @ ile an; sıradaki konuşmacı genelde o olur. Sadece tek bir kişiyle konuşma; henüz söz almamış katılımcıları da sohbete kat.\n' +
    '- Mesajına kendi adınla başlama. Birine soru soracaksan onu mesajının sonunda @ ile an.\n' +
    '- Kısa yaz (en fazla ~150 kelime), sohbet eder gibi; rapor yazma, başkasının söylediğini tekrar etme, sadece yeni bir şey ekle.\n' +
    `- Grubun (tüm katılımcıların) bir sonuca vardığını ve ekleyecek bir şeyin kalmadığını düşünüyorsan mesajının en sonuna ${CONSENSUS} yaz.\n` +
    `- ${LANG} ${READ_ONLY}`;
}

/** `log` entries: { who: 'user' | lane, text }; `name(who)` → "@codex (OpenAI Codex · GPT-6)" */
function groupLines(log, name) {
  return log.map((m) => `**${m.who === 'user' ? 'Kullanıcı' : name(m.who)}:**\n${clip(String(m.text || '').trim() || '(boş)', GROUP_MSG_MAX)}`).join('\n\n');
}

/** First turn of an agent (or an agent without resumable session): topic + whole conversation. */
export function groupFresh(log, name, handle) {
  const recent = log.length > 40 ? [log[0], ...log.slice(-39)] : log;
  const rest = recent.length > 1 ? `\n\nŞu ana kadarki konuşma:\n\n${groupLines(recent.slice(1), name)}` : '';
  return `Konu (kullanıcının açılış mesajı):\n${recent[0].text}${rest}\n\n` +
    (recent.length > 1 ? `Sıra sende, @${handle}.` : `Konuşmayı sen açıyorsun, @${handle}.`);
}

/** Later turns on a resumed session: only what was said since this agent last spoke. */
export function groupResume(newMessages, name, handle) {
  return `Son mesajından bu yana konuşmada yazılanlar:\n\n${groupLines(newMessages, name)}\n\nSıra sende, @${handle}.`;
}

// ---- parallel ---------------------------------------------------------------------------------

export const parallelSystem =
  'Bu görevi projenin sana ayrılmış bir git çalışma ağacı (worktree) kopyasında yapıyorsun; başka ajanlar aynı görevi ' +
  'kendi kopyalarında paralel yapıyor ve kullanıcı en iyi sonucu seçip uygulayacak. ' +
  `Değişiklikleri doğrudan dosyalara yap; git commit, branch, push veya stash yapma. ${LANG} Sonunda yaptıklarını kısaca özetle.`;

export function parallelFollowFresh(task, lastText, userText) {
  return `Önceki görev:\n${task}\n\nÖnceki çalışmanın sonunda yazdıkların:\n${clip(lastText || '(yok)', 4000)}\n\n` +
    `Kullanıcının yeni isteği (aynı çalışma ağacında devam et):\n${userText}`;
}

// ---- team -------------------------------------------------------------------------------------

export const plannerSystem = `Bir yazılım ekibinin planlayıcısısın. ${LANG} ${READ_ONLY}`;

export function plan(goal) {
  return `Görev:\n${goal}\n\n` +
    'Projeyi gerektiği kadar incele ve görevi sırayla uygulanacak 1–6 adıma böl. Her adım tek bir çalışanın tek ' +
    'seferde yapabileceği somut ve doğrulanabilir bir iş olsun (hangi dosyalar, kabul ölçütü). ' +
    'Cevabının sonunda planı tam olarak şu biçimde tek bir ```json bloğu olarak ver:\n' +
    '```json\n{"steps":[{"title":"Kısa başlık","details":"Ne yapılacak, hangi dosyalar, kabul ölçütü"}]}\n```';
}

export const workerSystem =
  `Bir yazılım ekibinde çalışansın; sana verilen adımı proje klasöründe uygula. Yalnızca kendi adımını yap, git commit yapma. ${LANG} ${SUMMARY_LINE}`;

export function planList(steps) {
  return steps.map((s, i) => `${i + 1}. ${s.title}${s.details ? ` — ${s.details}` : ''}`).join('\n');
}

function prevSummaries(summaries) {
  return summaries.length
    ? summaries.map((s) => `${s.index + 1}. ${s.title} (${s.by}): ${s.summary}`).join('\n')
    : '(henüz yok)';
}

export function workerStep(goal, steps, index, summaries) {
  const s = steps[index];
  return `Genel hedef:\n${goal}\n\nPlan:\n${planList(steps)}\n\nTamamlanan adımlar:\n${prevSummaries(summaries)}\n\n` +
    `Senin adımın (${index + 1}/${steps.length}): ${s.title}\n${s.details || ''}\n\nBu adımı şimdi uygula.`;
}

export const reviewerSystem = `Bir yazılım ekibinin denetçisisin. ${LANG} ${READ_ONLY}`;

const REVIEW_RULE =
  'Her şey doğru ve eksiksizse cevabına tam olarak "ONAY" kelimesiyle başla ve kısa bir değerlendirme yaz. ' +
  'Sorun varsa "ONAY" yazma; sorunları numaralı, somut ve düzeltilebilir bir liste olarak yaz.';

export function review(goal, steps, summaries, diff) {
  return `Genel hedef:\n${goal}\n\nPlan:\n${planList(steps)}\n\nAdım özetleri:\n${prevSummaries(summaries)}\n\n` +
    `Yapılan değişiklikler:\n${diffBlock(diff)}\n\n` +
    `Değişiklikleri hedefe ve plana göre incele; gerekirse dosyaları oku. ${REVIEW_RULE}`;
}

export function fix(goal, reviewText) {
  return `Genel hedef:\n${goal}\n\nDenetçi şu sorunları buldu:\n${clip(reviewText, 12_000)}\n\n` +
    `Bu sorunları proje klasöründe düzelt. ${SUMMARY_LINE}`;
}

export function finalReview({ goal, fixSummary, diff, resumed }) {
  return (resumed ? '' : `Genel hedef:\n${goal}\n\n`) +
    `Çalışan bulduğun sorunlar için düzeltme yaptı: ${fixSummary}\n\nGüncel değişiklikler:\n${diffBlock(diff)}\n\n` +
    'Kısa bir son değerlendirme yap. Sorunlar giderildiyse "ONAY" ile başla; kalan sorunları kısaca listele.';
}

export function teamFollow(goal, steps, lastReview, userText) {
  return `Genel hedef:\n${goal}\n\nPlan:\n${planList(steps)}\n\n` +
    (lastReview ? `Denetçinin son değerlendirmesi:\n${clip(lastReview, 6000)}\n\n` : '') +
    `Kullanıcının ek isteği:\n${userText}\n\nBunu proje klasöründe uygula. ${SUMMARY_LINE}`;
}

export function teamFollowReview({ goal, userText, summary, diff, resumed }) {
  return (resumed ? '' : `Genel hedef:\n${goal}\n\n`) +
    `Kullanıcının ek isteği:\n${userText}\n\nÇalışanın özeti: ${summary}\n\nBu istekteki değişiklikler:\n${diffBlock(diff)}\n\n` +
    `Kısaca incele. ${REVIEW_RULE}`;
}

// ---- text-only coders (textcoder.js) ----------------------------------------------------------

/** How a text-only agent runs commands through Ortak (`RUN:`), by permission. */
function runRule(permission) {
  const sh = shell().name;
  const base = `- "RUN: komut" → komutu proje klasöründe bir terminalde çalıştırır (${sh}) ve çıktısını, çıkış koduyla birlikte gönderir. ` +
    `Örn. "RUN: npm test", "RUN: git diff", "RUN: node src/index.js". Bir mesajda en fazla 5 RUN; her komut en fazla ${COMMAND_TIMEOUT_MS / 1000} sn çalışır ` +
    '(sunucu/izleme gibi bitmeyen komutlar başlatma). Etkileşimli (soru soran) komut kullanma.\n';
  if (permission === 'full') return base;
  if (permission === 'read-only') return base + '  Bu çalışma SALT OKUNUR: yalnızca hiçbir şeyi değiştirmeyen komutlar çalışır (test, listeleme, git status/diff/log).\n';
  return base + '  Yasak (çalıştırılmaz): git commit/push/reset/checkout, global paket kurulumu, paket yayınlama, klasör silme, sistem komutları.\n';
}

export function textCoderSystem(permission) {
  return 'Bir yazılım ekibinde çalışansın ama proje dosyalarına doğrudan erişimin yok: Ortak adlı araç senin elin ve terminalin. ' +
    'İsteklerini ayrı satırlara, satırın başına yaz:\n' +
    READ_RULES +
    runRule(permission) +
    '- Dosya değiştirmek ya da oluşturmak için değişiklikleri SEARCH/REPLACE blokları olarak ver; Ortak uygular.\n' +
    `Değişiklik yaptıysan uygunsa testleri RUN ile çalıştırıp sonucu doğrula. ${LANG}`;
}

const EDIT_FORMAT =
  'Değişiklik biçimi (her blok DÖRT backtick (````) ile açılıp kapanan bir kod bloğunun içinde, işaret satırları aynen):\n' +
  '````\nFILE: yol/dosya.js\n<<<<<<< SEARCH\n(dosyadaki mevcut satırlar, boşluklarıyla birebir aynı)\n=======\n(yerine gelecek satırlar)\n>>>>>>> REPLACE\n````\n' +
  '- Dört backtick şart: dosya içeriğinde üç backtick\'li (```) kod blokları olabilir (ör. README).\n' +
  '- SEARCH kısmı dosyada tam olarak bir kez geçmeli; birkaç satır bağlam ekle. Gördüğün dosya içeriğinden birebir kopyala.\n' +
  '- Yeni dosya için SEARCH kısmını boş bırak, REPLACE kısmına dosyanın tamamını yaz.\n' +
  '- Bir dosyada birden çok değişiklik için birden çok blok yaz; her blokta FILE satırı olsun.\n' +
  '- Görmediğin bir dosyayı değiştirme: önce READ ile iste.';

function fileHeader(f) {
  if (!f.lines) return `### ${f.path}`;
  const more = f.to < f.lines ? ` — devamı için "READ: ${f.path}:${f.to + 1}-${Math.min(f.lines, f.to + 400)}"` : '';
  return `### ${f.path} (satır ${f.from}-${f.to} / toplam ${f.lines}${f.truncated ? ', boyut sınırı nedeniyle kesildi' : ''}${more})`;
}

function fileBlocks(files) {
  return files.map((f) => (f.error
    ? `### ${f.path}\n(okunamadı: ${f.error})`
    : `${fileHeader(f)}\n\`\`\`\n${f.text}\n\`\`\``)).join('\n\n');
}

/** READ / GREP lines shared by the text-only prompts. */
const READ_RULES =
  '- "READ: yol/dosya" → dosyanın içeriğini gönderir (aynı anda birden çok READ satırı yazabilirsin). Büyük dosyada yalnızca ' +
  'gereken kısmı iste: "READ: yol/dosya:120-260" (satır aralığı). Kesilen dosyanın başlığında hangi satırların geldiği yazar.\n' +
  '- "GREP: desen" → tüm projede arar, eşleşen satırları dosya:satır ile gönderir (büyük/küçük harf duyarsız düzenli ifade). ' +
  'Bir klasörle sınırlamak için "GREP: desen @ src/". Bir şeyin nerede tanımlandığını/kullanıldığını bulmak için dosyaları tek tek okumak yerine bunu kullan.\n';

export function textCoderTask({ goal, task, listing, attached, readOnly, leadName }) {
  const list = listing.files.join('\n') + (listing.more ? `\n… ve ${listing.more} dosya daha` : '');
  return `${leadName ? `Yöneticin (${leadName}) sana bir görev verdi.\n\n` : ''}` +
    `Genel hedef (kullanıcının isteği):\n${goal}\n\nSenin görevin:\n${task}\n\n` +
    `Projedeki dosyalar:\n\`\`\`\n${list || '(boş)'}\n\`\`\`\n\n` +
    (attached.length ? `İlgili dosyalar:\n\n${fileBlocks(attached)}\n\n` : '') +
    (readOnly
      ? 'Bu çalışma salt okunur: dosyaları değiştiremezsin. Gerekirse READ ile dosya iste, sonra görevi cevapla (analiz, öneri, inceleme).\n\n'
      : `${EDIT_FORMAT}\n\n`) +
    `Önce gerekiyorsa READ ile dosya iste; dosyalar elindeyse doğrudan değişiklikleri ver. ${SUMMARY_LINE}`;
}

function grepBlocks(found = []) {
  return found.map((g) => (g.error
    ? `### GREP ${g.spec}\n(aranamadı: ${g.error})`
    : `### GREP ${g.spec} — ${g.hits.length ? `${g.hits.length + g.more} eşleşme, ${g.files} dosyada` : 'eşleşme yok'}\n` +
      (g.hits.length ? `\`\`\`\n${g.hits.join('\n')}${g.more ? `\n… ve ${g.more} eşleşme daha (deseni daralt ya da "@ klasör" ekle)` : ''}\n\`\`\`` : ''))).join('\n\n');
}

function ranBlocks(ran = []) {
  return ran.map((r) => (r.refused
    ? `### RUN ${r.command}\n(çalıştırılmadı: ${r.refused})`
    : `### RUN ${r.command}\n${r.timedOut ? `Zaman aşımı: ${COMMAND_TIMEOUT_MS / 1000} sn sonra durduruldu.` : `Çıkış kodu: ${r.code}`}\n\`\`\`\n${r.output || '(çıktı yok)'}\n\`\`\``)).join('\n\n');
}

export function textCoderFollow({ files, ran = [], found = [], results, current }) {
  const parts = [];
  if (ran.length) parts.push(`Komutların sonucu:\n\n${ranBlocks(ran)}`);
  if (found.length) parts.push(`Arama sonuçları:\n\n${grepBlocks(found)}`);
  if (results.length) {
    parts.push('Değişikliklerinin sonucu:\n' + results.map((r) => `- ${r.path}: ${r.ok ? (r.created ? 'oluşturuldu' : 'uygulandı') : `UYGULANAMADI — ${r.error}`}`).join('\n'));
  }
  if (current.length) parts.push(`Uygulanamayan blokların dosyalarının güncel hâli:\n\n${fileBlocks(current)}`);
  if (files.length) parts.push(`İstediğin dosyalar:\n\n${fileBlocks(files)}`);
  return `${parts.join('\n\n')}\n\nGörevine devam et: gerekirse uygulanamayan blokları düzeltip yeniden ver. Bittiyse ne yaptığını kısaca anlat. ${SUMMARY_LINE}`;
}

// ---- text-only agents in the Kod arayüzü's single-agent chat (textChatTurn) ------------------

export function textChatSystem(permission) {
  const readOnly = permission === 'read-only';
  return 'Kullanıcıyla bir yazılım projesi üzerinde Claude Code gibi sohbet ederek çalışıyorsun. Proje dosyalarına doğrudan ' +
    'erişimin yok: Ortak adlı araç senin elin ve terminalin. İsteklerini ayrı satırlara, satırın başına yaz:\n' +
    '- "LIST: klasör" → klasörün içeriğini gösterir (kök için "LIST: .").\n' +
    READ_RULES +
    runRule(permission) +
    (readOnly
      ? '- Bu çalışma SALT OKUNUR: dosya değiştiremezsin; değişiklikleri sadece öneri olarak anlat.\n'
      : '- Dosya değiştirmek/oluşturmak için SEARCH/REPLACE blokları ver; Ortak uygular ve sonucunu bildirir.\n\n' + EDIT_FORMAT + '\n') +
    'Ortak, LIST/READ/GREP/RUN isteklerinin ve değişikliklerin sonucunu bir sonraki mesajda gönderir; sonra kaldığın yerden devam et. ' +
    'Bir şey istediğin mesajı kısa tut ve cevabı uydurma: önce dosyayı oku. Kod değiştirdiysen uygunsa testleri/derlemeyi RUN ile çalıştırıp doğrula. ' +
    `İstediğin bir şey kalmadığında kullanıcıya normal cevabını yaz. ${LANG}`;
}

/** First message of a text-only chat on a project: the project's file list + the user's message. */
export function textChatIntro({ listing, text }) {
  const list = listing.files.join('\n') + (listing.more ? `\n… ve ${listing.more} dosya daha (LIST ile gezebilirsin)` : '');
  return `Projedeki dosyalar:\n\`\`\`\n${list || '(boş)'}\n\`\`\`\n\nKullanıcının mesajı:\n${text}`;
}

export const textChatBrokenBlocks =
  '[Ortak] Değişiklik blokların kod bloğunun dışında kaldı: satırlar birleşti ve "=======" kayboldu, hiçbiri uygulanamadı. ' +
  'Aynı değişiklikleri yeniden ver: HER blok kendi kod bloğunun içinde olsun — ayrı bir satırda ```` (dört backtick) ile aç, ' +
  'FILE / <<<<<<< SEARCH / ======= / >>>>>>> REPLACE satırlarını yaz, ayrı bir satırda ```` ile kapat. Başka bir şey yazma.';

/** First turn of a text-only team/parallel worker: the project's file list + its task. */
export function textWorkIntro({ listing, prompt }) {
  const list = listing.files.join('\n') + (listing.more ? `\n… ve ${listing.more} dosya daha (LIST ile gezebilirsin)` : '');
  return `Projedeki dosyalar:\n\`\`\`\n${list || '(boş)'}\n\`\`\`\n\n${prompt}`;
}

export function textChatFollow({ files, dirs, ran = [], found = [], results, current }) {
  const parts = ['[Ortak] İsteklerinin sonucu:'];
  if (ran.length) parts.push(ranBlocks(ran));
  if (found.length) parts.push(grepBlocks(found));
  if (results.length) {
    parts.push('Değişiklikler:\n' + results.map((r) => `- ${r.path}: ${r.ok ? (r.created ? 'oluşturuldu' : 'uygulandı') : `UYGULANAMADI — ${r.error}`}`).join('\n'));
  }
  if (current.length) parts.push(`Uygulanamayan blokların dosyalarının güncel hâli:\n\n${fileBlocks(current)}`);
  for (const d of dirs) {
    parts.push(d.error
      ? `### LIST ${d.path}\n(listelenemedi: ${d.error})`
      : `### LIST ${d.path}\n\`\`\`\n${d.entries.join('\n') || '(boş)'}${d.more ? `\n… ve ${d.more} öğe daha` : ''}\n\`\`\``);
  }
  if (files.length) parts.push(`İstediğin dosyalar:\n\n${fileBlocks(files)}`);
  return `${parts.join('\n\n')}\n\nDevam et: gerekirse başka dosya iste ya da uygulanamayan blokları düzeltip yeniden ver; işin bittiyse kullanıcıya ne yaptığını anlat.`;
}

// ---- API agents with real function calling (textcoder.js nativeTurn) -------------------------

function nativeToolRules(permission) {
  const readOnly = permission === 'read-only';
  return 'Proje dosyalarına doğrudan erişimin yok; Ortak sana araçlar veriyor ve çağırdığın araçları senin yerine çalıştırıyor:\n' +
    '- list_dir: klasörün içeriği. read_file: dosya okur; büyük dosyada start_line/end_line ile yalnızca gereken kısmı iste.\n' +
    '- grep: tüm projede (ya da bir klasörde) arar. Bir şeyin nerede tanımlandığını/kullanıldığını bulmak için dosyaları tek tek okumak yerine bunu kullan.\n' +
    `- run_command: proje klasöründe bir ${shell().name} komutu çalıştırır ve çıktısını çıkış koduyla verir (en fazla ${COMMAND_TIMEOUT_MS / 1000} sn; ` +
    'sunucu/izleme gibi bitmeyen ya da soru soran komut kullanma).\n' +
    (readOnly
      ? '- Bu çalışma SALT OKUNUR: dosya değiştiremezsin, yalnızca hiçbir şeyi değiştirmeyen komutlar çalışır. Değişiklikleri öneri olarak anlat.\n'
      : '- edit_file: dosyada old_text\'i new_text ile değiştirir (old_text dosyada birebir ve tek bir kez geçmeli: önce dosyayı oku, birkaç satır bağlam ekle). ' +
        'write_file: yeni dosya oluşturur ya da bir dosyayı baştan yazar.\n') +
    (permission === 'edit' ? '- Yasak komutlar (çalıştırılmaz): git commit/push/reset/checkout, global paket kurulumu, paket yayınlama, klasör silme, sistem komutları.\n' : '') +
    'Araçları gerektiği kadar çağır; cevabı uydurma, önce dosyayı oku. Kod değiştirdiysen uygunsa testleri/derlemeyi run_command ile çalıştırıp doğrula.';
}

export function nativeChatSystem(permission) {
  return `Kullanıcıyla bir yazılım projesi üzerinde Claude Code gibi sohbet ederek çalışıyorsun. ${nativeToolRules(permission)}\n` +
    `İşin bitince kullanıcıya ne yaptığını kısaca anlat. ${LANG}`;
}

export function nativeCoderSystem(permission) {
  return `Bir yazılım ekibinde çalışansın. ${nativeToolRules(permission)}\n${LANG}`;
}

export function nativeCoderTask({ goal, task, listing, attached, readOnly, leadName }) {
  const list = listing.files.join('\n') + (listing.more ? `\n… ve ${listing.more} dosya daha` : '');
  return `${leadName ? `Yöneticin (${leadName}) sana bir görev verdi.\n\n` : ''}` +
    `Genel hedef (kullanıcının isteği):\n${goal}\n\nSenin görevin:\n${task}\n\n` +
    `Projedeki dosyalar:\n\`\`\`\n${list || '(boş)'}\n\`\`\`\n\n` +
    (attached.length ? `İlgili dosyalar:\n\n${fileBlocks(attached)}\n\n` : '') +
    (readOnly
      ? 'Bu çalışma salt okunur: dosyaları değiştiremezsin. Gerekirse dosyaları okuyup görevi cevapla (analiz, öneri, inceleme). '
      : 'Değişiklikleri edit_file / write_file araçlarıyla doğrudan yap. ') +
    SUMMARY_LINE;
}

/** User-attached files folded into the message text the agents see. */
export function withAttachments(text, files, images = []) {
  let out = text;
  if (files?.length) {
    const blocks = files.map((f) => `### ${f.name}${f.truncated ? ' (kısaltıldı)' : ''}\n\`\`\`\n${f.text}\n\`\`\``).join('\n\n');
    out += `\n\nKullanıcının eklediği dosyalar:\n\n${blocks}`;
  }
  if (images?.length) {
    out += '\n\nKullanıcının eklediği resimler (resmi görebiliyorsan bu mesaja eklendi; dosya araçların varsa şu yoldan da açabilirsin):\n' +
      images.map((i) => `- ${i.name}: ${i.path}`).join('\n');
  }
  return out;
}

// ---- lead (Yönetici) --------------------------------------------------------------------------

export const leadSystem =
  'Bir yazılım ekibinin yöneticisisin (lider). Kendin kod yazmaz, dosya değiştirmez, komut çalıştırmazsın: ' +
  'işi alt ajanlara dağıtır, sonuçlarını denetler, gerekirse düzeltme görevi verirsin. ' +
  `Proje dosyalarını okuyarak denetleyebilirsin. ${LANG} ${READ_ONLY}`;

/** `workers` = [{ handle, title, canEdit, canRun, textOnly }] */
function teamList(workers) {
  const what = (w) => {
    if (w.textOnly) return 'dosyalara doğrudan erişemez: Ortak onun istediği dosyaları okur, verdiği değişiklikleri uygular ve istediği komutları çalıştırır (test koşabilir)';
    if (!w.canEdit) return 'sadece okur';
    return w.canRun ? 'dosya düzenleyebilir ve komut çalıştırabilir (test koşabilir)' : 'dosya düzenleyebilir ama bu çalışmada komut çalıştıramaz (test koşamaz)';
  };
  return workers.map((w) => `- @${w.handle} — ${w.title} — ${what(w)}`).join('\n');
}

const LEAD_FORMAT =
  'Her cevabının sonunda tek bir ```json bloğu ver:\n' +
  '```json\n{"tasks":[' +
  '{"id":"t1","agent":"sonnet","task":"Ne yapılacak, hangi dosyalar, kabul ölçütü","files":["src/a.js"]},' +
  '{"id":"t2","agent":"argon","task":"…"},' +
  '{"id":"t3","agent":"sol","task":"t1 ve t2\'nin sonucunu test et","after":["t1","t2"]}' +
  '],"done":false}\n```\n' +
  '- "id": kısa ve benzersiz. "after" (isteğe bağlı): önce bitmesi gereken görevlerin id\'leri — bu ya da önceki cevaplarındaki görevler. ' +
  '"files" (isteğe bağlı): o ajana önceden gönderilecek ilgili dosyalar.\n' +
  '- Yukarıdaki örnekte t1 ile t2 hemen ve aynı anda başlar, t3 ikisi de bitince kendiliğinden başlar.\n' +
  '- İş bittiğinde:\n```json\n{"tasks":[],"done":true,"summary":"Kullanıcıya yapılanların kısa özeti"}\n```';

const PARALLEL_RULES =
  '- Görevler PARALEL çalışır: "after" vermediğin her görev hemen ve diğerleriyle aynı anda başlar. ' +
  'Bir görev başka bir görevin sonucuna ihtiyaç duyuyorsa onu "after" ile bağla; Ortak onu, bağlı olduğu görevler biter bitmez kendisi başlatır. ' +
  'Bu yüzden bağımlı adımlar dahil bütün planı tek seferde ver; araya girmen gerekmez.\n' +
  '- Her ajan aynı anda tek iş yapar; aynı ajana verdiğin görevler sırayla çalışır. Hız için işleri farklı ajanlara dağıt.\n' +
  '- Aynı dosyayı değiştiren iki görev aynı anda çalışmasın: ya tek görevde birleştir ya da "after" ile sırala.\n';

export function leadStart({ goal, workers, readOnly, maxSteps }) {
  return `Kullanıcının isteği:\n${goal}\n\nEkibin (görev verirken "agent" alanına @ işaretsiz adı yaz):\n${teamList(workers)}\n\n` +
    'Kurallar:\n' +
    '- Gerekirse önce projeyi incele, sonra işi parçalara böl ve her parçayı en uygun ajana ver: zor işleri güçlü modellere, basit işleri hızlı ve ucuz modellere.\n' +
    PARALLEL_RULES +
    '- Her görev tek başına anlaşılır olsun (ajan büyük resmi bilmiyor): hedef, ilgili dosyalar, kabul ölçütü.\n' +
    '- Görevler bitince raporları ve değişikliklerin diff\'i sana gelir; bir görev başarısız olursa diğerleri sürerken hemen haber verilir. ' +
    'Denetle; hata ya da eksik varsa somut bir düzeltme görevi ver. Test/çalıştırma gerekiyorsa komut çalıştırabilen bir ajana ver.\n' +
    '- Sen kod yazma; "tasks" içinde kod değil, talimat ver.\n' +
    (readOnly ? '- Bu çalışma SALT OKUNUR: ajanlar dosya değiştiremez; inceleme, analiz ve öneri görevleri ver.\n' : '') +
    `\nEn fazla ${maxSteps} denetim turun var.\n\n${LEAD_FORMAT}`;
}

/** `tasks` = [{ id, handle, task, after? }] */
function taskLines(tasks) {
  const state = (t) => (t.status === 'running' ? ' — yarıda kaldı' : t.status === 'waiting' ? ' — hiç başlamadı' : '');
  return tasks.map((t) => `- ${t.id} · @${t.handle}: ${clip(t.task, 200)}${t.after?.length && !t.status ? ` (bekliyor: ${t.after.join(', ')})` : ''}${state(t)}`).join('\n');
}

/** `reports` = [{ id, handle, task, ok, skipped?, secs?, text, applied?, failed? }] */
function reportBlocks(reports) {
  return reports.map((r) => {
    const extra = [];
    if (r.applied?.length) extra.push(`Ortak'ın uyguladığı dosyalar: ${r.applied.join(', ')}`);
    if (r.failed?.length) extra.push(`Uygulanamayan değişiklikler: ${r.failed.map((f) => `${f.path} (${f.error})`).join('; ')}`);
    const state = r.ok ? 'tamamlandı' : r.skipped ? 'ÇALIŞTIRILMADI' : 'HATA';
    return `### ${r.id} · @${r.handle} — ${state}${r.secs != null ? ` (${r.secs} sn)` : ''}\nGörev: ${clip(r.task, 600)}\n` +
      (extra.length ? `${extra.join('\n')}\n` : '') +
      `Rapor:\n${clip(String(r.text || '').trim() || '(boş)', 4000)}`;
  }).join('\n\n');
}

/** The run's task history (`log` = [{ id, handle, task, ok, skipped }]) for a lead that lost its session. */
function history(log) {
  if (!log?.length) return '';
  const rows = log.slice(-40).map((r) => `- ${r.id} · @${r.handle} — ${r.ok ? 'tamamlandı' : r.skipped ? 'çalıştırılmadı' : 'HATA'}: ${clip(r.task, 200)}`);
  return `Bu çalışmada şu ana kadar verilen görevler${log.length > 40 ? ' (son 40)' : ''}:\n${rows.join('\n')}\n\n`;
}

/** `reports` = [{ id, handle, task, ok, skipped?, secs?, text, applied?, failed? }] */
export function leadReport({ round, maxRounds, reports, running, waiting, diff, warnings, goal, resumed }) {
  const body = reportBlocks(reports);
  const busy = running.length || waiting.length;
  const final = round >= maxRounds;
  return (resumed ? '' : `Kullanıcının isteği:\n${goal}\n\n`) +
    `Denetim ${round}/${maxRounds}. Biten görevler:\n\n${body || '(yok)'}\n\n` +
    (running.length ? `Hâlâ süren görevler (bitince raporları gelecek; bunları yeniden verme):\n${taskLines(running)}\n\n` : '') +
    (waiting.length ? `Başlamayı bekleyen görevler:\n${taskLines(waiting)}\n\n` : '') +
    (warnings.length ? `Uyarılar:\n${warnings.map((w) => `- ${w}`).join('\n')}\n\n` : '') +
    `Son denetimden bu yana değişiklikler${running.length ? ' (süren görevlerin yarım değişiklikleri de olabilir)' : ''}:\n${diffBlock(diff)}\n\n` +
    (final
      ? 'Denetim sınırına ulaşıldı: yeni görev veremezsin. Sonuçları denetle ve kullanıcıya yapılanları ve kalan eksikleri özetle (done:true).'
      : 'Denetle. Düzeltme ya da yeni iş gerekiyorsa görev ver: hemen başlarlar, süren görevlere "after" ile de bağlayabilirsin. ' +
        (busy
          ? 'Şimdilik verecek görevin yoksa boş "tasks" ve done:false ver; kalan görevler bitince yeniden sorulursun.'
          : 'İş bittiyse done:true ile bitir.') +
        (round === maxRounds - 1 ? ' Bir sonraki denetim SON tur: ondan sonra yeni görev veremeyeceksin.' : '')) +
    `\n\n${LEAD_FORMAT}`;
}

export function leadUser({ text, workers, maxSteps, goal, resumed, log }) {
  return (resumed ? '' : `İlk istek:\n${goal}\n\nEkibin:\n${teamList(workers)}\n\nKurallar:\n${PARALLEL_RULES}\n${history(log)}`) +
    `Kullanıcının yeni mesajı:\n${text}\n\nBuna göre ekibe görev ver ya da iş gerekmiyorsa done:true ile cevapla. En fazla ${maxSteps} denetim turun var.\n\n${LEAD_FORMAT}`;
}

/** Prepended when the lead's session was lost: the context a fresh session needs. */
export function leadRecap({ goal, workers, log }) {
  return `Kullanıcının isteği:\n${goal}\n\nEkibin (görev verirken "agent" alanına @ işaretsiz adı yaz):\n${teamList(workers)}\n\n` +
    `Kurallar:\n${PARALLEL_RULES}\n${history(log)}` +
    '(Önceki oturumun kayboldu; gerekirse projenin şu anki hâlini dosyaları okuyarak incele.)\n\n';
}

/**
 * The run stopped mid-way (usage limit, error, cancel, restart) and the user wants to go on:
 * reports the lead never saw + tasks that didn't finish.
 */
export function leadResume({ text, interrupted, unseen, open, log, workers, maxSteps, goal, resumed }) {
  return (resumed ? '' : `Kullanıcının isteği:\n${goal}\n\nEkibin (görev verirken "agent" alanına @ işaretsiz adı yaz):\n${teamList(workers)}\n\nKurallar:\n${PARALLEL_RULES}\n${history(log)}`) +
    `Çalışma yarıda kesilmişti${interrupted?.reason ? ` (${clip(interrupted.reason, 300)})` : ''}.\n\n` +
    (unseen.length ? `Sen görmeden biten görevlerin raporları:\n\n${reportBlocks(unseen)}\n\n` : '') +
    (open.length
      ? `Bitmeyen görevler — gerekiyorsa yeni id ile yeniden ver (eski id'lere "after" ile bağlanamazsın):\n${taskLines(open)}\n\n`
      : '') +
    `Kullanıcının mesajı:\n${text}\n\n` +
    'Gerekirse projenin şu anki hâlini dosyaları okuyarak kontrol et, sonra kaldığın yerden devam et: eksik ve hatalı kalan işleri ekibe dağıt ya da iş bittiyse done:true ile özetle. ' +
    `En fazla ${maxSteps} denetim turun var.\n\n${LEAD_FORMAT}`;
}

export function leadFixFormat() {
  return `Cevabında geçerli bir JSON bloğu bulamadım. Kararını yalnızca şu biçimde tekrar ver:\n\n${LEAD_FORMAT}`;
}

export function leadWorkerTask({ goal, task, files, leadName, canRun = true }) {
  return `Yöneticin (${leadName}) sana bir görev verdi.\n\nGenel hedef (kullanıcının isteği):\n${goal}\n\nSenin görevin:\n${task}\n\n` +
    (files?.length ? `İlgili dosyalar: ${files.join(', ')}\n\n` : '') +
    (canRun ? '' : 'Bu çalışmada komut çalıştırma iznin yok: komut/test çalıştırmayı deneme; gerekirse yöneticin testleri başka bir ajana koşturur.\n\n') +
    'Ekipteki başka ajanlar aynı anda başka görevler üzerinde çalışıyor olabilir: yalnızca kendi görevinin dosyalarına dokun. ' +
    'Yalnızca bu görevi proje klasöründe yap; git commit yapma. Bitince ne yaptığını kısaca raporla.';
}
