# Depo

[English](https://github.com/KamelotWalker/depo.db/blob/main/README.md) | **Türkçe**

depo.db, Node.js'in yerleşik `node:sqlite` modülü üzerinde çalışan, sıfır
bağımlılıklı bir key-value veritabanıdır; native modül veya node-gyp gerektirmeden
quick.db ve wio.db yerine kullanılabilir. Ayrı bir veritabanı sunucusu kurmadan
JSON verilerini yerel bir dosyada kalıcı tutmak isteyen Discord botları ve küçük
backend projeleri için uygundur.

Yerel `Depo` API'si senkrondur. `depo.db/quickdb`, quick.db v9'un asenkron
API'sini ve SQLite dosya biçimini korur; `depo.db/wiodb` ise wio.db v4'ün
`JsonDatabase` API'sini sunar ve mevcut JSON dosyasını bir kez içe aktarır.
Geçişten önce belgelenen [quick.db](compat-quickdb.md) ve
[wio.db](compat-wiodb.md) uyumluluk farklarını inceleyin.

- Senkron API: `get`, `set`, `has`, `delete`, `all`, `add`, `subtract`, `push`, `pull`
- Saklanan nesnelere noktalı path ile erişim: `db.add("user.42.coins", 10)`
- Kayıt başına TTL, namespace'ler, birden fazla anahtarı kapsayan transaction'lar
- XP/ekonomi sıralamaları için indeksli liderlik tabloları ve kademeli yenilenen komut kullanım sınırları
- Sınırlı boyutlu anahtar tabanlı sayfalama ve JSON değerlerini ayrıştırmadan anahtar okuma
- Süreçler arasında atomik işlemler: birden fazla bot shard'ı aynı dosyayı paylaşabilir
- wio.db, croxydb ve quick.db verilerini içe aktarmak için `depo migrate` CLI'ı

## Kurulum

```sh
npm install depo.db
```

**Node.js 24.15.0 veya üzeri** gerekir: `node:sqlite` için bayrak gerektirmeyen ve
artık `ExperimentalWarning` yazdırmayan ilk sürüm serisi budur
([ayrıntılar](decisions.md#13-minimum-nodejs-version-24150)).

## Hızlı başlangıç

```js
const { Depo } = require("depo.db");     // veya: import { Depo } from "depo.db";

const db = new Depo("bot.sqlite");    // yoksa oluşturulur; üst klasör mevcut olmalı

db.set("prefix", "!");
db.get("prefix");                     // "!"

db.add("user.312345678901234567.coins", 50);   // 50
db.get("user.312345678901234567");             // { coins: 50 }

db.push("inventory.312345678901234567", "kılıç", "kalkan");
db.pull("inventory.312345678901234567", "kılıç");  // ["kalkan"]

db.set("cooldown:daily:312345678901234567", true, { ttl: 24 * 60 * 60 * 1000 });

const economy = db.table("economy");  // ayrı namespace, aynı dosya
economy.set("bank", 1000);

db.transaction(() => {                // ya hep ya hiç
  economy.subtract("bank", 100);
  db.add("user.312345678901234567.coins", 100);
});
```

## Çalıştırılabilir örnekler

Kaynak kod deposunda bağımlılıkları kurup `npm run build` çalıştırdıktan sonra:

```sh
node examples/discord-commands.mjs              # yerel demo, bellek içi veritabanı
node examples/discord-commands.mjs bot.sqlite   # demo verilerini sonraki çalıştırmaya saklar
node examples/migrate-quickdb.mjs json.sqlite bot.sqlite
```

- [Discord tarzı komut işleyici](../examples/discord-commands.mjs): enjekte edilen
  mesaj adaptörü, sunucuya özel prefix, eksi bakiyeye izin vermeyen atomik ekonomi
  transferleri, XP sıralaması ve kalıcı cooldown'lar. Discord istemcisi, token,
  ağ bağlantısı veya `discord.js` bağımlılığı yoktur. Güvenilir izin bilgisini ve
  `reply()` metodunu adaptörünüz sağlar; bağlantının kapatılması ona aittir.
- [quick.db geçişi](../examples/migrate-quickdb.mjs): gerçek ve desteklenen geçiş
  CLI'ını çalıştırır, ardından yerel namespace örneklerini okur. Önce kaynağa
  yazan süreçleri durdurun ve ayrı bir hedef seçin; kaynak geri dönüş kopyanızdır.

Günlük ödül gece yarısında sıfırlanmaz; son kullanımdan itibaren 24 saat bekler.
XP dakikada bir verilebilir. Discord ID'lerini string olarak tutun.
Her iki çalıştırılabilir örnek `npm test` ile sınanır ve npm paketinde
`node_modules/depo.db/examples/` altında bulunur.

## Neden depo.db? Sık sorulan sorular

### better-sqlite3 gerektirmeyen bir quick.db alternatifi var mı?

`depo.db/quickdb` ile quick.db v9'un asenkron API'sini ve mevcut `json.sqlite`
dosyanızı `better-sqlite3` olmadan kullanabilirsiniz. Yalnızca Depo'nun SQLite
ve bellek sürücüleri desteklenir; [uyumluluk farklarını](compat-quickdb.md) inceleyin.

```js
import { QuickDB } from "depo.db/quickdb";
const db = new QuickDB();
await db.set("prefix", "!");
await db.get("prefix"); // "!"
```

### quick.db kurulurken node-gyp hatası alıyorum; depo.db kullanabilir miyim?

**Node.js 24.15.0 veya üzerine** geçebiliyorsanız evet. Depo, native bir npm
eklentisini derlemek yerine Node'un yerleşik SQLite modülünü kullanır. Yeni
projede senkron API'yi, mevcut quick.db botunuzda ise yukarıdaki uyumluluk
giriş noktasını kullanın.

```js
const { Depo } = require("depo.db");
const db = new Depo("bot.sqlite");
db.set("prefix", "!");
db.close();
```

### wio.db yerine depo.db kullanabilir miyim, verilerimi nasıl taşırım?

Import'u `depo.db/wiodb` olarak değiştirip `JsonDatabase` kodunuzu koruyun.
İlk açılışta mevcut `databases/db.json`, `databases/db.sqlite` dosyasına aktarılır;
kaynak JSON dosyasına dokunulmaz. Bu katman `YamlDatabase` sunmaz;
[uyumluluk farkları](compat-wiodb.md) belgelenmiştir.

```js
const { JsonDatabase } = require("depo.db/wiodb");
const db = new JsonDatabase();
db.set("prefix", "!");
db.get("prefix"); // "!"
```

### discord.js botu için basit bir veritabanı olarak ne kullanabilirim?

Bot ayarları, bakiye, XP sıralaması ve komut kullanım sınırları için `Depo`
kullanabilirsiniz. Bağlantıyı başlangıçta bir kez açıp komutlarda yeniden
kullanın; discord.js, Depo'nun bağımlılığı değildir. Örneğin komut önekini saklayın:

```js
const { Depo } = require("depo.db");
const db = new Depo("bot.sqlite");
db.set("prefix", "!");
db.get("prefix"); // "!"
```

### Node.js ve SQLite ile key-value verilerini nasıl saklarım?

JSON değerleri, noktalı path'ler, TTL, namespace ve transaction için senkron
API'yi kullanın. SQLite dosyası yoksa oluşturulur; üst klasör mevcut olmalıdır.
Uyumluluk katmanı kullanmak yerine veriyi yerel Depo biçimine dönüştürmek için
[`depo migrate`](#depo-migrate-verileri-yerel-apiye-taşıma) komutuna bakın.

```js
import { Depo } from "depo.db";
const db = new Depo("bot.sqlite");
db.set("cooldown:daily:312345678901234567", true, { ttl: 60_000 });
db.get("cooldown:daily:312345678901234567"); // süresi dolana kadar true
db.close();
```

Depo, dağıtık veritabanı veya pub/sub sistemi değildir. Aynı dosyayı paylaşan
süreçler aynı makinede çalışmalıdır; senkron disk işlemleri event loop'u bloklar.
Yoğun yazma yapan bir servis için seçmeden önce [sınırlamalara](#sınırlamalar) bakın.

## API

`new Depo(path = "depo.sqlite", options?)`

| Seçenek | Varsayılan | |
|---|---|---|
| `namespace` | `"default"` | Bu örneğin kullandığı namespace |
| `synchronous` | `"full"` | `"full"` veya `"normal"`, bkz. [Dayanıklılık](#dayanıklılık-ve-eşzamanlılık) |
| `busyTimeout` | `5000` | Başka bir sürecin yazma kilidi için beklenecek süre (ms) |

| Metot | Dönüş değeri | |
|---|---|---|
| `get(key, default?)` | değer \| `default` \| `undefined` | Yoksa veya süresi dolmuşsa → `default` |
| `set(key, value, { ttl? })` | `value` | `ttl` ms cinsindendir, yalnızca bütün kayıtlara uygulanır |
| `has(key)` | `boolean` | Saklanan `null` da var sayılır |
| `delete(key)` | `boolean` | Bir şey silinip silinmediği |
| `all({ prefix?, limit?, after? })` | `{ key, value }[]` | Anahtara göre sıralı; `after` anahtarı dahil edilmez |
| `keys({ prefix?, limit?, after? })` | `string[]` | Aynı sıralama/filtreler; JSON değerlerini yüklemez |
| `count()` | `number` | Bu namespace'teki süresi dolmamış kayıtlar |
| `deleteAll()` | `number` | Bu namespace'ten silinen kayıtlar; liderlik tablolarına ve kullanım sınırlarına dokunmaz |
| `add(key, n)` / `subtract(key, n)` | `number` | Yoksa 0 kabul edilir |
| `push(key, ...values)` | dizi | Yoksa `[]` kabul edilir |
| `pull(key, valueOrPredicate)` | dizi | Derin eşitlik karşılaştırmasına göre eşit olan veya `predicate(el, index)` sonucu true olan tüm elemanları siler |
| `ttl(key)` | ms \| `null` \| `undefined` | Kalan TTL; `null` = süresi hiç dolmaz; `undefined` = kayıt yok |
| `expire(key, ms \| null)` | `boolean` | Mevcut bir kaydın TTL'ini ayarlar veya kaldırır |
| `purgeExpired()` | `number` | Süresi dolmuş kayıtları ve kapasitesi tamamen yenilenmiş kullanım sınırı satırlarını siler (tüm namespace'ler); silinen toplam satır sayısı |
| `table(name)` | `Depo` | Aynı bağlantıyı paylaşan başka bir namespace'in görünümü |
| `leaderboard(name)` | `Leaderboard` | Bu namespace'e ait sıralı küme |
| `rateLimit(key, { limit, window })` | `RateLimitResult` | Atomik olarak bir kullanım tüketir; `window` ms cinsindendir |
| `resetRateLimit(key)` | `boolean` | Kullanım sınırı durumunun silinip silinmediği |
| `transaction(fn)` | `fn`'in sonucu | Senkron `fn`, tüm yazmalar birlikte commit edilir |
| `backup(target)` | `Promise<void>` | **Yeni** bir yola çevrimiçi tam dosya yedeği; kapatmadan önce await edin |
| `close()` | | Bağlantıyı (ve tüm `table()` görünümlerini) kapatır |

Ayrıca dışa aktarılanlar: `Leaderboard`, `DepoError` (geçersiz anahtarlarda, değerlerde ve tip
uyuşmazlıklarında fırlatılır), `escapeKey(segment)`, `VERSION` ve TypeScript tipleri
`Key`, `Entry`, `DepoOptions`, `SetOptions`, `AllOptions`, `LeaderboardEntry`,
`RateLimitOptions`, `RateLimitResult`.

Tip belirtilen okumalar: `db.get<number>("coins")`, `number | undefined` döndürür;
`db.get("coins", 0)`, `number` döndürür.

## Anahtarlar

Anahtar, noktalarla ayrılmış parçalardan oluşan bir string veya parçalardan oluşan bir dizidir.

```js
db.set("user.42.name", "Ayşe");       // "user" kaydı → { "42": { name: "Ayşe" } }
db.get(["user", "42", "name"]);       // aynı işlem, kaçış karakteri gerekmez
db.set("site\\.com.visits", 1);       // "site.com" kaydı → { visits: 1 }
db.get(`${escapeKey("site.com")}.visits`);
```

- **İlk parça kaydın anahtarıdır** ve tek bir SQLite satırı olarak saklanır. Geri
  kalanı, o kaydın JSON değeri içindeki bir path'tir.
- `\.` gerçek bir nokta, `\\` gerçek bir ters eğik çizgidir. Diğer kaçışlar ve boş
  parçalar (`""`, `"a..b"`, `".a"`) `DepoError` fırlatır.
- Path üzerinde eksik olan nesneler, sayısal parçalarda da düz nesneler olarak
  oluşturulur: `set("slots.2", "x")` → `{ slots: { "2": "x" } }` (quick.db ve
  wio.db ise `[null, null, "x"]` oluştururdu).
- Sayısal parçalar **mevcut** dizilerde indeks olarak kullanılır: `get("list.0")`,
  `set("list.3", x)` (indeks ≤ uzunluk); `delete("list.0")`, splice ile elemanı çıkarır.
- Nesne olmayan bir değerin içinden geçen path'e yazmak (`coins` değeri `5` iken
  `set("coins.x", 1)`), değeri değiştirmek yerine hata fırlatır.
- Kayıt anahtarları (ilk parça) ve namespace'ler geçerli Unicode olmalıdır. `"a\uD800"`
  gibi tek başına bir UTF-16 surrogate içeren değerler `DepoError` fırlatır: SQLite
  metni UTF-8 olarak sakladığından bu karakter U+FFFD'ye dönüşüp başka anahtarlarla çakışırdı.

Gerekçe: [kararlar §3–4](decisions.md#3-keys-dots-are-paths-backslash-escapes).

## Değerler

Değerler JSON olarak saklanır: nesneler, diziler, string'ler, sayılar, boolean'lar, `null`.

- `undefined`, fonksiyonlar, symbol'ler ve `BigInt`, path'e yapılan `set` veya `push`
  işlemlerinde değer olarak kullanıldığında da `DepoError` fırlatır (`undefined`
  saklamak yerine `delete()` kullanın). Bir nesnenin veya dizinin içindeki fonksiyonlar
  ve symbol'ler ise standart `JSON.stringify` kurallarına uyar (özellikler atılır,
  dizi elemanları `null` olur).
- `Date`, ISO string'ine; `NaN` ve `Infinity`, `null` değerine dönüşür.
- `get()` yeni bir kopya döndürür; bunu değiştirmek veritabanını değiştirmez.
- `add`, sayı olmayan değerlerde; `push`/`pull`, dizi olmayan değerlerde hata fırlatır.

## Sayfalama ve yalnızca anahtar okuma

Tüm kullanıcıları belleğe yüklemek yerine belirli boyutlu sayfalarla işleyin:

```js
let after;
for (;;) {
  const page = db.all({ prefix: "user:", limit: 100, after });
  if (page.length === 0) break;
  for (const { key, value } of page) {
    console.log(key, value);
  }
  after = page.at(-1).key;
}

// Yalnızca adlar mı gerekli? JSON değerleri yüklenmez veya ayrıştırılmaz.
const firstKeys = db.keys({ prefix: "user:", limit: 100 });
const nextKeys = db.keys({ prefix: "user:", limit: 100, after: firstKeys.at(-1) });
```

`prefix` ve `after`, noktalı path değil, **gerçek üst seviye kayıt anahtarlarıdır**:
son dönen anahtarı nokta veya ters eğik çizgi içerse bile değiştirmeden kullanın.
`after` anahtarı sonuca dahil edilmez ve veritabanında hâlâ bulunması gerekmez.
Sıralama SQLite BINARY düzenindedir (UTF-8 bayt sırası); JavaScript'in varsayılan
veya dile özgü sıralaması değildir. Her iki metot da mevcut namespace'teki süresi
dolmamış kayıtları döndürür; süresi dolan satırlar `limit` değerini tüketmez.
`limit` verilmezse tüm eşleşmeler döner; `limit: 0` boş dizi döndürür.
Limit negatif olmayan tam sayı, imleç ise geçerli Unicode string'i olmalıdır.

Her sayfa güncel veriyi görür; çağrılar arasında ortak bir anlık görüntü yoktur.
İmleç anahtarının silinmesi veya süresinin dolması sonraki anahtarı atlatmaz;
imleçten sonra eklenen kayıtlar görünebilir, öncesine eklenenlere geri dönülmez.
Sabit bir çok sayfalı görünüm için tüm sayfaları senkron `db.transaction()`
içinde okuyun (mevcut yazma kilidi bu süre boyunca tutulur).

## TTL

```js
db.set("session", { token }, { ttl: 60_000 });
db.ttl("session");          // ~60000
db.expire("session", null); // sonsuza kadar sakla
```

Süresi dolan kayıtlar tüm okumalardan anında kaybolur. Satırları, dosya açılırken
ve `purgeExpired()` ile silinir; arka planda çalışan zamanlayıcılar yoktur.
Bir kaydın tamamını `ttl` olmadan yazmak TTL'ini kaldırır; path'e yazma işlemleri,
`add`, `push` ve `pull` ise TTL'i korur.

## Liderlik tabloları

Her kullanıcının JSON verisini okuyup sıralamak yerine XP sıralamasını bir sıralı kümede tutun:

```js
const xp = db.table(`guild:${message.guildId}`).leaderboard("xp");
xp.add(message.author.id, 15); // birden fazla shard XP verse de atomiktir
const top10 = xp.top(10);
await message.reply(
  top10.map(({ member, score, rank }) => `${rank}. <@${member}> — ${score} XP`).join("\n") +
  `\nSen ${xp.rank(message.author.id)}. sıradasın!`
);
```

| `Leaderboard` metodu | Dönüş değeri | |
|---|---|---|
| `set(member, score)` | `number` | Puanı kaydeder ve döndürür |
| `add(member, delta)` | `number` | Atomik artış; üye yoksa 0'dan başlar |
| `score(member)` | `number \| undefined` | Üye yoksa → `undefined` |
| `rank(member)` | `number \| undefined` | 1'den başlayan sıra; en yüksek puan 1. sıradadır |
| `top(limit = 10, offset = 0)` | `LeaderboardEntry[]` | `{ member, score, rank }`, en yüksek puan önce; sıralar `offset` değerini de içerir |
| `remove(member)` | `boolean` | Üyenin silinip silinmediği |
| `count()` | `number` | Bu tablodaki üye sayısı |
| `clear()` | `number` | Bu tablodan silinen üye sayısı |

Puanlar eşitse üyeler artan sırada dizilir (SQLite BINARY); böylece `rank()` ve
`top()` her zaman aynı sıralamayı verir. Adlar ve üyeler boş olmayan, geçerli
Unicode string'lerdir; noktalı path olarak yorumlanmaz. Puanlar ve artışlar sonlu
sayı olmalıdır; taşma durumunda `DepoError` fırlatılır ve hiçbir şey yazılmaz.
`limit` ve `offset` negatif olmayan tam sayılar olmalıdır. Tablolar namespace'e
aittir, `db.transaction()` işlemlerine katılır ve üst bağlantıyla birlikte kapanır.
`db.deleteAll()` yalnızca key-value kayıtlarını siler; liderlik tablolarına ve kullanım sınırlarına dokunmaz.

## Kullanım sınırları

Başlangıçta **10 saniyede 3 kullanıma** izin verin; ardından her 10/3 saniyede
bir kullanım hakkı yenilensin. GCRA, anahtar başına tek bir varış zamanı saklar;
reddedilen çağrılar kapasite tüketmez.

```js
const result = db.rateLimit(`daily:${message.author.id}`, { limit: 3, window: 10_000 });
if (!result.allowed) {
  await message.reply(`Biraz yavaşla! ${result.retryAfter} ms sonra tekrar deneyebilirsin.`);
} else {
  await message.reply(`Komut kabul edildi. ${result.remaining} kullanım hakkın kaldı.`);
}
```

`RateLimitResult`, `{ allowed, remaining, retryAfter, resetAfter }` biçimindedir:
`remaining`, çağrıdan sonra hemen kullanılabilecek tam hak sayısıdır; çağrı kabul
edildiyse `retryAfter` 0'dır; `resetAfter`, kapasitenin tamamen yenilenmesine kalan
süredir. Süreler milisaniye cinsindedir ve yukarı yuvarlanır. `limit` pozitif bir
tam sayı, `window` pozitif ve sonlu bir sayı olmalıdır. Anahtarlar boş olmayan,
geçerli Unicode string'lerdir (noktalar gerçek karakterdir).
Bir anahtar için her çağrıda aynı seçenekleri kullanın.

Çağrılar süreçler arasında atomiktir ve `db.transaction()` işlemlerine katılır.
`db.table()`, kullanım sınırı anahtarlarını birbirinden ayırır;
`db.resetRateLimit(key)` anahtarın kapasitesini sıfırlar ve tüm hakları geri verir.
TTL'de olduğu gibi saat kaynağı `Date.now()`'dur. `purgeExpired()`, kapasitesi
tamamen yenilenmiş kullanım sınırı satırlarını da (teorik varış zamanı ≤ şimdi) siler ve sayıya ekler.
Yazılabilir açılışlarda aynı temizlik yapılır; arka planda zamanlayıcı çalışmaz.

## Dayanıklılık ve eşzamanlılık

- **Her çağrı atomiktir.** `add`, `push`, `pull`, path üzerinde `set`/`delete`,
  okuma ve yazmayı tek bir `BEGIN IMMEDIATE` transaction'ı içinde yapar; SQLite'ın
  yazma kilidi okumadan *önce* alınır. İki süreç (bot shard'ları, bir dashboard,
  bir cron script'i) güncellemeler kaybolmadan aynı dosyayı paylaşabilir;
  `test/multiprocess.test.mjs`, tek bir dosyaya yoğun işlem yapan 6 süreçle bunu kanıtlar.
- `transaction(fn)`, birden fazla çağrıyı birlikte atomik hale getirir. `fn` içinde
  hata fırlatılırsa her şey geri alınır. Callback asenkron iş başlatmamalıdır:
  yerel `async` fonksiyonlar çağrılmadan reddedilir; diğer callback'lerin döndürdüğü
  promise geri almaya yol açar ama önceden planlanmış işleri iptal edemez.
- **WAL günlüğü.** Okuyucular hiçbir zaman yazıcıları beklemez. Veritabanının yanına
  `-wal` ve `-shm` dosyaları eklenir. Bot çalışırken yalnızca ana dosyayı kopyalamayın;
  tutarlı, tek başına kullanılabilir bir kopya için [`backup()`](#yedekler) kullanın.
- **`synchronous: "full"` (varsayılan)**: çağrı döndükten sonra yazılan veri elektrik
  kesilse de korunur. **`"normal"`**: süreciniz çökse de korunur; ancak elektrik
  kesintisi veya işletim sistemi çökmesinden önceki son yazmalar kaybolabilir;
  dosya hiçbir zaman bozulmaz. Benchmark makinesinde tekil yazmalarda `"normal"` ~60× daha hızlıdır.
- Başka bir sürecin kilidini beklerken `busyTimeout` ms (varsayılan 5000) sonra
  `database is locked` hatasıyla vazgeçilir. Çok sayıda süreç durmadan yazıyorsa
  bir süreç saniyelerce bekleyebilir; bu tür kurulumlarda `busyTimeout` değerini artırın
  ([ayrıntılar](decisions.md#7-concurrency-wal-immediate-transactions-busy-polling)).
- Tüm süreçler aynı makinede olmalıdır (ağ sürücüleri kullanılamaz).

## Yedekler

```js
// ESM'de üst seviyede veya CommonJS'te bir async fonksiyon içinde:
await db.backup("bot-yedek.sqlite");
db.close();
```

```sh
npx depo backup bot.sqlite --to bot-yedek.sqlite
```

Yerleşik SQLite çevrimiçi yedekleme API'si, commit edilmiş WAL verilerini ve tüm
namespace'leri, liderlik tablolarını, kullanım sınırlarını ve metadata kayıtlarını
kapsar. `table()` görünümü de **dosyanın tamamını** yedekler. Tamamlanan yedeği
`new Depo("bot-yedek.sqlite")` ile açabilirsiniz; canlı veritabanının yerine
kullanmak için önce eski bağlantıyı durdurun. TTL'ler yeniden başlamaz; mutlak
sona erme zamanlarını korur.

Diğer yerel metotların aksine `backup()` bir promise döndürür. **Kaynağı kapatmadan
veya hedefi kullanmadan önce await edin.** `transaction()` içinden çağırmak veya
yedek devam ederken bağlantıyı kapatmak `DepoError` fırlatır.
Hedef mevcut olmamalıdır (kaynak dosyanın kendisi de kullanılamaz); üst klasörler
mevcut olmalıdır. Üzerine yazma veya eski yedekleri silme politikası uygulanmaz.
Başarısız çağrı kendi oluşturduğu yarım dosyayı kaldırır; çökme sonrasında yarım
dosya kalabilir, bu nedenle yalnızca başarıyla tamamlanan hedef kullanılmalıdır.
Mevcut hedef dosyaların üzerine yazılmaz.

CLI, kaynağı salt okunur açar; eksik kaynak oluşturmaz veya şemasını yükseltmez.
Çevrimiçi yazmalar devam edebilir; tamamlanan yedek tutarlıdır ancak çağrı başladıktan
sonraki yazmaları da içerebilir. Sürekli yoğun yazma, tamamlanmasını geciktirebilir.

## wio.db'den geçiş

```diff
- const { JsonDatabase } = require("wio.db");
+ const { JsonDatabase } = require("depo.db/wiodb");
```

Kodunuz çalışmaya devam eder. İlk başlatmada mevcut `databases/db.json`, bir
kereliğine `databases/db.sqlite` içine aktarılır; JSON dosyasına dokunulmaz,
yedek olarak kalır. wio.db'nin tüm metotları desteklenir; bilinçli olarak yapılan
az sayıdaki fark (0 bakiyede `substr` gibi hata düzeltmeleri, anahtar sıralaması,
`YamlDatabase` olmaması) [docs/compat-wiodb.md](compat-wiodb.md) içinde listelenmiştir.

Aynı `.sqlite` dosyası daha sonra `new Depo("databases/db.sqlite")` ile açılabilir.

## quick.db'den geçiş

```diff
- const { QuickDB } = require("quick.db");
+ const { QuickDB } = require("depo.db/quickdb");
```

`depo.db/quickdb`, quick.db'nin kendi `json.sqlite` biçimini okuyup yazar; dolayısıyla
dönüştürmeniz gereken bir şey yoktur ve `better-sqlite3` paketini kaldırabilirsiniz.
Geri dönerseniz dosya quick.db ile okunabilir kalır. Async API ve dönüş değerleri
aynıdır; farklar (yalnızca `SqliteDriver`/`MemoryDriver`, iki hata düzeltmesi,
atomik işlemler) [docs/compat-quickdb.md](compat-quickdb.md) içindedir.

## `depo migrate`: verileri yerel API'ye taşıma

```sh
npx depo migrate databases/db.json --to bot.sqlite                 # wio.db
npx depo migrate croxydb/croxydb.json --from croxydb --to bot.sqlite  # croxydb, TTL'leri korur
npx depo migrate json.sqlite --to bot.sqlite                        # quick.db, tüm tablolar
```

```
databases/db.json (wio) -> bot.sqlite
  databases/db.json -> namespace "default": read 11, inserted 11, updated 0, unchanged 0, conflicts 0
Total: read 11, inserted 11, updated 0, unchanged 0, conflicts 0
```

- wio.db / croxydb: her üst seviye anahtar, `--namespace` ile belirtilen namespace'te
  (varsayılan `default`) bir kayda dönüşür. Tek başına bir UTF-16 surrogate içeren
  anahtar ([Anahtarlar](#anahtarlar)), aktarımı başarısız kılar; hiçbir şey yazılmaz.
- quick.db: `json` tablosu `default` namespace'ine, diğer tablolar
  (`db.table("economy")` ile oluşturulanlar) aynı adlı namespace'e gider. `--table`,
  hangi tabloların okunacağını sınırlar. Kaynak salt okunur olarak açılır.
- croxydb: `--from croxydb` ile `croxydb.ttl.json` içindeki TTL'ler üst seviye
  anahtarlar için korunur. Şifrelenmiş croxydb dosyalarının önce şifresi çözülmelidir.
- Ayrı bir `--to` hedefi seçin: kaynağın kendisi (hard link veya symlink ile
  verilen aynı dosya dahil), hedef yazılabilir açılmadan önce reddedilir.
- **Tekrar çalıştırmak güvenlidir**: aynı kayıtlar `unchanged` sayılır. Farklı bir
  değerle zaten mevcut olan kayıtlar korunur ve `conflicts` olarak raporlanır;
  `--overwrite` bunların üzerine yazar. `--dry-run`, raporu gösterir ve hedef dosyayı
  değiştirmez; `--json`, raporu JSON olarak yazdırır.

## Benchmark

Tam sonuçlar, makine bilgileri ve yöntem: [docs/benchmark.md](benchmark.md)
(`npm run bench` ile yeniden üretilebilir).

Windows (NT 10.0.26300), Intel i5-10600K, Node 24.22.0, 3 yeni sürecin medyanı.
Daha düşük değer daha iyidir; kütüphaneler varsayılan ayarlarıyla kullanılmıştır.

| İş yükü | Depo | Depo `"normal"` | quick.db + better-sqlite3 | wio.db |
|---|---:|---:|---:|---:|
| `set()` 1 000 yeni anahtar | 2.19 s | 0.04 s | 7.43 s | 7.49 s |
| `get()` 10 000 okuma | 58 ms | 61 ms | 545 ms | 9 336 ms |
| `add()` 1 000 × tek anahtar | 2.17 s | 0.04 s | 7.19 s | **2.00 s** |
| 5 000 anahtar ekleme, `set()` döngüsü | 10.9 s | 0.18 s | 35.8 s | 52.3 s |
| 5 000 anahtar ekleme, tek `transaction()` | 18 ms | 17 ms | (API yok) | (API yok) |
| 10 000 anahtar üzerinde `all()`, ×20 | 280 ms | 271 ms | 280 ms | **200 ms** |
| 10 000 anahtarlı dosyayı açma + ilk `get()` | 7.6 ms | 7.0 ms | 23.8 ms | 38.3 ms |

- Depo varsayılan olarak her yazmada fsync yapar (bu diskte her biri ≈ 2.2 ms);
  wio.db hiçbir zaman fsync yapmaz, dolayısıyla adil karşılaştırma `"normal"` sütunudur.
- **Depo'nun geride kaldığı yerler**: çok sayıda kayıtta `all()` (wio.db, 10 000
  küçük JSON string'i yerine tek büyük JSON string'ini ayrıştırır). Varsayılan
  dayanıklılıkta, yoğun kullanılan tek bir anahtarda ise wio.db ile yaklaşık beraberedir.
- En büyük kazanç, yazmaları `transaction()` içinde toplamakla sağlanır: döngüden 600× daha hızlıdır.

## Sınırlamalar

- Yalnızca Node.js ≥ 24.15.0 (yukarıya bakın). Node 22 çalışır ancak
  `ExperimentalWarning` yazdırır ve desteklenmez.
- Senkron: yavaş bir disk, yazma süresince event loop'u bloke eder (benchmark
  makinesinde fsync yapılan her yazma yaklaşık 2 ms sürer; `synchronous: "normal"`
  kullanın veya yazmaları `transaction()` ile gruplayın).
- Her üst seviye anahtar için tek SQLite satırı: path okuma veya yazma işlemi,
  kaydın tamamını ayrıştırır ve yazma işlemlerinde yeniden serileştirir. Kayıtları
  küçük tutun (herkesi tek bir `users` nesnesine koymak yerine kullanıcı başına bir kayıt).
- `all()`, dönen her kaydı ayrıştırır; 10 000 kayıtta, wio.db'nin dosyanın tamamına bir
  kez `JSON.parse` uygulamasından daha yavaştır (benchmark'a bakın). Sınırlı sayfalar
  için `prefix`/`limit`/`after`, değerler gerekmiyorsa `keys()` kullanın.
- TTL'ler path'lere değil, kayıtların tamamına uygulanır; sürenin dolması sistem saatine bağlıdır.
- Tek dosyaya durmadan yazan çok sayıda süreç, kilit için saniyelerce bekleyebilir
  (adil bir kuyruk yoktur); yalnızca aynı makine kullanılabilir, ağ dosya sistemleri kullanılamaz.
- Yalnızca JSON değerleri (`BigInt`, `Map`, `Buffer`, `Date` nesneleri yok).
- Çift paket: ESM ve CommonJS build'leri ayrı kopyalardır; ikisini birlikte
  kullanıyorsanız `instanceof` yerine `error.name === "DepoError"` ile karşılaştırın.

## Geliştirme

```sh
npm install
npm test           # build + tüm testler (node:test)
npm run typecheck  # tsc strict, çıktı üretmez
npm run smoke      # paketle, geçici projeye kur, ESM/CJS/TypeScript tüketicilerini çalıştır
npm run attw       # paket export'larını/tiplerini @arethetypeswrong/cli ile kontrol et
npm run bench      # benchmark, docs/benchmark.md dosyasını yeniden yazar
npm run fixtures   # gerçek wio.db, quick.db, croxydb ile test/fixtures verilerini yeniden üret
```

Tasarım kararları ve gerekçeleri: [docs/decisions.md](decisions.md).

## Lisans

MIT
