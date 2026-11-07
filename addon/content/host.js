/* global Zotero, Services, IOUtils, PathUtils, Cc, Ci, ChromeUtils, PTCore */
(function (root) {
  'use strict';
  // Retain the installed identity, credentials and cache keys across the Tidal rename.
  const PREF = 'extensions.paper-translator.config';
  const DEEPSEEK_DEFAULTS_PREF = 'extensions.paper-translator.deepseekDefaultsApplied';
  const LOGIN_HOST = 'chrome://paper-translator';
  const ACTIVE = new Set(['queued', 'parsing', 'translating']);
  const JOB_STATES = new Set(['queued', 'parsing', 'translating', 'partial', 'complete', 'cancelled', 'error']);
  const TEST_TEXT = 'This is a translation connection test.';
  const LIMIT = { pdf: 200 * 1024 ** 2, zip: 256 * 1024 ** 2, images: 80 * 1024 ** 2, entries: 5000 };
  const URI = 'chrome://tidal/content/';

  function aborted() { const e = new Error('任务已取消'); e.name = 'AbortError'; return e; }
  function check(signal) { if (signal?.aborted) throw aborted(); }
  class Cancellation {
    constructor() {
      this.listeners = new Set();
      this.signal = { aborted: false,
        addEventListener: (type, cb) => { if (type === 'abort') this.listeners.add(cb); },
        removeEventListener: (type, cb) => { if (type === 'abort') this.listeners.delete(cb); } };
    }
    abort() {
      if (this.signal.aborted) return;
      this.signal.aborted = true;
      for (const fn of this.listeners) { try { fn(); } catch (_) {} }
      this.listeners.clear();
    }
  }
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      check(signal);
      const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(aborted()); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
      signal?.addEventListener('abort', cancel);
    });
  }
  function secureURL(value, allowLocal = true) {
    const u = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if ((u.protocol !== 'https:' && !(allowLocal && local && u.protocol === 'http:')) || u.username || u.password || u.hash) {
      throw new Error('服务链接必须使用 HTTPS；本机服务可使用 HTTP。链接不能含用户名、密码或片段。');
    }
    return u.href;
  }

  function mineruDownloadFallback(value) {
    const url = new URL(secureURL(value, false));
    // MinerU's documented OSS bucket serves the same result objects as its
    // CDN. Never rewrite custom providers, signed links or unrelated paths.
    if (url.hostname !== 'cdn-mineru.openxlab.org.cn' || url.port || url.search
      || !/^\/pdf\/[\w/-]+\.zip$/.test(url.pathname)) return null;
    url.hostname = 'mineru.oss-cn-shanghai.aliyuncs.com';
    return url.href;
  }

  // Native privileged XHR avoids browser CORS and does not log API keys, signed URLs or paper text.
  function request(method, url, options = {}) {
    return new Promise((resolve, reject) => {
      check(options.signal);
      secureURL(url);
      const xhr = new XMLHttpRequest({ mozAnon: true });
      let finished = false;
      let deniedRedirect = false;
      const cleanup = () => options.signal?.removeEventListener('abort', cancel);
      const done = (fn, value) => { if (!finished) { finished = true; cleanup(); fn(value); } };
      const networkError = (message, name = 'NetworkError') => {
        const e = new Error(message); e.name = name; e.retryable = name !== 'RedirectError'; return e;
      };
      const cancel = () => { done(reject, aborted()); try { xhr.abort(); } catch (_) {} };
      try {
        xhr.mozBackgroundRequest = true;
        xhr.open(method, url, true);
        xhr.timeout = options.timeout || 120000;
        xhr.responseType = options.responseType || 'json';
        const credentials = Object.keys(options.headers || {}).some(k => k.toLowerCase() === 'authorization');
        // Reject redirects for authenticated requests and signed uploads. Never forward credentials.
        const previous = xhr.channel.notificationCallbacks;
        const callbacks = {
          QueryInterface: ChromeUtils.generateQI(['nsIInterfaceRequestor', 'nsIChannelEventSink']),
          getInterface(iid) {
            if (iid.equals(Ci.nsIChannelEventSink)) return this;
            if (previous) return previous.getInterface(iid);
            throw Components.results.NS_ERROR_NO_INTERFACE;
          },
          asyncOnChannelRedirect(oldChannel, newChannel, flags, callback) {
            try {
              const internal = Boolean(flags & Ci.nsIChannelEventSink.REDIRECT_INTERNAL);
              secureURL(newChannel.URI.spec);
              const before = new URL(oldChannel.URI.spec), after = new URL(newChannel.URI.spec);
              if ((credentials && before.origin !== after.origin) || (before.protocol === 'https:' && after.protocol !== 'https:')) throw new Error('redirect');
              if (!internal && (credentials || method !== 'GET')) throw new Error('redirect');
              callback.onRedirectVerifyCallback(Components.results.NS_OK);
            } catch (_) {
              deniedRedirect = true;
              callback.onRedirectVerifyCallback(Components.results.NS_ERROR_ABORT);
            }
          }
        };
        xhr.channel.notificationCallbacks = callbacks;
        for (const [name, value] of Object.entries(options.headers || {})) xhr.setRequestHeader(name, value);
        xhr.onload = () => {
          if (deniedRedirect) return done(reject, networkError('接口发生重定向，请在设置中填写最终服务地址。', 'RedirectError'));
          const headers = {};
          for (const name of ['retry-after', 'content-type']) headers[name] = xhr.getResponseHeader(name) || '';
          done(resolve, { status: xhr.status, data: xhr.response, headers });
        };
        xhr.onerror = () => {
          let detail = '';
          try {
            const code = xhr.channel.securityInfo?.errorCodeString;
            if (/^[A-Z][A-Z0-9_]{2,80}$/.test(code || '')) detail = `（${code}）`;
          } catch (_) {}
          done(reject, networkError(deniedRedirect ? '接口发生重定向，请填写最终服务地址。'
            : `网络连接失败${detail}，请检查服务地址、网络和系统代理。`, deniedRedirect ? 'RedirectError' : 'NetworkError'));
        };
        xhr.ontimeout = () => done(reject, networkError('网络请求超时，可继续重试未完成部分。', 'TimeoutError'));
        xhr.onabort = () => done(reject, options.signal?.aborted ? aborted() : deniedRedirect
          ? networkError('接口发生重定向，请填写最终服务地址。', 'RedirectError') : networkError('请求中断。'));
        xhr.onprogress = event => {
          if (event.loaded > (options.maxBytes || LIMIT.zip)) {
            const e = new Error('服务响应超过插件允许的大小。');
            e.retryable = false; done(reject, e); xhr.abort();
          }
        };
        options.signal?.addEventListener('abort', cancel);
        check(options.signal);
        // ArrayBuffer uploads intentionally have no Content-Type or Authorization header.
        xhr.send(options.body === undefined ? null : options.body);
      } catch (_) {
        done(reject, options.signal?.aborted ? aborted() : networkError('无法发起请求，请检查服务地址和 Zotero 网络环境。'));
      }
    });
  }

  function ok(response, label) {
    if (response.status < 200 || response.status >= 300) {
      const e = new Error(`${label}失败：HTTP ${response.status}。${response.status === 401 || response.status === 403 ? '请检查凭证、地域和服务权限。' : '请检查服务状态后重试。'}`);
      e.status = response.status; e.retryable = response.status === 429 || response.status >= 500; throw e;
    }
    return response.data;
  }
  function minerData(response, label) {
    const data = ok(response, label);
    if (!data || data.code !== 0 || !data.data) {
      const code = /^[\w.-]{1,40}$/.test(String(data?.code)) ? String(data.code) : 'unknown';
      throw new Error(`${label}失败，MinerU 业务代码 ${code}。请检查 Token、额度及文件限制。`);
    }
    return data.data;
  }
  async function digest(value) {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(hash, b => b.toString(16).padStart(2, '0')).join('');
  }
  async function readJSON(path) {
    if (!(await IOUtils.exists(path))) return null;
    return JSON.parse(await IOUtils.readUTF8(path));
  }
  async function writeJSON(path, value) {
    await IOUtils.makeDirectory(PathUtils.parent(path), { ignoreExisting: true, createAncestors: true });
    await IOUtils.writeUTF8(path, JSON.stringify(value), { tmpPath: path + '.tmp' });
  }
  function plainJob(job) {
    const out = {};
    for (const key of Object.keys(job)) {
      if (!key.startsWith('_') && !['images', 'sourceMap'].includes(key)) out[key] = job[key];
    }
    out.chunks = job.chunks.map(({ locations, ...chunk }) => chunk);
    return out;
  }
  function safeMessage(error) {
    const text = String(error?.message || '操作失败');
    return text.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').replace(/\bsk-[\w-]+/g, '[已隐藏]')
      .replace(/https?:\/\/\S+/g, '[服务地址]').slice(0, 400);
  }
  function imageMime(bytes) {
    if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return 'image/png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 56) return 'image/gif';
    if (bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return 'image/webp';
    return null;
  }
  function dataURL(bytes, mime) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return `data:${mime};base64,${btoa(binary)}`;
  }
  function relativeTo(directory, file) {
    const a = directory ? directory.split('/') : [], b = file.split('/');
    while (a.length && b.length && a[0] === b[0]) { a.shift(); b.shift(); }
    return '../'.repeat(a.length) + b.join('/');
  }

  function validateSavedJob(data, id) {
    const valid = data && typeof data === 'object' && !Array.isArray(data)
      && data.schema === 1 && data.id === id && /^[a-f0-9]{64}$/.test(id)
      && Number.isInteger(data.libraryID) && data.libraryID > 0
      && typeof data.attachmentKey === 'string' && data.attachmentKey.length > 0
      && typeof data.createdAt === 'string' && Number.isFinite(Date.parse(data.createdAt))
      && typeof data.title === 'string' && typeof data.targetLang === 'string'
      && typeof data.model === 'string' && ['pdf', 'selection'].includes(data.type)
      && JOB_STATES.has(data.status) && typeof data.originalMd === 'string'
      && data.config && typeof data.config === 'object' && !Array.isArray(data.config)
      && Array.isArray(data.chunks) && data.chunks.every(chunk => chunk && typeof chunk === 'object'
        && typeof chunk.source === 'string' && Number.isInteger(chunk.index) && chunk.index >= 0
        && ['pending', 'done', 'skipped', 'error'].includes(chunk.status)
        && (chunk.translated == null || typeof chunk.translated === 'string')
        && (chunk.skipTranslation === undefined || typeof chunk.skipTranslation === 'boolean')
        && (chunk.status !== 'done' || (typeof chunk.translated === 'string'
          && (chunk.translated.trim() || !chunk.source.trim()))))
      && (data.type !== 'pdf' || (/^[a-f0-9]{64}$/.test(data.fileHash) && /^[a-f0-9]{64}$/.test(data.parseKey)));
    if (!valid) throw new Error('任务缓存格式不兼容或已损坏。请在任务与历史中手动删除该记录后重试。');
    for (const name of ['logs', 'outputItemIDs']) {
      if (data[name] === undefined) data[name] = [];
      if (!Array.isArray(data[name])) throw new Error('任务缓存格式不兼容或已损坏。');
    }
    for (const name of ['outputs', 'outputKeys']) {
      if (data[name] === undefined) data[name] = {};
      if (!data[name] || typeof data[name] !== 'object' || Array.isArray(data[name])) {
        throw new Error('任务缓存格式不兼容或已损坏。');
      }
    }
    if (!data.logs.every(log => log && typeof log.time === 'string' && typeof log.message === 'string')
      || !data.outputItemIDs.every(value => Number.isInteger(value) && value > 0)
      || (data.status === 'complete' && data.chunks.some(chunk => !['done', 'skipped'].includes(chunk.status)))) {
      throw new Error('任务缓存格式不兼容或已损坏。');
    }
    data.config = PTCore.normalizeConfig(data.config);
    return data;
  }

  class Application {
    constructor({ id, version }) {
      this.id = id; this.version = version;
      this.jobs = new Map(); this.subscribers = new Map(); this.windows = new Map();
      this.restoring = new Map(); this.connectionTest = null; this.settingsSave = null;
      this.settingsWindow = null; this.readerNodes = new Set();
      this.readerPanes = new Map();
      this.historyQueue = Promise.resolve(); this.startingSources = new Map(); this.deleting = new Set(); this.historyWindow = null;
      this.compacting = new Map(); this.processCleanup = null;
      this.writeClipboard = value => Cc['@mozilla.org/widget/clipboardhelper;1'].getService(Ci.nsIClipboardHelper).copyString(value);
      this.queue = Promise.resolve(); this.alive = true; this.request = request;
    }
    async init() {
      this.migrateDefaultService();
      this.cacheRoot = PathUtils.join(Zotero.DataDirectory.dir, 'paper-translator');
      await IOUtils.makeDirectory(this.cacheRoot, { ignoreExisting: true, createAncestors: true, permissions: 0o700 });
      this.translator = PTCore.createTranslator({ request: (...args) => this.request(...args), sleep });
      this.readerHandler = event => {
        const { reader, doc, params, append } = event;
        const text = params?.annotation?.text;
        if (!text || !this.alive) return;
        const button = doc.createElement('button');
        button.textContent = '翻译选区'; button.title = '使用 Tidal 翻译选中文本';
        button.className = 'tidal-selection';
        button.style.cssText = 'margin:4px;padding:5px 9px;border:1px solid #bdc7d5;border-radius:5px;cursor:pointer';
        button.addEventListener('click', async () => {
          if (button.disabled) return;
          button.disabled = true;
          try { await this.guard(() => this.startSelection(reader.itemID, text, reader)); }
          finally { button.disabled = false; }
        });
        append(button);
        for (const node of this.readerNodes) if (!node.isConnected) this.readerNodes.delete(node);
        this.readerNodes.add(button);
      };
      Zotero.Reader.registerEventListener('renderTextSelectionPopup', this.readerHandler, this.id);
      this.readerToolbarHandler = event => root.PTReaderPane?.addToolbarButton(this, event);
      Zotero.Reader.registerEventListener('renderToolbar', this.readerToolbarHandler, this.id);
      for (const reader of Zotero.Reader._readers || []) root.PTReaderPane?.attachToolbarButton(this, reader);
      this.paneID = await Zotero.PreferencePanes.register({ pluginID: this.id, id: 'tidal',
        label: 'Tidal', image: URI + 'icons/icon-96.png', src: URI + 'preferences.xhtml' });
    }
    migrateDefaultService() {
      if (Zotero.Prefs.get(DEEPSEEK_DEFAULTS_PREF, true) === true) return false;
      let saved = {};
      try { saved = JSON.parse(Zotero.Prefs.get(PREF, true) || '{}'); } catch (_) {}
      let isLegacyDefault = false;
      if (saved && typeof saved === 'object' && saved.provider === 'qwen-mt' && saved.model === 'qwen-mt-turbo') {
        try {
          isLegacyDefault = PTCore.chatURL(saved.serviceBase)
            === 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
        } catch (_) {}
      }
      if (isLegacyDefault) {
        const next = PTCore.normalizeConfig({ ...saved, provider: PTCore.DEFAULTS.provider,
          serviceBase: PTCore.DEFAULTS.serviceBase, model: PTCore.DEFAULTS.model });
        // Only current nonsecret settings change. Login realms and the config
        // snapshots of existing tasks remain bound to their original services.
        Zotero.Prefs.set(PREF, JSON.stringify(next), true);
      }
      Zotero.Prefs.set(DEEPSEEK_DEFAULTS_PREF, true, true);
      return isLegacyDefault;
    }
    getConfig() {
      let saved = {};
      try { saved = JSON.parse(Zotero.Prefs.get(PREF, true) || '{}'); } catch (_) {}
      return PTCore.normalizeConfig({ ...PTCore.DEFAULTS, ...saved });
    }
    async getSecret(kind, base) {
      const matches = await Services.logins.findLogins(LOGIN_HOST, null, `${kind}:${base}`);
      return matches[0]?.password || '';
    }
    async putSecret(kind, base, value, clear = false) {
      if (!value && !clear) return;
      const realm = `${kind}:${base}`;
      const matches = await Services.logins.findLogins(LOGIN_HOST, null, realm);
      if (clear) {
        for (const old of matches) Services.logins.removeLogin(old);
        return;
      }
      const info = Cc['@mozilla.org/login-manager/loginInfo;1'].createInstance(Ci.nsILoginInfo);
      info.init(LOGIN_HOST, null, realm, kind, value, '', '');
      if (matches.length) {
        Services.logins.modifyLogin(matches[0], info);
        for (const old of matches.slice(1)) Services.logins.removeLogin(old);
      } else if (Services.logins.addLoginAsync) await Services.logins.addLoginAsync(info);
      else Services.logins.addLogin(info);
    }
    async credentialStatus(config = this.getConfig()) {
      const mineruBase = PTCore.normalizeEndpoint(config.mineruBase, 'MinerU 地址');
      const serviceBase = PTCore.normalizeEndpoint(config.serviceBase, '翻译服务地址');
      return { mineru: Boolean(await this.getSecret('mineru', mineruBase)),
        translation: Boolean(await this.getSecret('translation', serviceBase)) };
    }
    saveSettings(input, secrets = {}) {
      if (!this.alive) return Promise.reject(new Error('插件已停用。'));
      if (this.settingsSave) return Promise.reject(new Error('设置正在保存，请稍候。'));
      const state = { promise: null };
      this.settingsSave = state;
      state.promise = (async () => {
        const config = PTCore.normalizeConfig(input);
        const changes = [
          { kind: 'mineru', base: config.mineruBase, value: (secrets.mineru || '').trim(), clear: Boolean(secrets.clearMineru) },
          { kind: 'translation', base: config.serviceBase, value: (secrets.translation || '').trim(), clear: Boolean(secrets.clearTranslation) }
        ].filter(change => change.value || change.clear);
        // Read every backup before changing either service. A failure in the
        // second credential or preferences must not silently leave half a save.
        for (const change of changes) change.previous = await this.getSecret(change.kind, change.base);
        const previous = Zotero.Prefs.get(PREF, true);
        const touched = [];
        let preferenceTouched = false;
        try {
          for (const change of changes) {
            touched.push(change);
            await this.putSecret(change.kind, change.base, change.value, change.clear);
          }
          // normalizeConfig excludes credentials and arbitrary properties.
          preferenceTouched = true;
          Zotero.Prefs.set(PREF, JSON.stringify(config), true);
          for (const pane of this.readerPanes.values()) {
            try { pane.frame.contentWindow?.PTViewer?.setAppearance(config); } catch (_) {}
          }
          return config;
        } catch (_) {
          let rollbackFailed = false;
          for (const change of touched.reverse()) {
            try { await this.putSecret(change.kind, change.base, change.previous, !change.previous); }
            catch (_) { rollbackFailed = true; }
          }
          if (preferenceTouched) {
            try {
              if (previous === undefined && typeof Zotero.Prefs.clear === 'function') Zotero.Prefs.clear(PREF, true);
              else Zotero.Prefs.set(PREF, previous === undefined ? '' : previous, true);
            } catch (_) { rollbackFailed = true; }
          }
          throw new Error(rollbackFailed
            ? '设置未能完整保存，部分配置或凭证未能恢复。请重新打开设置核对后重试。'
            : '设置保存失败，已恢复原配置和凭证。请重试。');
        }
      })().finally(() => { if (this.settingsSave === state) this.settingsSave = null; });
      return state.promise;
    }
    testTranslation(input, secrets = {}) {
      if (!this.alive) return Promise.reject(new Error('插件已停用。'));
      if (this.connectionTest) return Promise.reject(new Error('连接测试正在进行，请等待当前测试结束。'));
      const state = { controller: new Cancellation(), promise: null };
      this.connectionTest = state;
      state.promise = (async () => {
        const config = PTCore.normalizeConfig(input);
        const key = secrets.clearTranslation ? '' : (secrets.translation || '').trim()
          || await this.getSecret('translation', config.serviceBase);
        check(state.controller.signal);
        // Only an explicit settings action sends this fixed short text. No
        // preferences, credentials or task/cache records are written by a test.
        const started = Date.now();
        const result = await this.translator.translate(TEST_TEXT,
          { ...config, maxRetries: 0, timeout: Math.min(config.timeout, 30000) }, key,
          { signal: state.controller.signal });
        check(state.controller.signal);
        return { translation: result.text, model: config.model, elapsedMs: Date.now() - started };
      })().finally(() => { if (this.connectionTest === state) this.connectionTest = null; });
      return state.promise;
    }
    openSettings() {
      if (this.settingsWindow && !this.settingsWindow.closed) return this.settingsWindow.focus();
      const args = { app: this };
      this.settingsWindow = Zotero.getMainWindow().openDialog(URI + 'settings.xhtml?v=' + encodeURIComponent(this.version), 'tidal-settings',
        'chrome,centerscreen,resizable,dialog=no,width=960,height=840', { wrappedJSObject: args });
    }
    openExternal(url) {
      const parsed = new URL(url);
      if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) throw new Error('不支持的链接。');
      Zotero.launchURL(parsed.href);
    }
    alert(message) { Services.prompt.alert(Zotero.getMainWindow(), 'Tidal · 论文翻译', message); }
    async guard(fn) { try { return await fn(); } catch (error) { this.alert(safeMessage(error)); } }
    attachWindow(window) {
      if (this.windows.has(window) || !this.alive) return false;
      // A main window can exist before its menu DOM. Do not cache a failed
      // mounting attempt, otherwise the later main-window hook skips it.
      if (!window.document.getElementById('zotero-itemmenu') || !window.document.getElementById('menu_ToolsPopup')) return false;
      const doc = window.document, elements = [], listeners = [];
      const add = (parentID, label, command, id) => {
        const parent = doc.getElementById(parentID); if (!parent) return null;
        const node = doc.createXULElement('menuitem');
        node.id = id; node.setAttribute('label', label);
        const handler = () => this.guard(command);
        node.addEventListener('command', handler); parent.appendChild(node);
        elements.push(node); listeners.push([node, 'command', handler]); return node;
      };
      const context = add('zotero-itemmenu', '翻译论文 PDF…', () => this.startSelected(window), 'tidal-item-menu');
      const update = () => {
        const selected = window.ZoteroPane.getSelectedItems();
        if (context) context.hidden = !selected.some(item => item.isRegularItem() || this.isPDF(item));
      };
      const popup = doc.getElementById('zotero-itemmenu');
      if (popup) { popup.addEventListener('popupshowing', update); listeners.push([popup, 'popupshowing', update]); }
      add('menu_ToolsPopup', 'Tidal：翻译选中 PDF…', () => this.startSelected(window), 'tidal-tools-start');
      add('menu_ToolsPopup', 'Tidal：任务与历史…', () => this.showHistory(), 'tidal-tools-history');
      add('menu_ToolsPopup', 'Tidal：设置…', () => this.openSettings(), 'tidal-tools-settings');
      this.windows.set(window, { elements, listeners });
      return true;
    }
    detachWindow(window) {
      const state = this.windows.get(window); if (!state) return;
      for (const [node, type, listener] of state.listeners) node.removeEventListener(type, listener);
      for (const node of state.elements) node.remove();
      this.windows.delete(window);
    }
    isPDF(item) {
      return Boolean(item?.isAttachment() && !item.deleted && (item.attachmentContentType === 'application/pdf' || /\.pdf$/i.test(item.attachmentFilename || '')));
    }
    async resolveAttachment(item) {
      if (this.isPDF(item)) return item;
      if (!item?.isRegularItem()) throw new Error('请选择文献条目或 PDF 附件。');
      const attachments = Zotero.Items.get(item.getAttachments()).filter(file => this.isPDF(file));
      if (!attachments.length) throw new Error('该条目没有 PDF 附件。请先添加并下载 PDF。');
      if (attachments.length === 1) return attachments[0];
      const choice = { value: 0 };
      const accepted = Services.prompt.select(Zotero.getMainWindow(), '选择需要翻译的 PDF', item.getField('title'),
        attachments.map(file => file.attachmentFilename || file.getField('title')), choice);
      return accepted ? attachments[choice.value] : null;
    }
    async startSelected(window) {
      const items = window.ZoteroPane.getSelectedItems();
      if (!items.length) throw new Error('请先选择文献条目或 PDF 附件。');
      const visited = new Set();
      for (const item of items) {
        const attachment = await this.resolveAttachment(item);
        if (!attachment || visited.has(attachment.id)) continue;
        visited.add(attachment.id);
        await this.startAttachment(attachment);
      }
    }
    async sourceBytes(attachment) {
      const path = await attachment.getFilePathAsync();
      if (!path || !(await IOUtils.exists(path))) throw new Error('PDF 尚未下载或链接文件已移动。请先在 Zotero 中打开该附件，再启动翻译。');
      const stat = await IOUtils.stat(path);
      if (stat.size > LIMIT.pdf) throw new Error('PDF 超过 200 MB。请先拆分文件。MinerU 的页数限制还需在服务端检查。');
      const bytes = await IOUtils.read(path);
      if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-')) throw new Error('附件内容不是有效的 PDF 文件。');
      return bytes;
    }
    async startAttachment(attachment, reader) {
      if (!this.alive) throw new Error('插件已停用。');
      const bytes = await this.sourceBytes(attachment), config = this.getConfig();
      const fileHash = await digest(bytes);
      const id = await digest(`${attachment.libraryID}:${attachment.key}:${fileHash}:${PTCore.fingerprintConfig(config)}:pdf-v2-paragraphs`);
      const result = await this.sourceJob(`pdf:${attachment.libraryID}:${attachment.key}:${fileHash}`, async () => {
        const existing = await this.cachedSource(id, record => record.type === 'pdf' && record.libraryID === attachment.libraryID
          && record.attachmentKey === attachment.key && record.fileHash === fileHash);
        if (existing) return { job: existing, created: false };
        const parseKey = await digest(JSON.stringify({ fileHash, endpoint: config.mineruBase, model: config.mineruModel, language: config.parseLanguage, v: 1 }));
        return { job: this.newJob(id, attachment, config, { type: 'pdf', fileHash, parseKey, chunkMode: 'paragraphs-v1',
          filename: attachment.attachmentFilename || 'paper.pdf' }), created: true };
      });
      const { job, created } = result;
      return this.openSourceJob(job, created, reader);
    }
    async startSelection(attachmentID, text, reader) {
      if (!this.alive) throw new Error('插件已停用。');
      if (typeof text !== 'string' || !text.trim()) throw new Error('请先在阅读器中选中需要翻译的文字。');
      const attachment = Zotero.Items.get(attachmentID);
      if (!attachment) throw new Error('无法定位当前阅读器附件。');
      const config = this.getConfig();
      const id = await digest(`${attachment.libraryID}:${attachment.key}:${text}:${PTCore.fingerprintConfig(config)}:selection-v1`);
      const selectionHash = await digest(text);
      const { job, created } = await this.sourceJob(`selection:${attachment.libraryID}:${attachment.key}:${selectionHash}`, async () => {
        const existing = await this.cachedSource(id, record => record.type === 'selection' && record.libraryID === attachment.libraryID
          && record.attachmentKey === attachment.key && record.originalMd === text);
        return existing ? { job: existing, created: false } : { job: this.newJob(id, attachment, config, { type: 'selection', originalMd: text,
          title: `${attachment.getField('title') || '论文'} · 选区翻译` }), created: true };
      });
      return this.openSourceJob(job, created, reader);
    }
    async openSourceJob(job, created, reader) {
      if (!this.alive) throw new Error('插件已停用。');
      try { await this.openViewer(job.id, reader); }
      catch (error) {
        if (created && !job._runPromise && job.status === 'queued') {
          await this.update(job, { status: 'error', message: '阅读器未能打开，翻译尚未自动启动。可打开历史后手动继续。' });
        }
        throw error;
      }
      if (created && job.status !== 'complete' && !job._runPromise) this.resume(job.id);
      return job;
    }
    newJob(id, attachment, config, extra) {
      if (!this.alive) throw new Error('插件已停用。');
      if (this.deleting.has(id)) throw new Error('记录正在删除，请稍后重试。');
      // Restore can finish for two callers before either creates the job. The
      // synchronous map check makes both entry points use the same live object.
      if (this.jobs.has(id)) return this.jobs.get(id);
      const parent = attachment.parentID ? Zotero.Items.get(attachment.parentID) : null;
      const job = { schema: 1, id, attachmentID: attachment.id, attachmentKey: attachment.key, libraryID: attachment.libraryID,
        title: parent?.getField('title') || attachment.getField('title') || '论文翻译', config,
        targetLang: config.targetLang, model: config.model, createdAt: new Date().toISOString(),
        status: 'queued', message: '等待开始', progress: 0, originalMd: '', chunks: [], images: {},
        outputItemIDs: [], outputs: {}, outputKeys: {}, logs: [], ...extra };
      this.jobs.set(id, job); return job;
    }
    jobPath(id) {
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('无效任务编号。');
      return PathUtils.join(this.cacheRoot, 'jobs', id + '.json');
    }
    async restore(id) {
      if (!this.alive) throw new Error('插件已停用。');
      if (this.deleting.has(id)) throw new Error('记录正在删除。');
      if (this.jobs.has(id)) return this.jobs.get(id);
      if (this.restoring.has(id)) return this.restoring.get(id);
      const pending = (async () => {
        const data = await readJSON(this.jobPath(id));
        if (this.jobs.has(id)) return this.jobs.get(id);
        if (!data) return null;
        validateSavedJob(data, id);
        // Resolve the item by stable library/key, never trust a reused numeric item id.
        const attachment = await Zotero.Items.getByLibraryAndKeyAsync(data.libraryID, data.attachmentKey);
        if (!attachment || attachment.deleted) throw new Error('原 PDF 条目已移除，无法恢复该任务。');
        data.attachmentID = attachment.id; data.images = {};
        if (ACTIVE.has(data.status)) { data.status = 'cancelled'; data.message = '上次任务未完成，可从已保存分块继续。'; }
        if (data.parseKey && data.originalMd) await this.loadParsedImages(data);
        if (!this.alive || this.deleting.has(id)) throw new Error('任务已关闭或正在删除。');
        // A live task created while disk/images were loading always wins.
        if (this.jobs.has(id)) return this.jobs.get(id);
        this.jobs.set(id, data);
        return data;
      })();
      this.restoring.set(id, pending);
      try { return await pending; }
      finally { if (this.restoring.get(id) === pending) this.restoring.delete(id); }
    }
    getJob(id) { return this.jobs.get(id); }
    subscribe(id, callback) {
      if (!this.subscribers.has(id)) this.subscribers.set(id, new Set());
      this.subscribers.get(id).add(callback);
      return () => this.subscribers.get(id)?.delete(callback);
    }
    emit(job) {
      for (const callback of this.subscribers.get(job.id) || []) {
        try { callback(job); } catch (_) { /* A closed viewer must not stop a translation. */ }
      }
    }
    persist(job) {
      if (this.deleting.has(job.id) || this.jobs.get(job.id) !== job) return Promise.reject(new Error('该历史记录已关闭或删除，未写入缓存。'));
      const data = plainJob(job);
      // Capture now, then serialize writes so simultaneous workers cannot overwrite newer progress.
      const snapshot = JSON.parse(JSON.stringify(data));
      const pending = (job._savePromise || Promise.resolve()).catch(() => {}).then(() => {
        if (this.jobs.get(job.id) !== job) throw new Error('历史记录已删除。');
        return writeJSON(this.jobPath(job.id), snapshot);
      });
      job._savePromise = pending; return pending;
    }
    async update(job, values) { Object.assign(job, values); this.emit(job); await this.persist(job); }
    log(job, message, level = 'info') {
      job.logs.push({ time: new Date().toISOString(), message, level });
      if (job.logs.length > 120) job.logs.shift(); this.emit(job);
    }
    async openViewer(id, reader) {
      if (!this.alive) return;
      return root.PTReaderPane.open(this, id, reader);
    }
    historyLock(callback) {
      const operation = this.historyQueue.catch(() => {}).then(() => {
        if (!this.alive) throw new Error('插件已停用。');
        return callback();
      });
      this.historyQueue = operation.catch(() => {});
      return operation;
    }
    sourceJob(key, factory) {
      if (this.startingSources.has(key)) return this.startingSources.get(key);
      const pending = this.historyLock(async () => {
        const result = await factory();
        if (result.created) {
          try { await this.persist(result.job); }
          catch (error) {
            result.job.status = 'error'; result.job.message = '本地缓存写入失败，翻译尚未启动。请检查磁盘后手动重试。';
            this.emit(result.job); throw error;
          }
        }
        return result;
      });
      this.startingSources.set(key, pending);
      const finish = () => { if (this.startingSources.get(key) === pending) this.startingSources.delete(key); };
      pending.then(finish, finish);
      return pending;
    }
    async scanHistory() {
      const folder = PathUtils.join(this.cacheRoot, 'jobs');
      const records = new Map(Array.from(this.jobs.values(), job => [job.id, job]));
      if (await IOUtils.exists(folder)) {
        for (const path of await IOUtils.getChildren(folder)) {
          const match = path.replace(/\\/g, '/').match(/\/([a-f0-9]{64})\.json$/);
          if (!match) continue;
          if (records.has(match[1])) continue;
          let raw;
          try {
            raw = await readJSON(path);
            if (!raw) throw new Error('空缓存');
            records.set(match[1], validateSavedJob(raw, match[1]));
          } catch (_) {
            records.set(match[1], { id: match[1], corrupt: true, status: 'corrupt', createdAt: '', chunks: [],
              title: typeof raw?.title === 'string' ? raw.title : '损坏的历史记录',
              type: raw?.type, libraryID: raw?.libraryID, attachmentKey: raw?.attachmentKey, fileHash: raw?.fileHash,
              originalMd: typeof raw?.originalMd === 'string' ? raw.originalMd : '' });
          }
        }
      }
      return [...records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    async cachedSource(preferredID, matches) {
      const records = await this.scanHistory();
      const candidates = records.filter(record => !record.corrupt && matches(record));
      const record = candidates.find(record => record.id === preferredID)
        || candidates.find(record => record.status === 'complete') || candidates[0];
      if (record) return this.jobs.get(record.id) || this.restore(record.id);
      if (records.some(record => record.id === preferredID || (record.corrupt && matches(record)))) {
        throw new Error('发现损坏或身份异常的历史缓存，已保留原文件。请在任务与历史中检查并手动删除后重试。');
      }
      return null;
    }
    historyMeta(record) {
      const live = this.jobs.get(record.id);
      const busy = Boolean(live && (live._runPromise || ACTIVE.has(live.status) || live._outputPromise || live._notePromise));
      return { id: record.id, title: record.title, type: record.type, createdAt: record.createdAt,
        targetLang: record.targetLang || '', model: record.model || '', corrupt: Boolean(record.corrupt),
        status: !live && ACTIVE.has(record.status) ? 'cancelled' : record.status,
        paragraphs: record.chunks.length, completed: record.chunks.filter(chunk => ['done', 'skipped'].includes(chunk.status)).length,
        canDelete: !busy, canCopyOriginal: !record.corrupt && Boolean(record.originalMd),
        canCopyTranslation: !record.corrupt && record.status === 'complete' && record.chunks.length > 0 };
    }
    listHistory() {
      return this.historyLock(async () => (await this.scanHistory()).map(record => this.historyMeta(record)));
    }
    async readHistoryRecord(id) {
      this.jobPath(id);
      if (this.deleting.has(id)) throw new Error('记录正在删除。');
      const live = this.jobs.get(id);
      if (live) return live;
      const record = await readJSON(this.jobPath(id));
      if (!record) throw new Error('该历史记录已删除。');
      return validateSavedJob(record, id);
    }
    historyDetails(id) {
      return this.historyLock(async () => {
        const record = await this.readHistoryRecord(id);
        return { ...this.historyMeta(record), originalMarkdown: record.originalMd,
          translatedMarkdown: record.status === 'complete' ? PTCore.markdownForCopy(record, 'translated') : '' };
      });
    }
    async copyMarkdown(id, side, indices = null) {
      const value = await this.historyLock(async () => PTCore.markdownForCopy(await this.readHistoryRecord(id), side, indices));
      await this.writeClipboard(value);
      return { characters: value.length };
    }
    getParagraphTools() { return Zotero.Prefs.get('extensions.paper-translator.paragraphTools', true) === true; }
    setParagraphTools(value) {
      if (typeof value !== 'boolean') throw new Error('段落工具选项无效。');
      Zotero.Prefs.set('extensions.paper-translator.paragraphTools', value, true);
      for (const pane of this.readerPanes.values()) {
        try { pane.frame.contentWindow?.PTViewer?.setToolsVisible(value); } catch (_) {}
      }
    }
    async openHistoryJob(id) {
      if (this.processCleanup) await this.processCleanup;
      const job = await this.restore(id);
      if (!job) throw new Error('该历史记录已删除。');
      await this.openViewer(id);
    }
    showHistory() {
      if (!this.alive) return;
      if (this.historyWindow && !this.historyWindow.closed) return this.historyWindow.focus();
      this.historyWindow = Zotero.getMainWindow().openDialog(URI + 'history.xhtml?v=' + encodeURIComponent(this.version), 'tidal-history',
        'chrome,centerscreen,resizable,dialog=no,width=1040,height=760', { wrappedJSObject: { app: this } });
      return this.historyWindow;
    }
    deleteHistory(id, { removeParsed = true } = {}) {
      this.jobPath(id);
      if (typeof removeParsed !== 'boolean') return Promise.reject(new Error('解析缓存删除选项无效。'));
      return this.historyLock(async () => {
        const records = await this.scanHistory(), record = records.find(record => record.id === id);
        if (!record) throw new Error('该历史记录已删除。');
        if (!this.historyMeta(record).canDelete) throw new Error('请先取消任务，等待运行或回存结束后再删除。');
        this.deleting.add(id);
        try {
          const live = this.jobs.get(id);
          await Promise.allSettled([live?._savePromise, this.restoring.get(id)].filter(Boolean));
          await IOUtils.remove(this.jobPath(id), { ignoreAbsent: true });
          this.jobs.delete(id);
          for (const pane of [...this.readerPanes.values()]) if (pane.jobID === id) pane.destroy();
          this.subscribers.delete(id);
          const warnings = [];
          try { await IOUtils.remove(PathUtils.join(this.cacheRoot, 'exports', id), { recursive: true, ignoreAbsent: true }); }
          catch (_) { warnings.push('本地导出缓存未能清理。'); }
          const shared = records.some(other => other.id !== id && (other.corrupt || other.parseKey === record.parseKey));
          let parsedRemoved = false;
          if (removeParsed && !record.corrupt && /^[a-f0-9]{64}$/.test(record.parseKey || '') && !shared) {
            try { await IOUtils.remove(this.parseDir(record), { recursive: true, ignoreAbsent: true }); parsedRemoved = true; }
            catch (_) { warnings.push('解析缓存未能清理。'); }
          }
          return { deleted: true, parsedRemoved, sharedParseKept: Boolean(removeParsed && record.parseKey && shared), warnings };
        } finally { this.deleting.delete(id); }
      });
    }
    resume(id) {
      if (this.processCleanup) return this.processCleanup.then(() => this.resume(id));
      const job = this.jobs.get(id); if (!job) return Promise.reject(new Error('任务不存在。'));
      if (this.deleting.has(id)) return Promise.reject(new Error('记录正在删除。'));
      if (job._runPromise) return job._runPromise;
      if (!this.alive) return Promise.reject(new Error('插件已停用。'));
      if (job.status === 'complete') return Promise.resolve(job);
      job._controller = new Cancellation();
      job.status = 'queued'; job.message = '任务已排队，文档依次处理。'; this.emit(job);
      const run = this.queue.catch(() => {}).then(() => this.run(job));
      job._runPromise = run.finally(() => { job._runPromise = null; job._controller = null; });
      this.queue = job._runPromise.catch(() => {});
      return job._runPromise;
    }
    cancel(id) {
      const job = this.jobs.get(id); if (!job) return;
      job._controller?.abort(); job.message = '正在取消；已完成分块会保留。'; this.emit(job);
    }
    async run(job) {
      const signal = job._controller.signal;
      try {
        check(signal);
        const key = await this.getSecret('translation', job.config.serviceBase);
        if (!key && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(job.config.serviceBase).hostname)) {
          throw new Error('尚未配置翻译 API Key。请打开设置，保存与服务地址对应的密钥后重试。');
        }
        if (job.type === 'pdf') {
          const attachment = this.sourceAttachment(job);
          const bytes = await this.sourceBytes(attachment); check(signal);
          if (await digest(bytes) !== job.fileHash) throw new Error('PDF 内容已发生变化。请从文献列表重新启动任务，避免将旧译文用于新文件。');
          if (!job.originalMd) await this.parse(job, bytes, signal);
        }
        check(signal);
        if (!job.chunks.length) {
          job.chunks = PTCore.chunkMarkdown(job.originalMd, { maxChars: job.config.chunkSize, skipReferences: job.config.skipReferences,
            paragraphs: job.chunkMode === 'paragraphs-v1', referenceMode: job.config.referenceMode,
            referenceRanges: job.sourceMap?.blocks || [] })
            .map(chunk => ({ ...chunk, translated: chunk.skipTranslation ? chunk.source : null, status: chunk.skipTranslation ? 'skipped' : 'pending', error: '' }));
          const retained = job.chunks.filter(chunk => chunk.skipTranslation).length;
          if (retained) this.log(job, `已识别并保留 ${retained} 段参考文献原文。`);
        }
        root.PTAnchors?.bindChunks(job.originalMd, job.chunks, job.sourceMap);
        await this.update(job, { status: 'translating', message: '正在翻译；每个成功分块都会保存。' });
        const pending = job.chunks.filter(chunk => !['done', 'skipped'].includes(chunk.status));
        const batches = [];
        for (const chunk of pending) {
          const last = batches.at(-1);
          if (job.chunkMode === 'paragraphs-v1' && last
            && last.reduce((n, c) => n + c.source.length + 60, 0) + chunk.source.length + 60 <= job.config.chunkSize) last.push(chunk);
          else batches.push([chunk]);
        }
        let cursor = 0;
        const worker = async () => {
          while (cursor < batches.length) {
            check(signal);
            const batch = batches[cursor++], chunk = batch[0];
            for (const part of batch) { part.status = 'pending'; part.error = ''; }
            try {
              const transport = batch.length > 1 ? PTCore.paragraphBatch(batch.map(c => c.source)) : null;
              const result = await this.translator.translate(transport ? transport.source : chunk.source, job.config, key, { signal, paragraphBatch: Boolean(transport),
                onRetry: () => this.log(job, `分块 ${chunk.index + 1} 暂时失败，正在重试。`, 'warning') });
              check(signal);
              const texts = transport ? transport.split(result.text) : [result.text];
              batch.forEach((part, index) => { part.translated = texts[index]; part.status = 'done'; part.usage = index === 0 ? result.usage || null : null; });
            } catch (error) {
              if (error.name === 'AbortError' || signal.aborted) throw aborted();
              for (const part of batch) { part.status = 'error'; part.translated = null; part.error = safeMessage(error); }
              this.log(job, `分块 ${chunk.index + 1}：${safeMessage(error)}`, 'error');
              // Invalid credentials or invalid request format should not be resent for every remaining chunk.
              if ([400, 401, 403, 404].includes(error.status)) cursor = batches.length;
            }
            const done = job.chunks.filter(c => ['done', 'skipped'].includes(c.status)).length;
            await this.update(job, { progress: Math.round(100 * done / job.chunks.length), message: `已完成 ${done} / ${job.chunks.length} 块` });
          }
        };
        // allSettled ensures no worker can write to a job after it has been reported cancelled.
        const workers = await Promise.allSettled(Array.from({ length: Math.min(job.config.concurrency, Math.max(1, batches.length)) }, worker));
        check(signal);
        const rejected = workers.find(result => result.status === 'rejected');
        if (rejected) throw rejected.reason;
        const incomplete = job.chunks.filter(c => !['done', 'skipped'].includes(c.status)).length;
        await this.update(job, { status: incomplete ? 'partial' : 'complete', progress: incomplete ? job.progress : 100,
          message: incomplete ? `${incomplete} 块未完成。点击“重试/继续”仅处理这些分块。` : '翻译完成，可保存双语 HTML、译文 Markdown 或笔记。' });
      } catch (error) {
        const cancelled = error.name === 'AbortError' || signal.aborted;
        job.status = cancelled ? 'cancelled' : 'error';
        job.message = cancelled ? '任务已取消；已完成分块保留，可继续。' : safeMessage(error);
        this.log(job, job.message, cancelled ? 'info' : 'error');
        this.emit(job);
        try { await this.persist(job); } catch (_) { job.message += ' 本地缓存写入失败，请检查磁盘。'; this.emit(job); }
      }
      return job;
    }
    parseDir(job) { return PathUtils.join(this.cacheRoot, 'parsed', job.parseKey); }
    async parse(job, bytes, signal) {
      const folder = this.parseDir(job), recordPath = PathUtils.join(folder, 'parsed.json');
      const parsed = await readJSON(recordPath);
      if (parsed && (job.chunkMode !== 'paragraphs-v1' || parsed.sourceMapPath || parsed.contentListPath || parsed.layoutPath)) {
        job.originalMd = await IOUtils.readUTF8(PathUtils.join(folder, ...PTCore.validateArchivePath(parsed.mdPath).split('/')));
        await this.loadParsedImages(job, parsed); this.log(job, '已复用本地 MinerU 解析结果。'); return;
      }
      if (parsed) this.log(job, '旧解析缓存缺少段落坐标，正在重新解析以启用段落定位。');
      const cfg = job.config, token = await this.getSecret('mineru', cfg.mineruBase);
      if (!token) throw new Error('尚未配置 MinerU Token。请在设置中保存 Token；仅选区翻译不需要 MinerU。');
      const headers = { Authorization: `Bearer ${token}` };
      const batchPath = PathUtils.join(folder, 'batch.json');
      let batch = await readJSON(batchPath);
      await this.update(job, { status: 'parsing', message: '准备解析 PDF…', progress: 2 });
      if (!batch?.uploaded || Date.now() - batch.created > 22 * 60 * 60 * 1000) {
        check(signal);
        const info = minerData(await this.request('POST', cfg.mineruBase.replace(/\/$/, '') + '/file-urls/batch', {
          headers: { ...headers, 'Content-Type': 'application/json' }, responseType: 'json', timeout: cfg.timeout, signal,
          body: JSON.stringify({ files: [{ name: job.filename, data_id: job.id }], model_version: cfg.mineruModel,
            enable_formula: true, enable_table: true, language: cfg.parseLanguage })
        }), '申请 PDF 上传');
        const raw = info.file_urls?.[0], url = typeof raw === 'string' ? raw : raw?.url || raw?.put_url || raw?.file_url;
        if (!url || !info.batch_id) throw new Error('MinerU 未返回有效的上传链接或任务编号。');
        secureURL(url, false);
        await this.update(job, { message: '正在上传 PDF 到你配置的 MinerU 服务…', progress: 8 });
        ok(await this.request('PUT', url, { body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          responseType: 'text', timeout: Math.max(cfg.timeout, 600000), signal }), 'PDF 上传');
        batch = { batchID: String(info.batch_id), uploaded: true, created: Date.now() };
        await writeJSON(batchPath, batch);
      } else this.log(job, '继续查询先前上传的 MinerU 任务。');
      const started = Date.now(); let result;
      while (Date.now() - started < cfg.pollTimeout) {
        check(signal);
        const info = minerData(await this.request('GET', cfg.mineruBase.replace(/\/$/, '') + '/extract-results/batch/' + encodeURIComponent(batch.batchID),
          { headers, responseType: 'json', timeout: cfg.timeout, signal }), '查询解析结果');
        const entries = info.extract_result || [];
        result = entries.find(entry => entry.data_id === job.id) || (entries.length === 1 ? entries[0] : null);
        if (result?.state === 'failed') {
          await IOUtils.remove(batchPath, { ignoreAbsent: true });
          throw new Error('MinerU 已返回解析失败。请检查 PDF 是否超页数、加密或损坏，以及服务额度；重试会创建新解析任务。');
        }
        if (result?.state === 'done') break;
        const p = result?.extract_progress;
        const progress = p?.total_pages ? Math.min(70, 15 + 55 * p.extracted_pages / p.total_pages) : 15;
        await this.update(job, { progress, message: p?.total_pages ? `MinerU 解析中：${p.extracted_pages}/${p.total_pages} 页` : '等待 MinerU 解析…' });
        await sleep(cfg.pollInterval, signal);
      }
      if (result?.state !== 'done') throw new Error('MinerU 解析等待超时，任务编号已保存，可稍后继续查询。');
      if (!result.full_zip_url) throw new Error('MinerU 完成解析但未返回结果 ZIP。');
      const url = secureURL(result.full_zip_url, false);
      await this.update(job, { message: '正在下载并读取解析结果…', progress: 80 });
      const archive = await this.downloadParsedArchive(job, url, signal);
      if (!archive || archive.byteLength > LIMIT.zip) throw new Error('解析 ZIP 为空或超过大小限制。');
      await IOUtils.makeDirectory(folder, { ignoreExisting: true, createAncestors: true });
      const zipPath = PathUtils.join(folder, 'result.zip');
      try {
        await IOUtils.write(zipPath, new Uint8Array(archive));
        check(signal);
        const metadata = await this.extractArchive(zipPath, folder, signal);
        if (parsed) metadata.imagePaths = Array.from(new Set([...parsed.imagePaths, ...metadata.imagePaths]));
        job.originalMd = await IOUtils.readUTF8(PathUtils.join(folder, ...metadata.mdPath.split('/')));
        if (!job.originalMd.trim()) throw new Error('解析结果中的 Markdown 为空。');
        const retained = await this.loadParsedImages(job, metadata);
        await writeJSON(recordPath, retained || metadata);
        await this.removeScratch(batchPath, job);
        this.log(job, `解析完成：${job.originalMd.length} 字符，${metadata.imagePaths.length} 张图片。`);
        await this.persist(job);
      } finally { await this.removeScratch(zipPath, job); }
    }
    async downloadParsedArchive(job, url, signal) {
      const options = { responseType: 'arraybuffer', timeout: job.config.timeout, signal, maxBytes: LIMIT.zip };
      try {
        return ok(await this.request('GET', url, options), '下载解析 ZIP');
      } catch (error) {
        check(signal);
        const fallback = mineruDownloadFallback(url);
        if (!fallback || !(error.retryable || error.status === 403 || error.status === 404)) {
          throw new Error(`MinerU 结果下载失败；解析任务已保留，重试会继续下载。${safeMessage(error)}`);
        }
        this.log(job, 'MinerU CDN 下载失败，正在使用官方 OSS 备用通道。', 'warning');
        await this.update(job, { message: 'MinerU 已完成解析，正在通过官方备用通道下载结果…', progress: 80 });
        try {
          return ok(await this.request('GET', fallback, options), '下载解析 ZIP');
        } catch (backupError) {
          check(signal);
          throw new Error(`MinerU 结果下载失败：CDN 与官方备用通道均未成功。解析任务已保留，可检查网络后重试。${safeMessage(backupError)}`);
        }
      }
    }
    async extractArchive(zipPath, folder, signal) {
      const zip = Cc['@mozilla.org/libjar/zip-reader;1'].createInstance(Ci.nsIZipReader);
      zip.open(Zotero.File.pathToFile(zipPath));
      try {
        const iterator = zip.findEntries('*'), entries = []; let count = 0;
        while (iterator.hasMore()) {
          check(signal); const name = iterator.getNext(), entry = zip.getEntry(name);
          if (++count > LIMIT.entries) throw new Error('解析 ZIP 中的文件数量过多。');
          PTCore.validateArchivePath(name.replace(/\/$/, ''));
          if (entry.isDirectory) continue;
          const path = PTCore.validateArchivePath(name);
          entries.push({ name, path, size: entry.realSize });
        }
        const markdowns = entries.filter(entry => /(^|\/)full\.md$/i.test(entry.path));
        if (markdowns.length !== 1) throw new Error('解析 ZIP 必须包含且只包含一个 full.md；当前结果无法唯一定位。');
        const md = markdowns[0], images = entries.filter(entry => /\.(png|jpe?g|gif|webp)$/i.test(entry.path));
        const directory = md.path.split('/').slice(0, -1).join('/');
        const siblings = entries.filter(entry => entry.path.split('/').slice(0, -1).join('/') === directory);
        const lists = siblings.filter(entry => /(?:^|\/)\w[\w.-]*_content_list\.json$/i.test(entry.path));
        const layout = siblings.find(entry => /(?:^|\/)layout\.json$/i.test(entry.path));
        const contentList = lists.length === 1 ? lists[0] : null;
        if (images.reduce((sum, entry) => sum + entry.size, 0) > LIMIT.images) throw new Error('解析结果中的图片总量超过 80 MB，请拆分论文。');
        for (const entry of [md, ...images, contentList, layout].filter(Boolean)) {
          check(signal);
          const target = PathUtils.join(folder, ...entry.path.split('/'));
          await IOUtils.makeDirectory(PathUtils.parent(target), { ignoreExisting: true, createAncestors: true });
          const stream = zip.getInputStream(entry.name);
          const binary = Cc['@mozilla.org/binaryinputstream;1'].createInstance(Ci.nsIBinaryInputStream);
          binary.setInputStream(stream);
          const temporary = target + '.extracting';
          try {
            // Replace partial attempts and write bounded chunks instead of
            // allocating a JavaScript array for the whole ZIP member.
            await IOUtils.write(temporary, new Uint8Array());
            let remaining = entry.size;
            while (remaining > 0) {
              check(signal);
              const data = new Uint8Array(binary.readByteArray(Math.min(1024 ** 2, remaining)));
              if (!data.length) throw new Error('解析 ZIP 条目数据不完整。');
              await IOUtils.write(temporary, data, { mode: 'append' });
              remaining -= data.length;
            }
            await IOUtils.move(temporary, target, { noOverwrite: false });
          } catch (error) {
            await this.removeScratch(temporary);
            throw error;
          } finally { binary.close(); }
        }
        return { schema: 2, mdPath: md.path, imagePaths: images.map(entry => entry.path),
          contentListPath: contentList?.path || null, layoutPath: layout?.path || null };
      } finally { zip.close(); }
    }
    async loadParsedImages(job, metadata) {
      const folder = this.parseDir(job);
      const parsed = metadata || await readJSON(PathUtils.join(folder, 'parsed.json'));
      if (!parsed) return;
      const directory = parsed.mdPath.split('/').slice(0, -1).join('/'), images = {};
      let total = 0;
      for (const name of parsed.imagePaths || []) {
        const path = PTCore.validateArchivePath(name);
        const bytes = await IOUtils.read(PathUtils.join(folder, ...path.split('/')));
        total += bytes.length; if (total > LIMIT.images) throw new Error('缓存图片超过大小限制。');
        const mime = imageMime(bytes); if (!mime) continue;
        const data = dataURL(bytes, mime);
        images[relativeTo(directory, path)] = data;
        if (!Object.prototype.hasOwnProperty.call(images, path)) images[path] = data;
      }
      job.images = images;
      job.sourceMap = null;
      for (const chunk of job.chunks) chunk.locations = [];
      if (root.PTAnchors && (parsed.sourceMapPath || parsed.contentListPath || parsed.layoutPath)) {
        try {
          const result = await this.compactSourceMap(job, parsed);
          job.sourceMap = result.map;
          root.PTAnchors.bindChunks(job.originalMd, job.chunks, job.sourceMap);
          if (![...this.jobs.values()].some(other => other.id !== job.id && other.parseKey === job.parseKey && other._runPromise)) {
            await this.removeScratch(PathUtils.join(folder, 'result.zip'), job);
            await this.removeScratch(PathUtils.join(folder, 'batch.json'), job);
          }
          return result.metadata;
        } catch (_) { this.log(job, '段落坐标文件不可用，正文与译文仍可阅读。', 'warning'); }
      }
      return parsed;
    }
    async removeScratch(path, job, recursive = false) {
      try { await IOUtils.remove(path, { ignoreAbsent: true, recursive }); }
      catch (_) { if (Array.isArray(job?.logs)) this.log(job, '过程文件未能清理，可在历史中再次清理。', 'warning'); }
    }
    async compactSourceMap(job, metadata) {
      const folder = this.parseDir(job);
      if (this.compacting.has(folder)) return this.compacting.get(folder);
      const pending = (async () => {
        const read = async name => name ? readJSON(PathUtils.join(folder, ...PTCore.validateArchivePath(name).split('/'))) : null;
        const current = await readJSON(PathUtils.join(folder, 'parsed.json'));
        const parsed = current?.sourceMapPath ? current : metadata;
        const markdownHash = await digest(job.originalMd);
        const clearRaw = async retained => {
          const protectedPaths = new Set([retained.mdPath, ...(retained.imagePaths || []), retained.sourceMapPath, 'parsed.json']);
          const pendingPaths = [];
          for (const name of retained.scratchPaths || []) {
            const path = PTCore.validateArchivePath(name);
            if (protectedPaths.has(path)) continue;
            const target = PathUtils.join(folder, ...path.split('/'));
            await this.removeScratch(target, job);
            if (await IOUtils.exists(target)) pendingPaths.push(path);
          }
          if (retained.scratchPaths?.length) {
            const final = { ...retained }; delete final.scratchPaths;
            if (pendingPaths.length) final.scratchPaths = pendingPaths;
            await writeJSON(PathUtils.join(folder, 'parsed.json'), final); return final;
          }
          return retained;
        };
        if (parsed.sourceMapPath) {
          const saved = await read(parsed.sourceMapPath);
          if (saved?.schema !== 1 || saved.markdownHash !== markdownHash) throw new Error('定位缓存与正文不一致。');
          const map = root.PTAnchors.fromCache(job.originalMd, saved.map);
          return { map, metadata: await clearRaw(parsed) };
        }
        const map = root.PTAnchors.build(job.originalMd, await read(parsed.contentListPath), await read(parsed.layoutPath));
        const retained = { ...parsed, schema: 3, sourceMapPath: 'tidal-source-map.json', contentListPath: null, layoutPath: null,
          scratchPaths: [parsed.contentListPath, parsed.layoutPath].filter(Boolean) };
        await writeJSON(PathUtils.join(folder, retained.sourceMapPath), { schema: 1, markdownHash, map });
        // Commit the reusable index before removing its large raw inputs.
        await writeJSON(PathUtils.join(folder, 'parsed.json'), retained);
        return { map, metadata: await clearRaw(retained) };
      })();
      this.compacting.set(folder, pending);
      try { return await pending; }
      finally { if (this.compacting.get(folder) === pending) this.compacting.delete(folder); }
    }
    cleanupProcessFiles() {
      if (this.processCleanup) return this.processCleanup;
      const pending = this.historyLock(async () => {
        const result = { files: 0, bytes: 0, skipped: 0, warnings: [] };
        const records = await this.scanHistory();
        const busy = records.filter(record => !this.historyMeta(record).canDelete || this.restoring.has(record.id));
        const parseRoot = PathUtils.join(this.cacheRoot, 'parsed');
        const remove = async (path, recursive = false) => {
          if (!(await IOUtils.exists(path))) return;
          try {
            const stat = await IOUtils.stat(path, { followSymlinks: false });
            if (stat.type === 'directory' && recursive) {
              for (const child of await IOUtils.getChildren(path)) await remove(child, true);
              await IOUtils.remove(path, { ignoreAbsent: true });
            } else if (stat.type !== 'directory') {
              await IOUtils.remove(path, { ignoreAbsent: true }); result.files++; result.bytes += stat.size;
            }
          } catch (_) { result.warnings.push('部分过程文件未能清理。'); }
        };
        if (await IOUtils.exists(parseRoot)) for (const folder of await IOUtils.getChildren(parseRoot)) {
          const key = folder.replace(/\\/g, '/').split('/').at(-1);
          if (!/^[a-f0-9]{64}$/.test(key)) continue;
          if ((await IOUtils.stat(folder, { followSymlinks: false })).type !== 'directory') continue;
          if (busy.some(record => record.parseKey === key)) { result.skipped++; continue; }
          try {
            const parsed = await readJSON(PathUtils.join(folder, 'parsed.json'));
            if (parsed && (parsed.contentListPath || parsed.layoutPath || parsed.scratchPaths?.length)) {
              const originalMd = await IOUtils.readUTF8(PathUtils.join(folder, ...PTCore.validateArchivePath(parsed.mdPath).split('/')));
              const raw = [...new Set([parsed.contentListPath, parsed.layoutPath, ...(parsed.scratchPaths || [])].filter(Boolean))].map(name => PathUtils.join(folder, ...PTCore.validateArchivePath(name).split('/')));
              const sizes = await Promise.all(raw.map(async path => (await IOUtils.exists(path)) ? (await IOUtils.stat(path)).size : 0));
              await this.compactSourceMap({ parseKey: key, originalMd }, parsed);
              for (let index = 0; index < raw.length; index++) if (sizes[index]) {
                if (!await IOUtils.exists(raw[index])) { result.files++; result.bytes += sizes[index]; }
                else result.warnings.push('部分原始解析文件未能清理。');
              }
            }
          } catch (_) { result.warnings.push('部分原始解析数据未能压缩，已保留。'); }
          for (const name of ['result.zip', 'batch.json', 'parsed.json.tmp', 'tidal-source-map.json.tmp']) await remove(PathUtils.join(folder, name));
          const clearPartial = async directory => {
            for (const path of await IOUtils.getChildren(directory)) {
              const stat = await IOUtils.stat(path, { followSymlinks: false });
              if (stat.type === 'directory') await clearPartial(path);
              else if (path.endsWith('.extracting')) await remove(path);
            }
          };
          await clearPartial(folder);
        }
        const exports = PathUtils.join(this.cacheRoot, 'exports');
        if (await IOUtils.exists(exports)) for (const folder of await IOUtils.getChildren(exports)) {
          const id = folder.replace(/\\/g, '/').split('/').at(-1);
          if (!/^[a-f0-9]{64}$/.test(id)) continue;
          if (busy.some(record => record.id === id)) { result.skipped++; continue; }
          await remove(folder, true);
        }
        result.warnings = [...new Set(result.warnings)]; return result;
      });
      this.processCleanup = pending.finally(() => { this.processCleanup = null; });
      return this.processCleanup;
    }
    async openOriginal(id) {
      const job = this.jobs.get(id); if (!job) throw new Error('任务不存在。');
      await this.verifySource(job);
      await Zotero.Reader.open(job.attachmentID);
    }
    sourceAttachment(job) {
      const attachment = Zotero.Items.get(job.attachmentID);
      if (!attachment || attachment.deleted || attachment.key !== job.attachmentKey || attachment.libraryID !== job.libraryID) throw new Error('原附件已删除或身份改变，不能保存结果。');
      return attachment;
    }
    async verifySource(job) {
      const attachment = this.sourceAttachment(job);
      if (job.type === 'pdf' && await digest(await this.sourceBytes(attachment)) !== job.fileHash) {
        throw new Error('原 PDF 内容已改变。当前译文属于旧文件，请从文献列表重新启动翻译。');
      }
      return attachment;
    }
    outputContext(job) {
      const attachment = this.sourceAttachment(job);
      const library = Zotero.Libraries.get(attachment.libraryID);
      if (!library?.editable) throw new Error('当前文库不可编辑，无法保存翻译。');
      return { attachment, library, parentItemID: attachment.parentID || undefined };
    }
    requireComplete(job) {
      if (!job || job.status !== 'complete' || job.chunks.some(c => !['done', 'skipped'].includes(c.status))) throw new Error('请先完成全部分块，再保存结果。');
    }
    async saveOutputs(id, { html, markdown }) {
      if (this.processCleanup) await this.processCleanup;
      if (this.deleting.has(id)) throw new Error('记录正在删除，不能回存。');
      const job = this.jobs.get(id); this.requireComplete(job);
      if (job._outputPromise) return job._outputPromise;
      job._outputPromise = (async () => {
        await this.verifySource(job);
        const { attachment, library, parentItemID } = this.outputContext(job);
        if (!library.filesEditable) throw new Error('该群组允许编辑条目，但不允许上传附件。可以改为保存翻译笔记。');
        const folder = PathUtils.join(this.cacheRoot, 'exports', id);
        await IOUtils.makeDirectory(folder, { ignoreExisting: true, createAncestors: true });
        const added = [];
        for (const spec of [ { kind: 'html', name: 'bilingual.html', data: html, title: `双语译文 · ${job.targetLang}`, type: 'text/html' },
          { kind: 'markdown', name: 'translation.md', data: markdown, title: `译文 Markdown · ${job.targetLang}`, type: 'text/markdown' } ]) {
          if (typeof spec.data !== 'string' || !spec.data.trim()) throw new Error('导出内容为空。');
          const priorID = job.outputs?.[spec.kind], prior = priorID && Zotero.Items.get(priorID);
          if (prior && !prior.deleted && prior.libraryID === job.libraryID && prior.key === job.outputKeys?.[spec.kind]) { added.push(prior.id); continue; }
          const path = PathUtils.join(folder, spec.name);
          await IOUtils.writeUTF8(path, spec.data);
          const item = await Zotero.Attachments.importFromFile({ file: path, libraryID: job.libraryID, parentItemID,
            ...(parentItemID ? {} : { collections: attachment.getCollections() }), title: spec.title,
            contentType: spec.type, charset: 'utf-8' });
          item.addRelatedItem(attachment); await item.saveTx();
          job.outputs = { ...job.outputs, [spec.kind]: item.id };
          job.outputKeys = { ...job.outputKeys, [spec.kind]: item.key };
          job.outputItemIDs = Array.from(new Set([...job.outputItemIDs, item.id]));
          added.push(item.id); await this.persist(job);
        }
        this.log(job, '双语 HTML 和译文 Markdown 已保存到 Zotero。'); this.emit(job); return added;
      })();
      try { return await job._outputPromise; }
      finally {
        await this.removeScratch(PathUtils.join(this.cacheRoot, 'exports', id), job, true);
        job._outputPromise = null;
      }
    }
    async createNote(id) {
      if (this.deleting.has(id)) throw new Error('记录正在删除，不能回存。');
      const job = this.jobs.get(id); this.requireComplete(job);
      if (job._notePromise) return job._notePromise;
      job._notePromise = (async () => {
        await this.verifySource(job);
        const { attachment, parentItemID } = this.outputContext(job);
        const previous = job.outputs?.note && Zotero.Items.get(job.outputs.note);
        if (previous && !previous.deleted && previous.libraryID === job.libraryID && previous.key === job.outputKeys?.note) return previous.id;
        // Zotero note editor has a smaller supported HTML schema. Preserve equations as source text.
        const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const text = job.chunks.map(chunk => chunk.translated ?? chunk.source).join('');
        const note = new Zotero.Item('note'); note.libraryID = attachment.libraryID;
        if (parentItemID) note.parentID = parentItemID;
        else note.setCollections(attachment.getCollections());
        note.setNote(`<h1>${escape(job.title)} · ${escape(job.targetLang)} 译文</h1><p>模型：${escape(job.model)}。原文附件：${escape(attachment.key)}。公式、表格和图片请查看双语 HTML 附件。</p>` +
          text.split(/\n{2,}/).map(p => '<p>' + escape(p).replace(/\n/g, '<br/>') + '</p>').join(''));
        note.addRelatedItem(attachment); await note.saveTx();
        job.outputs = { ...job.outputs, note: note.id }; job.outputKeys = { ...job.outputKeys, note: note.key };
        job.outputItemIDs = Array.from(new Set([...job.outputItemIDs, note.id]));
        await this.persist(job); this.log(job, '译文笔记已保存。'); this.emit(job); return note.id;
      })();
      try { return await job._notePromise; } finally { job._notePromise = null; }
    }
    async shutdown() {
      this.alive = false;
      const test = this.connectionTest;
      test?.controller.abort();
      for (const job of this.jobs.values()) job._controller?.abort();
      await Promise.allSettled([
        ...Array.from(this.jobs.values()).flatMap(job =>
          [job._runPromise, job._outputPromise, job._notePromise, job._savePromise].filter(Boolean)),
        ...this.restoring.values(), ...(test ? [test.promise] : []),
        ...(this.settingsSave ? [this.settingsSave.promise] : []), this.historyQueue, ...this.startingSources.values()
      ]);
      if (this.readerHandler) Zotero.Reader.unregisterEventListener('renderTextSelectionPopup', this.readerHandler);
      if (this.readerToolbarHandler) Zotero.Reader.unregisterEventListener('renderToolbar', this.readerToolbarHandler);
      for (const pane of this.readerPanes.values()) pane.destroy();
      this.readerPanes.clear();
      for (const node of this.readerNodes) { try { node.remove(); } catch (_) {} }
      this.readerNodes.clear();
      for (const window of Array.from(this.windows.keys())) this.detachWindow(window);
      if (this.settingsWindow && !this.settingsWindow.closed) this.settingsWindow.close();
      if (this.historyWindow && !this.historyWindow.closed) this.historyWindow.close();
      this.subscribers.clear();
      // Zotero removes preference panes associated with pluginID when the plugin is disabled.
      if (this.paneID && Zotero.PreferencePanes.unregister) Zotero.PreferencePanes.unregister(this.paneID);
    }
  }
  root.PTPlatform = { Application, Cancellation, request, sleep, secureURL, mineruDownloadFallback, safeMessage, imageMime, relativeTo, LIMIT, ok, minerData };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PTPlatform;
})(typeof globalThis !== 'undefined' ? globalThis : this);
