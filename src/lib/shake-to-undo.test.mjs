import assert from 'node:assert/strict';
import { test } from 'node:test';

function useDevice({ userAgent, platform = '', maxTouchPoints = 0 }) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent, platform, maxTouchPoints },
    configurable: true,
  });
}

// Each test gets its own copy of the module, so typing in one doesn't leak into another.
let copy = 0;
const load = () => import(`./shake-to-undo.js?copy=${copy++}`);

const iPhone =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';

test('reloads on an iPhone once an address was typed', async () => {
  useDevice({ userAgent: iPhone });
  const { noteAddressTyped, shouldReloadToForgetTyping } = await load();
  assert.equal(shouldReloadToForgetTyping(), false);
  noteAddressTyped();
  assert.equal(shouldReloadToForgetTyping(), true);
});

test('reloads on an iPad that reports itself as a Mac', async () => {
  useDevice({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    platform: 'MacIntel',
    maxTouchPoints: 5,
  });
  const { noteAddressTyped, shouldReloadToForgetTyping } = await load();
  noteAddressTyped();
  assert.equal(shouldReloadToForgetTyping(), true);
});

test('never reloads off iOS', async () => {
  useDevice({ userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)' });
  const { noteAddressTyped, shouldReloadToForgetTyping } = await load();
  noteAddressTyped();
  assert.equal(shouldReloadToForgetTyping(), false);
});
