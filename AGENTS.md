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
- Nama yang tidak ada di dex dicatat di akhir embed (`⚠️ Tidak ditemukan: ...`) supaya user
  tahu hewan mana dari salinannya yang belum tertangkap.
- Salinan dari Discord sering memuat token emoji yang **terpotong**: `<a:snorlaxdoingafk:`
  (tanpa id) atau `:cpatreon:` (tanpa nama). `normalizeQueryToken` mengenali token yang
  mengandung `<`, `>`, `:`, digit superskrip, atau lebih dari 32 karakter (batas nama emoji
  Discord) sebagai potongan emoji, lalu mengambil bagian huruf/angkanya saja — jadi
  `snorlaxdoingafk` tetap bisa dicari, sedangkan `:cpatreon:` menjadi `cpatreon`.
  Mention `<@id>` dibuang di `extractFlags`.
- `<prefix>dex` **tanpa nama** tidak lagi menampilkan daftar hewan; balasannya adalah panduan
  cara pakai (`formatDexUsage`). Tidak ada kata kunci "tampilkan semua" — daftar penuh hanya
  pernah keluar lewat pencarian yang cocok banyak hewan.
- Emoji animasi Lucy bisa >256 KiB, batas unggah emoji Discord, sehingga `create` gagal 400 dan
  emoji tampil sebagai teks. `emojiSourceUrls` mencoba GIF dari ukuran kecil dulu
  (`?size=96,64,48,32`) — parameter CDN ini mengecilkan berkas tanpa membuang frame animasi —
  baru versi penuh. Kegagalan mirror dicatat ke console (terlihat di dashboard log).

## Dashboard
- `src/dashboard/server.js` (API + static) dan `src/dashboard/public/` (UI: `index.html`, `app.js`,
  `styles.css`). Semua endpoint `/api/*` butuh header `Authorization: Bearer <DASHBOARD_TOKEN>`.
- Fitur **Notes**: catatan bebas per server di `data/notes.json` via `src/utils/noteStorage.js`
  (CRUD: `listNotes`/`addNote`/`updateNote`/`deleteNote`, judul ≤120, isi ≤4000). Endpoint:
  `GET/POST/PUT/DELETE /api/notes`. UI-nya panel `#notes` di dashboard (tambah/edit/hapus).
- Test: `test/notes.test.js` (storage) dan `test/dashboardNotes.test.js` (API HTTP sungguhan).
