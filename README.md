# Lucy Boss Tracker

Bot Discord Node.js untuk memantau pesan Components V2 dari bot Lucy, membaca timestamp **Boss baru**, lalu mengirim notifikasi saat waktunya tiba.

## Fitur
- Membaca timestamp Discord seperti `<t:1792162619:R>` khusus pada baris `Boss baru`.
- Memantau pesan baru dan pesan yang diperbarui dari Lucy.
- Notifikasi ke channel pilihan server dengan mention role pilihan moderator/admin.
- Pengingat DM yang dapat diaktifkan atau dimatikan setiap pengguna untuk dirinya sendiri.
- Perintah slash dan prefix; prefix disimpan terpisah untuk setiap server.
- Konfigurasi per server tersimpan dan jadwal dipulihkan setelah bot restart.

## Izin pengguna

### Semua anggota
Anggota biasa hanya dapat mengatur pengingat pribadi mereka sendiri:
- `/boss on` atau `!boss on` — aktifkan DM pengingat.
- `/boss off` atau `!boss off` — matikan DM pengingat.
- `/boss status` atau `!boss status` — lihat status tracker dan waktu boss.
- `/boss help` atau `!boss help` — panduan singkat.

Perintah `!boss` menggunakan prefix server saat ini. Prefix default adalah `!`.

### Moderator/admin server
Memerlukan izin Discord **Manage Server** (administrator juga diizinkan):
- `/boss setup channel:#channel role:@role` atau `!boss setup #channel @role` — atur channel notifikasi dan role yang akan ditag.
- `/boss server-on` atau `!boss server on` — aktifkan tracker untuk seluruh server.
- `/boss server-off` atau `!boss server off` — matikan tracker server.
- `/boss prefix nilai:$` atau `!boss prefix $` — ubah prefix server menjadi `$`.
- `/boss prefix` atau `!boss prefix` — lihat prefix server.
- `/boss admin-help` atau `!boss admin-help` — panduan pengaturan moderator/admin.

Prefix harus 1–5 karakter tanpa spasi. Prefix setiap server tersimpan secara independen. Perintah pengguna biasa tidak dapat mengubah channel, role, prefix, atau status global server.

## Instalasi

Persyaratan: Node.js 20.11 atau lebih baru.

1. Buat aplikasi/bot melalui Discord Developer Portal.
2. Undang bot ke server dan berikan izin View Channels, Read Message History, Send Messages, Embed Links, serta izin mention role yang dipilih.
3. Aktifkan **Message Content Intent** pada Developer Portal > Bot > Privileged Gateway Intents.
4. Instal dependensi dan siapkan konfigurasi:

```bash
npm install
cp .env.example .env
```

Isi `.env`:
- `DISCORD_TOKEN`: token bot.
- `CLIENT_ID`: application ID bot.
- `GUILD_ID`: opsional; ID server untuk registrasi command saat pengembangan. Kosongkan untuk command global.
- `LUCY_BOT_ID`: ID bot Lucy.
- `LUCY_CHANNEL_ID`: channel sumber pesan Lucy. Kosongkan jika ingin memantau semua channel yang dapat dibaca.

Jalankan:

```bash
npm run deploy-commands
npm run check
npm start
```

Jangan unggah token atau file `.env` ke GitHub.

## Catatan
- Bot hanya dapat menjadwalkan waktu setelah menerima pesan Lucy yang memuat timestamp boss. Pastikan bot dapat membaca channel sumber.
- Jika bot dimulai setelah timestamp lewat, notifikasi akan dicoba segera saat tracker aktif, kecuali timestamp itu sudah diberitahukan.
- DM dapat gagal jika pengguna menutup DM dari anggota server.
- Penyimpanan JSON cocok untuk satu instance. Untuk beberapa instance, gunakan database bersama.
