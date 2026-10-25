# Depo

[English](https://github.com/KamelotWalker/depo.db/blob/main/README.md) | **Türkçe**

Node.js'in yerleşik `node:sqlite` modülü üzerinde çalışan bir key-value veritabanı.
**Sıfır bağımlılık, native modül yok, node-gyp yok**: `npm install` yeterli, çalışır.

Depo, [wio.db](https://www.npmjs.com/package/wio.db)
(son sürümü 2021'de yayımlandı) ve [quick.db](https://www.npmjs.com/package/quick.db)
(son sürümü 2023'te yayımlandı; kendiniz kurup derlemeniz gereken native
`better-sqlite3` modülüne ihtiyaç duyar) yerine geçmek üzere tasarlandı. İkisi için de
mevcut kodunuzla doğrudan uyumlu giriş noktaları var; geçiş için tek satırı değiştirmeniz yeterli.

- Senkron API: `get`, `set`, `has`, `delete`, `all`, `add`, `subtract`, `push`, `pull`
- Saklanan nesnelere noktalı path ile erişim: `db.add("user.42.coins", 10)`
- Kayıt başına TTL, namespace'ler, birden fazla anahtarı kapsayan transaction'lar
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
| `all({ prefix?, limit? })` | `{ key, value }[]` | Anahtara göre sıralı |
| `count()` | `number` | Bu namespace'teki süresi dolmamış kayıtlar |
| `deleteAll()` | `number` | Bu namespace'ten silinen kayıtlar |
| `add(key, n)` / `subtract(key, n)` | `number` | Yoksa 0 kabul edilir |
| `push(key, ...values)` | dizi | Yoksa `[]` kabul edilir |
| `pull(key, valueOrPredicate)` | dizi | Derin eşitlik karşılaştırmasına göre eşit olan veya `predicate(el, index)` sonucu true olan tüm elemanları siler |
| `ttl(key)` | ms \| `null` \| `undefined` | Kalan TTL; `null` = süresi hiç dolmaz; `undefined` = kayıt yok |
| `expire(key, ms \| null)` | `boolean` | Mevcut bir kaydın TTL'ini ayarlar veya kaldırır |
| `purgeExpired()` | `number` | Süresi dolmuş kayıtları diskten siler (tüm namespace'ler) |
| `table(name)` | `Depo` | Aynı bağlantıyı paylaşan başka bir namespace'in görünümü |
| `transaction(fn)` | `fn`'in sonucu | Senkron `fn`, tüm yazmalar birlikte commit edilir |
| `close()` | | Bağlantıyı (ve tüm `table()` görünümlerini) kapatır |

Ayrıca dışa aktarılanlar: `DepoError` (geçersiz anahtarlarda, değerlerde ve tip
uyuşmazlıklarında fırlatılır), `escapeKey(segment)`, `VERSION` ve TypeScript tipleri
`Key`, `Entry`, `DepoOptions`, `SetOptions`, `AllOptions`.

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

## Dayanıklılık ve eşzamanlılık

- **Her çağrı atomiktir.** `add`, `push`, `pull`, path üzerinde `set`/`delete`,
  okuma ve yazmayı tek bir `BEGIN IMMEDIATE` transaction'ı içinde yapar; SQLite'ın
  yazma kilidi okumadan *önce* alınır. İki süreç (bot shard'ları, bir dashboard,
  bir cron script'i) güncellemeler kaybolmadan aynı dosyayı paylaşabilir;
  `test/multiprocess.test.mjs`, tek bir dosyaya yoğun işlem yapan 6 süreçle bunu kanıtlar.
- `transaction(fn)`, birden fazla çağrıyı birlikte atomik hale getirir. `fn` içinde
  hata fırlatılırsa her şey geri alınır.
- **WAL günlüğü.** Okuyucular hiçbir zaman yazıcıları beklemez. Veritabanının yanına
  `-wal` ve `-shm` dosyaları eklenir; kullanımda olan bir veritabanını kopyalarken bunları bir arada tutun.
- **`synchronous: "full"` (varsayılan)**: çağrı döndükten sonra yazılan veri elektrik
  kesilse de korunur. **`"normal"`**: süreciniz çökse de korunur; ancak elektrik
  kesintisi veya işletim sistemi çökmesinden önceki son yazmalar kaybolabilir;
  dosya hiçbir zaman bozulmaz. Benchmark makinesinde tekil yazmalarda `"normal"` ~60× daha hızlıdır.
- Başka bir sürecin kilidini beklerken `busyTimeout` ms (varsayılan 5000) sonra
  `database is locked` hatasıyla vazgeçilir. Çok sayıda süreç durmadan yazıyorsa
  bir süreç saniyelerce bekleyebilir; bu tür kurulumlarda `busyTimeout` değerini artırın
  ([ayrıntılar](decisions.md#7-concurrency-wal-immediate-transactions-busy-polling)).
- Tüm süreçler aynı makinede olmalıdır (ağ sürücüleri kullanılamaz).

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
- `all()`, her kaydı ayrıştırır; 10 000 kayıtta, wio.db'nin dosyanın tamamına bir
  kez `JSON.parse` uygulamasından daha yavaştır (benchmark'a bakın). `prefix`/`limit` kullanın.
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
