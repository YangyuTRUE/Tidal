/* The window owns its subscriptions, never the lifetime of a translation job. */
(function () {
  "use strict";

  const XHTML = "http://www.w3.org/1999/xhtml";
  const LABELS = {
    queued: "准备中", parsing: "解析 PDF", translating: "正在翻译", partial: "部分完成",
    complete: "翻译完成", cancelled: "已取消", error: "任务失败"
  };
  const LANGUAGES = { "zh-CN": "简体中文", en: "English", ja: "日本語" };
  const ACTIVE = new Set(["queued", "parsing", "translating"]);
  let app, jobID, job, unsubscribe, disposed = false, rendering = false, actionBusy = false;
  let host, bound = false, toolsVisible = false, focusedSide = 'translated', selectionScheduled = false;
  let cards = [], cardOrder = "", activeIndex = -1, imageSignature = "", logSignature = "", syncLock = false;
  let feedbackTimer, previousStatus;
  const $ = id => document.getElementById(id);
  const create = tag => document.createElementNS(XHTML, tag);

  function text(value) { return typeof value === "string" ? value : value == null ? "" : String(value); }
  function message(value) {
    return text(value).replace(/\bBearer\s+\S+/gi, "Bearer [已隐藏]")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[API Key 已隐藏]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[Token 已隐藏]")
      .slice(0, 1400);
  }

  function feedback(value, level = "info") {
    if (disposed) return;
    const field = $("actionFeedback");
    field.textContent = message(value);
    field.dataset.level = level;
    $('feedbackToast').hidden = !value;
    clearTimeout(feedbackTimer);
    if (value && level !== 'error') feedbackTimer = setTimeout(() => { if (!disposed) $('feedbackToast').hidden = true; }, 4000);
  }

  function canExport() {
    return job && job.status === "complete" && Array.isArray(job.chunks) && job.chunks.length > 0
      && job.chunks.every(chunk => chunk.skipTranslation || chunk.status === "skipped"
        || (chunk.status === "done" && typeof chunk.translated === "string"
          && (chunk.translated.trim() || !text(chunk.source).trim())));
  }

  function updateActions() {
    $("saveOutputs").disabled = !canExport() || actionBusy;
    $("createNote").disabled = !canExport() || actionBusy;
    $("retry").disabled = !job || !["partial", "cancelled", "error"].includes(job.status) || actionBusy;
    $("cancel").disabled = !job || !ACTIVE.has(job.status);
    $("retry").hidden = !job || !["partial", "cancelled", "error"].includes(job.status);
    $("cancel").hidden = !job || !ACTIVE.has(job.status);
    $("openOriginal").disabled = !job || !job.attachmentID;
    const selected = selectedParagraphs();
    const side = selected?.side || currentSide();
    const indices = selected?.indices || (activeIndex >= 0 ? [activeIndex] : []);
    const ready = indices.length && indices.every(index => job?.chunks[index] && (side === 'original'
      || job.chunks[index].skipTranslation || ['done', 'skipped'].includes(job.chunks[index].status)));
    $("copyParagraph").disabled = !ready || actionBusy;
    $("copyDocument").disabled = actionBusy || (currentSide() === 'original' ? !job?.originalMd : !canExport());
    $("copyDocument").title = currentSide() === 'original' ? '复制全文原文 Markdown' : canExport() ? '复制全文译文 Markdown（包含保留的参考文献）' : '全文完成后可复制；可先复制已完成段落';
    $('copyDocument').setAttribute('aria-label', currentSide() === 'original' ? '复制全文原文 Markdown' : '复制全文译文 Markdown');
    const saved = Boolean(job?.outputs?.html && job?.outputs?.markdown);
    $('saveOutputs').dataset.saved = String(saved);
    $('saveOutputs').querySelector('use').setAttribute('href', saved ? '#i-saved' : '#i-save');
    $('saveOutputs').title = saved ? '已保存附件；点击检查或再次保存' : '保存双语 HTML 和译文 Markdown 到 Zotero';
  }

  function createCard(index, side, count) {
    const article = create("article");
    article.className = "chunk-card";
    article.dataset.chunkIndex = String(index);
    article.dataset.side = side;
    article.tabIndex = 0;
    article.setAttribute("aria-label", (side === "original" ? "原文" : "译文") + "段落 " + (index + 1) + "，按回车定位对照段落");
    const meta = create("div"); meta.className = "chunk-meta";
    const label = create("span"); label.textContent = (index + 1) + " / " + count;
    const status = create("span"); status.className = "chunk-state";
    meta.append(label, status);
    const links = create("div"); links.className = "paragraph-links";
    const pdf = create("button"); pdf.type = "button"; pdf.className = "paragraph-link"; pdf.dataset.action = "pdf";
    const counterpart = create("button"); counterpart.type = "button"; counterpart.className = "paragraph-link";
    counterpart.dataset.action = "counterpart";
    counterpart.textContent = side === "original" ? "译文" : "原文";
    counterpart.title = side === 'original' ? '跳到对应译文' : '跳到对应原文';
    const copy = create('button'); copy.type = 'button'; copy.className = 'paragraph-link'; copy.dataset.action = 'copy';
    copy.textContent = '复制 MD'; copy.title = '复制完整段落的 Markdown';
    links.append(pdf, counterpart, copy);
    const tools = create('div'); tools.className = 'paragraph-tools'; tools.hidden = !toolsVisible;
    tools.append(meta, links);
    const body = create("div"); body.className = "pt-md";
    article.append(tools, body);
    return { article, body, status, pdf, copy, links, tools, source: null, translated: null, signature: null };
  }

  function renderPlaceholder(container, chunk, state) {
    const box = create("div"); box.className = "chunk-placeholder" + (chunk.status === "error" ? " is-error" : "");
    const copy = create("p");
    copy.textContent = chunk.status === "error" ? "本段翻译失败。可点击“重试未完成段落”继续。"
      : state === "cancelled" ? "本段尚未完成。已完成的其他段落保留，可稍后重试。"
      : state === "error" || state === "partial" ? "本段尚未完成，请重试。" : "等待翻译…";
    box.appendChild(copy);
    if (chunk.error) {
      const error = create("p"); error.className = "error-detail"; error.textContent = message(chunk.error);
      box.appendChild(error);
    }
    container.replaceChildren(box);
  }

  function renderCards(current) {
    const chunks = Array.isArray(current.chunks) && current.chunks.length ? current.chunks
      : current.originalMd ? [{ index: 0, source: current.originalMd, translated: null, status: "pending" }] : [];
    if (!chunks.length) return;
    const order = chunks.map((chunk, index) => text(chunk.index == null ? index : chunk.index) + ':' + Boolean(chunk.skipTranslation || chunk.status === 'skipped')).join("|");
    const images = current.images || {};
    const nextImageSignature = Object.entries(images).map(([name, data]) => name + ":" + text(data).length).join("|");
    const newImages = imageSignature !== nextImageSignature;
    imageSignature = nextImageSignature;
    if (cardOrder !== order || cards.length !== chunks.length) {
      cards = chunks.map((_, index) => ({ original: createCard(index, "original", chunks.length), translated: createCard(index, "translated", chunks.length) }));
      $("originalContent").replaceChildren(...cards.map(card => card.original.article));
      const translated = []; let referenceGroup, referenceCount = 0;
      for (let index = 0; index < chunks.length; index++) {
        const retained = host?.embedded && (chunks[index].skipTranslation || chunks[index].status === 'skipped');
        if (retained) {
          if (!referenceGroup) {
            referenceGroup = create('details'); referenceGroup.className = 'reference-group';
            const summary = create('summary'); referenceGroup.appendChild(summary); translated.push(referenceGroup); referenceCount = 0;
          }
          referenceCount++;
          referenceGroup.firstElementChild.textContent = '参考文献 · ' + referenceCount + ' 段，保留原文';
          referenceGroup.appendChild(cards[index].translated.article);
        } else { referenceGroup = null; translated.push(cards[index].translated.article); }
      }
      $("translatedContent").replaceChildren(...translated);
      cardOrder = order;
    }
    chunks.forEach((chunk, index) => {
      const card = cards[index];
      for (const side of ["original", "translated"]) {
        card[side].links.hidden = !host?.embedded;
        card[side].pdf.disabled = !chunk.locations?.length || typeof host?.locatePDF !== "function";
        card[side].pdf.textContent = chunk.locations?.length ? "PDF · 第 " + (chunk.locations[0].pageIndex + 1) + " 页" : "无段落坐标";
        card[side].copy.disabled = side === 'translated' && !chunk.skipTranslation && !['done', 'skipped'].includes(chunk.status);
      }
      const source = text(chunk.source);
      if (card.original.source !== source || newImages) {
        PTRenderer.render(card.original.body, source, images);
        card.original.source = source;
      }
      card.original.status.textContent = source.length.toLocaleString() + " 字符";
      const skipped = chunk.skipTranslation || chunk.status === "skipped";
      const done = chunk.status === "done" && typeof chunk.translated === "string";
      const status = skipped ? "skipped" : done ? "done" : chunk.status === "error" ? "error" : "pending";
      card.translated.status.dataset.state = status;
      card.translated.status.textContent = ({ skipped: "保留原文", done: "已完成", error: "翻译失败", pending: "未完成" })[status];
      card.translated.status.title = ({ 'mineru-reference': 'MinerU 标记为参考文献', 'reference-heading': '参考文献章节标题', 'reference-section': '参考文献章节中的文献条目', 'bibliographic-pattern': '文末连续的文献格式条目' })[chunk.skipReason] || '';
      const translated = skipped ? source : done ? chunk.translated : "";
      const signature = status + "\u0000" + translated + "\u0000" + text(chunk.error)
        + (done || skipped ? '' : "\u0000" + current.status);
      if (card.translated.signature !== signature || newImages) {
        if (done || skipped) PTRenderer.render(card.translated.body, translated, images);
        else renderPlaceholder(card.translated.body, chunk, current.status);
        card.translated.signature = signature;
      }
      card.original.article.classList.toggle("is-active", index === activeIndex);
      card.translated.article.classList.toggle("is-active", index === activeIndex);
    });
  }

  function renderLogs(current) {
    const logs = Array.isArray(current.logs) ? current.logs.slice(-200) : [];
    const signature = logs.length + ":" + logs.map(log => text(log.time) + text(log.message)).join("|");
    if (signature === logSignature) return;
    logSignature = signature;
    $("logCount").textContent = logs.length ? "(" + logs.length + (current.logs.length > 200 ? "+" : "") + ")" : "";
    const items = logs.map(log => {
      const li = create("li"); li.dataset.level = ["error", "warning", "info"].includes(log.level) ? log.level : "info";
      const timestamp = create("time");
      const date = new Date(log.time);
      timestamp.textContent = Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const copy = create("span"); copy.textContent = message(log.message);
      li.append(timestamp, copy);
      return li;
    });
    const list = $("logList");
    const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 35;
    list.replaceChildren(...items);
    if (atEnd) list.scrollTop = list.scrollHeight;
  }

  function draw() {
    rendering = false;
    if (disposed || !job) return;
    const current = job;
    document.title = (text(current.title) || "论文翻译") + " · Tidal";
    $("documentTitle").textContent = text(current.title) || "论文翻译";
    $("documentTitle").title = text(current.title);
    $("documentMeta").textContent = (LANGUAGES[current.targetLang] || text(current.targetLang) || "未设置")
      + " · " + (text(current.model) || "未设置");
    $('documentIdentity').title = text(current.title) + '\n' + $('documentMeta').textContent;
    $("statusMessage").dataset.status = current.status || "queued";
    $("statusMessage").textContent = message(current.message) || LABELS[current.status] || "正在加载任务…";
    $("statusMessage").title = $("statusMessage").textContent;
    const chunks = Array.isArray(current.chunks) ? current.chunks : [];
    $("paragraphNavigation").hidden = !host?.embedded;
    const located = chunks.filter(chunk => chunk.locations?.length).length;
    $("followParagraph").disabled = !located;
    const locationHelp = located ? located + " / " + chunks.length + " 段可定位；点击 PDF 或段落联动"
      : current.type === "selection" ? "段落定位用于全文翻译任务。"
      : current.type === "pdf" && current.originalMd ? "此历史没有段落坐标；需重新解析时，请先在历史中删除该记录。" : "解析完成后可按段落定位。";
    $('paragraphNavigation').title = locationHelp + (located ? ($('followParagraph').checked ? '；联动已开启' : '；联动已关闭') : '');
    const done = chunks.filter(chunk => chunk.status === "done" && typeof chunk.translated === "string").length;
    const skipped = chunks.filter(chunk => chunk.skipTranslation || chunk.status === "skipped").length;
    const failed = chunks.filter(chunk => chunk.status === "error").length;
    $("chunkSummary").textContent = chunks.length ? "已翻译 " + done + " / " + (chunks.length - skipped)
      + (skipped ? " · 保留 " + skipped : "") + (failed ? " · 失败 " + failed : "") : "";
    $("sourceCount").textContent = current.originalMd ? text(current.originalMd).length.toLocaleString() + " 字符" : "";
    $("translationLanguage").textContent = LANGUAGES[current.targetLang] || text(current.targetLang);
    $("savedHint").textContent = Array.isArray(current.outputItemIDs) && current.outputItemIDs.length ? "已保存到文献条目" : "";
    renderCompactStatus();
    updateActions();
    try { renderCards(current); } catch (error) { feedback(error.message || error, "error"); }
    renderLogs(current);
  }

  function renderCompactStatus() {
    if (!job) return;
    const state = job.status || 'queued', chunks = job.chunks || [];
    const icons = { queued: 'clock', parsing: 'working', translating: 'working', complete: 'check', partial: 'warning', error: 'error', cancelled: 'pause' };
    const pending = chunks.filter(chunk => !chunk.skipTranslation && !['done', 'skipped'].includes(chunk.status)).length;
    const short = { queued: '排队', parsing: '解析', translating: '翻译', complete: chunks.length + ' 段',
      partial: pending + ' 段待译', error: '失败', cancelled: '已暂停' };
    $('taskStatus').dataset.status = state;
    $('statusBadge').dataset.status = state;
    const label = LABELS[state] || LABELS.queued;
    if ($('statusBadge').textContent !== label) $('statusBadge').textContent = label;
    $('statusText').textContent = short[state] || '准备';
    $('statusGlyph').setAttribute('href', '#i-' + (icons[state] || 'clock'));
    $('statusIcon').classList.toggle('is-spinning', ['parsing', 'translating'].includes(state));
    const block = activeIndex >= 0 ? chunks[activeIndex]?.locations?.[0] : null;
    const location = activeIndex >= 0 ? '段落 ' + (activeIndex + 1) + (block ? ' · PDF 第 ' + (block.pageIndex + 1) + ' 页' : ' · 无段落坐标') : '';
    $('locationHint').textContent = activeIndex >= 0 ? (activeIndex + 1) + (block ? ' · PDF ' + (block.pageIndex + 1) : '') : '';
    $('locationHint').title = location;
    const progress = Math.min(100, Math.max(0, Number(job.progress) || 0));
    $('taskProgress').value = progress;
    $('taskProgress').setAttribute('aria-valuetext', Math.round(progress) + '%');
    $('taskProgress').hidden = !ACTIVE.has(state) && state !== 'partial';
    $('progressPercent').textContent = Math.round(progress) + '%';
    $('progressPercent').hidden = !ACTIVE.has(state) || !progress;
    $('statusToggle').title = [label, message(job.message), $('chunkSummary').textContent, location].filter(Boolean).join('\n');
    $('statusToggle').setAttribute('aria-label', [label, ACTIVE.has(state) ? Math.round(progress) + '%' : '', location, '查看任务详情'].filter(Boolean).join('，'));
    if (state !== previousStatus) {
      if (state === 'error') { $('moreMenu').open = false; $('taskDetails').open = true; }
      else if (previousStatus === 'error') $('taskDetails').open = false;
      previousStatus = state;
    }
  }

  function update(current) {
    if (disposed) return;
    if (current) job = current;
    if (!rendering) { rendering = true; window.requestAnimationFrame(draw); }
  }

  function highlight(index, side, navigate = true) {
    if (index < 0 || !cards[index]) return;
    activeIndex = index;
    if (['original', 'translated'].includes(side)) focusedSide = side;
    cards.forEach((card, current) => {
      card.original.article.classList.toggle("is-active", current === index);
      card.translated.article.classList.toggle("is-active", current === index);
    });
    syncLock = true;
    const counterpart = cards[index][side === "original" ? "translated" : "original"].article;
    if (!host?.embedded) counterpart.scrollIntoView({ behavior: "auto", block: "center" });
    if (host?.embedded) {
      const block = job.chunks[index]?.locations?.[0];
      if (navigate && $("followParagraph").checked && block && typeof host.locatePDF === "function") {
        Promise.resolve(host.locatePDF(index)).catch(error => feedback(error.message || error, "error"));
      }
    }
    window.requestAnimationFrame(() => { syncLock = false; });
    renderCompactStatus();
    updateActions();
  }

  function cardInteraction(event) {
    const control = event.target.closest("button[data-action]");
    if (control && event.type === "click") {
      const card = control.closest(".chunk-card"), index = Number(card.dataset.chunkIndex);
      highlight(index, card.dataset.side, false);
      if (control.dataset.action === 'copy') {
        copyMarkdown(card.dataset.side, [index]);
      } else if (control.dataset.action === "pdf") {
        Promise.resolve(host.locatePDF(index)).catch(error => feedback(error.message || error, "error"));
      } else {
        const side = card.dataset.side === "original" ? "translated" : "original";
        showSide(side);
        revealParagraph(index, side);
      }
      return;
    }
    if (event.target.closest("a, button, input")) return;
    if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
    if (event.type === "click" && window.getSelection && window.getSelection().toString()) return;
    const card = event.target.closest(".chunk-card");
    if (!card) return;
    if (event.type === "keydown") event.preventDefault();
    highlight(Number(card.dataset.chunkIndex), card.dataset.side);
  }

  function synchronize(fromSide) {
    if (syncLock || !$("syncScroll").checked || !cards.length) return;
    const toSide = fromSide === "original" ? "translated" : "original";
    const from = $(fromSide === "original" ? "originalPane" : "translatedPane");
    const to = $(toSide === "original" ? "originalPane" : "translatedPane");
    const topInPane = (node, pane) => node.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    let index = 0;
    while (index + 1 < cards.length && topInPane(cards[index + 1][fromSide].article, from) <= from.scrollTop + 2) index++;
    const sourceCard = cards[index][fromSide].article;
    const targetCard = cards[index][toSide].article;
    const sourceTop = topInPane(sourceCard, from);
    const nextSource = index + 1 < cards.length ? topInPane(cards[index + 1][fromSide].article, from) : sourceTop + sourceCard.offsetHeight;
    const targetTop = topInPane(targetCard, to);
    const nextTarget = index + 1 < cards.length ? topInPane(cards[index + 1][toSide].article, to) : targetTop + targetCard.offsetHeight;
    const fraction = Math.max(0, Math.min(1, (from.scrollTop - sourceTop) / Math.max(1, nextSource - sourceTop)));
    syncLock = true;
    to.scrollTop = targetTop + fraction * (nextTarget - targetTop);
    window.requestAnimationFrame(() => { syncLock = false; });
  }

  async function action(callback, success) {
    if (actionBusy) return;
    const owner = jobID;
    actionBusy = true; updateActions(); feedback("");
    try {
      await callback();
      if (success && jobID === owner) feedback(success);
    } catch (error) {
      if (jobID === owner) feedback(error && error.message || error, "error");
    } finally {
      actionBusy = false;
      if (!disposed) updateActions();
    }
  }

  function bind() {
    // Keep a text selection intact while a toolbar copy button receives a click.
    for (const id of ['copyParagraph', 'copyDocument', 'moreActions']) $(id).addEventListener('mousedown', event => event.preventDefault());
    $('dismissFeedback').addEventListener('click', () => feedback(''));
    for (const [id, summary] of [['moreMenu', 'moreActions'], ['taskDetails', 'statusToggle']]) {
      $(id).addEventListener('toggle', () => $(summary).setAttribute('aria-expanded', String($(id).open)));
    }
    $('morePanel').addEventListener('click', event => {
      // The action handler may have disabled its button before this event bubbles.
      if (event.target.closest?.('button')) {
        $('moreMenu').open = false;
        if (event.detail === 0) $('moreActions').focus();
      }
    });
    document.addEventListener('click', event => {
      for (const id of ['moreMenu', 'taskDetails']) if ($(id).open && !$(id).contains(event.target)) $(id).open = false;
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      for (const [id, summary] of [['moreMenu', 'moreActions'], ['taskDetails', 'statusToggle']]) {
        if (!$(id).open) continue;
        event.preventDefault(); $(id).open = false; $(summary).focus(); return;
      }
      if (!$('feedbackToast').hidden) { event.preventDefault(); feedback(''); }
    });
    $("toggleParagraphTools").addEventListener('click', () => {
      setToolsVisible(!toolsVisible);
      Promise.resolve().then(() => app.setParagraphTools?.(toolsVisible)).catch(error => feedback(error.message, 'error'));
    });
    $("copyParagraph").addEventListener('click', () => {
      const selected = selectedParagraphs();
      copyMarkdown(selected?.side || currentSide(), selected?.indices || [activeIndex]);
    });
    $("copyDocument").addEventListener('click', () => copyMarkdown(currentSide(), null));
    $("history").addEventListener('click', () => Promise.resolve().then(() => app.showHistory()).catch(error => feedback(error.message, 'error')));
    document.addEventListener('selectionchange', () => {
      if (disposed || selectionScheduled) return;
      selectionScheduled = true;
      window.requestAnimationFrame(() => { selectionScheduled = false; if (!disposed && job) updateActions(); });
    });
    document.addEventListener('keydown', event => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || String(event.key).toLowerCase() !== 'c'
        || event.target.closest?.('textarea,input:not([type="checkbox"]),[contenteditable="true"]')) return;
      const selected = selectedParagraphs();
      if (!selected && window.getSelection?.()?.isCollapsed === false) return;
      if (!selected && activeIndex < 0) return;
      event.preventDefault(); event.stopPropagation();
      copyMarkdown(selected?.side || currentSide(), selected?.indices || [activeIndex]);
    }, true);
    document.addEventListener('copy', event => {
      const selected = selectedParagraphs();
      if (!selected) return;
      try {
        const value = PTCore.markdownForCopy(job, selected.side, selected.indices);
        if (event.clipboardData) {
          event.preventDefault(); event.clipboardData.setData('text/plain', value);
          feedback('已复制所选 ' + selected.indices.length + ' 个完整段落的 Markdown。');
        }
      } catch (error) { event.preventDefault(); feedback(error.message, 'error'); }
    });
    $("followParagraph").addEventListener("change", () => {
      host?.setFollowing?.($("followParagraph").checked);
      $('paragraphNavigation').title = $('followParagraph').checked ? '段落联动已开启' : '段落联动已关闭';
    });
    $("dockLeft").addEventListener("click", () => host?.setSide("left"));
    $("dockRight").addEventListener("click", () => host?.setSide("right"));
    $("closeDrawer").addEventListener("click", () => host?.close());
    for (const [id, source] of [["showTranslation", false], ["showSource", true]]) {
      $(id).addEventListener("click", () => {
        showSide(source ? "original" : "translated");
        if (activeIndex >= 0 && cards[activeIndex]) revealParagraph(activeIndex, source ? "original" : "translated");
      });
    }
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && host?.embedded && !event.defaultPrevented) {
        event.preventDefault(); host.close();
      }
    });
    $("openOriginal").addEventListener("click", () => Promise.resolve().then(() => app.openOriginal(jobID)).catch(error => feedback(error.message || error, "error")));
    $("settings").addEventListener("click", () => Promise.resolve().then(() => app.openSettings()).catch(error => feedback(error.message || error, "error")));
    $("cancel").addEventListener("click", () => {
      feedback("正在取消任务，已完成的段落会保留。");
      Promise.resolve().then(() => app.cancel(jobID)).catch(error => feedback(error.message || error, "error"));
    });
    $("retry").addEventListener("click", () => action(() => app.resume(jobID)));
    $("saveOutputs").addEventListener("click", () => action(async () => {
      if (!canExport()) throw new Error("请先完成所有待翻译段落。");
      const outputs = { html: PTRenderer.documentHTML(job), markdown: PTRenderer.translationMarkdown(job) };
      await app.saveOutputs(jobID, outputs);
    }, "双语 HTML 与译文 Markdown 已保存到 Zotero 文献条目。"));
    $("createNote").addEventListener("click", () => action(async () => {
      if (!canExport()) throw new Error("请先完成所有待翻译段落。");
      await app.createNote(jobID);
    }, "译文笔记已保存到 Zotero 文献条目。"));
    for (const id of ["originalContent", "translatedContent"]) {
      $(id).addEventListener("click", cardInteraction);
      $(id).addEventListener("keydown", cardInteraction);
    }
    $("originalPane").addEventListener("scroll", () => synchronize("original"), { passive: true });
    $("translatedPane").addEventListener("scroll", () => synchronize("translated"), { passive: true });
    document.addEventListener("click", event => {
      const link = event.target.closest && event.target.closest("a");
      if (!link) return;
      event.preventDefault();
      const href = PTRenderer.safeLink(link.getAttribute("href"));
      if (href && typeof app.openExternal === "function") {
        Promise.resolve().then(() => app.openExternal(href)).catch(error => feedback(error.message || error, "error"));
      }
    }, true);
    // Middle clicks must not bypass the privileged-window navigation guard.
    document.addEventListener("auxclick", event => {
      if (event.target.closest && event.target.closest("a")) event.preventDefault();
    }, true);
  }

  function disconnect() {
    disposed = true;
    clearTimeout(feedbackTimer);
    if (typeof unsubscribe === "function") {
      try { unsubscribe(); } catch (_) { /* The host may already be shutting down. */ }
    }
    unsubscribe = null;
  }

  function setSide(side) {
    $("dockLeft").setAttribute("aria-pressed", String(side === "left"));
    $("dockRight").setAttribute("aria-pressed", String(side !== "left"));
  }
  function currentSide() { return host?.embedded ? document.body.classList.contains('drawer-source') ? 'original' : 'translated' : focusedSide; }
  function selectedParagraphs() {
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed || !selection.rangeCount || !cards.length) return null;
    const anchor = selection.anchorNode?.nodeType === 1 ? selection.anchorNode : selection.anchorNode?.parentElement;
    const side = anchor?.closest('.chunk-card')?.dataset.side || currentSide();
    const indices = [];
    for (let index = 0; index < cards.length; index++) {
      const body = cards[index][side]?.body;
      if (!body?.getClientRects().length) continue;
      for (let i = 0; i < selection.rangeCount; i++) {
        try { if (selection.getRangeAt(i).intersectsNode(body)) { indices.push(index); break; } } catch (_) {}
      }
    }
    return indices.length ? { side, indices } : null;
  }
  function copyMarkdown(side, indices) {
    const owner = jobID;
    return action(() => app.copyMarkdown(owner, side, indices), indices === null
      ? '已复制全文 Markdown。' : '已复制 ' + indices.length + ' 个完整段落的 Markdown。');
  }
  function setToolsVisible(value) {
    const positions = [];
    for (const side of ['original', 'translated']) {
      const pane = $(side === 'original' ? 'originalPane' : 'translatedPane');
      const bounds = pane.getBoundingClientRect();
      if (!bounds.height || !bounds.width) continue;
      const card = cards.find(card => card[side].article.getBoundingClientRect().bottom > bounds.top);
      if (card) positions.push({ pane, article: card[side].article, top: card[side].article.getBoundingClientRect().top });
    }
    toolsVisible = Boolean(value);
    document.body.dataset.paragraphTools = String(toolsVisible);
    $("toggleParagraphTools").setAttribute('aria-pressed', String(toolsVisible));
    for (const card of cards) for (const side of ['original', 'translated']) card[side].tools.hidden = !toolsVisible;
    for (const { pane, article, top } of positions) pane.scrollTop += article.getBoundingClientRect().top - top;
  }
  function showSide(side) {
    const source = side === "original";
    document.body.classList.toggle("drawer-source", source);
    $("showTranslation").setAttribute("aria-pressed", String(!source));
    $("showSource").setAttribute("aria-pressed", String(source));
    if (job) updateActions();
  }
  function selectParagraph(index) {
    if (disposed || !cards[index]) return;
    highlight(index, "original", false);
    const side = document.body.classList.contains("drawer-source") ? "original" : "translated";
    revealParagraph(index, side);
  }
  function revealParagraph(index, side) {
    const article = cards[index][side].article;
    const group = article.closest('.reference-group');
    if (group) group.open = true;
    article.scrollIntoView({ block: 'center', behavior: 'auto' });
  }
  function setAppearance(config) {
    window.PTAppearance?.apply(config);
  }

  function connect(params) {
    try {
      if (!params || !params.app || !params.jobID) throw new Error("未取得翻译任务，请从 Zotero 文献菜单重新打开。");
      const changed = jobID !== params.jobID;
      disconnect(); disposed = false; rendering = false;
      host = params;
      if (!bound) { bind(); bound = true; }
      app = params.app; jobID = params.jobID;
      job = app.getJob(jobID);
      if (!job) throw new Error("该任务已不可用，请从 Zotero 文献菜单重新打开。");
      setAppearance(typeof app.getConfig === 'function' ? app.getConfig() : job.config || {});
      setToolsVisible(typeof app.getParagraphTools === 'function' ? app.getParagraphTools() : false);
      if (changed) {
        $('moreMenu').open = false; $('taskDetails').open = false; previousStatus = undefined;
        cards = []; cardOrder = ""; activeIndex = -1; imageSignature = ""; logSignature = "";
        for (const id of ["originalContent", "translatedContent"]) {
          const empty = create("p"); empty.className = "empty-state";
          empty.textContent = id === "originalContent" ? "PDF 解析完成后，原文会显示在这里。" : "译文将逐段出现，已完成的段落可以立即阅读。";
          $(id).replaceChildren(empty);
        }
        feedback("");
      }
      document.body.classList.toggle("embedded", Boolean(params.embedded));
      $("drawerControls").hidden = !params.embedded;
      $("drawerViews").hidden = !params.embedded;
      $('closeDrawer').hidden = !params.embedded;
      setSide(params.side || "right");
      host.setFollowing?.($("followParagraph").checked);
      unsubscribe = app.subscribe(jobID, update);
      update(job);
    } catch (error) {
      job = null;
      $("statusBadge").textContent = "无法打开";
      $("statusBadge").dataset.status = "error";
      $("statusMessage").textContent = message(error.message || error);
      $("documentTitle").textContent = "翻译任务不可用";
      $('taskStatus').dataset.status = 'error'; $('statusText').textContent = '无法打开';
      $('statusGlyph').setAttribute('href', '#i-error'); $('statusIcon').classList.remove('is-spinning');
      $('taskDetails').open = true; $('taskProgress').hidden = true; $('progressPercent').hidden = true;
      for (const button of document.querySelectorAll("button")) button.disabled = true;
      $('closeDrawer').disabled = !host?.close;
    }
  }

  window.PTViewer = { connect, disconnect, setSide, selectParagraph, setAppearance, setToolsVisible };
  function init() {
    if (window.location.hash === "#embedded") return;
    const raw = window.arguments && window.arguments[0];
    connect(raw && (raw.wrappedJSObject || raw));
  }
  window.addEventListener("unload", disconnect, { once: true });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
