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
- Auto Thread Rep: membuat thread dari pesan *rep dengan mention target yang benar; instruksi rep dikirim sebagai teks untuk disalin, bukan dieksekusi.
- Web Control Dashboard untuk mengatur fitur dan melihat runtime logs.
- Konfigurasi tersimpan dan jadwal dipulihkan setelah restart.

## Web Control Dashboard
Dashboard memiliki kategori Overview, Boss Tracker, Auto Thread Rep, dan System Logs.

Pengaturan Boss Tracker: ON/OFF, channel notifikasi, role mention, prefix server, dan status waktu boss berikutnya.

Pengaturan Auto Thread Rep: ON/OFF, target Discord user ID, nominal rep, awalan nama thread, dan durasi auto-archive.

Kotak log menampilkan log runtime terbaru secara otomatis. Buffer menyimpan maksimal 300 entri terakhir di memori proses.

Pengaturan pribadi per anggota (mode DM dan waktu DM peringatan) tetap dikelola oleh masing-masing anggota melalui perintah /boss menu. Dashboard mengatur konfigurasi fitur pada tingkat server dan tidak menimpa preferensi pribadi tersebut.

### Menyiapkan OAuth2
1. Buka Discord Developer Portal → aplikasi bot → OAuth2.
2. Tambahkan Redirect URL yang sama persis dengan DASHBOARD_REDIRECT_URI, misalnya http://localhost:3000/auth/callback untuk pengembangan lokal.
3. Salin OAuth2 Client Secret ke DISCORD_CLIENT_SECRET. Jangan commit secret atau file .env.
4. Atur CLIENT_ID, DISCORD_CLIENT_SECRET, dan DASHBOARD_REDIRECT_URI di .env.
5. Jalankan bot. Dashboard tersedia di http://localhost:3000 jika DASHBOARD_HOST=127.0.0.1.
6. Login dengan Discord. Hanya pengguna dengan izin Manage Server atau Administrator pada server tempat bot terpasang yang dapat melihat dan mengubah pengaturan server tersebut.

Dashboard nonaktif dengan aman jika konfigurasi OAuth belum lengkap. Gunakan HTTPS pada deployment publik dan pertahankan cookie Secure aktif. DASHBOARD_COOKIE_SECURE=false hanya untuk pengembangan lokal HTTP. Untuk akses dari perangkat lain, atur host/bind dan reverse proxy HTTPS sesuai lingkungan deployment.

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

Isi .env: DISCORD_TOKEN, CLIENT_ID, LUCY_BOT_ID, dan untuk dashboard DISCORD_CLIENT_SECRET serta DASHBOARD_REDIRECT_URI. GUILD_ID dan LUCY_CHANNEL_ID opsional. Jangan unggah token atau file .env ke GitHub.

## Catatan
- Bot menjadwalkan waktu setelah menerima timestamp boss dari Lucy. Pastikan bot dapat membaca channel sumber.
- Jika bot mulai setelah timestamp lewat, notifikasi akan dicoba segera saat tracker aktif, kecuali sudah diberitahukan.
- DM dapat gagal jika pengguna menutup DM.
- Penyimpanan JSON cocok untuk satu instance; gunakan database bersama untuk banyak instance.
