# Lucy Boss Tracker

Bot Discord Node.js untuk memantau pesan Components V2 dari bot Lucy, membaca timestamp **Boss baru**, lalu mengirim notifikasi saat waktunya tiba.

## Fitur
- Membaca timestamp Discord khusus pada baris `Boss baru`.
- Memantau pesan baru dan pesan yang diperbarui dari Lucy.
- Notifikasi channel server dengan role mention yang dikonfigurasi moderator/admin.
- Preferensi DM pribadi per anggota: DM, channel (tanpa DM), atau keduanya.
- **DM peringatan** — setiap anggota dapat mengatur berapa detik/menit sebelum boss muncul untuk menerima pengingat pribadi.
- UI panel **Components v2** (select menu, tombol) untuk mengatur preferensi pribadi.
- Perintah slash dan prefix; prefix tersimpan terpisah untuk setiap server, dengan **alias** untuk setiap subperintah.
- Konfigurasi tersimpan dan jadwal dipulihkan setelah restart.

## Untuk semua anggota
- `/boss menu` — **panel Components v2**: atur mode notifikasi, DM peringatan, dan tombol DM ON/OFF.
- `/boss notify mode:...` — pilih mode pengingat: DM, channel (tanpa DM pribadi), atau keduanya.
- `/boss warn detik:60` — atur **DM peringatan** beberapa detik/menit sebelum boss muncul (`0` = matikan).
- `/boss on` — aktifkan DM pribadi.
- `/boss off` — matikan DM pribadi.
- `/boss status` — lihat status tracker dan waktu boss berikutnya.
- `/boss help` — panduan singkat.

Versi prefix (prefix default `!`, semua subperintah punya alias — misal `!boss notif dm`, `!boss cek`, `!boss peringatan 60`):
- `!boss notify dm` / `!boss notify channel` / `!boss notify both`
- `!boss warn <detik>` — DM peringatan sebelum boss muncul (`0` untuk matikan)
- `!boss menu` — tampilkan panel Components v2
- `!boss status`
- `!boss help`

Daftar alias:
| Perintah | Alias |
| --- | --- |
| `help` | `bantuan` |
| `notify` | `notif`, `pengingat` |
| `on` | `nyalakan`, `aktifkan`, `enable` |
| `off` | `matikan`, `nonaktifkan`, `disable` |
| `status` | `cek`, `info`, `state` |
| `warn` | `peringatan`, `ingatkan` |
| `menu` | `panel`, `pengaturan` |
| `setup` | `set`, `atur`, `config`, `konfigurasi` |
| `server-on` | `server-nyalakan`, `aktif` |
| `server-off` | `server-matikan`, `nonaktif` |
| `prefix` | `awalan` |
| `admin-help` | `bantuan-admin` |

**Penting:** notifikasi di channel adalah notifikasi bersama untuk server, dikelola moderator/admin, dan tetap terlihat oleh anggota yang memiliki akses ke channel. Preferensi `dm` mengaktifkan DM pribadi; `channel` mematikan DM pribadi; `both` mengaktifkan DM pribadi sambil tetap menggunakan channel bersama. Bot tidak bisa menyembunyikan pesan channel hanya untuk satu anggota tanpa mengubah izin akses Discord mereka.

## Untuk moderator/admin
Membutuhkan izin Discord **Manage Server** (Administrator juga diizinkan):
- `/boss setup channel:#channel role:@role` atau `!boss setup #channel @role` — atur channel dan role yang akan ditag.
- `/boss server-on` atau `!boss server on` — aktifkan tracker untuk seluruh server.
- `/boss server-off` atau `!boss server off` — matikan tracker server.
- `/boss prefix nilai:$` atau `!boss prefix $` — ubah prefix server.
- `/boss prefix` atau `!boss prefix` — lihat prefix saat ini.
- `/boss admin-help` atau `!boss admin-help` — panduan moderator/admin.

Prefix harus 1–5 karakter tanpa spasi. Perintah pengguna biasa tidak dapat mengubah channel, role, prefix, atau status global server.

## Instalasi
Persyaratan: Node.js 20.11 atau lebih baru.

1. Buat aplikasi/bot di Discord Developer Portal.
2. Undang bot dan berikan izin View Channels, Read Message History, Send Messages, Embed Links, serta izin mention role.
3. Aktifkan **Message Content Intent** di Developer Portal > Bot > Privileged Gateway Intents.
4. Jalankan:
   ```bash
   npm install
   cp .env.example .env
   npm run deploy-commands
   npm run check
   npm test
   npm start
   ```

Isi `.env`: `DISCORD_TOKEN`, `CLIENT_ID`, opsional `GUILD_ID`, `LUCY_BOT_ID`, dan opsional `LUCY_CHANNEL_ID`. Jangan unggah token atau file `.env` ke GitHub.

## Catatan
- Bot menjadwalkan waktu setelah menerima timestamp boss dari Lucy. Pastikan bot dapat membaca channel sumber.
- Jika bot mulai setelah timestamp lewat, notifikasi akan dicoba segera saat tracker aktif, kecuali sudah diberitahukan.
- DM dapat gagal jika pengguna menutup DM.
- Penyimpanan JSON cocok untuk satu instance; gunakan database bersama untuk banyak instance.
