(function (root) {
  'use strict';
  const PALETTES = ['ocean', 'forest', 'violet', 'sand'];
  function apply(config = {}, document = root.document) {
    if (!document) return;
    const node = document.documentElement;
    node.dataset.palette = PALETTES.includes(config.palette) ? config.palette : 'ocean';
    node.dataset.theme = ['light', 'dark'].includes(config.colorScheme) ? config.colorScheme : 'system';
    node.dataset.readingFont = config.readingFont === 'serif' ? 'serif' : 'sans';
    const size = Number(config.readingSize);
    node.style.setProperty('--reading-size', (Number.isInteger(size) && size >= 13 && size <= 20 ? size : 15) + 'px');
  }
  root.PTAppearance = { apply, PALETTES };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PTAppearance;
})(typeof globalThis !== 'undefined' ? globalThis : this);
