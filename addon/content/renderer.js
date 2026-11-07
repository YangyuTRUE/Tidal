/* Tidal: safe Markdown rendering shared by the reader and exports. */
(function (global) {
  "use strict";

  const XHTML = "http://www.w3.org/1999/xhtml";
  const RASTER_DATA = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/i;
  const SAFE_TAGS = [
    "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "div", "span", "a",
    "strong", "b", "em", "i", "del", "s", "u", "sup", "sub", "blockquote", "pre",
    "code", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "th", "td",
    "img", "caption", "dl", "dt", "dd", "kbd", "samp"
  ];
  const SAFE_ATTRIBUTES = [
    "href", "src", "alt", "title", "colspan", "rowspan", "scope", "align", "start", "reversed"
  ];
  const LANGUAGES = { "zh-CN": "简体中文", en: "English", ja: "日本語" };

  function element(tag, doc = global.document) {
    return doc.createElementNS(XHTML, tag);
  }

  function asText(value) {
    return typeof value === "string" ? value : value == null ? "" : String(value);
  }

  function checkLibraries() {
    if (!global.marked || !global.DOMPurify || !global.DOMPurify.sanitize) {
      throw new Error("本地 Markdown 渲染组件未加载，请重新安装插件。");
    }
  }

  function safeLink(value) {
    const candidate = asText(value).trim();
    if (!candidate || /[\u0000-\u001f\u007f]/.test(candidate)) return "";
    try {
      const url = new URL(candidate);
      return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  function normalizedImagePath(value) {
    let path = asText(value).trim();
    try { path = decodeURIComponent(path); } catch (_) { return ""; }
    path = path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
    if (!path || path.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(path)
      || path.split("/").includes("..") || /[\u0000-\u001f\u007f]/.test(path)) return "";
    return path;
  }

  function imageURL(value, images = {}) {
    const src = asText(value).trim();
    if (RASTER_DATA.test(src)) return src;
    // A relative ../ path is safe only when the host already resolved that exact
    // archive alias to verified bytes. No path is ever opened by this renderer.
    let known = src;
    try { known = decodeURIComponent(src).replace(/\\/g, "/"); } catch (_) { return ""; }
    if (known && !known.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(known)
      && !/[\u0000-\u001f\u007f]/.test(known) && Object.prototype.hasOwnProperty.call(images, known)
      && RASTER_DATA.test(images[known])) return images[known];
    const path = normalizedImagePath(src);
    if (!path) return "";
    if (Object.prototype.hasOwnProperty.call(images, path) && RASTER_DATA.test(images[path])) {
      return images[path];
    }
    // A containing directory in the ZIP is allowed; ambiguous basenames are not.
    const matches = Object.entries(images).filter(([name, data]) => {
      const normalized = normalizedImagePath(name);
      return normalized && normalized.endsWith("/" + path) && RASTER_DATA.test(data);
    });
    return matches.length === 1 ? matches[0][1] : "";
  }

  function escapedAt(text, index) {
    let count = 0;
    for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) count++;
    return count % 2 === 1;
  }

  function findDelimiter(text, delimiter, start, singleLine) {
    let pos = start;
    while ((pos = text.indexOf(delimiter, pos)) !== -1) {
      if (singleLine && text.slice(start, pos).includes("\n")) return -1;
      if (!escapedAt(text, pos)) return pos;
      pos += delimiter.length;
    }
    return -1;
  }

  function codeSpanEnd(text, index) {
    if (index === 0 || text[index - 1] === "\n") {
      const fence = text.slice(index).match(/^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/);
      if (fence) {
        const close = new RegExp("^ {0,3}" + fence[1][0] + "{" + fence[1].length + ",}[ \\t]*(?:\\n|$)", "gm");
        close.lastIndex = index + fence[0].length;
        const match = close.exec(text);
        return match ? match.index + match[0].length : text.length;
      }
    }
    if (text[index] === "`" && !escapedAt(text, index)) {
      const run = text.slice(index).match(/^`+/)[0];
      let end = text.indexOf(run, index + run.length);
      while (end !== -1 && (text[end - 1] === "`" || text[end + run.length] === "`")) {
        end = text.indexOf(run, end + run.length);
      }
      if (end !== -1) return end + run.length;
    }
    return index;
  }

  // Keep TeX out of the Markdown parser while leaving code fences/spans literal.
  function protectMath(markdown) {
    const text = asText(markdown).replace(/\r\n?/g, "\n");
    let prefix = "PTMATHPLACEHOLDER";
    while (text.includes(prefix)) prefix += "X";
    const formulas = [];
    let output = "";
    let i = 0;
    while (i < text.length) {
      const codeEnd = codeSpanEnd(text, i);
      if (codeEnd > i) {
        output += text.slice(i, codeEnd);
        i = codeEnd;
        continue;
      }
      let open = "", close = "", display = false;
      if (!escapedAt(text, i)) {
        if (text.startsWith("$$", i)) { open = close = "$$"; display = true; }
        else if (text.startsWith("\\[", i)) { open = "\\["; close = "\\]"; display = true; }
        else if (text.startsWith("\\(", i)) { open = "\\("; close = "\\)"; }
        else if (text[i] === "$" && !/[\s$]/.test(text[i + 1] || " ")) { open = close = "$"; }
      }
      if (open) {
        const end = findDelimiter(text, close, i + open.length, open === "$");
        const tex = end < 0 ? "" : text.slice(i + open.length, end);
        const goodEnd = open !== "$" || (tex.trim() === tex && !/[\d$]/.test(text[end + 1] || ""));
        if (end !== -1 && tex.trim() && goodEnd) {
          const raw = text.slice(i, end + close.length);
          output += prefix + formulas.length + "END";
          formulas.push({ raw, tex, display });
          i = end + close.length;
          continue;
        }
      }
      output += text[i++];
    }
    return { markdown: output, formulas, prefix };
  }

  function sanitizeHTML(html, images = {}) {
    // Resolve resources while the sanitizer still owns its inert document.
    // Returning a DOM fragment with a remote src can start an image request even
    // when a caller subsequently appends it to a detached element and removes it.
    const guardImage = (node, attribute) => {
      if (node.localName === "img" && attribute.attrName === "src") {
        const safe = imageURL(attribute.attrValue, images);
        if (safe) attribute.attrValue = safe;
        else attribute.keepAttr = false;
      }
    };
    global.DOMPurify.addHook("uponSanitizeAttribute", guardImage);
    try {
      return global.DOMPurify.sanitize(html, {
        ALLOWED_TAGS: SAFE_TAGS,
        ALLOWED_ATTR: SAFE_ATTRIBUTES,
        ALLOW_DATA_ATTR: false,
        ALLOW_ARIA_ATTR: false,
        ALLOW_UNKNOWN_PROTOCOLS: false,
        FORBID_TAGS: ["script", "style", "svg", "math", "iframe", "object", "embed", "form", "base", "meta", "link"],
        FORBID_ATTR: ["style", "srcset", "ping", "download", "id", "name"],
        RETURN_DOM_FRAGMENT: true
      });
    } finally { global.DOMPurify.removeHook("uponSanitizeAttribute"); }
  }

  function renderFragment(markdown, images, options = {}) {
    checkLibraries();
    const protectedText = protectMath(markdown);
    const parsed = global.marked.parse(protectedText.markdown, { gfm: true, breaks: false, async: false });
    const fragment = sanitizeHTML(parsed, images || {});
    const wrapper = element("div");
    wrapper.className = "pt-md";
    wrapper.appendChild(fragment);

    // Rewrite/remove every resource before the fragment is attached to the window.
    for (const img of wrapper.querySelectorAll("img")) {
      const safe = imageURL(img.getAttribute("src"), images || {});
      if (safe) {
        img.setAttribute("src", safe);
        img.setAttribute("loading", "lazy");
      } else {
        const fallback = element("span");
        fallback.className = "pt-missing-image";
        fallback.textContent = "〔图片不可用" + (img.getAttribute("alt") ? "：" + img.getAttribute("alt") : "") + "〕";
        img.replaceWith(fallback);
      }
    }
    for (const link of wrapper.querySelectorAll("a")) {
      const href = safeLink(link.getAttribute("href"));
      if (href) {
        link.setAttribute("href", href);
        link.setAttribute("rel", "noopener noreferrer");
        link.setAttribute("target", "_blank");
      } else link.removeAttribute("href");
    }

    const walker = global.document.createTreeWalker(wrapper, 4 /* SHOW_TEXT */);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const expression = new RegExp(protectedText.prefix + "(\\d+)END", "g");
    for (const node of nodes) {
      if (!node.nodeValue.includes(protectedText.prefix)) continue;
      const replacement = global.document.createDocumentFragment();
      let previous = 0, match;
      expression.lastIndex = 0;
      while ((match = expression.exec(node.nodeValue))) {
        replacement.appendChild(global.document.createTextNode(node.nodeValue.slice(previous, match.index)));
        const formula = protectedText.formulas[Number(match[1])];
        if (!formula) {
          replacement.appendChild(global.document.createTextNode(match[0]));
        } else if (options.math === "source" || node.parentElement.closest("pre, code") || !global.katex) {
          replacement.appendChild(global.document.createTextNode(formula.raw));
        } else {
          const span = element("span");
          span.className = "pt-formula" + (formula.display ? " pt-formula-display" : "");
          span.setAttribute("title", "LaTeX: " + formula.tex);
          try {
            global.katex.render(formula.tex, span, {
              displayMode: formula.display,
              throwOnError: false,
              trust: false,
              strict: "ignore",
              maxExpand: 1000,
              maxSize: 20,
              output: options.math === "mathml" ? "mathml" : "htmlAndMathml"
            });
          } catch (_) { span.textContent = formula.raw; }
          replacement.appendChild(span);
        }
        previous = match.index + match[0].length;
      }
      replacement.appendChild(global.document.createTextNode(node.nodeValue.slice(previous)));
      node.replaceWith(replacement);
    }
    return wrapper;
  }

  function render(container, markdown, images) {
    const fragment = renderFragment(markdown, images);
    container.replaceChildren(...Array.from(fragment.childNodes));
    container.classList.add("pt-md");
  }

  function completeChunks(job) {
    if (!job || job.status !== "complete") throw new Error("任务全部完成后才可导出；请先重试未完成段落。");
    if (!Array.isArray(job.chunks) || !job.chunks.length) throw new Error("没有可导出的翻译内容。");
    return job.chunks.map((chunk) => {
      if (chunk.skipTranslation || chunk.status === "skipped") return { ...chunk, result: asText(chunk.source) };
      if (chunk.status !== "done" || typeof chunk.translated !== "string" || (!chunk.translated.trim() && asText(chunk.source).trim())) {
        throw new Error("存在未完成的翻译段落，暂时不能导出。");
      }
      return { ...chunk, result: chunk.translated };
    });
  }

  function markdownCodeRanges(markdown, tokens) {
    const ranges = [];
    const containsCode = token => token.type === 'code'
      || (token.tokens || token.items || []).some(containsCode);
    // Marked removes quote/list prefixes from the nested `text`. Map its lines
    // back to their raw positions so nested code can be shielded verbatim while
    // normal images in the same list or quotation are still embedded.
    function containerMap(raw, text) {
      const segments = [];
      let rawPosition = 0, textPosition = 0;
      for (const line of text.split('\n')) {
        const newline = raw.indexOf('\n', rawPosition);
        const end = newline < 0 ? raw.length : newline;
        const offset = raw.slice(rawPosition, end).lastIndexOf(line);
        if (offset < 0) return null;
        if (line.length) segments.push({ start: textPosition, end: textPosition + line.length, raw: rawPosition + offset });
        textPosition += line.length;
        if (textPosition < text.length) {
          if (newline < 0) return null;
          segments.push({ start: textPosition, end: textPosition + 1, raw: newline });
          textPosition++;
        }
        rawPosition = end + 1;
      }
      return index => {
        let low = 0, high = segments.length - 1;
        while (low <= high) {
          const mid = (low + high) >> 1, segment = segments[mid];
          if (index < segment.start) high = mid - 1;
          else if (index >= segment.end) low = mid + 1;
          else return segment.raw + index - segment.start;
        }
        return -1;
      };
    }
    function visit(list, source, position) {
      let cursor = 0;
      for (const token of list) {
        if (typeof token.raw !== 'string' || !token.raw) continue;
        const start = source.indexOf(token.raw, cursor);
        if (start < 0) continue;
        cursor = start + token.raw.length;
        const tokenPosition = index => position(start + index);
        const protect = () => ranges.push({ start: tokenPosition(0), end: tokenPosition(token.raw.length - 1) + 1 });
        if (token.type === 'code') protect();
        else if (token.type === 'list') visit(token.items, token.raw, tokenPosition);
        else if (['blockquote', 'list_item'].includes(token.type) && containsCode(token)) {
          const mapping = containerMap(token.raw, token.text);
          if (mapping) visit(token.tokens, token.text, index => tokenPosition(mapping(index)));
          // If a parser transformation cannot be mapped, preserve the container
          // rather than changing text that may be a literal code example.
          else protect();
        }
      }
    }
    visit(tokens, markdown, index => index);
    return ranges.sort((a, b) => a.start - b.start);
  }

  function replaceMarkdownImages(markdown, images) {
    // Marked normalizes line endings before tokenization. Keep the source used
    // for offset mapping in the same form, including Windows-origin Markdown.
    markdown = asText(markdown).replace(/\r\n?/g, "\n");
    // Use the same pinned Markdown parser as the reader. A URL may contain
    // balanced/escaped parentheses, a title, or a reference definition; a
    // regular expression ending at the first ')' truncates valid image paths.
    const lexer = new global.marked.Lexer({ gfm: true, breaks: false });
    const tokens = lexer.lex(markdown);
    const codeRanges = markdownCodeRanges(markdown, tokens);
    let prefix = "PTCODEPLACEHOLDER";
    while (markdown.includes(prefix)) prefix += "X";
    const code = [];
    let shielded = "", i = 0, codeIndex = 0;
    while (i < markdown.length) {
      while (codeIndex < codeRanges.length && codeRanges[codeIndex].end <= i) codeIndex++;
      const block = codeRanges[codeIndex];
      const end = block?.start === i ? block.end : codeSpanEnd(markdown, i);
      if (end > i) {
        shielded += prefix + code.length + "END";
        code.push(markdown.slice(i, end));
        i = end;
      } else shielded += markdown[i++];
    }
    let text = "";
    for (i = 0; i < shielded.length;) {
      if (shielded.startsWith('![', i) && !escapedAt(shielded, i)) {
        const remaining = shielded.slice(i);
        const token = lexer.tokenizer.link(remaining) || lexer.tokenizer.reflink(remaining, tokens.links);
        if (token?.type === 'image') {
          const safe = imageURL(token.href, images);
          // Keep the original alt-text syntax, including escaped/nested brackets
          // and entities. Re-escaping token.text would double-escape entities.
          let depth = 1, altEnd = 2;
          for (; altEnd < token.raw.length; altEnd++) {
            if (escapedAt(token.raw, altEnd)) continue;
            if (token.raw[altEnd] === '[') depth++;
            if (token.raw[altEnd] === ']' && --depth === 0) break;
          }
          text += safe ? token.raw.slice(0, altEnd + 1) + '(' + safe + ')'
            : '〔图片不可用' + (token.text ? '：' + token.text : '') + '〕';
          i += token.raw.length;
          continue;
        }
      }
      text += shielded[i++];
    }
    // Also cover MinerU's HTML images without copying event handlers into the file.
    text = text.replace(/<img\b[^>]*>/gi, (tag) => {
      const fragment = sanitizeHTML(tag, images || {});
      const img = fragment.querySelector("img");
      if (!img) return "";
      const safe = imageURL(img.getAttribute("src"), images);
      if (!safe) return "〔图片不可用〕";
      const clean = element("img");
      clean.setAttribute("src", safe);
      clean.setAttribute("alt", img.getAttribute("alt") || "");
      return clean.outerHTML;
    });
    return text.replace(new RegExp(prefix + "(\\d+)END", "g"), (_, index) => code[Number(index)]);
  }

  function translationMarkdown(job) {
    checkLibraries();
    return replaceMarkdownImages(completeChunks(job).map(chunk => chunk.result).join(""), job.images || {}) + "\n";
  }

  const PORTABLE_STYLE = `
    :root{color-scheme:light dark;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#233247;background:#f5f7fa}
    *{box-sizing:border-box}body{margin:0;padding:32px 24px}header,main,footer{max-width:1400px;margin:auto}
    header{margin-bottom:24px}h1{font-size:26px;line-height:1.35;margin:0 0 12px}.meta,footer{font-size:13px;color:#526276}
    .column-head,.pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.column-head{font-weight:650;color:#53667d;padding:10px 22px;gap:44px}
    .pair{background:#fff;border:1px solid #dce3ec;border-radius:10px;overflow:hidden;margin:0 0 14px}.side{padding:22px;min-width:0}.side+.side{border-left:1px solid #e3e8ef}
    .chunk-label{font-size:11px;color:#6b7a8e;margin-bottom:12px}.pt-md{font-size:15px;line-height:1.85;overflow-wrap:anywhere}.pt-md>:first-child{margin-top:0}.pt-md>:last-child{margin-bottom:0}
    .pt-md h1{font-size:23px}.pt-md h2{font-size:21px}.pt-md h3{font-size:18px}.pt-md h4{font-size:16px}.pt-md img{display:block;max-width:100%;height:auto;margin:14px auto}
    .pt-md pre{background:#f3f5f8;border-radius:7px;padding:14px;white-space:pre-wrap;overflow:auto}.pt-md code{font-family:ui-monospace,monospace;font-size:.9em}
    .pt-md :not(pre)>code{background:#edf1f6;padding:2px 4px;border-radius:3px}.pt-md table{display:block;max-width:100%;overflow:auto;border-collapse:collapse;margin:16px 0}
    .pt-md th,.pt-md td{border:1px solid #dce3ec;padding:7px 11px;text-align:left}.pt-md th{background:#f3f5f8}.pt-md blockquote{margin:16px 0;border-left:3px solid #448675;padding-left:15px;color:#526276}
    .pt-md a{color:#226c86}.pt-formula-display{display:block;max-width:100%;overflow:auto;margin:14px 0;text-align:center}.pt-formula math{font-size:1.08em}.pt-missing-image{color:#84591b;font-size:13px}
    footer{margin-top:24px;line-height:1.7}.pt-formula .katex{font:inherit}
    @media(max-width:760px){body{padding:20px 12px}.column-head{display:none}.pair{grid-template-columns:1fr}.side+.side{border-left:0;border-top:1px solid #e3e8ef}.side{padding:18px}}
    @media(prefers-color-scheme:dark){:root{color:#e5eaf0;background:#19212d}.pair{background:#202c3b;border-color:#3a485b}.side+.side,.pt-md th,.pt-md td{border-color:#3a485b}.meta,footer,.chunk-label,.column-head{color:#afbfce}.pt-md pre,.pt-md th,.pt-md :not(pre)>code{background:#28374a}.pt-md a{color:#8bc4e2}.pt-md blockquote{color:#bdc9d8}}
    @media print{:root{color:#111;background:white}body{padding:0}.pair{break-inside:auto;border-radius:0}.column-head{display:grid}.side{padding:12px}.pt-md pre{white-space:pre-wrap}a{color:inherit}}
  `;

  function documentHTML(job) {
    const chunks = completeChunks(job);
    const doc = global.document.implementation.createHTMLDocument(asText(job.title) || "论文双语译文");
    doc.documentElement.setAttribute("lang", "zh-CN");
    const charset = element("meta", doc);
    charset.setAttribute("charset", "UTF-8");
    doc.head.prepend(charset);
    const viewport = element("meta", doc);
    viewport.setAttribute("name", "viewport");
    viewport.setAttribute("content", "width=device-width,initial-scale=1");
    doc.head.appendChild(viewport);
    const csp = element("meta", doc);
    csp.setAttribute("http-equiv", "Content-Security-Policy");
    csp.setAttribute("content", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    doc.head.appendChild(csp);
    const style = element("style", doc);
    style.textContent = PORTABLE_STYLE;
    doc.head.appendChild(style);
    const header = element("header", doc);
    const heading = element("h1", doc);
    heading.textContent = asText(job.title) || "论文双语译文";
    const meta = element("p", doc);
    meta.className = "meta";
    meta.textContent = "原文 / " + (LANGUAGES[job.targetLang] || asText(job.targetLang) || "译文")
      + " · 模型：" + (asText(job.model) || "未记录") + " · " + chunks.length + " 个段落分块";
    header.append(heading, meta);
    doc.body.appendChild(header);
    const main = element("main", doc);
    const columnHead = element("div", doc);
    columnHead.className = "column-head";
    for (const label of ["原文 ORIGINAL", "译文 TRANSLATION"]) {
      const item = element("span", doc); item.textContent = label; columnHead.appendChild(item);
    }
    main.appendChild(columnHead);
    chunks.forEach((chunk, index) => {
      const pair = element("section", doc);
      pair.className = "pair";
      for (const [position, content] of [asText(chunk.source), chunk.result].entries()) {
        const side = element("div", doc);
        side.className = "side";
        const label = element("div", doc);
        label.className = "chunk-label";
        label.textContent = (position ? "译文" : "原文") + " · " + (index + 1) + " / " + chunks.length
          + (position && (chunk.skipTranslation || chunk.status === "skipped") ? " · 保留原文" : "");
        side.appendChild(label);
        side.appendChild(doc.importNode(renderFragment(content, job.images || {}, { math: "mathml" }), true));
        pair.appendChild(side);
      }
      main.appendChild(pair);
    });
    doc.body.appendChild(main);
    const footer = element("footer", doc);
    footer.textContent = "由 Tidal 生成。译文由机器生成，研究引用请核对原文。图片已内嵌；公式采用原生 MathML，LaTeX 源码保存在公式标注中。";
    doc.body.appendChild(footer);
    return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
  }

  function noteHTML(job) {
    const chunks = completeChunks(job);
    const note = element("div");
    const heading = element("h1");
    heading.textContent = "译文｜" + (asText(job.title) || "论文");
    note.appendChild(heading);
    const meta = element("p");
    meta.textContent = "目标语言：" + (LANGUAGES[job.targetLang] || asText(job.targetLang))
      + "；模型：" + (asText(job.model) || "未记录") + "。公式以 LaTeX 源码保留，排版公式请查看双语 HTML 附件。";
    note.appendChild(meta);
    for (const chunk of chunks) {
      note.appendChild(renderFragment(chunk.result, job.images || {}, { math: "source" }));
    }
    return note.outerHTML;
  }

  global.PTRenderer = Object.freeze({ render, documentHTML, translationMarkdown, noteHTML, safeLink });
})(globalThis);
