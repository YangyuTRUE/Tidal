/* MinerU reading-order blocks -> immutable Markdown offsets -> PDF positions. */
(function (root) {
  'use strict';
  const AUXILIARY = new Set(['header', 'footer', 'page_number', 'aside_text', 'page_footnote']);

  function normalized(text, offsets = false) {
    let value = ''; const map = [];
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    for (const match of String(text || '').matchAll(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|&(?:#x[\da-f]+|#\d+|\w+);|[\s\S]/gi)) {
      let part = match[0];
      if (part.startsWith('<')) continue;
      if (part.startsWith('&') && part.endsWith(';')) {
        const key = part.slice(1, -1);
        if (key[0] === '#') {
          const number = key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
          part = number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
        } else part = entities[key.toLowerCase()] ?? key;
      }
      for (const c of part.normalize('NFKC').toLowerCase()) {
        if (!/[\p{L}\p{N}]/u.test(c)) continue;
        value += c;
        if (offsets) for (let i = 0; i < c.length; i++) map.push(match.index);
      }
    }
    return { value, map };
  }
  function validBox(box) {
    return Array.isArray(box) && box.length === 4 && box.every(Number.isFinite)
      && box[0] >= 0 && box[1] >= 0 && box[2] <= 1 && box[3] <= 1 && box[2] > box[0] && box[3] > box[1];
  }
  function layoutText(block) {
    return (block.lines || []).flatMap(line => line.spans || []).map(span => span.content || '').join(' ')
      || (block.blocks || []).map(layoutText).join(' ');
  }
  function blocksFromLayout(layout) {
    return (layout?.pdf_info || []).flatMap(page => {
      const [w, h] = page.page_size || [];
      if (!(w > 0 && h > 0)) return [];
      return (page.para_blocks || []).map(block => ({ type: block.type, text: layoutText(block), page_idx: page.page_idx,
        bbox: block.bbox?.map((v, i) => v / (i % 2 ? h : w) * 1000) }));
    });
  }
  function build(markdown, contentList, layout) {
    const source = normalized(markdown, true);
    const entries = Array.isArray(contentList) ? contentList : blocksFromLayout(layout);
    const blocks = []; let cursor = 0, eligible = 0;
    for (const entry of entries.slice(0, 20000)) {
      if (!entry || AUXILIARY.has(entry.type)) continue;
      const box = Array.isArray(entry.bbox) ? entry.bbox.map(v => v / 1000) : null;
      if (!Number.isInteger(entry.page_idx) || entry.page_idx < 0 || !validBox(box)) continue;
      const image = ['image', 'chart'].includes(entry.type) && typeof entry.img_path === 'string' ? entry.img_path : '';
      const raw = entry.text || entry.table_body || entry.code_body || (entry.list_items || []).join(' ') || image;
      const key = normalized(raw).value;
      if (!key) continue;
      eligible++;
      let from = source.value.indexOf(key, cursor);
      // Short labels must be unique, and are never matched backwards or by fuzzy score.
      if (from < 0 || (key.length < 8 && source.value.indexOf(key, from + 1) >= 0)) continue;
      const start = source.map[from], end = source.map[from + key.length - 1] + 1;
      blocks.push({ id: `p${entry.page_idx}-b${blocks.length}`, pageIndex: entry.page_idx, bbox: box,
        start, end, type: entry.type || 'text' });
      cursor = from + key.length;
    }
    return { schema: 1, blocks, eligible, matched: blocks.length, sourceLength: markdown.length };
  }
  function bindChunks(markdown, chunks, map) {
    if (!map || chunks.map(c => c.source).join('') !== markdown) return;
    let start = 0;
    for (const chunk of chunks) {
      const end = start + chunk.source.length;
      chunk.locations = map.blocks.filter(block => block.end > start && block.start < end);
      start = end;
    }
  }
  function fromCache(markdown, map) {
    if (!map || map.schema !== 1 || map.sourceLength !== markdown.length || !Array.isArray(map.blocks)
      || map.blocks.length > 20000 || !map.blocks.every(block => block && typeof block.id === 'string'
        && Number.isInteger(block.pageIndex) && block.pageIndex >= 0 && validBox(block.bbox)
        && Number.isInteger(block.start) && Number.isInteger(block.end)
        && block.start >= 0 && block.end > block.start && block.end <= markdown.length
        && typeof block.type === 'string') || new Set(map.blocks.map(block => block.id)).size !== map.blocks.length) {
      throw new Error('段落定位缓存无效。');
    }
    return { schema: 1, sourceLength: markdown.length, matched: map.blocks.length, eligible: map.eligible,
      blocks: map.blocks.map(({ id, pageIndex, bbox, start, end, type }) => ({ id, pageIndex, bbox, start, end, type })) };
  }
  function hitTest(map, pageIndex, x, y) {
    return map?.blocks.filter(block => block.pageIndex === pageIndex
      && x >= block.bbox[0] && x <= block.bbox[2] && y >= block.bbox[1] && y <= block.bbox[3])
      .sort((a, b) => (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) - (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]))[0] || null;
  }
  function chunkForBlock(chunks, id) {
    return chunks.findIndex(chunk => chunk.locations?.some(block => block.id === id));
  }
  // Use the intrinsic page viewport. PDF.js handles CropBox, intrinsic
  // rotation and PDF's bottom-left origin; never assume a page height.
  function pdfPosition(block, viewport) {
    if (!validBox(block.bbox)) throw new Error('段落坐标无效。');
    if (!(Number.isFinite(viewport.width) && viewport.width > 0 && Number.isFinite(viewport.height) && viewport.height > 0)) {
      throw new Error('PDF 页面的坐标信息尚未加载。');
    }
    const [x0, y0, x1, y1] = block.bbox;
    const a = viewport.convertToPdfPoint(x0 * viewport.width, y0 * viewport.height);
    const b = viewport.convertToPdfPoint(x1 * viewport.width, y1 * viewport.height);
    if (![...a, ...b].every(Number.isFinite)) throw new Error('PDF 页面坐标转换失败。');
    return { pageIndex: block.pageIndex, rects: [[Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]] };
  }
  root.PTAnchors = { normalized, build, fromCache, bindChunks, hitTest, chunkForBlock, pdfPosition, validBox };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PTAnchors;
})(typeof globalThis !== 'undefined' ? globalThis : this);
