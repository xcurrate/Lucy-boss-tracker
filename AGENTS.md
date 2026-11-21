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
- **Clue** (`!f100 clue` / `petunjuk` / `hint`): tiap pemakaian membuka **satu huruf acak pada
  SETIAP jawaban** yang masih boleh di-clue (lihat `addHint`, `clueMask`, `letterIndices`), jadi satu
  clue memberi petunjuk untuk seluruh papan sekaligus dan posisinya acak (tidak berurutan dari
  depan). Sebuah jawaban hanya boleh di-clue selama sisa huruf tersembunyinya > `CLUE_HIDDEN` (2);
  begitu tersisa tepat 2, jawaban itu **terkunci** dan dilewati clue berikutnya sementara jawaban
  lain tetap berjalan — jadi tidak ada jawaban yang pernah terbaca penuh. Jawaban dengan huruf < 3
  (`MIN_CLUE_LETTERS`) tidak pernah bisa di-clue sama sekali. Kuota **per pemain** `CLUE_MAX` (3) per
  soal (`session.clueByUser`); bila tidak ada jawaban yang bisa di-clue, jatah **tidak** dipotong dan
  pemain diberi tahu. Kuota dan hint (`session.hints`, per indeks jawaban) direset tiap soal baru.
  Clue tidak membuka slot dan tidak menambah poin; jumlah huruf yang terbuka tampil di footer
  (`Clue n huruf`).
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
- **Data pasif battle OwO** ada di `src/data/owoPassives.json` (+ loader `src/data/owoPassives.js`).
  Murni referensi untuk rencana fitur simulasi battle; **belum dipakai kode produksi**. Sumber
  `ChristopherBThai/Discord-OwO-Bot` (CC BY-NC-SA 4.0), angka sudah divalidasi dengan menjalankan
  class aslinya di quality 0/50/100 — jangan diedit dari ingatan, ambil ulang dari sumbernya.
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
- Tiga jenis pengingat: pray (5 menit, dipakai pray+curse), battle (15 detik, dipakai
  battle+hunt), lucy (10 detik). Definisi ada di `KINDS`. `TRIGGER_KIND_TO_REMINDER`
  memetakan AKSI (dari lucyTrigger) ke jenis reminder. Jenis = satuan pengingat dan
  cooldown; penghitungan dan leaderboard tetap per AKSI.
- **Pengingat OFF secara default** (`DEFAULT_PREF = { enabled: false, pingMode: 'tag' }`).
  Jangan memakai `{ enabled: true }` sebagai fallback di tempat lain — semua pembacaan
  preferensi harus memakai `DEFAULT_PREF`, termasuk `store.getPref(userId, kind, DEFAULT_PREF)`.
- `KINDS` TIDAK lagi menyimpan nama aksi (`info.action` sudah dihapus). `handleAction`
  menerima nama AKSI lalu memetakannya; penghitungan tetap per aksi supaya leaderboard
  battle dan hunt terpisah, sementara cooldown per jenis (battle/hunt berbagi jendela).
- **Pengingat pertama menang** (`lh` lalu `lb` dihitung dari `lh`). Aturan ini ada di
  dalam `scheduleReminder`: kalau key sudah ada di `timers`, panggilan berikutnya
  mengembalikan pengingat yang sedang berjalan tanpa menggeser `dueAt`/`scheduledAt`.
  Jangan menambahkan parameter `replace` kembali. `reminders` (Map sejajar `timers`)
  menyimpan objek pengingat + `action` pemicu supaya bisa dibaca dan diuji.
- `ACTION_LABELS` memetakan AKSI -> nama tampilan, dipakai untuk `{kind}` di teks
  pengingat, supaya `lh` tampil "Lucy Hunt" dan `lcurse` tampil "Lucy Curse" walau
  jenis reminder-nya `battle`/`pray`.
- Rentang leaderboard diparsing lewat `parseRangeAndPage`: token setelah kategori dicoba
  dari yang terpanjang supaya `5 nov` (dua kata) terbaca sebagai satu rentang, dan sisa
  token jadi nomor halaman. Jangan kembali membaca `positional[1]` saja — itu membuat
  `d llb curse 5 nov` dan `d llb all 2` gagal.
- Balasan kustom dicari per AKSI dulu (`replies.curse`), baru per JENIS
  (`replies.pray`). Lihat `replyKindFor`. `{count}` diisi `actionCount(...)` = jumlah
  AKSI pemicu hari itu (bukan seluruh jenis). Reminder `lucy` membacanya dari
  `lucyCounterStorage` (`getGuildData().users[].days[day]`), bukan lucyActionStorage —
  jangan pakai `actionsFor('lucy')` karena hasilnya selalu kosong.
- **Aksi user TIDAK dibalas sama sekali**, termasuk info "pengingat OFF" untuk anggota
  yang belum mengatur. Jangan menambahkan pesan ajakan di `handleAction`.
- Sakelar induk counter per server: `lucyCounter.enabled` (default OFF, sama dengan
  dashboard). `d s count on|off` (alias `count`) mengubahnya; admin server ATAU
  developer bot. Saat OFF: `handleAction` tidak mencatat & tidak menjadwalkan, mention
  Lucy tidak dihitung, dan SEMUA perintah leaderboard (`top`/`global`/`lcount`/
  `lcountall`/`ltarget` + tombol navigasi per server) membalas `counterOffNotice()`
  ("No data found! ... `d s count`"). Pakai helper itu, jangan tulis pesan baru.
  PENGECUALIAN: board LINTAS SERVER tetap tampil walau server ini OFF, karena
  menggabungkan data server lain — `d g`/`d global` (cek `global` sebelum memblokir)
  dan `d lservers` + tombol navigasi type `servers`.
- `all` adalah RENTANG all-time (parseRange), BUKAN kategori. Kategori gabungan
  semua aksi sudah dihapus. Kategori hanya: lucy, pray, curse, battle, hunt.
- Leaderboard `top`/`global` punya tombol navigasi (`lbtop|<kategori>|<rentang>|<g|l>|<hal>:<aksi>`),
  ditangani `handleLeaderboardNav` dan didaftarkan di `index.js`. Rentang
  diringkas jadi token (`today`/`alltime`/`7d`/`date:YYYY-MM-DD`) karena
  custom_id Discord maksimal 100 karakter.
- Perintah leaderboard: `top`/`t` (per server) dan `global`/`g` (lintas server), dengan
  alias lama `llb`/`llbboard`/`lboard`. `global`/`g` = `top` dengan flag global dipaksa,
  jadi tidak ada penghitung baru. `tglobal`/`tall` juga memaksa global. Token `semua`
  adalah RENTANG all-time di parseRange, bukan flag global — jangan masukkan ke GLOBAL_TOKENS.
  Tanpa kategori, `top` menampilkan leaderboard jumlah LUCY memakai penghitung Lucy
  yang sudah ada (`lucyCounterStorage`) — jangan bikin penghitung baru. Judul embed
  mengikuti rentang lewat `rangeTitle` (Harian / N Hari Terakhir / tanggal / All-Time).
- **Aksi user TIDAK dibalas.** Jangan menambahkan `message.reply(...)` publik di
  `handleAction`: balasannya memakai teks yang sama dengan teks pengingat, sehingga
  satu aksi terlihat menghasilkan dua pesan. Pesan pemicu juga JANGAN dihapus, karena
  mode ping `reply` membalas pesan itu. Satu-satunya pesan dari `handleAction` adalah
  info ephemeral untuk anggota yang belum pernah mengatur dan pengingatnya OFF.
- Pemicu aksi ada di `src/utils/lucyTrigger.js` (TANPA dependensi, supaya bisa dipakai
  lucyReminder dan lucyCounter tanpa require melingkar). Menerima `<prefix><alias>` dan
  `<prefix> <alias>`; alias: pray/doa, curse/kutuk, battle/fight/war/b, hunt/catch/h.
  Alias satu huruf (`b`, `h`) HANYA berlaku bentuk bersambung (`lb`), bukan `l b`, supaya
  chat biasa tidak ikut terpicu.
- Mention pengguna di BELAKANG perintah dibuang sebelum dicocokkan (`lpray @Lucy`,
  `lb <@123>`, `lucy battle <@!123>`), karena user sering menyertakan mention bot Lucy.
  Hanya mention yang dibuang; teks lain tetap membuat pesan dianggap chat biasa
  (`lb ya nanti`, `lpray halo @Lucy`, `lpray @Lucy extra`).
- **Penting: prefix bot Lucy BUKAN prefix bot kita.** Prefix bot kita (`d`) hanya memanggil
  perintah kita (`d lreminder`, `d llb`). Prefix bot Lucy adalah prefix yang dipakai bot
  Lucy untuk membaca perintah user (`lucy`, `l`, `g`, ...), dan bot kita memantau pesan
  dengan prefix itu. Daftarnya dikelola admin per server lewat
  `d lucyprefix set|add|remove|reset`, disimpan di `settings.lucyReminder.lucyPrefixes`.
- `lucy` adalah prefix BAWAAN bot Lucy, jadi SELALU dipantau dan tidak bisa dihapus
  (`ALWAYS_LUCY_PREFIXES`). Pengaturan admin bersifat MENAMBAH: `lucyPrefixes('g')` ->
  `['lucy', 'g']`. `null`/'' berarti belum diatur -> default `['lucy', 'l']`; daftar
  kosong `[]` berarti admin hanya ingin prefix bawaan. Jangan ubah menjadi
  "menggantikan" — `lucy battle` harus tetap dikenali di server mana pun.
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
  dengan placeholder `{user}`, `{mention}`, `{kind}`, `{durasi}`, dan `{count}` (jumlah aksi
  hari ini untuk jenis itu — kategori battle mencakup battle + hunt).

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

## Custom Reminder (`src/services/reminders.js`)

Distribusi **manual oleh developer** (tanpa giveaway otomatis/voting/pembayaran). Model data sudah
siap untuk integrasi giveaway nanti.

- **Modul**: `src/utils/reminderStorage.js` (SQLite `data/reminders.db`, skema v2),
  `src/utils/reminderCategories.js` (registry kategori/format + pemetaan aksi),
  `src/utils/reminderVariables.js` (registry variabel), `src/utils/reminderValidate.js`
  (embed/collectible/URL/Tenor/Klipy), `src/utils/reminderResolve.js` (layer resolusi pesan),
  `src/services/reminders.js` (perintah + siklus award/redeem).
- **Titik integrasi engine**: `deliverReminder()` di `src/services/lucyReminder.js` memanggil
  `reminderResolve.resolveRendered()` sebelum mengirim. Tidak ada scheduler/pendeteksi aksi kedua —
  trigger, durasi, dan cooldown lama tidak berubah. Pengaturan server lewat namespace `s` di
  `src/commands/prefix.js` (sub `reminder-setting`).
- **Kategori × format**: 3 kategori (`PRAY_CURSE`, `HUNT_BATTLE`, `LUCY`) × 2 format (`NORMAL`,
  `EMBED`) = 6 kombinasi. Kategori memetakan banyak-ke-satu ke jenis engine (pray+curse satu jenis,
  battle+hunt satu jenis). **Pengaturan server disimpan per KATEGORI**, memakai aksi KASAR sebagai
  kunci baris (`pray` untuk PRAY_CURSE, `battle` untuk HUNT_BATTLE, `lucy` untuk LUCY), supaya
  `s battle` dan `s hunt` tidak menulis dua baris yang membuat pengingat terbelah dua. Helper:
  `settingKeyFor()` di storage, `canonicalAction()`/`isCoarseAction()`/`actionsForCategory()` di
  `reminderCategories`. Migrasi skema v2→v3 menggabungkan baris lama per aksi menjadi per kategori.
- **Urutan resolusi**: owned aktif → default server → bawaan Dragneel. Nonaktif otomatis jatuh ke
  default server. `pickActiveOwned` memilih yang paling awal dibuat bila ada beberapa (deterministik);
  semua tetap ada di inventory.
- **Tiga ID**: `T-` template, `C-` claim, `R-` reminder (5 karakter alfanumerik + prefiks).
  `createAward` idempoten lewat `UNIQUE(source, source_ref, recipient_id)` untuk sumber berulang dan
  cek `pending` untuk pemberian manual. `markAwardRedeemed` memakai guard SQL sehingga klaim ganda
  mustahil.
- **Izin**: developer (`isDeveloper` lama) untuk template/give/awards/revoke. Admin/pemilik server
  untuk `s <aksi>`; developer **tidak** otomatis boleh. Pemilik saja untuk edit/enable/shareable.
- **Rentang leaderboard** diparse di `parseRange()` (`src/services/lucyReminder.js`) memakai
  `parseIndonesianDateRange()` dari `lucyCounter.js`. Tipe rentang: `today`, `range` (N hari
  terakhir, mis. `7d`), `date` (satu tanggal), `span` (tanggal awal–akhir, mis. `10-18 nov`),
  `alltime`. Setiap tempat yang memeriksa `range.type` **harus** menangani `range` dan `span`
  berdampingan (ranking, filter, label, judul, token tombol). `span` disimpan di custom_id
  sebagai `span:<from>:<to>` karena jumlah harinya tidak bisa disingkat jadi `Nd`.
- **Dua sumber data aksi**: `lucy_action_daily` / `lucy_daily` (agregat per hari,
  permanen, dipakai leaderboard) dan `lucy_action_events` (satu baris per kejadian,
  bertimestamp, retensi 365 hari, dipangkas `pruneEvents()` saat start). Rentang
  harian/tanggal memakai agregat; rentang jam/menit (`30m`, `2j`) memakai kejadian.
  Jangan membaca kejadian untuk rentang tanggal — datanya terpotong retensi.
- **Jangan pakai backtick di dalam komentar SQL** pada template literal `db.exec(...)` di
  `reminderStorage.js` — backtick menutup literal dan bikin SyntaxError.
- **Transfer** hanya untuk reminder `shareable`, perlu konfirmasi, dan memindahkan `owner_id`.
  Aturan format: reminder `EMBED` **tidak pernah** bisa dibagikan — `r shareable ... on` ditolak sejak
  awal, dan `r send` serta eksekusi transfer memakai `shareBlockReason()` supaya kolom `shareable`
  yang sempat `true` (data lama) tidak bisa dipakai lolos. Helper: `isShareable()` untuk tampilan,
  `shareBlockReason()` untuk pesan penolakan.
- **Kode redeem (`C-XXXXXX`) sekali pakai dan hanya penerimanya.** `markAwardRedeemed` memakai guard
  `status = 'pending'` + `recipient_id` di SQL. Balapan klaim **harus** dilempar (`CLAIM_RACE`) di
  dalam `inTransaction` agar ROLLBACK menghapus reminder setengah jadi; kalau hanya mengembalikan
  hasil gagal, transaksi COMMIT dan reminder tertinggal. `redeemAward` menangkapnya jadi
  `{ ok: false, errors: [...] }`, dan handler `redeem` membungkus pemanggilan dengan try/catch agar
  pengguna selalu menerima balasan.
- **Panel interaktif**: `d r` = inventory (judul = nama user, thumbnail = avatar) + tombol
  `rempanel:help`, `rempanel:vars`, `rempanel:back`. Router tombol ada di `src/index.js`.
- **Semua balasan** dalam lingkup reminder dikirim sebagai embed (`sendEmbed`/`sendOk`/`sendError`/`sendWarn`).
- **Perintah pengguna (8)**: `redeem`, `view`, `send`, `update`, `embed`, `media`, `enable`, `disable`.
  Pendukung: `shareable`, `setcollectible`, `reset`, alias `active`/`info`.
- **`r create <KATEGORI> <FORMAT>`** tanpa nama/isi; balas kode template. Kategori menerima nama aksi
  (`battle` → `HUNT_BATTLE`) lewat `resolveCategoryInput`.
- **Counter OFF tidak mematikan reminder**: `handleAction` tetap memasang pengingat (hanya berhenti
  menghitung), dan `lucyCounter.handleMessage` tetap memanggil hook `onCounted` lewat `notifyCounted`.
- **Embed menerima payload discohook/webhook**: `unwrapWebhookPayload` mengambil `embeds[0]`;
  `resolveEmbedMedia` mengubah halaman Tenor/Klipy jadi URL media langsung.
- **`{USER}` = username, `{USER_MENTION}` = mention.** Tag hanya muncul saat pingMode `tag`/`both`;
  mode `reply`/`none` menetralkan mention di teks DAN embed (`neutraliseMentions`). Mode `tag` menandai
  sekali saja walau teks memuat mention. `renderLegacyEmbed` merender token lama (`{mention}`) di embed.
- **`{DAILY}`/`{DAILY_TOMORROW}`/`{DAILY_YESTERDAY}` = 00:00 WIB** (`wibDayStartUnix`). Bentuk ini
  adalah timestamp mentah dan **tidak dirender di embed** (Discord hanya merender `<t:...>` di content).
  Untuk embed pakai `{DAILY_FULL}`/`{DAILY_TIME}`/`{DAILY_DATE}`/`{DAILY_IN}`/`{TOMORROW_FULL}`.
- **Reminder "Lucy" hanya saat pesan memuat kata `lucy`**: `lucyCounter` mengecek
  `trigger.isActionCommand` dulu (pesan aksi = milik lucyReminder) lalu `countLucy`. Tanpa itu semua
  chat jadi "Lucy terdeteksi".
- **`d reminder`/`d r` = Custom Reminder; `d lreminder`/`d lrem` = engine pengingat lama.** Jangan
  menambahkan `reminder` ke daftar head `lucyReminder` — itu membuat balasan ganda.
- **Hapus reminder = KHUSUS DEVELOPER.** `d r delete|hapus|buang <ID>` memakai alur konfirmasi yang
  sudah ada (`askConfirm` + `runConfirmed`, `kind: 'delete'`) dan memeriksa `isDeveloper` DUA KALI
  (saat prompt dan saat eksekusi). Pemilik/admin sengaja TIDAK boleh. Storage:
  `reminderStorage.deleteReminder({ reminderId, ownerId, actorId })` menulis audit `reminder_delete`;
  `ownerId` adalah pengaman opsional, bukan syarat — dev boleh menghapus milik siapa pun. Tidak ada
  foreign key ke tabel `reminders`, jadi penghapusan aman; award yang sudah diklaim tetap tersimpan.
- **Satu pengirim saja**: pengiriman pengingat HANYA di `lucyReminder.deliverReminder`
  (menghormati pingMode + durasi kategori). Jangan menambah pengirim kedua di `index.js`.
- **Test**: `test/reminders.test.js` (106 test).

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

## Mesin simulasi battle (`src/services/battle*.js`)
Port dari `battle/` OwO. Beberapa perilaku **tidak** boleh "dirapikan" karena memang begitu di sumber:

- **Semua buff ikut dipanggil, jangan berhenti di yang pertama.** `runTurn` memanggil `canAttack`
  pada *semua* buff (bukan `some(...)`), karena Freeze menurunkan durasinya sendiri di situ —
  berhenti di Freeze pertama membuat durasinya tidak pernah turun saat ada dua Freeze.
  Hook `preTurn`/`postTurn` juga wajib dipanggil untuk buff **dan** pasif senjata; dulu pasif
  senjata terlewat, sehingga Regeneration/Energize tidak pernah jalan.
- **Penumpukan buff tidak seragam.** Tiap buff OwO punya `bind()` sendiri; tabelnya ada di
  `STACK` (`battleBuffs.js`): `merge` (durasi ditambah), `replace` (Flame: instance lama meledak
  lalu dibuang), `independent` (selalu instance baru). `sameFrom` hanya untuk Poison.
- **Flame meledak memakai buff BARU.** Di `Flame.js`, ledakan dihitung di `bind()` instance yang
  baru menempel (`this.stats[1]` dan `this.from`), bukan dari instance lama. Karena itu
  `bindBuff` mengoper buff baru ke `explode()`.
- **Rune of the Forgotten** tidak punya ability aktif (`ability.kind = "none"`); efeknya hanya
  `statBoost: "all"` plus override serangan dasar `basicAttack` (`mixed_true`, 65% STR + 65% MAG
  TRUE). Menaruhnya sebagai ability membuat Rune kehilangan bonus stat-nya.
- **Kualitas senjata adalah array slot**, bukan satu angka: `stat → buff → mana` (OwO menyambung
  `qualityList` senjata dengan `qualityList` tiap buff, lalu `manaRange` di ujung). Pakai
  `buffQuality()`/`manaQuality()` di `battleWeapon.js`; jangan ambil `quality[quality.length-1]`.
- **Tes regresi harus lewat `runTurn`/`runBattle`**, bukan memanggil hook langsung — bug wiring
  (hook tidak dipanggil mesin) hanya terlihat dari jalur itu. Lihat `test/battle.test.js`.
- **Aegis (Shield) memasang Taunt di `preTurn`, bukan ability aktif.** `Shield.preTurn` di OwO
  memeriksa WP sendiri (di luar `act()`), lalu `attackWeapon` melewati serangan pada turn itu
  karena buff baru berstatus `justCreated`. Di sini ditandai lewat `unit.skippedAttack`.
- **`heal()` menolak target ber-HP 0 kecuali `{ revive: true }`.** Resurrection Staff menyetel
  `hp[0] = 0` lalu memanggil `heal`; tanpa flag itu rekan tidak pernah benar-benar hidup dan
  hanya WP yang terbuang. Target revive mengikuti `WeaponInterface.getDead()` (slot pertama).
- **Vanguard's Banner juga `preTurn`, bukan ability aktif.** OwO memasang Attack Up ke *semua*
  rekan dan menaikkan tier (6 → 7 → 8) saat buff lama tinggal ≤1 turn; unit lalu melewati
  serangan di turn itu (`skippedAttack`). Durasi yang dipasang **`ability.duration + 1`**: mesin
  menurunkan durasi di akhir turn pemasangan juga, jadi OwO memanggil `attemptBind(ally, 3)` untuk
  buff yang di deskripsi disebut "2 turns". Tanpa +1, buff tinggal 1 turn saat `preTurn`
  berikutnya, Banner recast tiap turn, dan unit pemakainya tidak pernah menyerang.
  Arcane Scepter boleh `overreplenish` 150%.
- **Tim pemain selalu menyerang lebih dulu**, sama seperti OwO yang memanggil `executeTurn` dengan
  tim pemain sebagai `team`. Jangan mengacak sisi pembuka "supaya mirror 50%": keuntungan
  giliran pertama adalah bagian dari hasil yang diukur simulasi.
- **Emoji hewan harus sudah ter-mirror SEBELUM render, jangan mengandalkan cache.** `emoji_map`
  hanya terisi saat startup dan saat kartu ditangkap, jadi data lama bisa kosong. `d dex` selalu
  benar karena memanggil `mirrorEmojiTokens()` lalu `await` tepat sebelum render — panel wajib
  sama: `handleTeamCommand`, `handleTeamButton`, dan `handleSimCommand` memanggil
  `animalDex.ensureAnimalEmojis()` dan menunggu hasilnya. Retry di latar belakang saja tidak
  cukup: render pertama tetap jatuh ke 🐾 walau render kedua sudah benar.
  Token hewan memakai `emojiName || name` yang dipotong ke 32 karakter, karena nama emoji
  Discord tidak wajib terbaca dari judul kartu. Konsekuensinya handler tersebut `async`, jadi
  pemanggil dan tesnya harus `await` (tanpa itu asersi jalan sebelum balasan terkirim).
- **Jangan pakai `getAnimal()` untuk membaca `animal_key` slot.** Kunci slot bisa berasal dari
  versi dex sebelumnya — nama emoji (`feagle`), alias, atau kapitalisasi berbeda — sedangkan
  `d dex` tetap menemukannya karena memakai pencarian longgar. `getAnimal()` menuntut cocok
  persis, jadi slot seperti itu menghasilkan `animal: null` → 🐾 padahal hewannya ada di dex.
  Semua jalur render (`battlePanel`, `battleSim`, `battleTeam`) memakai
  `dexStore.resolveAnimal()` yang mencocokkan `name_key`, `name`, `emoji_name`, dan `alias`
  tanpa peduli kapitalisasi. Gejala khasnya: sebagian pet tampil, sebagian 🐾, dan pet yang
  🐾 selalu yang nama aslinya berbeda dari nama emoji.
- **Token yang tidak perlu di-mirror tetap harus dicatat ke `emoji_map`.** Emoji guild yang
  sudah bisa dirender bot (emoji milik server bot sendiri) dilewati `mirrorEmojiTokens()`,
  sedangkan `battleEmoji.resolve()` hanya membaca `emoji_map` — jadi melewatinya tanpa mencatat
  membuat emoji yang sebenarnya valid jatuh ke 🐾. Sekarang token tersebut disimpan apa adanya,
  dan `resolve()` punya lapisan kedua: pakai token asli bila `isRenderableToken(id)` benar.
  Gejalanya: sebagian pet tampil, sebagian 🐾, tanpa pola yang jelas dari sisi nama.
- **Tim kustom bersifat global per user** (`src/utils/battleTeamStorage.js`), bukan per server.
  Kolom `guild_id` dipertahankan hanya demi skema lama (selalu string kosong) dan
  `migrateToGlobal()` menggabungkan baris lama per user+nama saat database pertama dibuka.
- **Angka mengikuti `qualityList` di kode OwO, bukan deskripsi `?%`.** Deskripsi sengaja
  menyembunyikan nilainya; Sacrifice misalnya `[[50,75],[50,75]]` — jangan "menebak" dari teks.
- **Deskripsi live bot menang atas repo OwO publik.** Repo `9aec92b` sudah tertinggal (Sacred
  Ward belum ada di sana). Bila pengguna memberi teks deskripsi terbaru, pakai itu sebagai
  sumber dan perbarui data + mekanik, bukan mencari pembenaran di repo lama.
- **Sacred Ward (buff 13)** memblokir debuff di `bindBuff`: satu stack instance dibuang lalu
  pemasangnya me-replenish target sebesar 15-25% MAG. Buff positif tetap masuk.
- **`d sim -m` tidak punya batas atas**, tetapi `simulate()` tetap wajib `await` dan memakai
  `yieldEvery` (default 2000 run). Node hanya satu thread: loop 1 juta run butuh ~12 detik, dan
  tanpa jeda itu seluruh bot berhenti melayani perintah lain. Statistik turn dihitung dari
  histogram `Uint32Array` (satu sel per jumlah turn, maksimal `MAX_TURNS`), bukan array `turns`,
  supaya memori tetap kecil. Tes memakai `yieldEvery: 0` agar cepat.
- **Simulasi panjang mengirim progres, bukan diam lalu menjawab.** `simulate()` menerima
  `onProgress` yang dipanggil tiap `yieldEvery` run; handler `d sim` mengirim satu pesan
  "berjalan", memperbaruinya maksimal sekali per detik (`PROGRESS_EDIT_MS`) karena Discord
  membatasi edit, lalu **mengedit pesan yang sama** menjadi hasil akhir. Bila pengirim tidak
  mengembalikan objek Message (tes) atau edit gagal, hasil akhir dikirim sebagai pesan baru.
- **Jumlah pasif senjata kini berupa rentang, bukan angka pasti.** `passiveCount` adalah batas
  bawah, dan setiap senjata boleh memakai sampai `passiveCount + passiveBonus` (global 1 di
  `owoBattle.json`, bisa ditimpa per senjata). Pakai `data.passiveRange(weapon)` → `{min,max}`;
  jangan membandingkan langsung dengan `passiveCount`. Hasilnya: Great Sword 1-2, Orb of Potency
  2-3, Rune of the Forgotten 0-2 (boleh tanpa pasif). Bila pemanggil tidak memilih pasif,
  `rollPassives` tetap mengundi sebanyak `passiveCount` bawaan — jangan diganti ke batas atas,
  karena itu mengubah hasil simulasi lama tanpa diminta.
- **`d sim` punya cooldown 5 detik per user** (`SIM_COOLDOWN_MS` di `src/commands/battleSim.js`,
  tabel `command_cooldowns` di `battleTeamStorage`). Gerbangnya dipasang SETELAH validasi dan
  ditandai dua kali (sebelum `simulate` supaya run panjang tak bisa ditumpuk, sesudahnya supaya
  hitungannya dari akhir). Jangan pindahkan gerbang ke awal handler: perintah salah ketik akan
  dibalas pesan cooldown, bukan pesan validasinya. `d sim help` sengaja bebas cooldown.
  Tes memakai `store.setCooldown`/`clearCooldown` agar tidak menunggu 5 detik nyata.
- **Buff Wither (id 14) + Withering Staff (id 132).** Wither memotong `healed` dan
  `replenished`; sebar dilakukan di `postTurn` ke musuh yang belum terkena, dengan
  `effectiveness` dibagi `spreadWeakening` (0.5, dibaca dari data). Penumpukan memakai
  `STACK[14] = 'merge'` — durasi digabung, persen TIDAK dijumlah, supaya dua Wither tidak
  jadi −80%. Setiap buff baru harus punya factory di `battleBuffs.FACTORIES`, entri
  `STACK`, dan slot di `qualityList`; slot yang lupa ditambahkan membuat `stats[n]`
  `undefined` dan peluangnya selalu lolos (bug senyap, bukan error).
- **Buff Midnight Curse (id 15) + Witching Hour (id 133).** Beda dari senjata lain:
  efeknya `preTurn` (`curse_all`), bukan ability aktif, jadi tidak ada damage langsung
  dan WP dibayar tiap giliran. Jangan pasang ulang ke musuh yang sudah terkena —
  `STACK[15]='merge'` akan menggabung durasi sehingga kutukan melebihi 2 turn.
  Tiga persen tetapnya (`damageReduction`/`healReduction`/`wpDrain`) dibaca dari data,
  bukan ditanam di kode. `qualityList` satu nilai HARUS ditulis `[x, x]`: `statAt`
  lama menghasilkan `NaN` untuk `[x]` dan damage dibatalkan diam-diam.
- **Emoji senjata satu-varian.** `defaultEmoji` dipakai untuk semua tier bila `emojis`
  kosong; tes menerima `defaultEmoji` ATAU `emojiNote`. `resolve()` di `battleEmoji`
  tetap jatuh ke ikon netral kalau client Discord belum punya emoji itu di cache —
  itu wajar di tes, bukan bug. Saat ini **semua** senjata dan pasif sudah punya 7
  token rank; `defaultEmoji` tinggal jalur cadangan, bukan keadaan data.
- **Array emoji yang belum lengkap.** `pick()` memakai token terakhir untuk rank di
  atasnya (`Math.min(rankIndex(q), list.length - 1)`). Dulu ia mengembalikan `null`
  untuk rank > panjang array, jadi data 1-token hanya tampil di Common dan jatuh ke
  ikon netral di Fabled — persis tier yang dipakai saat `quality` tidak diisi.
- **`emoji_map` bisa basi.** Baris `emoji_map` hanya dipakai kalau `tokenIsLive()`
  memastikan emoji hasil mirror masih ada di cache. Satu token basi membuat Discord
  menolak **seluruh pesan** dengan error `10014` (Unknown Emoji), bukan sekadar
  kehilangan satu ikon. `isRenderableToken()` memeriksa cache guild **dan** cache
  `client.application.emojis`; emoji aplikasi bot tidak ada di `client.emojis`.
  Aturan ini berlaku untuk emoji battle **dan** emoji dex hewan: `resolve()` di
  `battleEmoji` serta `ensureAnimalEmoji()`/`ensureAnimalEmojis()` di `animalDex`
  semuanya memverifikasi sebelum memakai hasil cache.
- **`applyEmojiMap()` jangan sampai mengubah `null` jadi `"null"`.** Fungsi ini
  mengembalikan teks apa adanya kalau input kosong. Tanpa penjagaan itu,
  `String(null)` menghasilkan string `"null"` sehingga fallback
  `animalEmoji(a) || '**nama**'` tidak pernah jalan dan tabel dex menampilkan
  `null` sebagai label baris. Ini kena ke **11 dari 169** hewan — justru yang
  paling umum (`bee`, `bug`, `sheep`, `dragon`, `whale`), yaitu hewan yang
  gambarnya lampiran biasa sehingga tidak punya token emoji.
- **Tabel ringkas tidak boleh memotong hasil.** `d dex ... -c` dulu memakai
  `TABLE_MAX_ROWS = 30`, jadi query besar (mis. menempel seluruh pesan kebun
  binatang) berhenti di hewan ke-30 tanpa penjelasan — padahal sisa ruang embed
  masih 1888 karakter. Sekarang baris dipecah mengikuti batas asli Discord:
  4096 karakter per description, dan 6000 karakter total per pesan. Hasil
  panjang dikirim sebagai **beberapa pesan** berurutan, dengan judul bernomor
  `1/3`, `2/3`, dst. `buildDexResponse()` mengembalikan `{ messages: [...] }`
  untuk kasus ini; `prefix.js` mengirim tiap pesan berurutan.
- **`id` internal ≠ `owoId`.** Senjata lama memakai id 1-22 (urutan internal), sedangkan
  OwO punya id resmi sendiri (Flame Staff 10 vs 110, Glacial Axe 15 vs 115). JANGAN
  renumber `id`: dipakai tes, penyimpanan tim, dan alias. Id resmi disimpan di `owoId`.
  Saat menambah senjata baru, `id` internal dimulai dari 123 dan `owoId` boleh sama.
- **Alias harus unik lintas senjata DAN pending.** `bgaze`/`cclaw`/`cstaff` dulu menunjuk
  Burning Gaze/Cursed Claw/Cursed Staff; deskripsi live memindahkannya ke Bleeding
  Gaze/Conduit Claw/Staff of Corruption. Saat memindahkan alias, hapus dari
  `owoPending.json` dan catat di `aliasNotes`, kalau tidak alias lama tetap menang.
- **`act()` wajib memeriksa ability, bukan `manaCost`.** Bleeding Gaze berbiaya WP 0;
  gerbang lama `if (weapon.manaCost && ...)` membuat ability-nya tidak pernah jalan
  (bug senyap: senjata tampak normal, hanya efeknya hilang).
- **`ctx.turn`** diisi `runTurn` dan dipakai senjata berjadwal (Scepter: tiap 4 turn).
  Kalau membuat hook `preTurn` baru yang butuh nomor giliran, jangan pakai `ctx.tags`.
- **Efektivitas buff lewat `eff(self, pct)`.** Jangan kalikan `this.effectiveness`
  manual di tiap hook; `eff()` sudah menangani `undefined` (default 1).
- **`d team add` hanya menerima pasif numerik (`passive=27`).** Alias pasif (`adapt`,
  `sg`) hanya berlaku di `dtm s`/`dtm w`. Ini perilaku lama, bukan bug baru.
- **Adaptation (27): SATU pool stack, bukan dua.** Sumber menyebut Stoneskin
  (Physical) dan Spellskin (Magical), tapi keduanya berbagi satu pool: maksimal
  5 stack (`MAX_ADAPT_STACKS` di engine), dan menerima tipe lain menghapus SEMUA
  stack. Jangan simpan `stacks: {p, m}` terpisah — itu salah baca sumber.
  Damage TRUE menghapus stack tanpa menambah (bukan Physical/Magical).
- **Reward OCR: jangan pilih hasil dari confidence tertinggi.** PSM 6 bisa salah baca
  digit tunggal dengan keyakinan ~87% (angka "8" dibaca "3"), jadi satu mode atau
  confidence saja tidak cukup. `recognizeDigits` membaca tiap region dengan PSM
  6/7/8/13 lalu memilih lewat SUARA MAYORITAS. Kalau menambah parameter PSM, tambahkan
  ke daftar itu, bukan menggantinya.
- **Preprocessing crop dipakai untuk dua hal sekaligus.** Blur radius 3 (`BLUR_RADIUS`)
  menghaluskan tepi pixel font yang bergerigi, dan `darkBackground` menentukan
  polaritas: kartu gelap memakai angka putih. Membuang salah satunya membuat angka
  putih di kartu gelap ikut terhapus sebelum masuk Tesseract (pernah terjadi).
- **Fixture tes reward memakai font blok 5x7.** Glyph yang pikselnya asimetris
  (mis. '0' berbentuk `10011/10101/11001`) tidak dikenali sebagai digit dan bikin
  tes gagal; pakai bentuk kanonik. Angka yang digambar lebih lebar dari region akan
  terpotong secara fisik — itu batas fixture, bukan bug OCR.
- **Tim punya ID 1-21 per user.** `slot_id` di tabel `teams` diisi nomor bebas
  terkecil, jadi `del` mengosongkan slot ID dan ID itu dipakai ulang. `findTeam`
  mencoba ID lebih dulu, lalu nama; JANGAN memakai `getTeam` untuk input pengguna
  karena input `"3"` akan dianggap nama, bukan ID. Batas tim = `MAX_TEAM_ID` (21).
- **`dtm` menampilkan komposisi, bukan daftar nama.** Navigasi lewat tombol sempit
  `◀ [n/total] ▶` + satu select menu (`src/ui/teamPanel.js`). Jangan menambah tombol
  per tim: 21 tim menghabiskan seluruh baris komponen Discord. Select menu menyimpan
  **indeks** di `value`, bukan nama tim.
- **Jangan `require` di dalam fungsi yang dipanggil per serangan.** `battleWeapon.js`
  dulu memanggil `require('./battleEngine')` di 20 handler ability. Node meng-cache
  modulnya, tetapi resolusi nama tetap jalan dan profil CPU menunjukkan ~40% waktu
  simulasi habis di module loader. Pakai aksesor malas ber-cache seperti
  `battleBuffs`/`battlePassives` (`let engineRef = null; function engine()`).
  Perbaikan ini menaikkan throughput dari ~28 ribu ke ~90 ribu pertarungan/detik
  tanpa mengubah hasil battle sama sekali.
- **Simulasi global dipecah ke `worker_threads`.** `globalSimCore.js` berisi
  agregasi murni (dipakai worker maupun proses utama), `globalSimWorker.js` hanya
  pembungkus tipis, dan `globalSim.js` mengatur pembagian kerja + penggabungan.
  Worker mengirim **ringkasan**, bukan daftar pertarungan: jutaan hasil akan jauh
  lebih mahal dikirim daripada dihitung.
- **Seed tiap pertarungan = `runSeed(seed, nomorLawan, nomorRun)`.** Pertarungan
  jadi saling lepas, sehingga hasilnya identik berapa pun jumlah worker dan
  bagaimana pekerjaan dibagi (diuji 1/3/4 worker), dan satu rentang run bisa
  dihitung tanpa memajukan RNG lebih dulu. Pembagian kerja memakai rentang run,
  bukan per tim, supaya satu tim lawan pun tetap bisa diparalelkan.
- **Progres dikirim dari dalam worker, bukan per potong.** Satu potong berisi
  ratusan ribu pertarungan, jadi melapor hanya saat potong selesai membuat embed
  diam di 0% sampai hampir akhir. `aggregateChunk` menerima `onStep` dan worker
  mengirim pesan `{ type: 'progress' }` tiap `PROGRESS_STEP` pertarungan;
  `runChunkInWorker` membedakan pesan progres dari hasil akhir lewat `type`.
  Orkestrator menyaringnya ke `PROGRESS_EMIT_MS` (200 ms) dan menjumlahkan
  **nilai terakhir tiap potong** — menambahkan delta akan menghitung ganda.
  `handleGlobalSim` juga mengirim satu laporan `done: 0` sebelum worker mulai
  supaya balasan muncul seketika (dan bisa menyebut "menunggu antrean").
- **Streak gabungan butuh head/tail/sum/count per potong.** Tiap potong melaporkan
  kemenangan beruntun di awal (`head`), di akhir (`tail`), dan streak yang sudah
  selesai (`sum`/`count`). Penggabung menyambung `tail` potong sebelumnya dengan
  `head` potong berikutnya. Streak pertama di dalam potong **tidak** dihitung di
  sana — kalau dihitung, streak itu terhitung dua kali.
- **Jumlah tim dihitung sekali per lawan, bukan per unit kerja.** Tim yang
  terpecah antar-potong hanya dihitung saat `unit.from === 0`. Tanpa penjagaan ini
  `buckets.*.teams` membengkak dan rata-rata level jadi salah.
- **Hanya satu simulasi berat berjalan sekaligus.** `runGlobalSim` memakai antrean
  (`MAX_QUEUE = 3`); dua simulasi jutaan pertarungan bersamaan berebut core yang
  sama dan memakai memori dua kali. Antrean penuh bukan kesalahan user: command
  melepas cooldown dan menampilkan pesan agar bisa langsung dicoba lagi.
- **Batas `MAX_GLOBAL_BATTLES` = 10 juta** (~39 detik dengan 4 worker pada 4 vCPU;
  mesin uji punya 2 core fisik, jadi speedup praktis ~2x). Jangan naikkan tanpa
  mengukur ulang: batas waktu interaksi Discord dan memori VPS jadi taruhannya.
- **`-m` = per tim, `-total` = total pertarungan** (dibulatkan ke bawah agar tidak
  melebihi permintaan). Keduanya wajib terdaftar di `parseFlags`; flag yang tidak
  terdaftar akan jatuh ke `rest` dan ditolak sebagai "argumen tidak dikenal".
- **`dtm` menampilkan semua tim, simulasi hanya memakai tim berisi.** `listOpponentTeams`
  membuang tim tanpa slot, jadi memakainya langsung membuat jumlah lawan di
  simulasi lebih kecil daripada yang dilihat user di `dtm` tanpa penjelasan.
  `handleGlobalSim` mengiterasi `listAllTeams()` dan mencatat setiap tim yang
  dilewati beserta alasannya (`kosong` / `stat belum lengkap`) untuk field
  "⚠️ Tim dilewati". Kalau menambah alasan baru, tambahkan di situ — jangan
  kembali memakai `continue` tanpa catatan.
- **Warna embed simulasi global selalu biru (`COLOR.blue`), bukan `simColor`.**
  Simulasi duel tetap memakai `simColor` (hijau/kuning/merah mengikuti winrate);
  untuk global warna itu berubah-ubah dan mengganggu. Embed progres memilih warna
  dari opsi `mode`, bukan dari ada/tidaknya `title`.
