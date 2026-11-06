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
  perubahan kode. Nama harus persis: `hp att pr wp mg mr` (huruf kecil).
- Emoji guild yang sudah bisa diakses bot dipakai langsung tanpa di-mirror.
