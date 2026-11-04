const test = require('node:test');
const assert = require('node:assert/strict');
const { countLucy, dayKey, isTargetWindow, challengeCycleKey, leaderboardEmbed, targetLeaderboardEmbed, serverLeaderboardEmbed, targetRanking, pageRows } = require('../src/services/lucyCounter');

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
