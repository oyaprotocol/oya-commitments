import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

// GHSA-gcqx-w48m-w2h4 has no patched deepmerge release. Keep it out
// of the dependency tree rather than accepting an audit exception.
test('frontend dependency tree excludes vulnerable deepmerge', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const copies = Object.keys(lock.packages).filter((path) => path.endsWith('/node_modules/deepmerge') || path === 'node_modules/deepmerge');
  assert.deepEqual(copies, []);
});

test('RainbowKit CSS dependency preserves nested style composition and fallback arrays', () => {
  const require = createRequire(import.meta.url);
  const rainbowRequire = createRequire(require.resolve('@rainbow-me/rainbowkit'));
  const cssRequire = createRequire(rainbowRequire.resolve('@vanilla-extract/css'));
  const { style } = rainbowRequire('@vanilla-extract/css');
  const { mockAdapter, setAdapter, removeAdapter } = cssRequire('@vanilla-extract/css/adapter');
  const { setFileScope, endFileScope } = cssRequire('@vanilla-extract/css/fileScope');
  const rules = [];
  setAdapter({ ...mockAdapter, appendCss: (css) => rules.push(css.rule) });
  setFileScope('test/compatibility.css.ts', 'oya-frontend');
  try {
    style([
      { color: 'red', fontFamily: ['Arial', 'sans-serif'], ':hover': { color: 'blue', padding: 4 } },
      { color: 'green', fontFamily: ['Georgia', 'serif'], ':hover': { color: 'purple' } },
    ]);
    assert.deepEqual(rules, [{
      color: 'green', fontFamily: ['Georgia', 'serif'], ':hover': { color: 'purple', padding: 4 },
    }]);
  } finally {
    endFileScope();
    removeAdapter();
  }
});
