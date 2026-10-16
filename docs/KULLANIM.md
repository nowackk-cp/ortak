# Ortak — Ayrıntılı kullanım kılavuzu

Bilgisayarında zaten giriş yapmış olduğun yapay zekâ kodlama ajanlarını — **Claude Code**,
**OpenAI Codex**, **Google Antigravity**, **Gemini** (web, ör. 4 Argon), **OpenCode**, **Kilo Code**,
**GitHub Copilot**, **JetBrains Junie** ve **EVREN** (SSYZ LLM API'si) — tek bir uygulamadan yönetmek için yerel bir arayüz.
Her ajan kendi aboneliğinle / kendi limitinle (ya da ücretsiz modelleriyle) çalışır; Ortak sadece onları yönetir.
Sol paneldeki **Ajanlar** bölümünde her birinin kalan limitini canlı görürsün.

## İki arayüz: Sohbet ve Kod

Sol üstteki **Sohbet | Kod** düğmesi, Claude uygulamalarındaki gibi iki ayrı arayüz arasında geçiş yapar:

- **Sohbet** — claude.ai gibi: proje klasörü yok, herhangi bir ajanın herhangi bir modeliyle konuşursun.
  Modlar: **Tek model**, **Grup sohbeti**, **Beyin fırtınası**. Ajanlar dosyalara ve komutlara dokunmaz
  (her zaman salt okunur), sohbet asistanı gibi cevap verir. Sohbetlerin ayrı bir listede durur.
- **Kod** — Claude Code gibi: bir proje klasörü seçersin ve aşağıdaki altı modun hepsi kullanılır.

Her iki arayüzde de mesaja **dosya ve resim ekleyebilirsin**: mesaj kutusundaki ataç düğmesi, sürükle-bırak ya da yapıştır (Ctrl+V ile ekran görüntüsü de olur). En fazla 10 dosya; metin/kod dosyaları mesajın içine eklenir. Resimler (PNG, JPEG, WebP, GIF; mesaj başına 6, her biri en fazla 8 MB) şöyle gider: **Gemini web** resmi sohbet kutusuna yapıştırılmış olarak alır, **EVREN** resim görebilen modellere resmi doğrudan gönderir, **Claude Code / Codex** gibi dosya araçlı ajanlar resmi diskteki yolundan açar. Resimler sohbet balonunda küçük önizleme olarak görünür.

Her arayüz kendi seçtiğin modu ve ayarlarını hatırlar. Geçmişten bir çalışmayı açınca arayüz kendiliğinden ona geçer.

## Modlar (Kod arayüzü)

| Mod | Ne yapar |
|---|---|
| **Sohbet** | Tek bir ajanla Claude Code gibi çalışırsın: proje klasörü, dosya düzenleme, devam eden oturum. Dosya araçları olmayan modeller (Gemini web / 4 Argon, EVREN) de seçilebilir: Ortak onların "eli" olur — `LIST:` ile klasörlerde gezer, `READ:` ile dosya okur, verdikleri SEARCH/REPLACE değişikliklerini uygular, `RUN:` ile istedikleri terminal komutlarını çalıştırır (salt okunur yetkide değişiklik uygulanmaz). |
| **Yönetici** | Claude Code gibi, ama işi bir ekip yapar. Yönetici model (örn. Claude Opus) kod yazmaz: projeyi okur, işi parçalara böler, her parçayı en uygun alt ajana verir (örn. 4 Argon, GPT Sol, Gemini Flash, Sonnet, Haiku), raporları ve diff'leri denetler, eksik varsa düzeltme görevi verir; iş bitince özet yazar. Hangi uygulamada / API'de hangi modeller olduğunu üç yerde görürsün: **Ajanlar ve API'ler** penceresinde her ajanın altındaki *Modeller (N)* listesi (12'den fazlaysa arama kutusuyla); yeni çalışmada Yönetici → Otomatik ekip altında *Yönetici N model arasından seçer* kutusu; çalışmanın başında da yöneticinin gördüğü bütün modelleri listeleyen katlanır kart (başlangıç ekibindekiler "ekipte" etiketli, her modelin yanında ücret sınıfı ve geçmişi). Bir model listesi o an alınamazsa (yavaş bağlantı) son bilinen liste gösterilir. Yönetici bütün sağlayıcıların bütün modellerini (**model kataloğu**: OpenRouter'ın ücretsiz modelleri, EVREN'in GLM / DeepSeek modelleri, Copilot, Groq…) `sağlayıcı:model` adlarıyla görür ve her görev için modeli kendisi seçer; ekipte olmayan bir modele görev verirse Ortak onu ekibe katar. Görevler **paralel** çalışır: bağımsız işler hemen birlikte başlar (aynı anda en fazla 5; Gelişmiş → *Aynı anda görev*), bir işe bağlı olan iş (`after`) o biter bitmez kendiliğinden başlar. Aynı model meşgulken ona yeni görev gelirse Ortak o modelin yeni bir kopyasını açar (Gemini web ve Antigravity tek kopya: onlarda görevler sırayla çalışır, gerekirse model değiştirilir). Bir iş başarısız olursa yönetici, diğerleri sürerken hemen devreye girer. **Görev süre sınırı** (varsayılan 10 dk; Gelişmiş → *Görev süre sınırı*): bu sürede bitmeyen görev durdurulur ve başka bir modele verilir; yeni model önceki denemenin yarım bıraktığı değişikliklere bakması gerektiğini bilir. Ortak her modelin görevlerini ne kadar sürede bitirdiğini ve ne sıklıkla başarısız olduğunu kaydeder (`data/model-stats.json`); yönetici bu "geçmiş"i görür, yavaş ya da sık başarısız modellere küçük iş vermez. Junie yöneticiye **YAVAŞ** diye tanıtılır (her turda Java başlatır, sonra kendi planla → düzenle → doğrula → raporla döngüsünü çalıştırır; küçük bir iş bile dakikalar sürebilir). (Claude Code, Codex, Copilot gibi uygulamalar için aynı anda çalışma sınırı Ayarlar → *Aynı anda çalışan ajan*dan gelir.) Dosyalara erişemeyen ajanlar (Gemini web / 4 Argon) için Ortak "el" olur: istedikleri dosyaları okur, önerdikleri değişiklikleri (SEARCH/REPLACE) proje klasörüne uygular ve istedikleri komutları (`RUN:`, ör. testler) çalıştırır. Takip mesajı yöneticiye gider; *Hedef* menüsünden bir alt ajana doğrudan da yazabilirsin. **Ekip çalışırken de yazabilirsin**: mesajın yöneticiye hemen iletilir, yönetici planı günceller, yeni görev verir ya da artık gerekmeyen görevleri iptal eder (`cancel`). Kullanım limiti dolarsa çalışma hata vermez, **durur**: yapılanlar, yöneticinin henüz görmediği raporlar ve yarım kalan işler kaydedilir, yöneticinin oturumu korunur; limit yenilenince "devam et" yazman yeterli. Geçici hatalar (sunucu yoğunluğu, bağlantı, Claude Code giriş anahtarı yenileme çakışması) 20 sn ve 60 sn sonra kendiliğinden yeniden denenir. |
| **Grup Sohbeti** | Modeller tek bir ortak sohbette sırayla konuşur ve birbirleriyle gerçekten tartışır: `@codex` gibi birbirine hitap eder, soru sorar, itiraz eder. Anılan ajan sıradaki konuşmacı olur; ama iki ajan birbirini anıp dursa bile kimse bir turdan uzun bekletilmez. Her katılımcı uzlaşınca (`[UZLAŞI]`) ya da tur sınırında durur; sen istediğin an yazıp araya girersin, `@ad` ile birine doğrudan sorabilirsin. |
| **Beyin Fırtınası** | Seçtiğin modeller soruyu önce bağımsız cevaplar, sonra birbirinin cevabını görüp eleştirir ve geliştirir (1–4 tur). Moderatör sonunda ortak noktaları, ayrışmaları ve önerilen yolu özetler. Sonradan yazdığın mesaj yeni bir tur başlatır. |
| **Paralel** | Aynı görevi birden çok ajan, her biri kendi `git worktree`'sinde aynı anda yapar. Diff'leri yan yana görür, beğendiğini **Bunu uygula** ile projene uygularsın. |
| **Takım** | Bir ajan planlar, diğerleri adımları sırayla uygular, bir başkası inceler; sorun bulursa onay verene kadar düzeltme turları yapılır (varsayılan en fazla 3). Limit dolarsa durur, `devam et` ile kaldığı yerden sürer. Örn. Claude planlar → Codex yazar → Antigravity inceler. |

Aynı ajanı farklı modellerle birden çok kez ekleyebilirsin (örn. Claude Opus + Claude Haiku).

**Çalışma sürerken mesaj:** Yazmak için durmasını beklemen gerekmez. *Yönetici* mesajı hemen alır; *Takım* plan ve uygulama sırasında yazdığını not olarak alır (sonraki adımlar ve denetim dikkate alır); *Grup sohbeti*nde mesajın o anki konuşmadan hemen sonra sohbete katılır. Diğer modlarda mesaj **sıraya** girer ve tur bitince gönderilir; hemen gitmesini istiyorsan *Durdur*'a bas. Yazı kutusu boşken düğme *Durdur*, yazı varken *Gönder*'dir.

**Ajan kartları:** Yönetici modunda her görev kendi kartında görünür (aynı ajan iki görev yaparsa iki kart olur); kartta görev, çalışma süresi ve ajanın şu an ne yaptığı yazar. Art arda gelen araç çağrıları tek satırda toplanır (tıklayınca açılır). Bir ajan 2,5 dakikadır yeni çıktı vermiyorsa kartı sarıya döner; takıldığını düşünüyorsan karttaki ■ ile **yalnızca o ajanı** durdurabilirsin — çalışma sürer, yönetici görevi başka bir modele verebilir.

Kendi dosya araçları olmayan modeller (Gemini web / 4 Argon, EVREN, Groq, OpenRouter gibi API modelleri) her modda kod yazabilir: Ortak onların "eli" olur. Model `LIST: klasör` ile gezer, `READ: dosya` ile okur, değişiklikleri SEARCH/REPLACE blokları olarak verir; Ortak uygular ve sonucunu (uygulanamayan blokları dosyanın güncel hâliyle) geri bildirir. `RUN: komut` ile Codex gibi terminal de kullanırlar: Ortak komutu proje klasöründe çalıştırır (Windows'ta PowerShell, en fazla 2 dk) ve çıktıyı çıkış koduyla geri gönderir. Yetkiye göre:

| Yetki | Hangi komutlar çalışır |
|---|---|
| Salt okunur | Yalnızca hiçbir şeyi değiştirmeyenler (test, listeleme, `git status/diff/log`) |
| Düzenleme | Hepsi, şunlar hariç: `git commit/push/reset/checkout…`, global paket kurulumu, paket yayınlama, klasör silme, internetten indirip çalıştırma, sistem komutları |
| Tam yetki | Hepsi |

Bu gerçek bir sandbox değil (kurallar komut metnine bakar); her komut arayüzde kart olarak görünür.

Bu modellerin diğer araçları:

| İstek | Ne yapar |
|---|---|
| `READ: yol:120-260` | Dosyanın yalnızca o satırlarını gönderir. Büyük dosya kesildiğinde başlıkta hangi satırların geldiği ve devamının nasıl isteneceği yazar. |
| `GREP: desen` / `GREP: desen @ src/` | Tüm projede (ya da bir klasörde) arar, eşleşen satırları `dosya:satır` olarak gönderir (büyük/küçük harf duyarsız düzenli ifade; .gitignore'a uyar). |
| `FIND: *.test.js` / `FIND: src/**/*.ts` | Adı desene uyan dosyaları bulur. |
| `OUTLINE: src/a.js` | Dosyadaki fonksiyon, sınıf, metot ve tipleri satır numaralarıyla listeler (JS/TS, Python, Go, Rust, Java, C#, Kotlin, PHP, Ruby). |
| `SYMBOL: ad` | Bir fonksiyon/sınıf/tipin tanımlandığı yeri (`dosya:satır`) bulur. |
| `GIT: status` · `GIT: diff [yol]` · `GIT: log [yol]` · `GIT: show <commit>[:yol]` | Salt okunur git; `diff` son commit'ten bu yana yeni dosyalar dahil her değişikliği gösterir. |
| `WEB: sorgu` · `FETCH: https://…` | İnternette arar (DuckDuckGo) ya da bir sayfayı metin olarak okur. Yerel ağ adresleri her zaman kapalıdır; ayarlardan tamamen kapatılabilir. |
| `DELETE: yol` · `MOVE: eski -> yeni` | Dosya siler ya da taşır (yalnızca düzenleme yetkisinde; **Geri al** ile geri gelir). |
| **Geri al** | Ortak'ın bir turda yaptığı dosya değişiklikleri sohbette "N dosya değişti — Geri al" çubuğu olarak görünür. Geri al, dosyaları o turdan önceki hâline döndürür (yeni oluşturulanları siler). Sonradan değişen bir dosyanın üzerine yazmaz, onu atladığını söyler. |

**Gerçek araç çağırma (API modelleri).** EVREN, Groq ve OpenRouter'daki modellerin çoğu *function calling* destekler (Cline, Kilo gibi kodlama araçlarının DeepSeek'i kullandığı yöntem). Ortak bu modellere yukarıdaki yazı komutları yerine gerçek araçlar verir: `list_dir`, `find_files`, `read_file` (satır aralığıyla), `outline`, `find_symbol`, `grep`, `git`, `run_command`, `web_search`, `web_fetch` ve düzenleme için `edit_file`, `multi_edit` (bir dosyada birden çok değişiklik, hepsi ya da hiçbiri), `replace_lines`, `write_file`, `delete_file`, `move_file` (salt okunur yetkide düzenleme araçları verilmez). Araçları yine Ortak çalıştırır: aynı yetki kuralları, aynı araç kartları, aynı **Geri al** noktaları. Model istediği kadar araç çağırır (bir mesajda en fazla 40 adım), sonra cevabını yazar. Bu yöntem metin protokolünden daha güvenilirdir: ayrıştırma hatası ya da bozuk değişiklik bloğu olmaz.

- Araç desteklemeyen bir model seçilirse (ya da model aracı reddederse) Ortak bunu fark eder, bir not düşer ve aynı mesajı LIST/READ/RUN yöntemiyle yeniden yapar; o model için bundan sonra hep metin yöntemi kullanılır. OpenRouter ve EVREN hangi modelin araç desteklediğini kendileri bildirir (EVREN'de DeepSeek V4/V4.1 Flash, GLM 5.3, MiMo, Qwen ve Gemma destekler; "auto" desteklemez); Groq'da ilk denemede anlaşılır.
- Model bozuk bir araç çağrısı üretirse hatası kendisine söylenir ve yeniden denemesi istenir. Araç kullandıktan sonra boş cevap verip durursa devam etmesi hatırlatılır.

**Ücretsiz modeller için kolaylıklar** (iki yöntemde de):
- **Esnek eşleşme:** Aranan metin birebir bulunamazsa önce satır sonu boşlukları, sonra girinti farkı yok sayılır; yeni satırlar dosyanın girintisine oturtulur. Yine bulunamazsa hata mesajında dosyadaki en yakın yer gösterilir.
- **Sözdizimi kontrolü:** Değişen her `.js/.mjs/.cjs`, `.json` ve (Python kuruluysa) `.py` dosyası hemen kontrol edilir; hata varsa model aynı turda öğrenir ve düzeltir.
- **Proje talimatları ve haritası:** İlk mesajda `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.github/copilot-instructions.md` gibi dosyalar modele verilir. 150 dosyadan büyük projelerde dosya listesi yerine klasör haritası, diller ve `package.json` script'leri gider.
- **Bağlam bütçesi:** Okuma, arama ve komut çıktıları modelin kaldırabileceği kadar kısaltılır (Groq'un ücretsiz katmanında bir dosyadan en fazla ~6.000 karakter). Araç döngüsü uzayıp sınıra yaklaşınca eski araç çıktıları kısaltılır, en eski geçmiş turlar düşürülür.
- Sağlayıcı araç döngüsünün ortasında geçici olarak meşgul olursa (ör. EVREN "model şu anda dolu", 503) Ortak 10, 20 ve 40 sn bekleyerek kaldığı yerden devam eder; o ana kadar yapılan iş kaybolmaz.
- Groq'un ücretsiz planı dakikada 8.000 token ile sınırlı ve araç döngüsü her adımda sohbeti yeniden gönderir. Sağlayıcı "N sn sonra tekrar dene" derse (en fazla 45 sn) Ortak bekleyip kaldığı yerden devam eder.
- Gemini web'in araç çağırma arayüzü yoktur; o her zaman metin yöntemini kullanır.

Gemini web bir sayfa üzerinden sürüldüğü için Ortak sayfanın sağlığını izler: sayfa değişmiş görünürse (düğme, kutu ya da menü bulunamazsa), Gemini sayfada hata gösterirse ya da üst üste iki tur başarısız olursa Ajanlar ve API'ler penceresinde Gemini'nin altında sarı bir uyarı çıkar. İlk başarılı turda uyarı kalkar. Gemini bir mesajı alıp cevaba hiç başlamazsa Ortak bunu fark eder ve mesajı bir kez yeniden gönderir.

## Ajanlar ve modelleri

| Ajan | Nasıl bağlanır | Modeller |
|---|---|---|
| **Claude Code** | `claude -p` (kendi aboneliğin) | Opus, Sonnet, Haiku, Fable |
| **OpenAI Codex** | `codex exec` (ChatGPT hesabın) | GPT-6.1 Sol, Luna, Astra… |
| **Antigravity** | açık uygulamanın yerel dil sunucusu | Gemini Flash/Pro, Claude, GPT-OSS |
| **Gemini (web)** | Ortak'ın kendi Chrome penceresi | 4 Argon (düşünme düzeyleriyle), 3.1 Pro, Flash |
| **OpenCode** | `opencode run` | Hesapsız **ücretsiz** OpenCode Zen modelleri: DeepSeek V4.1 Flash, Big Pickle, Nemotron 3 Ultra / 3.5 Lightning / 3.5 Super VL, MiMo V2.6 Flash, Muse Spark 1.3, LongCat 2.5, Cat Jam, Space Bunny. Hesap bağlarsan (`opencode auth login`) o sağlayıcının modelleri de listeye gelir. |
| **Kilo Code** | `kilo run` | Kilo Gateway'in 300+ modeli. Hesapsız **ücretsiz** olanlar: Otomatik (ücretsiz), Nemotron 3 Ultra/Super/Nano/3.5, Laguna S/XS 2.1, Inkling Small, North Mini Code, Glyph Cluster, Dots3-Note, LFM2.5, OpenRouter Free. Diğerleri (Claude, GPT, Gemini, Grok, Qwen, GLM, Kimi…) Kilo hesabı + kredi ister; o zamana kadar listede kilitli görünür. |
| **GitHub Copilot** | `copilot` CLI (GitHub hesabın; `gh` girişi de yeter) | Copilot Free'de yalnızca **Otomatik** (Copilot modeli kendisi seçer, ör. GPT-6 Luna); ücretli planda hesabındaki tüm modeller. Kota: ayda 200 sohbet/ajan isteği (Free). |
| **Junie** | `junie` (JSON akışı) | **Junie Lite** (ücretsiz, varsayılan) ve JetBrains AI planı gerektiren modeller: Claude Fable 5.1 / Opus 5.5 / Opus 5 / Sonnet 5.5 / Sonnet 5 / Haiku 5.5, GPT-6-Astra / 6.1-Sol / 6-Sol / 6-Luna / 5.6-Sol / 5.6-Terra / 5.6-Luna, Gemini 3.8 / 3.7 / 3.6 Flash, Grok 4.7 / 4.6. Önce JetBrains hesabıyla giriş gerekir: Ajanlar ve API'ler penceresinde **Giriş yap** tarayıcıyı açar. Abonelik yoksa yalnızca Junie Lite çalışır. |
| **Groq** | Groq'un OpenAI-uyumlu API'si (LPU), kendi API anahtarınla (`data/groq.json` ya da `GROQ_API_KEY`) | Ücretsiz planın sohbet modelleri: Qwen 3.8 27B, GPT-OSS 120B / 20B… Çok hızlı. Ücretsiz plan: günde 1.000 istek, dakikada 8.000 token. Gerçek araç çağırır; dosyalara Ortak'ın "elleri" ile dokunur. |
| **OpenRouter** | OpenRouter'ın OpenAI-uyumlu API'si, kendi API anahtarınla (`data/openrouter.json` ya da `OPENROUTER_API_KEY`) | Yalnızca **ücretsiz** modeller (`:free`, `openrouter/free`); ücretli modeller listelenmez ve reddedilir. Araç destekleyen modeller gerçek araç çağırır; dosyalara Ortak'ın "elleri" ile dokunur. |
| **EVREN** | EVREN LLM Gateway'in OpenAI-uyumlu API'si (evren.ssyz.org.tr), kendi API anahtarınla | Anahtarının erişebildiği tüm sohbet modelleri (`/v1/models`'tan canlı okunur, sağlayıcıya göre gruplanır; düşünme düzeyi destekleyenler düzeyleriyle). Sadece metinle konuşur (Gemini web gibi): dosyalara Ortak'ın "elleri" ile dokunur. Kota ve kredi Ajanlar ve API'ler penceresinde görünür. |

Uzun model listeleri seçicide gruplanır (Ücretsiz, Anthropic, OpenAI…). Ajanlar ve API'ler penceresindeki **Giriş yap** /
**Hesap bağla** düğmeleri ajanın kendi giriş akışını (terminal penceresi ya da tarayıcı) açar; Ortak şifreni görmez.
Yeni bir ajan kullanılabilir olunca, daha önce kaydettiğin beyin fırtınası ve yönetici ayarlarına bir kez kendiliğinden eklenir.

## Çalıştırma

**Tek tık:** masaüstündeki **Ortak** ikonuna tıkla. Sunucu arka planda (pencere açmadan) başlar —
zaten çalışıyorsa yeniden başlatılmaz — ve Ortak, Chrome/Edge'de adres çubuğu olmayan ayrı bir
uygulama penceresinde açılır. Görev çubuğuna sabitlemek için ikona sağ tıkla → *Görev çubuğuna sabitle*.

| | |
|---|---|
| Kısayolları (yeniden) oluştur | `npm run kisayol` — Masaüstü + Başlat menüsü (*Ortak*, *Ortak'ı Durdur*) |
| Arka plandaki sunucuyu kapat | Başlat menüsü → *Ortak'ı Durdur* veya `npm run durdur` (çalışan ajanları iptal eder) |
| Kod güncellendikten sonra | önce durdur, sonra ikona tıkla |
| Sunucu günlüğü | `data/server.log` |

Elle çalıştırmak istersen: `npm start` ve tarayıcıda <http://127.0.0.1:4747>. Sunucu sadece bu
bilgisayardan erişilebilir. Gerçek ajanları harcamadan arayüzü denemek için `npm run mock`
(listeye bir "Test Ajanı" ekler).

## Performans

Üst çubuktaki **hız göstergesi** simgesi Performans ayarlarını açar (değişiklikler hemen uygulanır):

| Ayar | Varsayılan | Ne işe yarar |
|---|---|---|
| Aynı anda çalışan ajan | 5 | Claude Code, Codex, OpenCode, Kilo, Copilot ve Junie her tur için ayrı bir program başlatır; fazlası sıraya girer ("Sırada" yazar). |
| Düşük öncelik | açık | Ajanlar ve Ortak'ın açtığı pencereler işlemciyi oyun, tarayıcı gibi programlara bırakır. |
| Gemini penceresini boşta kapat | 10 dk | Sonraki turda simge durumunda yeniden açılır. |
| Antigravity'yi gerektiğinde aç | açık | Antigravity'yi kapalı tutabilirsin; ihtiyaç olunca Ortak açar. |
| Ortak'ın açtığı Antigravity'yi boşta kapat | kapalı | Sadece Ortak'ın açtığı örneği, normal şekilde kapatır. |
| Limitleri otomatik yenile | 5 dk | Pencere arka plandayken hiç yenilenmez. |

**Hafif mod** düğmesi yoğun bir bilgisayar için hepsini birden kısar (tek ajan, kısa uyku süreleri).
Kapalı olup gerektiğinde açılacak ajanlar Ajanlar ve API'ler penceresinde **uykuda** etiketiyle görünür. Arayüz,
akan metni saniyede en fazla ~20 kez çizer; pencere arka plandayken neredeyse hiç çizmez.

## Gereksinimler

- Node.js 22+ (npm paketi gerekmez)
- **Claude Code**: `claude` komutu kurulu ve giriş yapılmış
- **Codex**: `codex` komutu kurulu ve `codex login` yapılmış
- **Antigravity**: uygulama kurulu ve **açık** olmalı. Kapalıysa Ajanlar ve API'ler penceresindeki **Başlat** butonu açar.
- **Gemini (web)**: Chrome veya Edge. Ajanlar ve API'ler penceresinde Gemini → **Başlat**, Ortak'a ait ayrı bir Gemini penceresi
  açar. İlk seferde o pencere normal modda açılır: Google hesabınla giriş yap, pencereyi kapat, tekrar **Başlat**
  (Google, kontrol edilen bir tarayıcıda girişe izin vermiyor; oturum profilde kalıyor). Gemini uygulamandaki
  modeller (4 Argon ve düşünme düzeyi, 3.1 Pro, Flash) bu yolla kullanılır. Kendi dosya araçları yok, ama Ortak onun
  "eli" olur: Sohbet, Yönetici, Takım ve Paralel modlarında klasörlerde gezer, dosya okur ve değişiklik yapar
  (terminal komutlarını da Ortak çalıştırır). Sohbetler Gemini geçmişinde görünür.
- **OpenCode** (`npm i -g @opencode/cli`) ve **Kilo Code** (`npm i -g @kilocode/cli`): kurulu olmaları yeter, ücretsiz modeller hesapsız çalışır.
- **GitHub Copilot** (`npm i -g @github/copilot`): `copilot login` ya da `gh auth login` ile giriş yapılmış olmalı.
- **Junie**: junie.jetbrains.com/cli kurulumu; ilk seferde Ajanlar ve API'ler penceresinden **Giriş yap** (JetBrains hesabı).
- **EVREN**: API anahtarı `data/evren.json` dosyasında (`{"apiKey": "evren_llm_…"}`, git'e girmez) ya da `EVREN_API_KEY` ortam değişkeninde. İlk kullanımdan önce Ajanlar ve API'ler penceresinde **Şartları kabul et** (EVREN kullanım şartları, metni: `/v1/terms/text`).
- Codex bu bilgisayarda yoksa `npm run araclar` onu Ortak klasörüne (`tools/`) kurar.
- Paralel mod için proje klasörü en az bir commit'i olan bir git deposu olmalı.

## Yetki seviyeleri

| | Claude Code | Codex | Antigravity | OpenCode / Kilo | Copilot | Junie |
|---|---|---|---|---|---|---|
| **Salt okunur** | sadece okuma araçları | `read-only` sandbox | talimat + ihlalde durdurma ⚠️ | düzenleme ve kabuk araçları kapalı | yazma ve kabuk araçları reddedilir | yalnızca okuma/arama araçları (PreToolUse kancası) |
| **Düzenleme** | dosya düzenleme otomatik onaylı, onay isteyen komutlar reddedilir | `workspace-write` sandbox | talimat + klasör dışına yazınca durdurma ⚠️ | proje içinde düzenleme; kabuk ve klasör dışı kapalı | düzenleme açık (proje klasörü); kabuk reddedilir | düzenleme açık; komutlar reddedilir (PreToolUse kancası) |
| **Tam yetki** | onaysız | onaysız, sandbox yok | onaysız | onaysız | `--allow-all` | her izin onaylanır |

⚠️ **Antigravity'de izinler zorunlu değil.** Antigravity'nin araç kısıtlamaları dışarıdan zorlanamıyor
ve Windows 10'da komut sandbox'ı yok. Salt okunur/düzenleme modunda ajana talimat verilir ve yasak
bir işlem görülürse tur durdurulur — ama işlem engellenmez, sadece sonradan yakalanır. Antigravity'yi
önemli projelerde düzenleme rolünde kullanırken bunu bil.

## Güvenlik

- Ortak hiçbir giriş bilgisini (token, `auth.json`, `.credentials.json`) okumaz veya bir yere göndermez.
  Antigravity'ye, açık olan uygulamanın kendi yerel dil sunucusu üzerinden bağlanır. Copilot'un hesap/kota/model
  bilgisi Copilot'un kendi SDK sunucu modundan (`copilot --headless`) gelir; girişleri ajanların kendi akışları yapar.
- Sunucu sadece `127.0.0.1`'e bağlanır; başka sitelerden gelen istekleri (Host/Origin kontrolü) reddeder.
- "Tam yetki" ajanlara onaysız ve sandbox'sız komut çalıştırma izni verir; sadece güvendiğin klasörlerde kullan.

## Bilinen sınırlamalar

- Codex, OpenCode ve Kilo canlı yazım akışı (token token) vermiyor; cevaplar mesaj mesaj gelir.
- OpenCode ve Kilo'nun ücretsiz modelleri zaman zaman yavaşlar ya da hiç cevap vermez; 8 dakika hiçbir olay
  gelmezse tur "cevap vermedi" hatasıyla biter (başka bir model seçin). Ücretsiz model listesi sık değişir.
- Junie ücretsiz hesapta yalnızca **Junie Lite** modelini çalıştırır; listedeki diğer modeller JetBrains AI
  aboneliği ister ve abonelik yoksa "yetki hatası" ile biter.
- Junie adım adım ilerler (canlı yazım akışı yok) ve cevabını kendi görev raporu biçiminde ("Changes",
  "Verification") verir.
- Claude'un limit bilgisi `claude /usage` çıktısından okunur; Claude Code çıktı biçimini değiştirirse bozulabilir.
- Antigravity entegrasyonu uygulamanın iç (yerel) API'sini kullanır; Antigravity güncellemeleri bunu bozabilir.
- Hesabının kullanamadığı modeller (ör. Antigravity'de **Gemini 4 Argon** — Google AI Ultra planı
  gerekiyor) listede "kilitli" görünür ve seçilemez.
- **Gemini (web)** gemini.google.com sayfasını Ortak'ın kendi Chrome penceresinde kullanıcı gibi kullanır
  (yazar, gönderir, cevabı okur). Bu resmî bir API değil: Google sayfayı değiştirirse bozulabilir ve Google
  otomatik kullanımı kurallarında kısıtlıyor — hesabını riske atmamak için yoğun kullanma. Turlar sırayla
  işlenir (aynı anda tek Gemini mesajı); kotası Ortak'ta görünmez. Gemini masaüstü uygulaması ve Gemini CLI
  bu iş için kullanılamıyor (uygulamanın API'si yok, CLI kişisel hesapları artık kabul etmiyor).

## Yapı

```
server/index.js            HTTP + SSE sunucu
server/orchestrator/       Sohbet, Yönetici, Grup, Beyin Fırtınası, Paralel, Takım modları (prompts.js: ajanlara giden şablonlar,
                           CHAT_SURFACE: Sohbet arayüzünün talimatı;
                           textcoder.js: dosyaya erişemeyen ajanlar için Ortak'ın oku/düzenle "elleri")
server/adapters/           claude.js, codex.js, antigravity.js, geminiweb.js (+ cdp.js), opencode.js + kilo.js (opencode-core.js),
                           copilot.js, junie.js (+ acp.js), evren.js (HTTP API), mock.js — yeni ajan = yeni adaptör
web/                       arayüz (derleme adımı yok)
scripts/try-adapter.mjs    tek bir adaptörü elle deneme
Ortak.vbs                  tek tık başlatıcı (scripts/launch.mjs'i pencere açmadan çalıştırır)
scripts/launch.mjs         sunucu kapalıysa arka planda başlatır, uygulama penceresini açar
scripts/install-shortcuts.ps1, scripts/stop.mjs, scripts/make-icon.mjs (assets/ortak.ico)
```

Ayrıntılı mimari ve sözleşme: [docs/CONTRACT.md](CONTRACT.md)
