'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { appPalette, chatPalette, hsvHex, hexHsv, textOn } = require('../src/colors.js');

test('app regions can be mixed or identical without affecting chat colors', () => {
  const chat = { background: '#123456', incoming: '#F0F2F4', outgoing: '#4257C9' };
  const before = chatPalette('custom', chat, false);
  for (const [chrome, background] of [['#121212', '#FAFAFA'], ['#FFFFFF', '#151515'], ['#202020', '#202020'], ['#747474', '#767676']]) {
    const palette = appPalette('custom', { chrome, background }, false);
    assert.equal(palette.chrome, chrome);
    assert.equal(palette.rail, chrome);
    assert.equal(palette.surface, background);
    assert.equal(palette.chromeText, textOn(chrome));
    assert.equal(palette.text, textOn(background));
    assert.equal(textOn(palette.chromeHover), palette.chromeText);
    assert.equal(textOn(palette.surfaceAlt), palette.text);
    assert.deepEqual(chatPalette('custom', chat, false), before);
  }
});
test('normal themes ignore custom colors and system theme follows the current OS', () => {
  const colors = { chrome: '#012345', background: '#ABCDEF' };
  for (const mode of ['light', 'dark']) assert.deepEqual(appPalette(mode, colors, false), appPalette(mode, null, false));
  assert.equal(appPalette('system', colors, true).dark, true);
  assert.equal(appPalette('system', colors, false).dark, false);
  assert.equal(appPalette('custom', { chrome: 'invalid', background: '#123456' }).chrome, '#EEF1F5');
});
test('spectrum conversion covers primaries, grayscale, midpoint and HEX round trips', () => {
  for (const [hue, hex] of [[0, '#FF0000'], [60, '#FFFF00'], [120, '#00FF00'], [180, '#00FFFF'], [240, '#0000FF'], [300, '#FF00FF'], [360, '#FF0000']])
    assert.equal(hsvHex(hue, 1, 1), hex);
  assert.equal(hsvHex(120, .5, .5), '#408040');
  assert.equal(hsvHex(240, 0, 0), '#000000');
  assert.equal(hsvHex(120, 0, 1), '#FFFFFF');
  assert.equal(hexHsv('#808080', 240).hue, 240);
  for (const hex of ['#182139', '#ABCDEF', '#FFFFFF', '#000000', '#FF0000', '#747474']) {
    const hsv = hexHsv(hex);
    assert.equal(hsvHex(hsv.hue, hsv.saturation, hsv.value), hex);
  }
});
