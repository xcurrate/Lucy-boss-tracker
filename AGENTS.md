# Lucy-boss-tracker — catatan repo

## Perintah
- `npm run check` — syntax check semua file src (jalankan sebelum commit).
- `npm test` — seluruh suite (`node --test test/*.test.js`). Satu test `reward OCR integration`
  gagal secara pre-existing (butuh fixture OCR), tidak terkait perubahan lain.
- `npm start` — jalankan bot; butuh `DISCORD_TOKEN` + `LUCY_BOT_ID` di `.env`.

## Animal Dex
- Data disimpan di SQLite `data/animal-dex.db` (global, satu baris per nama hewan). Tabel `emoji_map`
  menyimpan cache pemetaan emoji sumber → emoji aplikasi bot.
- Kartu hewan dikirim Lucy sebagai pesan Components V2; `src/services/animalDex.js` mem-parse-nya.
- **Penting — emoji aplikasi tidak bisa dipakai aplikasi lain.** Discord hanya mengizinkan aplikasi
  pemilik memakai emoji aplikasinya (`<:hp:…>` milik Lucy tidak bisa dirender bot ini; tampil sebagai
  teks `:hp:`). Karena itu `mirrorEmojiTokens()` menyalin emoji tersebut ke **aplikasi bot sendiri**
  lewat `client.application.emojis` (endpoint `/applications/{id}/emojis`, tidak butuh guild/izin
  server), lalu memakainya saat render. Mirror jalan saat start (`syncAnimalDexEmojis`) dan saat
  render dex. Gagal mirror tidak fatal — token asli dipertahankan sebagai fallback.
- Pencocokan emoji aplikasi bot dilakukan **berdasarkan nama**, jadi meng-upload emoji manual di
  portal (Developer Portal → aplikasi → Emoji) dengan nama yang sama juga langsung terpakai tanpa
  perubahan kode. Nama yang dikenali: `hp att pr wp mg mr` (huruf kecil), plus alias di
  `EMOJI_ALIASES` (`mg`/`mag`/`magic`, `att`/`attack`, `pr`/`prot`/`protection`, dll).
- Emoji guild yang sudah bisa diakses bot dipakai langsung tanpa di-mirror.
- Perintah `dex` menerima **salinan blok kartu** apa adanya: token emoji dipakai sebagai
  nama hewan, sedangkan sisa salinan diabaikan — digit superskrip penanda jumlah (mis.
  `⁰⁰⁰⁰`) dibuang karena tidak mungkin jadi nama, dan emoji dekoratif (`DECORATIVE_EMOJI`,
  mis. `blank`) dilewati. Kata seperti `blank` tetap bisa dicari bila diketik manual.
- Query yang **tidak menemukan hewan tidak dilaporkan** (tidak ada baris "Tidak ditemukan").
  Judul embed hanya menyebut query yang ada di dex. Kalau semua query kosong, balasannya
  panduan pemakaian. Jadi menyalin blok kartu besar tetap enak dibaca: hanya hewan yang
  sudah tertangkap yang muncul.
- Salinan dari Discord sering memuat token emoji yang **terpotong**: `<a:snorlaxdoingafk:`
  (tanpa id) atau `:cpatreon:` (tanpa nama). `normalizeQueryToken` mengenali token yang
  mengandung `<`, `>`, `:`, digit superskrip, atau lebih dari 32 karakter (batas nama emoji
  Discord) sebagai potongan emoji, lalu mengambil bagian huruf/angkanya saja — jadi
  `snorlaxdoingafk` tetap bisa dicari, sedangkan `:cpatreon:` menjadi `cpatreon`.
  Mention `<@id>` dibuang di `extractFlags`.
- `<prefix>dex` **tanpa nama** tidak lagi menampilkan daftar hewan; balasannya adalah panduan
  cara pakai (`formatDexUsage`). Tidak ada kata kunci "tampilkan semua" — daftar penuh hanya
  pernah keluar lewat pencarian yang cocok banyak hewan.
- Tabel ringkas (`-c`): judul embed tetap `📖 Animal Dex (ringkas)` tanpa nama hewan.
  Header memakai emoji, bukan kata — `🧬` untuk kolom hewan dan `∑` untuk total.
  Tiap angka dibungkus code span supaya lebar digit sama; antar sel dipisah
  `COLUMN_GAP` = spasi biasa + spasi em U+2001 (spasi em jauh lebih lebar, spasi
  biasa jadi jaring pengaman bila klien memangkas Unicode). Sel kosong tetap `–`.
  Tidak ada tabel markdown asli karena Discord tidak merendernya di dalam embed.
- Emoji animasi Lucy bisa >256 KiB, batas unggah emoji Discord, sehingga `create` gagal 400 dan
  emoji tampil sebagai teks. `emojiSourceUrls` mencoba GIF dari ukuran kecil dulu
  (`?size=96,64,48,32`) — parameter CDN ini mengecilkan berkas tanpa membuang frame animasi —
  baru versi penuh. Kegagalan mirror dicatat ke console (terlihat di dashboard log).

## Lucy Counter — leaderboard per tanggal
- Perintah leaderboard menerima argumen **tanggal opsional**: `lcount`, `ltarget`, `lservers`
  (juga `lcountall`, tapi all-time selalu memakai semua tanggal). Contoh: `!lcount 5 nov`,
  `!ltarget 5 nov 2` (tanggal + halaman).
- Format tanggal yang diterima `parseIndonesianDate`: `5 nov`, `5 november 2026`, `5/11/2026`,
  `2026-11-05`. Tahun opsional — tanpa tahun dipakai tahun berjalan (WIB). Nama bulan Indonesia
  ada di `MONTHS_ID`; `formatIndonesianDate` mengubah key kembali jadi `5 nov 2026` untuk footer.
- `extractDateArg(args)` memisahkan token tanggal dari sisa argumen (nomor halaman) dan
  mengembalikan `invalid` untuk teks yang menyerupai tanggal tapi tidak valid (mis. `32 nov`),
  supaya perintah bisa membalas pesan kesalahan alih-alih diam-diam mengabaikannya.
- Data harian sudah ada di tabel `lucy_daily (guild_id, user_id, day, count)`, jadi filter
  tanggal untuk `lcount`/`lservers` langsung jalan.
- **Progres Target Lucy hanya menyimpan siklus terakhir** di `lucy_users` (ditimpa saat siklus
  berganti), jadi ditambah tabel riwayat `lucy_target_daily (guild_id, user_id, cycle_key, count)`
  yang diisi `recordLucy` setiap Lucy diterima dalam jendela target. `getTargetCounts(guildId, cycleKey)`
  membaca riwayat ini; bentuk barisnya disamakan dengan state user (`challengeDayKey`/`challengeCount`)
  agar bisa dipakai `targetRanking` apa adanya. Siklus berjalan tetap dibaca dari state user.
- Siklus target berjalan 12:00 → 10:00 WIB (`challengeCycleKey`), jadi "tanggal" pada `ltarget`
  berarti tanggal **mulai siklus**, bukan tanggal kalender biasa.
- Tombol navigasi `lcnav` kini membawa tanggal: `lcnav:<tipe>:<tanggal|-:><aksi>`, mis.
  `lcnav:daily:2026-11-05:next`. Tanggal `-` berarti tanpa filter, sehingga klik tombol tetap
  menampilkan tanggal yang sama saat memuat ulang data dari SQLite.
- Data riwayat target **mulai terkumpul sejak tabel ini ada**; tanggal sebelum itu kosong.

## Family 100
- Game tebak jawaban tersembunyi. Satu soal punya beberapa jawaban yang **disembunyikan**
  sebagai slot `▓▓▓`; bot mendengarkan semua pesan di channel ronde dan mencocokkannya.
- Perintah: `!f100` / `!family100` (mulai; **kalau ronde sudah jalan, menampilkan ulang soalnya**),
  `!f100 soal` (alias `status`, tampilkan ulang soal & jawaban terbuka), `!f100 clue` (**semua orang**),
  `!f100 skip` (**semua orang**), `!f100 stop` & `!f100 on|off` (**moderator/admin/developer**),
  `!f100 lb [all]`. Alias perintah: `kuis`.
- **Clue** (`!f100 clue` / `petunjuk` / `hint`): tiap pemakaian membuka satu huruf depan lagi pada
  semua slot yang masih tersembunyi (`clueMask`). Kuota **per pemain**: masing-masing pemain punya
  jatah `CLUE_MAX` (3) sendiri per soal (`session.clueByUser`), tapi papan memakai level **tertinggi**
  yang pernah diminta siapa pun (`session.clueLevel`), jadi petunjuk tidak bisa "mundur" walau pemain
  lain baru memakai clue pertamanya. Kuota dan level direset setiap soal baru. Huruf di tengah tetap
  `▓` dan selalu disisakan minimal satu huruf tersembunyi, jadi jawaban pendek tidak terbuka penuh.
  Clue tidak membuka slot dan tidak menambah poin; tingkat clue tampil di footer (`Clue n/3`).
- **Skill developer `reveal`** (`!f100 reveal`, alias `bocorkan`/`dev`): mengirim embed berisi
  **semua jawaban** soal aktif (menandai mana yang sudah terbuka beserta penemunya), lalu pesannya
  **dihapus otomatis setelah `REVEAL_MS` (2000 ms)**. Hanya pemilik bot / `DEVELOPER_IDS` / pemilik
  server (`isDeveloper`); moderator biasa ditolak. Tidak mengubah state ronde maupun papan — murni
  alat pengawasan. Pakai `message.reply(...)` lalu `setTimeout(...).unref()` supaya timer tidak
  menahan proses saat test.
- **Izin**: `skip` bebas untuk semua orang supaya soal mentok bisa dilanjutkan siapa saja. `stop`
  dan `on|off` hanya untuk moderator/admin (`ManageGuild`), pemilik server, atau developer.
  "Developer" = pemilik aplikasi bot, ID di env `DEVELOPER_IDS` (dipisah koma), atau pemilik server
  (`src/services/family100.js`: `isModerator`/`isDeveloper`/`isAdmin`).
- **Satu sesi aktif per server**, terikat ke channel tempat `!f100` dijalankan. `!f100` di channel
  yang sama saat ronde berjalan akan **mengirim ulang papan soal** (bukan memulai ronde baru);
  di channel berbeda hanya membalas lokasi sesi. Ini cara cepat menemukan soal yang tenggelam saat
  tak ada yang bisa menjawab.
- **Auto-bump**: kalau channel ronde dibanjiri pesan biasa (`AUTO_BUMP_AFTER`, default 20) tanpa
  jawaban benar, papan dikirim ulang otomatis (`noteChannelActivity`) supaya soal tetap terlihat.
  Penghitung direset setiap kali papan dikirim, jadi tidak bisa spam.
- Poin **skema C**: tiap soal bernilai total **100 poin**, tanpa bonus penutup ronde, tanpa
  penalti untuk jawaban salah. Bobot menurun linier mengikuti urutan jawaban (jawaban teratas
  dapat poin terbesar), dibulatkan dengan metode sisa terbesar supaya total tepat 100 dan tidak
  ada jawaban bernilai 0 (`src/services/family100Score.js`).
- Pencocokan jawaban (`src/services/family100Match.js`) toleran: huruf besar/kecil, tanda baca,
  kata depan (`yang`, `itu`, `di`, …), dan spasi/tanda hubung dibuang; salah ketik 1–2 huruf
  dimaafkan **hanya untuk jawaban satu kata** agar "goreng" tidak cocok dengan "nasi goreng".
  Pesan yang berawalan prefix (perintah) tidak pernah dihitung sebagai jawaban.
- Bank soal: `src/data/family100.json` — 1.709 soal hasil deduplikasi dari
  [YangJunMing12/family100-database](https://github.com/YangJunMing12/family100-database)
  (Apache-2.0). Untuk memperbarui, ganti JSON-nya; `src/data/family100Bank.js` menormalkan
  ulang saat dimuat, jadi tidak ada langkah build.
- **Bank sudah dikurasi.** Dari 1.767 soal mentah, 58 dibuang: soal kembar (judul beda, jawaban
  identik), soal yang jawabannya murni lelucon/era-IRC (mis. "Intip Soal Dan Jawaban",
  "Cowo Brengsek Neh"), dan soal berjawaban sampah ("doi gue", "sialan lu ngumpat gue").
  Jawaban lelucon pada soal yang tetap dipakai juga dibersihkan, dan typo ejaan diperbaiki
  (mis. "chinese cabage" → "chinese cabbage", "strawbery" → "strawberry"). Saat menambah soal
  baru, pastikan tiap jawaban benar-benar bisa ditebak dari soalnya.
- **Papan soal dikirim ulang setiap ada jawaban benar.** Papan lama dihapus dan papan baru
  dikirim sebagai pesan baru (via `reply` ke pesan penebak) supaya selalu berada di dasar channel —
  kalau hanya di-*edit* di tempat, di channel ramai pesannya tertimbun dan tidak terbaca lagi.
  Pengiriman diserialkan per sesi (`session.boardQueue`) agar dua tebakan benar yang hampir
  bersamaan tidak menyisakan dua papan. Jika hapus/ kirim gagal (mis. izin kurang), hanya dicatat
  ke console — ronde tetap jalan dan papan lama dibiarkan.
- Poin disimpan di SQLite `data/family100.db` (`family100_scores` per pemain per hari WIB,
  `family100_users` untuk nama) via `src/utils/family100Storage.js`. Leaderboard mingguan
  dihitung dari rentang Senin–Minggu WIB (`weekRange`), all-time dari seluruh baris.
- Durasi ronde opsional (detik) diatur dari dashboard; `0` = tanpa batas. Jika diisi, ronde
  otomatis ditutup saat waktu habis. Kolom channel opsional membatasi channel tempat ronde boleh mulai.
- Test: `test/family100.test.js` (skor, pencocokan, mesin ronde, kirim ulang papan, clue, izin, bank) dan
  `test/dashboardFamily100.test.js` (API settings + leaderboard).

## Pengingat Aksi Lucy (`src/services/lucyReminder.js`)
- Tiga jenis pengingat, masing-masing dengan perintah prefix dan durasi tunggu sendiri:
  pray/curse = 5 menit, battle/hunt = 15 detik, lucy = 10 detik. Definisi ada di `KINDS`.
- Pemicu aksi ada di `src/utils/lucyTrigger.js` (TANPA dependensi, supaya bisa dipakai
  lucyReminder dan lucyCounter tanpa require melingkar). Menerima `<prefix><alias>` dan
  `<prefix> <alias>`; alias: pray/doa/p, curse/kutuk/c, battle/fight/war/b, hunt/catch/h.
  Alias satu huruf HANYA berlaku bentuk bersambung (`lb`), bukan `l b`, supaya chat biasa
  tidak ikut terpicu. Prefix server diatur admin lewat `d lucyprefix set`; `lucy` dan `l`
  selalu ikut dikenali di samping prefix itu.
- Preferensi reminder (on/off + cara ping) bersifat GLOBAL: tabel `lucy_reminder_prefs_global`
  tanpa `guild_id`. `getPref/setPref/getPrefs` hanya menerima userId. Jangan tambahkan
  guild_id kembali tanpa alasan kuat — ini permintaan eksplisit pemilik bot.
- Leaderboard punya scope: lokal (default) atau global lewat token `global`
  (`store.topByRangeAll`/`topAllTimeAll` untuk aksi, `lucyRankingGlobal` untuk Lucy).
- **Kategori "lucy" TIDAK punya penghitung baru.** Ia memakai `lucyCounterStorage` (tabel
  `lucy_daily`) yang sudah ada, lewat hook `onCounted` yang dipanggil `lucyCounter.handleMessage`.
  Jangan menambahkan penghitung kedua untuk hal yang sama.
- Aksi pray/curse/battle/hunt dicatat di `data/lucy-actions.db` (`src/utils/lucyActionStorage.js`).
  `battle` dan `hunt` digabung jadi satu kategori leaderboard lewat `GROUPS`.
- **Satu pesan hanya boleh memicu satu pengingat.** `lucy pray` adalah perintah aksi, jadi
  `lucyCounter` melewatkannya (guard regex di `handleMessage`); tanpa guard itu satu pesan
  memicu pengingat aksi DAN pengingat Lucy sekaligus.
- Cara ping disimpan per orang per jenis di `lucy_reminder_prefs`: `tag`, `reply`, `both`, `none`.
  Panel tombol (`lrem:toggle:<kind>` / `lrem:mode:<kind>`) mengubahnya; `handleComponent` selalu
  membaca ulang SQLite agar tampilan sinkron.
- Timer pengingat HANYA di memori (`timers` Map). Restart bot membatalkan timer — ini disengaja.
  Cooldown tetap akurat karena `ready_at` disimpan di SQLite; aksi ulang dalam jendela tunggu
  mengganti timer lama, bukan menambah.
- `scheduleReminder` menerima `waitMs` opsional (dipakai test; durasi kustom per server nanti).
- Leaderboard: `llb <kategori> [rentang] [halaman]`. Rentang lewat `parseRange`: hari ini,
  `Nd` (N hari terakhir), `all`, atau tanggal — parser tanggal dipinjam dari `lucyCounter`
  supaya formatnya konsisten (`5 nov`, `5/11/2026`, `2026-11-05`).
- Balasan kustom digerbangi `settings.lucyReminder.premium`; balasan default ada di `DEFAULT_REPLIES`
  dengan placeholder `{user}`, `{mention}`, `{kind}`, `{durasi}`.

## Cepat Tepat (Matematika)
- Game hitung cepat terpisah dari Family 100: satu soal aritmetika aktif per server, siapa pun yang
  menjawab **benar paling dulu** dapat poin, lalu soal berikutnya dikirim. Perintah `d math [jumlah]`
  (alias `mtk`, `hitung`), `d math lb [all]`, `d math stop` (moderator/admin/developer).
- **Penilaian eksak, bukan toleran.** `mathEngine.isCorrect` membandingkan nilai dengan epsilon 1e-9;
  berbeda dari `family100Match` yang memaafkan typo, di sini "3" TIDAK sama dengan "8". Jangan
  memakai `matchAnswer` untuk matematika.
- **Tidak ada `eval()`.** `mathEngine.evaluate` adalah parser turun-rekursif untuk `+ - * / ()`;
  jawaban pemain hanya diterima bila berbentuk angka, desimal (`,` atau `.`), atau pecahan `a/b`.
  Input seperti `process.exit(1)` ditolak.
- **Soal selalu berjawaban bilangan bulat** (level 1–5, pembagian dibuat dari hasil kali), jadi
  tidak ada jawaban desimal membingungkan. Level naik seiring nomor soal.
- **Poin** = `basePoints(level)` (40–140) + bonus kecepatan linier maks 50; bonus dihitung dari
  durasi sesi (`session.deadline - session.askedAt`), bukan settings yang bisa berubah di tengah ronde.
- **Jeda antar soal** `nextDelayMs` (default 2,5 dtk) bisa diubah lewat `setNextDelay` — test memakai 0.
- Skor disimpan terpisah di `data/math-race.db` (`src/utils/mathStorage.js`), tidak bercampur
  dengan Family 100. Kolom `best_ms` menyimpan waktu tercepat menjawab.
- Pengaturan per server: `settings.mathRace` (`enabled`, `channelId`, `durationSeconds` default 30).

## Prefix command (`<prefix> <perintah>`)
- **Prefix bawaan = `d`** (inisial bot Dragneel), konstanta `DEFAULT_PREFIX` di
  `src/utils/storage.js`. Semua fallback `|| '!'` sudah memakai konstanta ini, jadi jangan
  menulis `'!'` langsung di kode baru.
- **Input tidak pandang huruf besar/kecil.** Pakai `matchPrefix(content, prefix)` dari
  `storage.js` untuk mencocokkan prefix (mengembalikan sisa teks setelah prefix, atau `null`).
  Jangan pakai `content.startsWith(prefix)` — itu case-sensitive. Prefix juga dinormalkan ke
  huruf kecil saat disimpan (`normalizePrefix`), jadi `D BOSS STATUS` == `d boss status`.
- **Dua level perintah.** Fitur boss ada di bawah kategori `boss` (`d boss status`, `d boss menu`,
  `d boss setup`, `d boss admin-help`). Perintah tingkat bot langsung mengikuti prefix, tanpa
  kategori: `d help`, `d prefix`, `d ping`, `d dex`, `d f100` (Family 100 punya root sendiri).
  `parsePrefixInput` memisahkan keduanya lewat `TOP_SUBS` (help, prefix) vs `KNOWN_SUBS`
  (sub di bawah kategori boss).
- **Subcommand tak dikenal diabaikan, bukan dibalas.** Dengan prefix satu huruf (`d`), chat biasa
  seperti "duh", "dah", "dulu aku pergi" berawalan sama. `parsePrefixInput` mengembalikan `null`
  bila sub tidak ada di `KNOWN_SUBS` (turunan `ALIASES`), jadi bot tidak berisik. Karena itu
  **setiap subcommand baru wajib masuk `ALIASES`** — kalau tidak, perintahnya tidak pernah jalan.
  `d` saja (prefix tanpa sub) = bantuan.
- Handler: `src/commands/prefix.js`. Di `src/index.js`, handler ini dipanggil untuk **setiap** pesan
  (setelah `family100` dan `tracker`), jadi urutan pemanggilan penting: `family100` hanya menangkap
  `f100`/`family100`/`kuis`, sehingga tidak menelan subcommand lain.
- Subcommand: `help`, `menu`, `notify`, `on`/`off`, `warn`, `status`, `prefix`, `admin-help`,
  `setup`, `server on|off`. Alias di `ALIASES` (mis. `awalan`/`pref` → `prefix`).
- **Ubah prefix per server:** `<prefix> prefix <baru>` (moderator, izin Manage Server) atau slash
  `/boss prefix nilai:<baru>`. Dashboard (developer) punya field `PREFIX PERINTAH` di panel Boss
  Tracker. Panjang prefix **1–10 karakter** tanpa spasi — batas ini dinaikkan dari 5 agar nama bot
  seperti `dragneel` bisa dipakai, dan harus konsisten di 3 tempat: `prefix.js`, `validPrefix` di
  `boss.js`, dan `validateSettings` di `dashboard/server.js`.
- **Gotcha:** `helpEmbed(prefix, { isAdmin })` menyembunyikan semua field yang diawali `⚙️` bila
  `isAdmin` tidak diisi. Jalur prefix dulu memanggil `helpEmbed(prefix)` tanpa flag ini, sehingga
  moderator **tidak pernah melihat** bagian Admin (termasuk cara mengubah prefix) — padahal
  perintahnya tetap bisa dipakai. Selalu teruskan `{ isAdmin: _isAdmin(message) }` di jalur prefix.
  Dijaga oleh `test/prefix.test.js` ("shows the admin section ... to admins").

## Dashboard
- `src/dashboard/server.js` (API + static) dan `src/dashboard/public/` (UI: `index.html`, `app.js`,
  `styles.css`). Semua endpoint `/api/*` butuh header `Authorization: Bearer <DASHBOARD_TOKEN>`.
- Fitur **Notes**: catatan bebas per server di `data/notes.json` via `src/utils/noteStorage.js`
  (CRUD: `listNotes`/`addNote`/`updateNote`/`deleteNote`, judul ≤120, isi ≤4000). Endpoint:
  `GET/POST/PUT/DELETE /api/notes`. UI-nya panel `#notes` di dashboard (tambah/edit/hapus).
- Test: `test/notes.test.js` (storage) dan `test/dashboardNotes.test.js` (API HTTP sungguhan).
