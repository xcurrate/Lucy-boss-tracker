# Lucy Boss Tracker

Bot Discord Node.js untuk memantau pesan Components V2 dari bot Lucy, membaca timestamp Boss baru, lalu mengirim notifikasi saat waktunya tiba.

## Fitur
- Membaca timestamp Discord khusus pada baris Boss baru.
- Memantau pesan baru dan pesan yang diperbarui dari Lucy.
- Notifikasi channel server dengan role mention yang dikonfigurasi moderator/admin.
- Preferensi DM pribadi per anggota: DM, channel (tanpa DM), atau keduanya.
- DM peringatan sebelum boss muncul.
- Panel Components v2 untuk preferensi pribadi.
- Perintah slash dan prefix dengan alias per subperintah.
- Auto Thread Rep: membuat thread dari pesan *rep dengan mention target yang benar pada channel yang dipilih; instruksi rep dikirim sebagai teks untuk disalin, bukan dieksekusi.
- Web Control Dashboard lokal untuk konfigurasi fitur dan runtime logs.
- Konfigurasi tersimpan dan jadwal dipulihkan setelah restart.

## Web Control Dashboard

Dashboard memiliki kategori Overview, Boss Tracker, Auto Thread Rep, Lucy Counter, Boss Reward Reminder, Notes, dan System Logs.

Pengaturan Boss Tracker: ON/OFF, channel notifikasi, role mention, prefix server, dan status waktu boss berikutnya.

Pengaturan Auto Thread Rep: ON/OFF, **channel pemicu khusus**, target Discord user ID, nominal rep, awalan nama thread, dan durasi auto-archive. Fitur hanya memproses pesan *rep yang dikirim di channel Auto Thread Rep yang dipilih. Channel ini terpisah dari channel notifikasi Boss Tracker.

Notes: catatan bebas per server (judul + isi), bisa ditambah, diedit, dan dihapus langsung dari dashboard. Catatan disimpan di `data/notes.json` dan hanya berlaku untuk server yang sedang dipilih.

Kotak log menampilkan log runtime terbaru secara otomatis. Buffer menyimpan maksimal 300 entri terakhir di memori proses.

Pengaturan pribadi per anggota (mode DM dan waktu DM peringatan) tetap dikelola oleh masing-masing anggota melalui perintah /boss menu. Dashboard mengatur konfigurasi fitur pada tingkat server dan tidak menimpa preferensi pribadi tersebut.

### Akses dashboard developer

Tidak menggunakan OAuth atau login Discord. Untuk hosting Pterodactyl, dashboard bind ke `0.0.0.0` agar dapat menerima koneksi dari allocation port container. Atur `DASHBOARD_PORT` ke port allocation di panel (contoh `4002`), `DASHBOARD_HOST=0.0.0.0`, dan isi `DASHBOARD_TOKEN` dengan secret acak minimal 24 karakter melalui Environment Variables di panel. Buka `http://bt1.luckystore.id:4002` (ganti host/port sesuai allocation). Saat pertama dibuka, masukkan token tersebut; token disimpan hanya di session browser. API dashboard menolak request tanpa token. Jangan pernah memasukkan token ke source code atau membagikannya. Jika panel memakai proxy HTTPS, akses melalui URL HTTPS yang disediakan panel.

## Untuk semua anggota
- /boss menu — panel pengaturan pribadi.
- /boss notify mode:... — pilih mode DM, channel, atau keduanya.
- /boss warn detik:60 — atur DM peringatan sebelum boss muncul (0 = matikan).
- /boss on dan /boss off — aktifkan/matikan DM pribadi.
- /boss status — lihat status tracker dan waktu boss berikutnya.
- /boss help — panduan singkat.

Versi prefix (prefix default `d`, inisial bot Dragneel). Fitur boss ada di bawah kategori `boss`,
perintah tingkat bot langsung mengikuti prefix:
- d boss notify dm / d boss notify channel / d boss notify both
- d boss warn <detik> — DM peringatan sebelum boss muncul (0 untuk matikan)
- d boss menu, d boss status
- d f100 — mulai ronde Family 100
- d f100 reveal — tampilkan semua jawaban soal aktif selama 2 detik lalu hilang (khusus developer)

## Cepat Tepat (Matematika)
Game hitung cepat: bot mengirim satu soal aritmetika, siapa pun yang menjawab benar paling dulu dapat poin.
Tingkat kesulitan naik tiap soal; poin = dasar per level + bonus kecepatan.
- d math [jumlah] — mulai ronde (default 5 soal, maks 30) (alias: d mtk, d hitung)
- d math lb [all] — leaderboard mingguan/all-time
- d math stop — hentikan ronde (moderator/admin/developer)

## Pengingat Aksi Lucy
Aksi Lucy ditulis `<prefix-lucy> <aksi>`, dengan pengingat otomatis setelah durasi tunggu:

| Jenis pengingat | Bentuk aksi yang dikenali | Pengingat |
|---|---|---|
| Lucy Pray/Curse | `lucy pray`, `lpray`, `lucy curse`, `lcurse` | 5 menit |
| Lucy Battle/Hunt | `lucy battle`, `lucy fight`, `lucy war`, `lbattle`, `lfight`, `lb`, `lucy hunt`, `lucy catch`, `lhunt`, `lh` | 15 detik |
| Lucy | pesan yang memuat kata "lucy" | 10 detik |

**Semua pengingat OFF secara default.** Anggota menyalakannya sendiri lewat
`d lreminder`.

Aksi yang durasinya sama berbagi satu pengingat: pray+curse (5 menit) dan
battle+hunt (15 detik). Yang menyatu hanya pengingat dan cooldown-nya, sementara
**penghitungan tetap per aksi** — jadi `d llb pray` dan `d llb curse` tetap
menunjukkan angka masing-masing, begitu juga battle dan hunt.

**Pengingat pertama yang menang.** Kalau kamu menulis `lh` lalu `lb`, atau
`lpray` lalu `lcurse`, yang dihitung adalah aksi yang **lebih dulu**: waktunya
tidak digeser, dan teks pengingatnya memakai aksi pertama itu. Jadi `lh` lalu
`lb` tetap dihitung dari `lh`, dan `lpray` lalu `lcurse` tetap dari `lpray`.

**Bot tidak membalas aksi.** Aksi cukup dipantau; pengingat dijadwalkan dari
pesanmu dan dikirim setelah durasi tunggu habis. Jadi satu aksi = satu pesan
(pengingatnya), bukan balasan lalu pengingat. Anggota yang belum pernah mengatur
dan pengingatnya masih OFF akan diberi tahu sekali lewat pesan sementara yang
hanya dia yang lihat.

Bentuk berspasi juga jalan: `l fight`, `l hunt`.

- d lreminder — kotak interaksi: tombol on/off dan tombol cara ping per jenis
- Cara ping: Tag, Reply, Tag + Reply, atau Tanpa keduanya
- Pengaturan reminder berlaku GLOBAL di semua server — atur sekali, berlaku di mana pun

### Prefix bot Lucy
Prefix bot Lucy adalah prefix yang dipakai bot Lucy untuk membaca perintah user
(mis. `lucy`, `l`, atau `g`). Ini berbeda dari prefix bot kita sendiri (`d`), yang
hanya untuk perintah `d lreminder`, `d llb`, dan sejenisnya.

`lucy` adalah prefix bawaan bot Lucy, jadi **selalu dikenali** dan tidak bisa
dihapus. Pengaturan admin hanya MENAMBAH prefix lain yang dipakai di server.

- d lucyprefix — lihat prefix yang dipantau (mis. `lucy`, `l`)
- d lucyprefix add g — tambah `g` (jadi `lucy`, `l`, dan `g`)
- d lucyprefix remove l — hapus `l` (kalau server tidak memakainya)
- d lucyprefix set g — hanya tambahan `g` (`lucy` tetap aktif)
- d lucyprefix reset — kembali ke default `lucy` dan `l`

Jadi `lucy battle` tetap dikenali di server mana pun. Untuk tiap prefix, bentuk
pendek juga jalan (mis. `gb`, `gh`, `gfight`).
- d lreminder reply <jenis> <teks> — balasan kustom (khusus premium)
- Balasan default tersedia untuk semua; balasan kustom + embed direncanakan sebagai fitur premium

### Leaderboard Aksi Lucy
- d llb <pray|curse|battle|hunt|lucy> [rentang] [halaman] [global]
- d llb all [rentang] — gabungan semua kategori
- Tambahkan `global` untuk menggabungkan seluruh server (mis. `d llb pray 7d global`)
- Rentang: kosong/harian (hari ini), 7d (7 hari terakhir), all (semua waktu), atau tanggal (5 nov)
- battle dan hunt digabung jadi satu kategori; lucy memakai penghitung Lucy yang sudah ada
- d ping (alias d p) — cek latency bot (roundtrip & WebSocket)
- d dex <nama...> — Animal Dex (alias d d)
- d help (alias d) — panduan; d prefix — lihat/ubah prefix server

Prefix bisa diganti per server oleh moderator (`d prefix <prefix-baru>`) atau lewat dashboard
developer. Subcommand yang tidak dikenal diabaikan supaya chat biasa seperti "duh" tidak memicu
balasan bot.

## Lucy Counter & Leaderboard
Menghitung pesan yang memuat kata "lucy" per anggota (cooldown 10 detik per anggota, maksimal 1 per pesan).
- d lcount [halaman] — leaderboard Lucy harian.
- d lcountall [halaman] — leaderboard Lucy all-time.
- d ltarget [halaman] — leaderboard progres Target Lucy (alias: d ltargetlb, d lucytarget leaderboard).
- d lservers [halaman] — leaderboard all-time per server (alias: d lserver).
- d lucytarget on|off, d lucytarget target on|off, d lucytarget set <jumlah>, d lucytarget message <pesan>, d lucytarget status — pengaturan Target Lucy (moderator/admin).

## Animal Dex
Menangkap kartu **"Informasi animal"** yang dikirim bot Lucy (pesan Components V2) secara otomatis, lalu menyimpannya ke database SQLite (`data/animal-dex.db`). Dex bersifat **global** — satu entri per nama hewan, digabung dari semua server (hewan yang sama tidak diduplikasi antar server). Setiap kali bot Lucy mengirim/memperbarui kartu animal, datanya di-*upsert* per nama hewan sehingga dex selalu terbarui. Database skema lama (per-server) dimigrasikan otomatis ke global saat pertama dijalankan.
- d dex [nama...] — tampilkan detail satu atau beberapa hewan sekaligus.
- d d [nama...] — alias singkat.
Nama bisa lebih dari satu, dipisah spasi atau koma. Contoh: `d dex lawliet`, `d dex lawliet buaya kudanil`, `d d patreon, hybrid`.
Query mencocokkan nama, alias, nickname, rank, atau nama emoji hewan (tidak peka huruf besar/kecil). Bila sebuah nama cocok ke beberapa hewan, hasilnya ditampilkan sebagai daftar gabungan.

Emoji hewan di kartu Lucy memuat nama hewannya, jadi user boleh **menempel emoji tersebut** langsung sebagai query (mis. `d dex <a:lawliet:1557672128059539466>`); bot akan memakai nama di balik emoji itu untuk mencari.

Tambahkan flag **`-c`** (atau `--compact`) di akhir perintah untuk tampilan ringkas berupa **tabel** (tanpa tabel embed, hanya kolom & baris). Baris pertama berisi emoji statistik hp→mr, baris berikutnya berisi emoji hewan + angka statistiknya:

```
Animal | <hp> <att> <pr> | <wp> <mg> <mr> | Total
<emoji hewan> | 2 0 1 | 3 14 2 | 22
```

Setiap nama pada query menghasilkan satu baris, jadi `d dex lawliet buaya kudanil -c` menampilkan satu baris per hewan. Contoh: `d dex lawliet -c`, `d d -c` (seluruh dex).

Data yang **ditampilkan** per hewan: nama, jumlah, rank, alias, role, statistik (HP/ATT/PR/WP/MG/MR), dan **total stat** (jumlah seluruh statistik). Data lain (nickname, points, sell, sacrifice, rekomendasi weapon, kelangkaan) tetap tersimpan di database tetapi tidak ditampilkan pada dex.

Gambar animal diambil dari accessory kartu (Components V2 type 11) — bentuknya **link** (mis. GIF emoji Discord), bukan file terpisah; link ini disimpan dan ditampilkan sebagai thumbnail pada kartu dex.

Emoji statistik (hp → mr) dan emoji hewan berasal dari **aplikasi Lucy**. Discord hanya mengizinkan aplikasi pemilik memakai emoji aplikasinya, sehingga bot ini tidak bisa merender emoji tersebut secara langsung (akan tampil sebagai `:hp:` teks biasa). Karena itu bot **menyalin (mirror)** emoji tersebut menjadi emoji milik aplikasi bot sendiri — sekali saja, disimpan di tabel `emoji_map` — lalu memakai emoji hasil mirror itu saat menampilkan dex. Proses mirror dijalankan otomatis saat bot start dan saat render dex; bila gagal (mis. tanpa izin), dex tetap tampil memakai nama emoji sebagai fallback. Emoji **guild** yang sudah bisa diakses bot (mis. emoji buatan sendiri di server bot) dipakai langsung tanpa di-mirror.

Emoji juga bisa di-upload **manual** di Developer Portal (aplikasi → Emoji) dengan nama yang dikenali: `hp`, `att`, `pr`, `wp`, `mg`, `mr` (huruf kecil) beserta aliasnya (`mg`/`mag`/`magic`, `att`/`attack`, `pr`/`prot`/`protection`). Emoji manual ini dipakai langsung tanpa dibuat ulang.

Setiap leaderboard memiliki tombol navigasi ⏮️ ◀️ ▶️ ⏭️ (awal, sebelumnya, berikutnya, akhir). Tombol membaca ulang data dari SQLite setiap kali ditekan, sehingga jumlah Lucy yang tampil selalu sinkron dengan data terbaru. Tombol tetap aktif di halaman pertama/terakhir (halaman otomatis di-clamp ke rentang yang valid).

## Untuk moderator/admin
Membutuhkan izin Discord Manage Server (Administrator juga diizinkan):
- /boss setup channel:#channel role:@role — atur channel dan role yang akan ditag.
- /boss server-on dan /boss server-off — aktifkan atau matikan tracker seluruh server.
- /boss prefix nilai:$ — ubah prefix server (prefix bawaan `d`).
- d prefix <prefix-baru> — ubah prefix lewat chat (moderator/admin).
- /boss admin-help — panduan moderator/admin.

## Instalasi
Persyaratan: Node.js 22.13 atau lebih baru (leaderboard Lucy memakai `node:sqlite` bawaan Node).

1. Buat aplikasi/bot di Discord Developer Portal.
2. Undang bot dan berikan izin View Channels, Read Message History, Send Messages, Embed Links, serta izin mention role.
3. Aktifkan Message Content Intent di Developer Portal → Bot → Privileged Gateway Intents.
4. Jalankan:

   npm install
   cp .env.example .env
   npm run deploy-commands
   npm run check
   npm test
   npm start

Isi `.env`: `DISCORD_TOKEN`, `CLIENT_ID`, dan `LUCY_BOT_ID`. `GUILD_ID` dan `LUCY_CHANNEL_ID` opsional. Jangan unggah token atau file `.env` ke GitHub.

## Catatan
- Bot menjadwalkan waktu setelah menerima timestamp boss dari Lucy. Pastikan bot dapat membaca channel sumber.
- Jika bot mulai setelah timestamp lewat, notifikasi akan dicoba segera saat tracker aktif, kecuali sudah diberitahukan.
- DM dapat gagal jika pengguna menutup DM.
- Data leaderboard Lucy disimpan di SQLite (`data/lucy-counter.db`) memakai `node:sqlite` bawaan Node. Saat pertama dijalankan, data lama dari `data/lucy-counter.json` dimigrasikan otomatis (satu kali) lalu file JSON dibiarkan sebagai cadangan.
- Penyimpanan berbasis file cocok untuk satu instance; gunakan database bersama untuk banyak instance.
