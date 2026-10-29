# Lucy Boss Tracker

Bot Discord Node.js untuk memantau pesan Components V2 dari bot Lucy, membaca timestamp **Boss baru**, lalu mengirim notifikasi saat waktunya tiba.

## Fitur v1
- Membaca timestamp Discord seperti `<t:1792162619:R>` khusus pada baris `Boss baru` (bukan timestamp reset harian).
- Memantau pesan baru dan pesan yang diperbarui dari Lucy.
- Notifikasi ke channel dengan mention role seperti `@Boss slayer`.
- DM pribadi untuk pengguna yang memilih mengaktifkannya.
- Konfigurasi tersimpan per server dan jadwal dipulihkan setelah restart.
- Slash commands dan help bawaan.

## Persyaratan
- Node.js 20.11 atau lebih baru.
- Bot dibuat melalui Discord Developer Portal.
- Berikan izin View Channels, Read Message History, Send Messages, Embed Links, dan izin mention role yang dipilih.
- Aktifkan **Message Content Intent** di Developer Portal > Bot > Privileged Gateway Intents.

## Instalasi
```bash
npm install
cp .env.example .env
```
Isi file `.env`:
- `DISCORD_TOKEN`: token bot.
- `CLIENT_ID`: application ID bot.
- `GUILD_ID`: opsional; isi ID server untuk registrasi command saat pengembangan. Kosongkan untuk command global.
- `LUCY_BOT_ID`: ID bot Lucy.
- `LUCY_CHANNEL_ID`: channel sumber pesan Lucy. Kosongkan jika ingin memantau semua channel yang dapat dibaca.

Daftarkan command dan jalankan bot:
```bash
npm run deploy-commands
npm start
```
Jangan unggah token atau file `.env` ke GitHub.

## Command
| Command | Fungsi | Izin |
|---|---|---|
| `/boss help` | Menampilkan panduan | Semua |
| `/boss status` | Melihat status, channel, role, timestamp boss, preferensi DM | Semua |
| `/boss setup channel:#channel role:@Boss slayer` | Mengatur channel dan role notifikasi | Manage Server |
| `/boss enable` | Mengaktifkan notifikasi server | Manage Server |
| `/boss disable` | Menonaktifkan notifikasi server | Manage Server |
| `/boss dm aktif:true` | Mengaktifkan DM untuk akun sendiri; gunakan `false` untuk mematikan | Semua |

**Alur awal:** jalankan `/boss setup`, lalu `/boss enable`. User yang ingin menerima DM perlu menjalankan `/boss dm aktif:true` sendiri.

## Struktur proyek
```text
.
├── .env.example
├── .gitignore
├── package.json
├── README.md
└── src
    ├── index.js
    ├── deploy-commands.js
    ├── commands/boss.js
    ├── services/bossTracker.js
    └── utils/storage.js
```

## Catatan
- Bot hanya dapat menjadwalkan waktu setelah menerima pesan Lucy yang memuat timestamp boss. Pastikan bot dapat membaca channel sumber.
- Jika bot dimulai setelah timestamp lewat, notifikasi akan dicoba segera saat tracker aktif, kecuali timestamp itu sudah diberitahukan.
- DM dapat gagal jika pengguna menutup DM dari anggota server.
- Penyimpanan JSON cocok untuk satu instance. Untuk beberapa instance, gunakan database bersama.
