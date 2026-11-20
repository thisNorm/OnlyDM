'use strict';

(() => {
  const appDefaults = Object.freeze({ chrome: '#EEF1F5', background: '#FFFFFF' });
  const chatDefaults = Object.freeze({ background: '#FFFFFF', incoming: '#F0F2F4', outgoing: '#4257C9' });
  function normalizeHex(value) {
    const input = typeof value === 'string' ? value.trim() : '';
    return /^#?[0-9a-f]{6}$/i.test(input) ? '#' + input.replace(/^#/, '').toUpperCase() : null;
  }
  function textOn(hex) {
    const channels = [1, 3, 5].map(start => {
      const value = parseInt(hex.slice(start, start + 2), 16) / 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    });
    const luminance = .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
    return (luminance + .05) / .05 >= 1.05 / (luminance + .05) ? '#000000' : '#FFFFFF';
  }
  function tint(background, amount) {
    const text = textOn(background);
    const mix = toward => '#' + [1, 3, 5].map(start => {
      const from = parseInt(background.slice(start, start + 2), 16);
      const to = parseInt(toward.slice(start, start + 2), 16);
      return Math.round(from + (to - from) * amount).toString(16).padStart(2, '0');
    }).join('').toUpperCase();
    const result = mix(text);
    return textOn(result) === text ? result : mix(text === '#FFFFFF' ? '#000000' : '#FFFFFF');
  }
  function appPalette(mode, colors, systemDark) {
    const dark = mode === 'dark' || (mode === 'system' && systemDark);
    const palette = dark ? {
      dark: true, surface: '#1F232B', surfaceAlt: '#2A303A', rail: '#15181D',
      text: '#F2F4F8', muted: '#AAB1BD', border: '#343B47',
    } : {
      dark: false, surface: '#FFFFFF', surfaceAlt: '#EEF1F5', rail: '#EEF1F5',
      text: '#171A21', muted: '#687080', border: '#DEE3EA',
    };
    Object.assign(palette, { accent: '#4257C9', accentText: '#FFFFFF',
      chrome: palette.surface, chromeText: palette.text, chromeMuted: palette.muted, chromeHover: palette.border });
    if (mode === 'custom') {
      const chrome = normalizeHex(colors?.chrome) || appDefaults.chrome;
      const surface = normalizeHex(colors?.background) || appDefaults.background;
      Object.assign(palette, { dark: textOn(surface) === '#FFFFFF', chrome, rail: chrome, surface,
        text: textOn(surface), muted: textOn(surface), chromeText: textOn(chrome), chromeMuted: textOn(chrome),
        surfaceAlt: tint(surface, .07), border: tint(surface, .18), chromeHover: tint(chrome, .12) });
    }
    return palette;
  }
  function chatPalette(mode, colors, systemDark) {
    const custom = mode === 'custom';
    const background = custom ? normalizeHex(colors?.background) || chatDefaults.background : null;
    const palette = appPalette(custom ? textOn(background) === '#FFFFFF' ? 'dark' : 'light' : mode, null, systemDark);
    const incoming = custom ? normalizeHex(colors?.incoming) || chatDefaults.incoming : palette.dark ? '#2A303A' : '#F0F2F4';
    const outgoing = custom ? normalizeHex(colors?.outgoing) || chatDefaults.outgoing : '#4257C9';
    return { ...palette, background: background || (palette.dark ? '#181C22' : '#FFFFFF'),
      incoming, incomingText: custom ? textOn(incoming) : palette.text, outgoing, outgoingText: textOn(outgoing),
      ...(custom ? { text: textOn(background), muted: textOn(background) } : {}) };
  }
  function hsvHex(hue, saturation, value) {
    const chroma = value * saturation;
    const sector = ((hue % 360) + 360) % 360 / 60;
    const second = chroma * (1 - Math.abs(sector % 2 - 1));
    const offset = value - chroma;
    const channels = sector < 1 ? [chroma, second, 0] : sector < 2 ? [second, chroma, 0]
      : sector < 3 ? [0, chroma, second] : sector < 4 ? [0, second, chroma]
      : sector < 5 ? [second, 0, chroma] : [chroma, 0, second];
    return '#' + channels.map(channel => Math.round((channel + offset) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  function hexHsv(hex, previousHue = 0) {
    const [red, green, blue] = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255);
    const max = Math.max(red, green, blue), delta = max - Math.min(red, green, blue);
    const sector = !delta ? null : max === red ? (green - blue) / delta : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
    return { hue: sector === null ? previousHue : (sector * 60 + 360) % 360, saturation: max ? delta / max : 0, value: max };
  }
  const api = Object.freeze({ appDefaults, chatDefaults, normalizeHex, textOn, tint, appPalette, chatPalette, hsvHex, hexHsv });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.onlydmColors = api;
})();
