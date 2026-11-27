import assert from 'node:assert/strict';
import test from 'node:test';

import { claimLink, createLinkClickTracker, openableLink, openInNewTab, resetOpenedLinksForTests } from './openLink';

test('only http and https links open', () => {
  assert.equal(openableLink('https://github.com/a/b/issues/10'), 'https://github.com/a/b/issues/10');
  assert.equal(openableLink('http://127.0.0.1:3001/'), 'http://127.0.0.1:3001/');
  assert.equal(openableLink('javascript:alert(1)'), null);
  assert.equal(openableLink('file:///etc/passwd'), null);
  assert.equal(openableLink('not a url'), null);
  assert.equal(openableLink(42), null);
});

test('a link clicked once opens once, even when both handlers see the click', () => {
  resetOpenedLinksForTests();
  const url = 'https://example.com/x';
  assert.equal(claimLink(url, 1000), true);
  assert.equal(claimLink(url, 1500), false);
  assert.equal(claimLink('https://example.com/other', 1500), true);
  // A later click on the same link opens it again.
  assert.equal(claimLink(url, 6000), true);
});

test('a blocked new tab is reported, an opened one gets the address and no opener', () => {
  assert.equal(openInNewTab('https://example.com/', () => null), false);
  const tab = { opener: {} as unknown, location: { href: '' } };
  assert.equal(openInNewTab('https://example.com/', () => tab as unknown as Window), true);
  assert.equal(tab.opener, null);
  assert.equal(tab.location.href, 'https://example.com/');
});

test('a click opens the link pressed on, even if the terminal forgot it before the release', () => {
  const opened: Array<[string, boolean]> = [];
  const tracker = createLinkClickTracker((url, askFirst) => opened.push([url, askFirst]));
  const at = (clientX: number, clientY: number, button = 0) => ({ button, clientX, clientY });

  tracker.hover('https://example.com/a', true);
  tracker.down(at(10, 10));
  // The CLI redraws on the press; xterm.js drops the link.
  tracker.leave('https://example.com/a');
  tracker.up(at(11, 10));
  assert.deepEqual(opened, [['https://example.com/a', true]]);

  // A drag selects text; it opens nothing.
  tracker.hover('https://example.com/a', true);
  tracker.down(at(10, 10));
  tracker.up(at(60, 10));
  // No link under the pointer, or another button: nothing.
  tracker.leave('https://example.com/a');
  tracker.down(at(10, 10));
  tracker.up(at(10, 10));
  tracker.hover('https://example.com/b', false);
  tracker.down(at(10, 10, 2));
  tracker.up(at(10, 10, 2));
  assert.equal(opened.length, 1);

  tracker.down(at(5, 5));
  tracker.up(at(5, 5));
  assert.deepEqual(opened[1], ['https://example.com/b', false]);
});
