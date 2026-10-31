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

Dashboard memiliki kategori Overview, Boss Tracker, Auto Thread Rep, dan System Logs.

Pengaturan Boss Tracker: ON/OFF, channel notifikasi, role mention, prefix server, dan status waktu boss berikutnya.

Pengaturan Auto Thread Rep: ON/OFF, **channel pemicu khusus**, target Discord user ID, nominal rep, awalan nama thread, dan durasi auto-archive. Fitur hanya memproses pesan *rep yang dikirim di channel Auto Thread Rep yang dipilih. Channel ini terpisah dari channel notifikasi Boss Tracker.

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

Versi prefix (prefix default !):
- !boss notify dm / !boss notify channel / !boss notify both
- !boss warn <detik> — DM peringatan sebelum boss muncul (0 untuk matikan)
- !boss menu, !boss status, !boss help

## Untuk moderator/admin
Membutuhkan izin Discord Manage Server (Administrator juga diizinkan):
- /boss setup channel:#channel role:@role — atur channel dan role yang akan ditag.
- /boss server-on dan /boss server-off — aktifkan atau matikan tracker seluruh server.
- /boss prefix nilai:$ — ubah prefix server.
- /boss admin-help — panduan moderator/admin.

## Instalasi
Persyaratan: Node.js 20.11 atau lebih baru.

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
- Penyimpanan JSON cocok untuk satu instance; gunakan database bersama untuk banyak instance.
