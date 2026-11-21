const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
let dir;
let store;
let teamPanel;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-team-panel-'));
  process.chdir(dir);
  delete require.cache[require.resolve('../src/utils/battleTeamStorage')];
  delete require.cache[require.resolve('../src/ui/teamPanel')];
  store = require('../src/utils/battleTeamStorage');
  teamPanel = require('../src/ui/teamPanel');
});

afterEach(() => {
  process.chdir(ROOT);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ID tim 1-21', () => {
  it('memberi ID berikutnya yang bebas, bukan nomor urut naik terus', () => {
    const a = store.createTeam('u', 'Alpha').team;
    const b = store.createTeam('u', 'Beta').team;
    const c = store.createTeam('u', 'Gamma').team;
    assert.deepEqual([a.slotId, b.slotId, c.slotId], [1, 2, 3]);

    store.deleteTeam('u', '2');
    assert.equal(store.createTeam('u', 'Delta').team.slotId, 2, 'slot ID 2 dipakai ulang');
    assert.equal(store.createTeam('u', 'Epsilon').team.slotId, 4);
  });

  it('menolak tim ke-22 karena ID hanya 1-21', () => {
    for (let i = 1; i <= store.MAX_TEAM_ID; i++) {
      assert.ok(store.createTeam('u', `Tim ${i}`).team, `tim ke-${i}`);
    }
    const extra = store.createTeam('u', 'Kelebihan');
    assert.match(extra.error, /1-21/);
    assert.equal(store.listTeams('u').length, store.MAX_TEAM_ID);
  });

  it('mencari tim lewat ID maupun nama', () => {
    store.createTeam('u', 'Alpha');
    store.createTeam('u', 'Beta');
    assert.equal(store.findTeam('u', '2').name, 'Beta');
    assert.equal(store.findTeam('u', 'beta').name, 'Beta');
    assert.equal(store.findTeam('u', '9'), null);
    assert.equal(store.findTeam('u', ''), null);
  });

  it('ID milik user lain tidak saling bertabrakan', () => {
    const mine = store.createTeam('u1', 'Alpha').team;
    const other = store.createTeam('u2', 'Alpha').team;
    assert.equal(mine.slotId, 1);
    assert.equal(other.slotId, 1);
    assert.equal(store.findTeam('u2', '1').id, other.id);
  });

  it('memberi ID ke tim lama yang belum punya ID', () => {
    store.createTeam('u', 'Lama');
    // Simulasikan database versi sebelumnya: ID dikosongkan.
    store.getDb().prepare('UPDATE teams SET slot_id = NULL WHERE user_id = ?').run('u');
    const backfilled = store.nextFreeSlotId('u');
    assert.equal(backfilled, 1, 'ID lama diisi ulang saat dibuka');
  });
});

describe('panel tim', () => {
  it('menampilkan komposisi tim aktif, bukan daftar nama', () => {
    store.createTeam('u', 'Alpha');
    store.createTeam('u', 'Beta');
    store.setActiveTeam('u', 'Beta');
    const teams = store.listTeams('u');
    const active = store.getActiveTeam('u');
    const payload = teamPanel.panelPayload(teams, teamPanel.indexOfActive(teams, active), 'u', { active });
    const embed = payload.embeds[0].toJSON();
    assert.match(embed.title, /Beta/);
    assert.match(embed.title, /2/, 'ID tim ikut tampil di judul');
    assert.equal(payload.index, 1);
    assert.equal(payload.total, 2);
  });

  it('menyediakan tombol panah dan select menu, tanpa tombol per tim', () => {
    store.createTeam('u', 'Alpha');
    store.createTeam('u', 'Beta');
    const payload = teamPanel.panelPayload(store.listTeams('u'), 0, 'u', {});
    const rows = payload.components.map(row => row.toJSON());
    assert.equal(rows.length, 2, 'satu baris select + satu baris panah');
    assert.equal(rows[0].components[0].type, 3, 'select menu');
    assert.equal(rows[1].components.length, 3, '◀ label ▶');
    assert.deepEqual(rows[1].components.map(b => b.label), ['◀', 'Tim 1/2', '▶']);
  });

  it('panah membungkus daftar dan select menu memakai indeks', () => {
    store.createTeam('u', 'Alpha');
    store.createTeam('u', 'Beta');
    store.createTeam('u', 'Gamma');
    const payload = teamPanel.panelPayload(store.listTeams('u'), 0, 'u', {});
    const prev = payload.components[1].toJSON().components[0];
    const next = payload.components[1].toJSON().components[2];
    const parsedPrev = teamPanel.parsePanelNav(prev.custom_id);
    const parsedNext = teamPanel.parsePanelNav(next.custom_id);
    assert.equal(parsedPrev.index, 2, 'dari tim pertama, ◀ membungkus ke terakhir');
    assert.equal(parsedNext.index, 1);

    const pick = teamPanel.parsePanelNav(teamPanel.navId(teamPanel.NAV_PICK, 'u', 0));
    assert.equal(pick.kind, 'pick');
    // Select menu ada di dalam action row: components[0].components[0].
    const menu = payload.components[0].toJSON().components[0];
    // Select menu menaruh pilihan di `options`, bukan `components`.
    assert.deepEqual(menu.options.map(o => o.value), ['0', '1', '2']);
    assert.equal(menu.options[0].default, true, 'opsi aktif ditandai');
  });

  it('menolak customId yang bukan milik panel', () => {
    assert.equal(teamPanel.isTeamPanelNav('battle_tm_prev:u:0'), true);
    assert.equal(teamPanel.isTeamPanelNav('battle_team_pick:u:0'), false);
    assert.equal(teamPanel.parsePanelNav('battle_tm_prev').ok, false);
    assert.equal(teamPanel.parsePanelNav('battle_tm_next:u:abc').ok, false);
  });
});
