/*
 * Zotero bootstrap lifecycle. Integration patterns were checked against
 * Zotero's documentation and zotero-immersivetranslate (see docs/COMPATIBILITY.md).
 * No service credentials or translation provider code belongs in this file.
 */
var PTBootstrap = {
  phase: 'idle', step: '', error: '', readyPromise: null, initPromise: null, scope: null, app: null,
  chromeHandle: null, cancelled: false, generation: 0, diagnosticWindows: new Map()
};

function install() {}
function uninstall() {}

function diagnosticMenu(window) {
  if (!window || window.closed || PTBootstrap.diagnosticWindows.has(window)) return;
  const parent = window.document.getElementById('menu_ToolsPopup');
  if (!parent) return;
  const item = window.document.createXULElement('menuitem');
  item.id = 'tidal-startup-error';
  item.setAttribute('label', 'Tidal：查看启动错误…');
  item.addEventListener('command', () => {
    Services.prompt.alert(window, 'Tidal 启动诊断',
      '阶段：' + PTBootstrap.step + '\n' + PTBootstrap.error +
      '\n\n请在 Zotero 的“帮助 → 调试输出日志”中查看详细错误。');
  });
  parent.appendChild(item);
  PTBootstrap.diagnosticWindows.set(window, item);
}

function removeDiagnostics(window) {
  const item = PTBootstrap.diagnosticWindows.get(window);
  if (item) { item.remove(); PTBootstrap.diagnosticWindows.delete(window); }
}

function reportStartupFailure(error, generation) {
  if (generation !== PTBootstrap.generation || PTBootstrap.cancelled) return;
  PTBootstrap.phase = 'failed';
  PTBootstrap.error = String(error?.message || error).slice(0, 1500);
  Zotero.logError(new Error('Tidal startup [' + PTBootstrap.step + ']: ' + PTBootstrap.error));
  for (const window of Zotero.getMainWindows()) diagnosticMenu(window);
}

function releaseBootstrapResources(generation, app) {
  if (generation !== PTBootstrap.generation) return;
  if (Zotero.Tidal === app) delete Zotero.Tidal;
  try { PTBootstrap.chromeHandle?.destruct(); } catch (error) { Zotero.logError(error); }
  PTBootstrap.chromeHandle = null; PTBootstrap.scope = null; PTBootstrap.app = null;
  PTBootstrap.initPromise = null;
}

// Return promptly: waiting for uiReadyPromise inside the bootstrap hook itself
// can hold up Zotero's startup. The tracked worker waits outside that hook.
function startup({ id, version, rootURI, resourceURI }) {
  const generation = ++PTBootstrap.generation;
  PTBootstrap.phase = 'loading'; PTBootstrap.error = ''; PTBootstrap.cancelled = false;
  PTBootstrap.initPromise = null;
  Zotero.TidalDiagnostics = PTBootstrap;
  try {
    PTBootstrap.step = 'register-resources';
    rootURI = rootURI || resourceURI?.spec;
    if (!rootURI) throw new Error('插件安装路径不可用。');
    if (!rootURI.endsWith('/')) rootURI += '/';
    // Bind supported Components interfaces instead of assuming Cc/Ci aliases.
    const manager = Components.classes['@mozilla.org/addons/addon-manager-startup;1']
      .getService(Components.interfaces.amIAddonManagerStartup);
    PTBootstrap.chromeHandle = manager.registerChrome(Services.io.newURI(rootURI + 'manifest.json'), [
      ['content', 'tidal', rootURI + 'content/']
    ]);
    PTBootstrap.step = 'load-modules';
    const scope = {
      rootURI, Zotero, Services, Components, ChromeUtils, IOUtils, PathUtils,
      Cc: Components.classes, Ci: Components.interfaces, Cu: Components.utils,
      Cr: Components.results, XMLHttpRequest, TextEncoder, TextDecoder, URL,
      crypto, btoa, atob, setTimeout, clearTimeout, setInterval, clearInterval
    };
    scope.globalThis = scope;
    scope._globalThis = scope;
    PTBootstrap.scope = scope;
    // Registered chrome URLs work for packed XPIs and development folders.
    Services.scriptloader.loadSubScript('chrome://tidal/content/core.js?v=' + encodeURIComponent(version), scope);
    Services.scriptloader.loadSubScript('chrome://tidal/content/anchors.js?v=' + encodeURIComponent(version), scope);
    Services.scriptloader.loadSubScript('chrome://tidal/content/reader-pane.js?v=' + encodeURIComponent(version), scope);
    Services.scriptloader.loadSubScript('chrome://tidal/content/host.js?v=' + encodeURIComponent(version), scope);
    if (!scope.PTCore || !scope.PTPlatform?.Application) throw new Error('插件模块未能加载。');
    const app = new scope.PTPlatform.Application({ id, version });
    PTBootstrap.app = app;
    PTBootstrap.phase = 'waiting'; PTBootstrap.step = 'wait-for-zotero-ui';
    PTBootstrap.readyPromise = (async () => {
      try {
        await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise, Zotero.uiReadyPromise]);
        if (PTBootstrap.cancelled || generation !== PTBootstrap.generation) return;
        PTBootstrap.step = 'initialize-plugin';
        PTBootstrap.initPromise = app.init();
        await PTBootstrap.initPromise;
        if (PTBootstrap.cancelled || generation !== PTBootstrap.generation) { await app.shutdown(); return; }
        Zotero.Tidal = app;
        PTBootstrap.step = 'attach-menus';
        for (const window of Zotero.getMainWindows()) app.attachWindow(window);
        PTBootstrap.phase = 'ready'; PTBootstrap.step = 'ready';
        Zotero.debug('Tidal ' + version + ': initialized');
      } catch (error) {
        try { await app.shutdown(); } catch (_) {}
        releaseBootstrapResources(generation, app);
        reportStartupFailure(error, generation);
      }
    })();
  } catch (error) {
    releaseBootstrapResources(generation, PTBootstrap.app);
    reportStartupFailure(error, generation);
    PTBootstrap.readyPromise = Promise.resolve();
  }
}

function onMainWindowLoad({ window }) {
  if (PTBootstrap.phase === 'ready') {
    try { PTBootstrap.app.attachWindow(window); }
    catch (error) { PTBootstrap.step = 'attach-main-window'; reportStartupFailure(error, PTBootstrap.generation); }
  } else if (PTBootstrap.phase === 'failed') diagnosticMenu(window);
}

function onMainWindowUnload({ window }) {
  PTBootstrap.app?.detachWindow(window);
  removeDiagnostics(window);
}

async function shutdown() {
  PTBootstrap.cancelled = true;
  const app = PTBootstrap.app;
  // Do not wait for uiReadyPromise when disabled while Zotero is starting.
  // The worker checks cancellation after its awaits and cannot reactivate itself.
  if (PTBootstrap.initPromise) { try { await PTBootstrap.initPromise; } catch (_) {} }
  if (app) { try { await app.shutdown(); } catch (error) { Zotero.logError(error); } }
  for (const window of Array.from(PTBootstrap.diagnosticWindows.keys())) removeDiagnostics(window);
  releaseBootstrapResources(PTBootstrap.generation, app);
  PTBootstrap.phase = 'stopped'; PTBootstrap.step = 'stopped';
  if (Zotero.TidalDiagnostics === PTBootstrap) delete Zotero.TidalDiagnostics;
}
