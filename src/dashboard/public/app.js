const $ = id => document.getElementById(id);
let guildId = null;
let latestLogId = 0;
let logRows = [];
let dashboardToken = sessionStorage.getItem('lucy-dashboard-token') || '';

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(dashboardToken ? { Authorization: 'Bearer ' + dashboardToken } : {}), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request gagal (' + response.status + ')');
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
  $('channel-id').value = settings.channelId || '';
  $('role-id').value = settings.roleId || '';
  $('prefix').value = settings.prefix || '!';
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
async function loadGuild(id) {
  guildId = id;
  setStatus('Memuat konfigurasi…');
  const data = await api('/api/settings?guildId=' + encodeURIComponent(id));
  selectOptions($('channel-id'), data.channels, 'Pilih channel teks', data.settings.channelId);
  selectOptions($('rep-channel-id'), data.channels, 'Pilih channel Auto Thread Rep', data.settings.autoThreadRep.channelId);
  selectOptions($('role-id'), data.roles, 'Pilih role', data.settings.roleId);
  renderSettings(data.settings);
  setStatus('Konfigurasi dimuat. Perubahan belum disimpan.');
}
function collectSettings() {
  return {
    enabled: $('boss-enabled').checked,
    channelId: $('channel-id').value,
    roleId: $('role-id').value,
    prefix: $('prefix').value,
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
async function boot() {
  try {
    if (!dashboardToken) {
      dashboardToken = window.prompt('Masukkan DASHBOARD_TOKEN dari environment Pterodactyl:') || '';
      if (!dashboardToken) throw new Error('Token dashboard wajib diisi.');
      sessionStorage.setItem('lucy-dashboard-token', dashboardToken);
    }
    const data = await api('/api/me');
    $('app-view').classList.remove('hidden');
    $('user-name').textContent = 'Developer lokal';
    if (!data.guilds.length) {
      setStatus('Bot belum tergabung di server mana pun.', true);
      return;
    }
    const select = $('guild-select');
    for (const guild of data.guilds) select.add(new Option(guild.name, guild.id));
    await loadGuild(select.value);
    select.addEventListener('change', () => loadGuild(select.value).catch(e => setStatus(e.message, true)));
    pollLogs(); setInterval(pollLogs, 2500);
  } catch (error) {
    setStatus(error.message, true);
  }
}
$('save').addEventListener('click', saveSettings);
$('clear-logs').addEventListener('click', () => { logRows = []; renderLogs(); });
boot();
