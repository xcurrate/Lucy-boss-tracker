const MAX = 300;
const entries = [];
let sequence = 0;
let installed = false;

function stringify(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}
function install() {
  if (installed) return;
  installed = true;
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      const message = args.map(stringify).join(' ');
      entries.push({ id: ++sequence, time: new Date().toISOString(), level, message: message.slice(0, 2000) });
      if (entries.length > MAX) entries.splice(0, entries.length - MAX);
      original(...args);
    };
  }
}
function read(after = 0) {
  return entries.filter(entry => entry.id > after).slice(-MAX);
}
function latestId() { return sequence; }
module.exports = { install, read, latestId };
