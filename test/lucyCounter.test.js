const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { countLucy, dayKey, isTargetWindow, challengeCycleKey, leaderboardEmbed, targetLeaderboardEmbed, serverLeaderboardEmbed, targetRanking, pageRows, navRow, isLucyNav, handleNavigation } = require('../src/services/lucyCounter');
const store = require('../src/utils/lucyCounterStorage');

test('counts at most one Lucy per message, case-insensitively', () => {
  assert.equal(countLucy('Lucy lucy LUCY'), 1);
  assert.equal(countLucy('lucyland lucky'), 0);
  assert.equal(countLucy('one Lucy, two lucy!'), 1);
  assert.equal(countLucy('hello there'), 0);
});

test('daily key uses YYYY-MM-DD in WIB', () => {
  assert.match(dayKey(new Date('2026-11-01T17:30:00.000Z')), /^2026-11-02$/);
});

test('target schedule spans from noon to 10:00 WIB the next day', () => {
  const config = { targetStartTime: '12:00', targetStopTime: '10:00' };
  assert.equal(isTargetWindow(new Date('2026-11-02T05:00:00.000Z'), config), true); // 12:00 WIB
  assert.equal(isTargetWindow(new Date('2026-11-03T02:59:00.000Z'), config), true); // 09:59 WIB
  assert.equal(isTargetWindow(new Date('2026-11-03T03:00:00.000Z'), config), false); // 10:00 WIB
  assert.equal(isTargetWindow(new Date('2026-11-03T04:59:00.000Z'), config), false); // 11:59 WIB
  assert.equal(challengeCycleKey(new Date('2026-11-02T04:59:00.000Z'), config), '2026-11-01');
  assert.equal(challengeCycleKey(new Date('2026-11-02T05:00:00.000Z'), config), '2026-11-02');
});

test('all-time leaderboard has the correct title and paginates ten rows', () => {
  const users = {};
  for (let i = 1; i <= 23; i++) users['u' + i] = { name: 'User ' + i, days: { '2026-11-04': 1 } };
  const embed = leaderboardEmbed({ users }, '2026-11-04', true, 2);
  assert.equal(embed.data.title, 'All-Time Server Lucy Leaderboard');
  assert.equal(embed.data.description.split('\n').length, 10);
  assert.ok(embed.data.footer.text.includes('Halaman 2/3'));
});

test('Lucy target leaderboard is separate and uses current challenge cycle progress', () => {
  const guild = { users: {
    a: { name: 'Alice', challengeDayKey: '2026-11-04', challengeCount: 12, days: {} },
    b: { name: 'Bob', challengeDayKey: '2026-11-03', challengeCount: 99, days: {} },
    c: { name: 'Cara', challengeDayKey: '2026-11-04', challengeCount: 7, days: {} }
  } };
  assert.deepEqual(targetRanking(guild, '2026-11-04').map(x => [x.name, x.count]), [['Alice', 12], ['Cara', 7]]);
  const embed = targetLeaderboardEmbed(guild, { targetStartTime: '12:00', targetStopTime: '10:00' }, 1, new Date('2026-11-04T06:00:00.000Z'));
  assert.equal(embed.data.title, 'Lucy Target Leaderboard');
});

test('server leaderboard aggregates Lucy totals by guild and paginates ten entries', () => {
  const all = {};
  for (let i = 1; i <= 12; i++) all['g' + i] = { users: { u: { days: { '2026-11-04': i } } } };
  const embed = serverLeaderboardEmbed(all, null, 1);
  assert.equal(embed.data.title, 'All-Time Lucy Server Leaderboard');
  assert.equal(embed.data.description.split('\n').length, 10);
  assert.ok(embed.data.footer.text.includes('Halaman 1/2'));
});

test('leaderboard page helper clamps page and keeps page size at ten', () => {
  const result = pageRows(Array.from({ length: 21 }, (_, i) => i), 2);
  assert.equal(result.rows.length, 10);
  assert.equal(result.page, 2);
  assert.equal(pageRows([1, 2], 9).page, 1);
});

test('navigation row always renders four enabled buttons', () => {
  const buttons = navRow('daily').components;
  assert.equal(buttons.length, 4);
  assert.deepEqual(buttons.map(b => b.data.label), ['⏮️', '◀️', '▶️', '⏭️']);
  assert.ok(buttons.every(b => !b.data.disabled), 'semua tombol harus aktif (tidak disabled)');
});

test('navigation custom ids carry type and action', () => {
  assert.ok(isLucyNav('lcnav:daily:next'));
  assert.ok(isLucyNav('lcnav:servers:last'));
  assert.equal(isLucyNav('boss_panel_refresh:123'), false);
  assert.equal(isLucyNav(undefined), false);
  const ids = navRow('alltime').components.map(b => b.data.custom_id);
  assert.deepEqual(ids, ['lcnav:alltime:first', 'lcnav:alltime:prev', 'lcnav:alltime:next', 'lcnav:alltime:last']);
});

test('navigation reloads live counts from SQLite on each interaction', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-tracker-nav-'));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.includes('lucyCounterStorage.js') || key.includes('lucyCounter.js')) delete require.cache[key];
    }
    const svc = require('../src/services/lucyCounter');
    const db = require('../src/utils/lucyCounterStorage');
    // 23 users => 3 pages of 10.
    for (let i = 1; i <= 23; i++) {
      db.recordLucy({ guildId: 'g1', userId: 'u' + i, name: 'User ' + i, day: svc.dayKey(), cycleKey: svc.dayKey(), targetActive: false, goal: 0 });
    }
    const updates = [];
    const makeInteraction = action => ({
      customId: 'lcnav:daily:' + action,
      guildId: 'g1',
      client: { guilds: { cache: new Map() } },
      message: { embeds: [{ footer: { text: 'Harian • Halaman 1/1 • 23 peserta' } }] },
      update: async payload => { updates.push(payload); }
    });

    await svc.handleNavigation(makeInteraction('next'));
    assert.match(updates[0].embeds[0].data.footer.text, /Halaman 2\/3/);
    assert.ok(updates[0].components[0].components.every(b => !b.data.disabled));

    await svc.handleNavigation(makeInteraction('last'));
    assert.match(updates[1].embeds[0].data.footer.text, /Halaman 3\/3/);

    // Data berubah setelah pesan tampil: jumlah di-refresh langsung dari SQLite.
    db.recordLucy({ guildId: 'g1', userId: 'u99', name: 'Late', day: svc.dayKey(), cycleKey: svc.dayKey(), targetActive: false, goal: 0 });
    await svc.handleNavigation(makeInteraction('first'));
    assert.match(updates[2].embeds[0].data.footer.text, /Halaman 1\/3/);
    assert.match(updates[2].embeds[0].data.footer.text, /24 peserta/);
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
