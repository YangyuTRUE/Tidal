/* Zotero Reader owns the PDF. This module only adds/removes sibling UI. */
(function (root) {
  'use strict';
  const HTML = 'http://www.w3.org/1999/xhtml';
  const URI = 'chrome://tidal/content/';
  const SIDE_PREF = 'extensions.paper-translator.drawerSide';
  const WIDTH_PREF = 'extensions.paper-translator.drawerWidth';
  function intrinsicViewport(page, window) {
    // Content code cannot read properties on a privileged options object.
    const options = Components.utils.cloneInto({ scale: 1, rotation: page.pdfPage.rotate }, window);
    return page.viewport.clone(options);
  }

  function button(app, reader, doc) {
    const node = doc.createElementNS(HTML, 'button');
    node.className = 'toolbar-button tidal-toggle';
    node.textContent = '译文';
    node.title = '展开或收起论文译文';
    node.setAttribute('aria-label', '展开或收起论文译文');
    node.setAttribute('aria-pressed', String(Boolean(app.readerPanes.get(reader)?.visible)));
    node.addEventListener('click', () => app.guard(async () => {
      const pane = app.readerPanes.get(reader);
      if (pane) return pane.setVisible(!pane.visible);
      // Reopen the newest task for this PDF before starting another request.
      const existing = [...app.jobs.values()].filter(job => job.attachmentID === reader.itemID)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (existing) return open(app, existing.id, reader);
      return app.startAttachment(Zotero.Items.get(reader.itemID), reader);
    }));
    app.readerNodes.add(node);
    return node;
  }

  function addToolbarButton(app, { reader, doc, append }) {
    if (!app.alive || !reader || !doc || doc.querySelector('.tidal-toggle')) return;
    append(button(app, reader, doc));
  }

  function attachToolbarButton(app, reader) {
    const doc = reader._iframeWindow?.document;
    if (!doc || doc.querySelector('.tidal-toggle')) return;
    const toolbar = doc.querySelector('.toolbar .end') || doc.querySelector('.toolbar');
    if (toolbar) toolbar.appendChild(button(app, reader, doc));
  }

  class Drawer {
    constructor(app, reader) {
      this.app = app; this.reader = reader; this.visible = false; this.jobID = null;
      this.doc = reader._iframe.ownerDocument;
      this.parent = reader._iframe.parentNode;
      this.side = Zotero.Prefs.get(SIDE_PREF, true) === 'left' ? 'left' : 'right';
      const create = tag => this.doc.createElementNS(HTML, tag);
      this.styles = create('link'); this.styles.rel = 'stylesheet';
      this.styles.href = URI + 'reader-pane.css?v=' + encodeURIComponent(app.version);
      this.doc.documentElement.appendChild(this.styles);
      this.parent.classList.add('pt-reader-layout');
      this.panel = create('aside'); this.panel.className = 'pt-reader-drawer';
      this.panel.setAttribute('aria-label', '论文译文抽屉');
      const width = Number(Zotero.Prefs.get(WIDTH_PREF, true));
      this.width = Number.isFinite(width) && width >= 300 ? width : 440;
      this.splitter = create('div'); this.splitter.className = 'pt-reader-splitter';
      this.splitter.tabIndex = 0; this.splitter.setAttribute('role', 'separator');
      this.splitter.setAttribute('aria-orientation', 'vertical');
      this.splitter.setAttribute('aria-label', '调整译文抽屉宽度，使用左右方向键');
      this.frame = create('iframe'); this.frame.className = 'pt-reader-frame';
      this.frame.title = '论文译文';
      this.frame.addEventListener('load', () => { this.connectedJobID = null; this.connect(); });
      this.frame.src = URI + 'viewer.xhtml?v=' + encodeURIComponent(app.version) + '#embedded';
      this.panel.appendChild(this.frame);
      this.parent.append(this.splitter, this.panel);
      this.splitter.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        this.drag = { x: event.clientX, width: this.panel.getBoundingClientRect().width };
        this.splitter.setPointerCapture(event.pointerId);
      });
      this.splitter.addEventListener('pointermove', event => {
        if (this.drag) this.resize(this.drag.width + (event.clientX - this.drag.x) * (this.side === 'left' ? 1 : -1));
      });
      const stopDrag = () => { if (this.drag) Zotero.Prefs.set(WIDTH_PREF, Math.round(this.width), true); this.drag = null; };
      this.splitter.addEventListener('pointerup', stopDrag);
      this.splitter.addEventListener('lostpointercapture', stopDrag);
      this.splitter.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
        event.preventDefault();
        this.resize(event.key === 'Home' ? 440 : this.width + (event.key === 'ArrowRight' ? 24 : -24) * (this.side === 'left' ? 1 : -1));
        Zotero.Prefs.set(WIDTH_PREF, Math.round(this.width), true);
      });
      this.onResize = () => this.resize(this.width);
      this.doc.defaultView.addEventListener('resize', this.onResize);
      this.onUnload = () => this.destroy();
      reader._iframeWindow.addEventListener('unload', this.onUnload, { once: true });
      this.pdfDocuments = new Map();
      this.pollPDFViews = this.doc.defaultView.setInterval(() => this.attachPDFViews(), 1000);
      this.attachPDFViews();
      this.setSide(this.side, false);
      this.setVisible(false);
    }
    resize(width) {
      const available = this.parent.getBoundingClientRect().width;
      if (!available) return; // An inactive Zotero tab has no layout box.
      const max = Math.max(240, Math.min(840, available - 260));
      this.width = Math.min(max, Math.max(Math.min(300, max), width));
      this.panel.style.width = this.width + 'px';
      this.panel.style.flexBasis = this.width + 'px';
      this.splitter.setAttribute('aria-valuemin', String(Math.min(300, max)));
      this.splitter.setAttribute('aria-valuemax', String(Math.round(max)));
      this.splitter.setAttribute('aria-valuenow', String(Math.round(this.width)));
    }
    setSide(side, persist = true) {
      this.side = side === 'left' ? 'left' : 'right';
      this.panel.dataset.side = this.side; this.splitter.dataset.side = this.side;
      if (persist) Zotero.Prefs.set(SIDE_PREF, this.side, true);
      this.frame.contentWindow?.PTViewer?.setSide(this.side);
    }
    setVisible(visible) {
      this.visible = visible;
      this.panel.hidden = !visible; this.splitter.hidden = !visible;
      if (visible) { this.resize(this.width); this.frame.focus(); }
      else this.reader._iframe.focus();
      for (const node of this.reader._iframeWindow.document.querySelectorAll('.tidal-toggle')) {
        node.setAttribute('aria-pressed', String(visible));
      }
    }
    connect() {
      if (!this.jobID || !this.app.alive || this.destroyed || this.connectedJobID === this.jobID) return;
      clearTimeout(this.connectTimer);
      const viewer = this.frame.contentWindow?.PTViewer;
      // HTML iframe load delivery differs in Zotero's XUL windows. Also wait
      // here for the deferred script, rather than depending on load alone.
      if (!viewer || this.frame.contentDocument.readyState === 'loading') {
        if ((this.connectAttempts = (this.connectAttempts || 0) + 1) < 100) {
          this.connectTimer = setTimeout(() => this.connect(), 100);
        }
        return;
      }
      viewer.connect({ app: this.app, jobID: this.jobID, embedded: true,
        side: this.side, setSide: side => this.setSide(side), close: () => this.setVisible(false),
        locatePDF: index => this.locatePDF(index), setFollowing: value => { this.following = value; } });
      this.connectedJobID = this.jobID;
      this.connectAttempts = 0;
    }
    show(id) {
      if (this.jobID !== id) { this.jobID = id; this.connectAttempts = 0; }
      this.connect();
      this.setVisible(true);
    }
    pdfViews() {
      const internal = this.reader._internalReader;
      return [internal?._primaryView, internal?._secondaryView].filter(view => view?._iframeWindow?.PDFViewerApplication);
    }
    attachPDFViews() {
      for (const [doc, handlers] of this.pdfDocuments) {
        if (doc.defaultView?.closed || !this.pdfViews().some(view => view._iframeWindow.document === doc)) {
          doc.removeEventListener('pointerdown', handlers.down, true); doc.removeEventListener('click', handlers.click, true);
          this.pdfDocuments.delete(doc);
        }
      }
      for (const view of this.pdfViews()) {
        const doc = view._iframeWindow.document;
        if (this.pdfDocuments.has(doc)) continue;
        let down;
        const handlers = {
          down: event => { down = { x: event.clientX, y: event.clientY }; },
          click: event => {
            if (!this.visible || this.following === false || event.button !== 0 || event.detail > 1
              || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
              || (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4)
              || event.target.closest('a,button,input,textarea,[contenteditable="true"],.annotation')
              || doc.defaultView.getSelection()?.toString()) return;
            const tool = this.reader._internalReader?._state?.tool?.type;
            if (tool && tool !== 'pointer') return;
            const pageNode = event.target.closest('.page');
            const pdf = (view._iframeWindow.wrappedJSObject || view._iframeWindow).PDFViewerApplication;
            const pages = pdf.pdfViewer?._pages || [];
            const pageIndex = Number(pageNode?.getAttribute('data-page-number')) - 1;
            if (!Number.isInteger(pageIndex) || pageIndex < 0) return;
            const page = pages[pageIndex];
            if (!page?.pdfPage) return;
            const rect = page.div.getBoundingClientRect();
            const point = page.viewport.convertToPdfPoint(event.clientX - rect.left, event.clientY - rect.top);
            const intrinsic = intrinsicViewport(page, view._iframeWindow);
            const [x, y] = intrinsic.convertToViewportPoint(...point);
            this.app.guard(() => this.selectFromPDF(pageIndex, x / intrinsic.width, y / intrinsic.height));
          }
        };
        doc.addEventListener('pointerdown', handlers.down, true, true); doc.addEventListener('click', handlers.click, true, true);
        this.pdfDocuments.set(doc, handlers);
      }
    }
    async selectFromPDF(pageIndex, x, y) {
      const job = this.app.getJob(this.jobID), owner = this.jobID;
      const block = root.PTAnchors.hitTest(job?.sourceMap, pageIndex, x, y);
      if (!block) return false;
      const index = root.PTAnchors.chunkForBlock(job.chunks, block.id);
      if (index < 0) return false;
      await this.app.verifySource(job);
      if (this.destroyed || this.jobID !== owner) return false;
      this.frame.contentWindow.PTViewer?.selectParagraph(index, block.pageIndex);
      return true;
    }
    async locatePDF(index) {
      const job = this.app.getJob(this.jobID), owner = this.jobID, serial = this.navigationSerial = (this.navigationSerial || 0) + 1;
      const block = job?.chunks[index]?.locations?.[0];
      if (!block) throw new Error('这一段没有可靠的 PDF 坐标。');
      await this.app.verifySource(job);
      const internal = this.reader._internalReader;
      const view = internal._lastView || internal._primaryView;
      const pdfWindow = view?._iframeWindow;
      const pdf = (pdfWindow?.wrappedJSObject || pdfWindow)?.PDFViewerApplication;
      if (!pdf?.pdfDocument) throw new Error('PDF 阅读器尚未就绪。');
      const pageView = pdf.pdfViewer.getPageView(block.pageIndex);
      if (!pageView) throw new Error('段落页码超出当前 PDF 范围。');
      // Use the page proxy retained by PDF.js. Promise results from getPage()
      // can lose their class prototype across Zotero's compartments.
      if (!pageView.pdfPage) {
        await this.reader.navigate({ pageIndex: block.pageIndex });
        for (let i = 0; !pageView.pdfPage && i < 100 && !this.destroyed; i++) await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!pageView.pdfPage) throw new Error('PDF 页面的坐标信息尚未加载，请稍后重试。');
      if (this.destroyed || this.jobID !== owner || serial !== this.navigationSerial) return;
      const position = root.PTAnchors.pdfPosition(block, intrinsicViewport(pageView, pdfWindow));
      await this.reader.navigate({ position });
      return position;
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      clearTimeout(this.connectTimer);
      this.doc.defaultView.clearInterval(this.pollPDFViews);
      for (const [doc, handlers] of this.pdfDocuments) {
        doc.removeEventListener('pointerdown', handlers.down, true); doc.removeEventListener('click', handlers.click, true);
      }
      this.pdfDocuments.clear();
      this.frame.contentWindow?.PTViewer?.disconnect();
      this.doc.defaultView.removeEventListener('resize', this.onResize);
      this.reader._iframeWindow?.removeEventListener('unload', this.onUnload);
      this.panel.remove(); this.splitter.remove(); this.styles.remove();
      this.parent.classList.remove('pt-reader-layout');
      this.app.readerPanes.delete(this.reader);
    }
  }

  async function open(app, id, preferredReader) {
    const job = app.getJob(id);
    if (!job) throw new Error('翻译任务不存在，请从 PDF 重新打开。');
    let reader = preferredReader || await Zotero.Reader.open(job.attachmentID);
    // Zotero can return undefined while activating a previously unloaded tab.
    for (let attempt = 0; !reader && attempt < 100 && app.alive; attempt++) {
      const tabID = Zotero.getMainWindow()?.Zotero_Tabs?.selectedID;
      const candidate = Zotero.Reader.getByTabID(tabID);
      if (candidate?.itemID === job.attachmentID) reader = candidate;
      if (!reader) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!app.alive) return;
    if (!reader) throw new Error('Zotero 阅读器尚未就绪，请重新打开 PDF 后重试。');
    await reader._initPromise;
    if (!app.alive || !reader._iframe?.isConnected) return;
    let pane = app.readerPanes.get(reader);
    if (!pane) { pane = new Drawer(app, reader); app.readerPanes.set(reader, pane); }
    attachToolbarButton(app, reader);
    pane.show(id);
    return pane;
  }
  root.PTReaderPane = { open, Drawer, addToolbarButton, attachToolbarButton };
})(typeof globalThis !== 'undefined' ? globalThis : this);
