const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parsePrefixInput, parsePingInput, parseDexInput, ALIASES } = require('../src/commands/prefix');

describe('prefix aliases', () => {
  it('maps aliases to canonical subcommands', () => {
    assert.strictEqual(ALIASES.status.filter(a => a === 'status').length >= 1, true);
    assert.ok(ALIASES.notify.includes('notif'));
    assert.ok(ALIASES.status.includes('cek'));
    assert.ok(ALIASES.warn.includes('peringatan'));
    assert.ok(ALIASES['server-on'].includes('aktif'));
    assert.ok(ALIASES['server-off'].includes('server-matikan'));
    assert.ok(ALIASES['server-off'].includes('nonaktif'));
  });

  it('parses canonical help', () => {
    const out = parsePrefixInput('! help', '!');
    assert.strictEqual(out.sub, 'help');
  });

  it('parses Indonesian alias for help', () => {
    const out = parsePrefixInput('! bantuan', '!');
    assert.strictEqual(out.sub, 'help');
  });

  it('parses alias with remaining args', () => {
    const out = parsePrefixInput('!boss notif dm', '!');
    assert.strictEqual(out.sub, 'notify');
    assert.deepStrictEqual(out.args, ['dm']);
  });

  it('parses alias for warn', () => {
    const out = parsePrefixInput('!boss peringatan 300', '!');
    assert.strictEqual(out.sub, 'warn');
    assert.deepStrictEqual(out.args, ['300']);
  });

  it('parses setup alias', () => {
    const out = parsePrefixInput('!boss set #general @boss', '!');
    assert.strictEqual(out.sub, 'setup');
    assert.deepStrictEqual(out.args, ['#general', '@boss']);
  });

  it('parses server-on alias with action', () => {
    const out = parsePrefixInput('!boss server-nyalakan', '!');
    assert.strictEqual(out.sub, 'server-on');
  });

  it('ignores unknown subs instead of replying', () => {
    assert.strictEqual(parsePrefixInput('!boss somethingelse foo', '!'), null);
  });

  it('keeps the boss category prefix for boss features', () => {
    const out = parsePrefixInput('d boss status', 'd');
    assert.strictEqual(out.sub, 'status');
    assert.deepStrictEqual(out.args, []);
    assert.strictEqual(parsePrefixInput('d boss prefix dragneel', 'd').sub, 'prefix');
  });

  it('puts bot-level commands at the top level, without the boss category', () => {
    assert.strictEqual(parsePrefixInput('d prefix', 'd').sub, 'prefix');
    assert.deepStrictEqual(parsePrefixInput('d prefix dragneel', 'd').args, ['dragneel']);
    assert.strictEqual(parsePrefixInput('d help', 'd').sub, 'help');
    // `d status` bukan perintah bot-level: status ada di bawah kategori boss.
    assert.strictEqual(parsePrefixInput('d status', 'd'), null);
  });

  it('ignores ordinary chat that merely starts with the prefix', () => {
    for (const text of ['duh', 'dah', 'dulu aku pergi', 'dong', 'dadu']) {
      assert.strictEqual(parsePrefixInput(text, 'd'), null, text + ' harus diabaikan');
    }
  });

  it('treats a bare prefix as help', () => {
    assert.strictEqual(parsePrefixInput('d', 'd').sub, 'help');
  });

  it('returns null for messages without prefix or root', () => {
    assert.strictEqual(parsePrefixInput('hello boss', '!'), null);
    assert.strictEqual(parsePrefixInput('', '!'), null);
    assert.strictEqual(parsePrefixInput(null, '!'), null);
    assert.strictEqual(parsePrefixInput('!boss foo', '?'), null);
  });

  it('respects custom prefix', () => {
    const out = parsePrefixInput('? boss cek', '?');
    assert.strictEqual(out.sub, 'status');
  });
});

describe('case-insensitive input', () => {
  it('accepts uppercase prefix and subcommands', () => {
    assert.strictEqual(parsePrefixInput('D BOSS STATUS', 'd').sub, 'status');
    assert.strictEqual(parsePrefixInput('d BOSS status', 'd').sub, 'status');
    assert.strictEqual(parsePrefixInput('D Boss Menu', 'd').sub, 'menu');
    assert.deepStrictEqual(parsePrefixInput('D BOSS WARN 60', 'd').args, ['60']);
  });

  it('accepts uppercase bot-level commands', () => {
    assert.strictEqual(parsePrefixInput('D HELP', 'd').sub, 'help');
    assert.strictEqual(parsePrefixInput('D PREFIX', 'd').sub, 'prefix');
    assert.deepStrictEqual(parsePrefixInput('D PREFIX DRAGNEEL', 'd').args, ['DRAGNEEL']);
  });

  it('accepts uppercase prefix and ping/dex', () => {
    assert.deepStrictEqual(parsePingInput('D PING', 'd'), { args: [] });
    assert.deepStrictEqual(parseDexInput('D DEX lawliet', 'd'), { args: ['lawliet'] });
    assert.deepStrictEqual(parsePrefixInput('D BOsS cEk', 'd').args, []);
  });

  it('matches a prefix stored with different case', () => {
    assert.strictEqual(parsePrefixInput('d boss status', 'D').sub, 'status');
    assert.strictEqual(parsePrefixInput('DRAGNEEL BOSS STATUS', 'dragneel').sub, 'status');
  });

  it('still ignores ordinary chat regardless of case', () => {
    assert.strictEqual(parsePrefixInput('Duh', 'd'), null);
    assert.strictEqual(parsePrefixInput('DAH', 'd'), null);
    assert.strictEqual(parsePrefixInput('D', 'd').sub, 'help');
  });
});

describe('ping command parser', () => {
  it('parses ping and its short alias', () => {
    assert.deepStrictEqual(parsePingInput('!ping', '!'), { args: [] });
    assert.deepStrictEqual(parsePingInput('!p', '!'), { args: [] });
  });

  it('respects custom prefix', () => {
    assert.ok(parsePingInput('?ping', '?'));
    assert.strictEqual(parsePingInput('!ping', '?'), null);
  });

  it('ignores other commands and empty input', () => {
    assert.strictEqual(parsePingInput('!boss help', '!'), null);
    assert.strictEqual(parsePingInput('!pong', '!'), null);
    assert.strictEqual(parsePingInput('ping', '!'), null);
    assert.strictEqual(parsePingInput(null, '!'), null);
  });
});