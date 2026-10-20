import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { sanitizeGitError } from '../../services/gitErrorDetails';

it('preserves Git ref errors while removing URLs, auth fields and terminal controls', () => {
  const text = '\x1b[31mfatal: bad object refs/heads/topic\x1b[0m\r\n' +
    'https://user:password@example.com/repo?token=secret\n' +
    'proxy-authorization: Basic abc123\npassword="two words" token=abcdef\x00';
  assert.equal(sanitizeGitError(text), 'fatal: bad object refs/heads/topic\n' +
    '[redacted URL]\n[redacted authorization]\npassword=[redacted] token=[redacted]');
});

it('redacts before limiting output and retains final Git errors', () => {
  const text = 'start\n' + 'x'.repeat(8000) + '\nhttps://user:' + 'secret'.repeat(2000) +
    '@example.com/repo\nfatal: missing refs/heads/topic';
  const safe = sanitizeGitError(text);
  assert.ok(safe.length < 6100);
  assert.match(safe, /^start\n/);
  assert.match(safe, /\[…\]/);
  assert.match(safe, /\[redacted URL\]\nfatal: missing refs\/heads\/topic$/);
  assert.doesNotMatch(safe, /secret/);
});
