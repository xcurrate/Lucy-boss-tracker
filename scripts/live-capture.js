#!/usr/bin/env node
// Menangkap balasan bot untuk perintah yang dikirim user dari client Discord-nya
// sendiri. Skrip ini hanya membaca: tidak mengirim pesan, tidak menghapus pesan,
// dan tidak memerlukan token akun.
//
// Pemakaian:
//   node scripts/live-capture.js               # pantau terus sampai Ctrl-C
//   node scripts/live-capture.js --once        # cetak balasan yang sudah ada lalu keluar
//   node scripts/live-capture.js --since <id>  # mulai dari pesan tertentu
//
// Alurnya: user mengetik perintah di kanal, skrip mencatat pesan user itu, lalu
// mengikuti balasan bot sampai isinya berhenti berubah (embed progres diedit
// menjadi hasil akhir, jadi hasil akhirnya adalah versi yang stabil).
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const API = 'https://discord.com/api/v10';
const CHANNEL = process.env.LIVE_CAPTURE_CHANNEL || '1554454470211936266';
const ONCE = process.argv.includes('--once');
const sinceFlag = process.argv.indexOf('--since');

const botToken = process.env.DISCORD_TOKEN;
let botMe = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(route) {
  const res = await fetch(API + route, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`GET ${route} -> ${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

function preflight() {
  if (!botToken) {
    console.error('❌ DISCORD_TOKEN belum ada. Skrip ini hanya butuh token bot untuk membaca kanal.');
    return false;
  }
  return true;
}

// Bot menjawab dengan pesan baru, lalu hasil akhirnya menimpa pesan yang sama.
// Tunggu sampai isi pesan berhenti berubah agar yang dibaca adalah hasil akhir.
//
// Yang diambil adalah balasan PALING AWAL setelah perintah, dan hanya selama
// belum ada pesan manusia lain sesudahnya. Tanpa batas itu, memutar ulang pesan
// lama akan memungut balasan terbaru di kanal, bukan balasan perintah itu.
async function waitReply(afterId, replyBotId, { timeout = 120000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  let stable = 0;
  while (Date.now() < deadline) {
    const msgs = await call(`/channels/${CHANNEL}/messages?limit=20`);
    const newer = msgs.filter(m => BigInt(m.id) > BigInt(afterId));
    let nextHuman = null;
    for (const m of newer) {
      if (m.author.bot) continue;
      if (nextHuman === null || BigInt(m.id) < BigInt(nextHuman)) nextHuman = m.id;
    }
    const mine = newer
      .filter(m => m.author.id === replyBotId)
      .filter(m => nextHuman === null || BigInt(m.id) < BigInt(nextHuman))
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    if (mine.length) {
      const current = mine[0];
      const sig = JSON.stringify(current.embeds?.[0] || current.content);
      if (sig === last) {
        if (++stable >= 2) return current;
      } else {
        last = sig;
        stable = 0;
      }
    }
    await sleep(1000);
  }
  return null;
}

function render(label, msg) {
  if (!msg) {
    console.log(`  ✖ ${label}: bot tidak menjawab (timeout)`);
    return null;
  }
  const embed = msg.embeds?.[0];
  console.log(`  ${label}`);
  if (embed?.title) console.log(`    [${embed.title}]`);
  for (const line of String(embed?.description || msg.content || '').split('\n')) {
    if (line.trim()) console.log(`    ${line}`);
  }
  for (const field of embed?.fields || []) {
    const [first] = String(field.value).split('\n');
    console.log(`    • ${field.name}: ${first}`);
  }
  return embed;
}

(async () => {
  if (!preflight()) process.exit(2);

  try {
    botMe = await call('/users/@me');
    console.log(`Menangkap balasan ${botMe.username} (${botMe.id}) di kanal ${CHANNEL}.\n`);
  } catch (err) {
    console.error(`❌ Token bot ditolak Discord: ${err.message}`);
    process.exit(2);
  }

  // Pesan terbaru saat mulai. Semua pesan setelah penanda ini dianggap baru,
  // sehingga balasan lama tidak ikut tercetak.
  const latest = await call(`/channels/${CHANNEL}/messages?limit=1`);
  let cursor = sinceFlag > -1 ? process.argv[sinceFlag + 1] : (latest[0]?.id ?? '0');
  if (sinceFlag > -1) console.log(`Mulai dari pesan ${cursor}.`);
  else console.log(`Baseline pesan ${cursor}. Ketik perintahmu sekarang di kanal itu.`);

  // Perintah yang sudah dicatat, supaya satu perintah tidak diproses dua kali.
  const seen = new Set();

  async function scan() {
    const msgs = await call(`/channels/${CHANNEL}/messages?limit=20`);
    for (const m of msgs.reverse()) {
      if (BigInt(m.id) <= BigInt(cursor) || seen.has(m.id)) continue;
      seen.add(m.id);
      if (m.author.bot) continue;
      const command = (m.content || '').trim();
      if (!command) continue;

      console.log(`\n[${new Date(m.timestamp).toLocaleTimeString()}] 👤 ${m.author.username}: ${command}`);
      // `--once` hanya memutar ulang pesan lama, jadi balasannya sudah final dan
      // tidak perlu ditunggu lama. Mode pantau menunggu embed progres selesai
      // diedit menjadi hasil akhir.
      const reply = await waitReply(m.id, botMe.id, { timeout: ONCE ? 8000 : 120000 });
      render('balasan', reply);
    }
  }

  if (ONCE) {
    await scan();
    return;
  }

  console.log('Menunggu perintah baru... (Ctrl-C untuk berhenti)');
  while (true) {
    await scan().catch(err => console.error(`  ! gagal membaca kanal: ${err.message}`));
    await sleep(2000);
  }
})().catch(err => {
  console.error(`GAGAL: ${err.message}`);
  process.exit(1);
});
