const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parsePrefixInput, ALIASES } = require('../src/commands/prefix');

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
    const out = parsePrefixInput('!boss help', '!');
    assert.strictEqual(out.sub, 'help');
  });

  it('parses Indonesian alias for help', () => {
    const out = parsePrefixInput('!boss bantuan', '!');
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

  it('parses unknown sub as raw', () => {
    const out = parsePrefixInput('!boss somethingelse foo', '!');
    assert.strictEqual(out.sub, 'somethingelse');
  });

  it('returns null for messages without prefix or root', () => {
    assert.strictEqual(parsePrefixInput('hello boss', '!'), null);
    assert.strictEqual(parsePrefixInput('', '!'), null);
    assert.strictEqual(parsePrefixInput(null, '!'), null);
    assert.strictEqual(parsePrefixInput('!boss foo', '?'), null);
  });

  it('respects custom prefix', () => {
    const out = parsePrefixInput('?boss cek', '?');
    assert.strictEqual(out.sub, 'status');
  });
});