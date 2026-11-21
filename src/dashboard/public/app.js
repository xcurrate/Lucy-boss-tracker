const $ = id => document.getElementById(id);
let guildId = null;
let latestLogId = 0;
let logRows = [];
let dashboardToken = sessionStorage.getItem('lucy-dashboard-token') || '';

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(dashboardToken ? { Authorization: 'Bearer ' + dashboardToken } : {}), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || 'Request gagal (' + response.status + ')'); error.status = response.status; throw error; }
  return data;
}
function setStatus(message, bad = false) {
  $('save-status').textContent = message;
  $('save-status').style.color = bad ? '#ff7777' : '';
}
function selectOptions(select, rows, placeholder, selected) {
  select.replaceChildren(new Option(placeholder, ''));
  for (const row of rows) select.add(new Option(row.name, row.id));
  select.value = selected || '';
}
function renderSettings(settings) {
  $('boss-enabled').checked = settings.enabled;
  $('family100-enabled').checked = settings.family100?.enabled !== false;
  $('family100-channel').value = settings.family100?.channelId || '';
  $('family100-duration').value = Number(settings.family100?.durationSeconds || 0);
  $('lucy-counter-enabled').checked = Boolean(settings.lucyCounter?.enabled);
  $('lucy-target-enabled').checked = Boolean(settings.lucyCounter?.targetEnabled);
  $('lucy-target-goal').value = Number(settings.lucyCounter?.targetGoal || 0);
  $('lucy-target-channel').value = settings.lucyCounter?.targetChannelId || '';
  $('lucy-target-message').value = settings.lucyCounter?.targetMessage || '🎉 Target Lucy tercapai!';
  $('lucy-target-start').value = settings.lucyCounter?.targetStartTime || '12:00';
  $('lucy-target-stop').value = settings.lucyCounter?.targetStopTime || '10:00';
  const blacklistedChannels = new Set(settings.lucyCounter?.blacklistedChannelIds || []);
  for (const option of $('lucy-blacklisted-channels').options) option.selected = blacklistedChannels.has(option.value);
  const whitelistedChannels = new Set(settings.lucyCounter?.whitelistedChannelIds || []);
  for (const option of $('lucy-whitelisted-channels').options) option.selected = whitelistedChannels.has(option.value);
  $('channel-id').value = settings.channelId || '';
  $('role-id').value = settings.roleId || '';
  $('prefix').value = settings.prefix || 'd';
  $('next-boss').textContent = settings.lastBossTimestamp ? new Date(settings.lastBossTimestamp * 1000).toLocaleString('id-ID') : 'Belum terdeteksi';
  const rep = settings.autoThreadRep;
  $('rep-enabled').checked = rep.enabled;
  $('rep-channel-id').value = rep.channelId || '';
  $('rep-target').value = rep.targetUserId;
  $('rep-amount').value = rep.amount;
  $('thread-prefix').value = rep.threadNamePrefix;
  $('archive-duration').value = String(rep.autoArchiveDuration);
  $('boss-state').textContent = settings.enabled ? 'Aktif' : 'Nonaktif';
  $('boss-detail').textContent = settings.channelId ? 'Channel telah dipilih' : 'Channel belum dikonfigurasi';
  $('rep-state').textContent = rep.enabled ? 'Aktif' : 'Nonaktif';
  $('rep-detail').textContent = rep.channelId ? 'Channel: ' + ($('rep-channel-id').selectedOptions[0]?.textContent || rep.channelId) : 'Channel belum dipilih';
}
function renderBossRewards(settings) {
  $('reward-enabled').checked = Boolean(settings.enabled);
  $('reward-channel').value = settings.channelId || '';
  $('reward-role').value = settings.roleId || '';
  const targets = settings.targets || {};
  $('reward-ws').value = targets.weapon_shards?.target ?? '';
  $('reward-wc').value = targets.weapon_crate?.target ?? '';
  $('reward-flb').value = targets.fabled_lootbox?.target ?? '';
  $('reward-xp').value = targets.experience?.target ?? '';
}
function collectBossRewards() {
  return {
    enabled: $('reward-enabled').checked,
    channelId: $('reward-channel').value,
    roleId: $('reward-role').value,
    targets: {
      weapon_shards: $('reward-ws').value,
      weapon_crate: $('reward-wc').value,
      fabled_lootbox: $('reward-flb').value,
      experience: $('reward-xp').value
    }
  };
}
async function saveBossRewards() {
  if (!guildId) return;
  $('reward-save').disabled = true;
  try {
    const data = await api('/api/boss-rewards', { method: 'PUT', body: JSON.stringify({ guildId, settings: collectBossRewards() }) });
    renderBossRewards(data.settings);
    setStatus('Pengaturan Boss Reward Reminder tersimpan.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    $('reward-save').disabled = false;
  }
}
let noteRows = [];
let editingNoteId = null;

function setNoteStatus(message, bad = false) {
  const box = $('note-status');
  box.textContent = message || '';
  box.classList.toggle('bad', Boolean(bad));
}

function noteTime(value) {
  return new Date(value).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

function renderNotes() {
  const list = $('note-list');
  list.replaceChildren();
  $('note-count').textContent = String(noteRows.length);
  if (!noteRows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-log';
    empty.textContent = 'Belum ada note untuk server ini.';
    list.append(empty);
    return;
  }
  for (const note of noteRows) {
    const item = document.createElement('div');
    item.className = 'note-item' + (note.id === editingNoteId ? ' editing' : '');
    const head = document.createElement('div'); head.className = 'note-head';
    const title = document.createElement('div'); title.className = 'note-title';
    title.textContent = note.title || '(tanpa judul)';
    const actions = document.createElement('div'); actions.className = 'note-item-actions';
    const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Edit';
    edit.addEventListener('click', () => startEditNote(note.id));
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Hapus';
    remove.className = 'danger';
    remove.addEventListener('click', () => removeNote(note.id));
    actions.append(edit, remove);
    head.append(title, actions);
    item.append(head);
    if (note.body) {
      const body = document.createElement('div'); body.className = 'note-body'; body.textContent = note.body;
      item.append(body);
    }
    const meta = document.createElement('div'); meta.className = 'note-meta';
    meta.textContent = 'Dibuat ' + noteTime(note.createdAt) + ' • Diperbarui ' + noteTime(note.updatedAt);
    item.append(meta);
    list.append(item);
  }
}

function resetNoteForm() {
  editingNoteId = null;
  $('note-title').value = '';
  $('note-body').value = '';
  $('note-save').firstChild.textContent = 'Tambah note ';
  $('note-cancel').classList.add('hidden');
  renderNotes();
}

function startEditNote(id) {
  const note = noteRows.find(row => row.id === id);
  if (!note) return;
  editingNoteId = id;
  $('note-title').value = note.title || '';
  $('note-body').value = note.body || '';
  $('note-save').firstChild.textContent = 'Simpan perubahan ';
  $('note-cancel').classList.remove('hidden');
  setNoteStatus('Mengedit note. Perubahan belum disimpan.');
  renderNotes();
  $('note-title').focus();
}

async function saveNote() {
  if (!guildId) return;
  const title = $('note-title').value.trim();
  const body = $('note-body').value.trim();
  if (!title && !body) return setNoteStatus('Judul atau isi note wajib diisi.', true);
  $('note-save').disabled = true;
  try {
    const editing = editingNoteId;
    const payload = { guildId, id: editing, title, body };
    const data = await api('/api/notes', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    if (editing) noteRows = noteRows.map(row => (row.id === editing ? data.note : row));
    else noteRows = [data.note, ...noteRows];
    resetNoteForm();
    setNoteStatus(editing ? 'Note diperbarui.' : 'Note ditambahkan.');
  } catch (error) {
    setNoteStatus(error.message, true);
  } finally {
    $('note-save').disabled = false;
  }
}

async function removeNote(id) {
  if (!guildId) return;
  if (!window.confirm('Hapus note ini?')) return;
  try {
    await api('/api/notes', { method: 'DELETE', body: JSON.stringify({ guildId, id }) });
    noteRows = noteRows.filter(row => row.id !== id);
    if (editingNoteId === id) resetNoteForm();
    else renderNotes();
    setNoteStatus('Note dihapus.');
  } catch (error) {
    setNoteStatus(error.message, true);
  }
}

async function loadNotes() {
  setNoteStatus('Memuat note…');
  try {
    const data = await api('/api/notes?guildId=' + encodeURIComponent(guildId));
    noteRows = data.notes || [];
    resetNoteForm();
    setNoteStatus('');
  } catch (error) {
    noteRows = [];
    renderNotes();
    setNoteStatus(error.message, true);
  }
}

async function loadFamily100Board() {
  const body = $('family100-board').querySelector('tbody');
  if (!guildId) return;
  const scope = $('family100-scope').value;
  try {
    const data = await api('/api/family100/leaderboard?guildId=' + encodeURIComponent(guildId) + '&scope=' + scope);
    const rows = data.rows || [];
    body.replaceChildren();
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 3; td.className = 'muted'; td.textContent = 'Belum ada poin tercatat.';
      tr.appendChild(td); body.appendChild(tr);
      return;
    }
    rows.forEach((row, index) => {
      const tr = document.createElement('tr');
      const rank = document.createElement('td'); rank.textContent = String(index + 1);
      const name = document.createElement('td'); name.textContent = row.name || 'Pemain';
      const points = document.createElement('td'); points.textContent = Number(row.points || 0).toLocaleString('id-ID');
      tr.append(rank, name, points); body.appendChild(tr);
    });
  } catch (error) {
    body.replaceChildren();
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3; td.className = 'muted'; td.textContent = error.message;
    tr.appendChild(td); body.appendChild(tr);
  }
}

async function loadGuild(id) {
  guildId = id;
  setStatus('Memuat konfigurasi…');
  const data = await api('/api/settings?guildId=' + encodeURIComponent(id));
  selectOptions($('channel-id'), data.channels, 'Pilih channel teks', data.settings.channelId);
  selectOptions($('rep-channel-id'), data.channels, 'Pilih channel Auto Thread Rep', data.settings.autoThreadRep.channelId);
  selectOptions($('family100-channel'), data.channels, 'Semua channel (default)', data.settings.family100?.channelId);
  selectOptions($('lucy-target-channel'), data.channels, 'Pilih channel laporan target', data.settings.lucyCounter?.targetChannelId);
  selectOptions($('lucy-blacklisted-channels'), data.channels, 'Pilih channel untuk di-blacklist', '');
  selectOptions($('lucy-whitelisted-channels'), data.channels, 'Pilih channel untuk di-whitelist', '');
  selectOptions($('role-id'), data.roles, 'Pilih role', data.settings.roleId);
  selectOptions($('reward-channel'), data.channels, 'Pilih channel reward', data.bossRewards?.channelId);
  selectOptions($('reward-role'), data.roles, 'Pilih role reward', data.bossRewards?.roleId);
  renderSettings(data.settings);
  renderBossRewards(data.bossRewards || {});
  await loadNotes();
  await loadFamily100Board();
  setStatus('Konfigurasi dimuat. Perubahan belum disimpan.');
}
function collectSettings() {
  return {
    enabled: $('boss-enabled').checked,
    family100: {
      enabled: $('family100-enabled').checked,
      channelId: $('family100-channel').value,
      durationSeconds: Number($('family100-duration').value || 0)
    },
    lucyCounter: {
      enabled: $('lucy-counter-enabled').checked,
      targetEnabled: $('lucy-target-enabled').checked,
      targetGoal: Number($('lucy-target-goal').value || 0),
      targetMessage: $('lucy-target-message').value.trim(),
      targetChannelId: $('lucy-target-channel').value,
      targetStartTime: $('lucy-target-start').value,
      targetStopTime: $('lucy-target-stop').value,
      blacklistedChannelIds: [...$('lucy-blacklisted-channels').selectedOptions].map(option => option.value),
      whitelistedChannelIds: [...$('lucy-whitelisted-channels').selectedOptions].map(option => option.value)
    },
    channelId: $('channel-id').value,
    roleId: $('role-id').value,
    prefix: $('prefix').value.toLowerCase(),
    autoThreadRep: {
      enabled: $('rep-enabled').checked,
      channelId: $('rep-channel-id').value,
      targetUserId: $('rep-target').value.trim(),
      amount: $('rep-amount').value.trim(),
      threadNamePrefix: $('thread-prefix').value.trim(),
      autoArchiveDuration: Number($('archive-duration').value)
    }
  };
}
async function saveSettings() {
  if (!guildId) return;
  $('save').disabled = true;
  try {
    const data = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ guildId, settings: collectSettings() }) });
    renderSettings(data.settings);
    setStatus('Tersimpan ke server Discord.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    $('save').disabled = false;
  }
}
function renderLogs() {
  const box = $('log-box');
  box.replaceChildren();
  if (!logRows.length) {
    const empty = document.createElement('div'); empty.className = 'empty-log'; empty.textContent = 'Belum ada log runtime.'; box.append(empty);
  } else {
    for (const entry of logRows.slice(-250)) {
      const row = document.createElement('div'); row.className = 'log-row';
      const time = document.createElement('span'); time.className = 'log-time'; time.textContent = new Date(entry.time).toLocaleTimeString('id-ID');
      const level = document.createElement('span'); level.className = 'log-level ' + entry.level; level.textContent = entry.level;
      const message = document.createElement('span'); message.className = 'log-message'; message.textContent = entry.message;
      row.append(time, level, message); box.append(row);
    }
    box.scrollTop = box.scrollHeight;
  }
  $('log-count').textContent = logRows.length + ' entries';
}
async function pollLogs() {
  try {
    const data = await api('/api/logs?after=' + latestLogId);
    if (data.logs.length) {
      logRows.push(...data.logs); logRows = logRows.slice(-250);
      latestLogId = data.latestId; renderLogs();
    }
  } catch {}
}
async function openDashboard(token) {
  const submit = $('token-submit');
  const errorBox = $('login-error');
  submit.disabled = true;
  errorBox.textContent = 'Memverifikasi token…';
  dashboardToken = token.trim();
  try {
    const data = await api('/api/me');
    sessionStorage.setItem('lucy-dashboard-token', dashboardToken);
    $('token-view').classList.add('hidden');
    $('app-view').classList.remove('hidden');
    $('user-name').textContent = 'Developer';
    if (!data.guilds.length) {
      setStatus('Bot belum tergabung di server mana pun.', true);
      return;
    }
    const select = $('guild-select');
    select.replaceChildren();
    for (const guild of data.guilds) select.add(new Option(guild.name, guild.id));
    await loadGuild(select.value);
    select.addEventListener('change', () => loadGuild(select.value).catch(e => setStatus(e.message, true)));
    pollLogs(); setInterval(pollLogs, 2500);
  } catch (error) {
    dashboardToken = '';
    sessionStorage.removeItem('lucy-dashboard-token');
    errorBox.textContent = error.status === 401
      ? 'Token tidak cocok. Periksa kembali DASHBOARD_TOKEN di Pterodactyl, lalu coba lagi.'
      : error.message;
    $('dashboard-token').focus();
  } finally {
    submit.disabled = false;
  }
}
$('token-form').addEventListener('submit', event => {
  event.preventDefault();
  const value = $('dashboard-token').value;
  if (!value.trim()) {
    $('login-error').textContent = 'Token wajib diisi.';
    return;
  }
  openDashboard(value);
});
async function boot() {
  if (dashboardToken) {
    $('dashboard-token').value = dashboardToken;
    await openDashboard(dashboardToken);
  }
}
$('save').addEventListener('click', saveSettings);
$('reward-save').addEventListener('click', saveBossRewards);
$('note-save').addEventListener('click', saveNote);
$('note-cancel').addEventListener('click', () => { resetNoteForm(); setNoteStatus(''); });
$('clear-logs').addEventListener('click', () => { logRows = []; renderLogs(); });
$('family100-scope').addEventListener('change', () => loadFamily100Board());
boot();
