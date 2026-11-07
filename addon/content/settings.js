(function () {
  'use strict';
  window.addEventListener('DOMContentLoaded', async () => {
    const args = window.arguments?.[0];
    const app = (args?.wrappedJSObject || args)?.app || window.opener?.Zotero?.Tidal;
    const el = id => document.getElementById(id);
    const textFields = ['mineruBase', 'mineruModel', 'parseLanguage', 'serviceBase', 'provider', 'model', 'sourceLang', 'targetLang', 'glossary', 'referenceMode'];
    const numberFields = ['chunkSize', 'concurrency', 'maxRetries', 'readingSize'];
    const choices = { palette: ['ocean', 'forest', 'violet', 'sand'], colorScheme: ['system', 'light', 'dark'], readingFont: ['sans', 'serif'] };
    const form = el('settings-form');
    const controls = Array.from(form.querySelectorAll('input, select, textarea, button'));
    let config, busy = '', disposed = false, statusRequest = 0, translationDraftBase = '';
    let selects;

    function endpointIdentity(value) {
      try { return new URL(value.trim()).href.replace(/\/+$/, ''); }
      catch (_) { return value.trim(); }
    }
    function clearKeyForChangedEndpoint() {
      const next = endpointIdentity(el('serviceBase').value);
      if (next !== translationDraftBase) {
        // Draft keys are not address-bound by the login manager yet. Never
        // carry one to a new endpoint when the user changes a service preset.
        el('translation-secret').value = '';
        el('clear-translation').checked = false;
        translationDraftBase = next;
      }
    }
    function updateProviderHint() {
      el('provider-hint').textContent = ({
        deepseek: 'DeepSeek 官方使用 Chat Completions 接口。请使用对应的 DeepSeek API Key。',
        'openai-compatible': '使用通用 Chat Completions 格式；地址、模型和 Key 保持手动填写的内容。',
        'qwen-mt': '仅切换为 Qwen-MT 请求格式。请同时填写与 Qwen-MT 匹配的服务地址、模型和 Key。'
      })[el('provider').value] || '';
    }
    function updatePreview() {
      const value = formConfig();
      window.PTAppearance?.apply(value);
      el('readingSize-value').textContent = value.readingSize + ' px';
      el('reference-hint').textContent = ({
        smart: '优先使用 MinerU 的参考文献语义，再结合章节和文献格式识别。正文中的引用、附录和后续说明继续翻译。',
        heading: '只按“参考文献 / References”等章节标题排除，遇到后续章节或附录时恢复翻译。',
        translate: '参考文献也会发送到翻译服务。原文仍保留在 PDF 和对照视图中。'
      })[value.referenceMode] || '';
    }

    function safeText(value) {
      let text = String(value || '操作失败');
      for (const id of ['mineru-secret', 'translation-secret']) {
        const secret = el(id).value.trim();
        if (secret) text = text.split(secret).join('[已隐藏]');
      }
      return text.replace(/\bBearer\s+\S+/gi, 'Bearer [已隐藏]')
        .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[API Key 已隐藏]')
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[Token 已隐藏]')
        .replace(/https?:\/\/\S+/g, '[服务地址]').slice(0, 1400);
    }
    function message(value, level = 'info') {
      if (disposed) return;
      el('message').textContent = value ? safeText(value) : '';
      el('message').dataset.level = level;
    }
    function setBusy(value) {
      busy = value;
      if (disposed) return;
      // Lock the captured form while asynchronous credential/network operations
      // are pending, so a completed save cannot clear newer edits or keys.
      for (const control of controls) {
        if (control.id !== 'close') control.disabled = Boolean(value);
      }
      selects?.sync();
      el('save').textContent = value === 'saving' ? '正在保存…' : '保存设置';
      el('test-translation').textContent = value === 'testing' ? '正在测试…' : '测试翻译连接';
      form.setAttribute('aria-busy', String(Boolean(value)));
    }
    function fillForm(value) {
      for (const key of [...textFields, ...numberFields]) {
        if (!selects.setValue(key, value[key])) el(key).value = String(value[key] ?? '');
      }
      el('timeout-seconds').value = value.timeout / 1000;
      el('skipReferences').checked = value.skipReferences;
      for (const [name, values] of Object.entries(choices)) for (const option of values) el(name + '-' + option).checked = value[name] === option;
      translationDraftBase = endpointIdentity(el('serviceBase').value);
      updateProviderHint();
      updatePreview();
    }
    function formConfig() {
      const next = { ...config };
      for (const key of textFields) next[key] = el(key).value.trim();
      for (const key of numberFields) next[key] = Number(el(key).value);
      next.timeout = Number(el('timeout-seconds').value) * 1000;
      next.skipReferences = next.referenceMode !== 'translate';
      for (const [name, values] of Object.entries(choices)) next[name] = values.find(value => el(name + '-' + value).checked) || config[name];
      return next;
    }
    function clearTestResult() {
      el('translation-test-result').hidden = true;
      el('translation-test-output').textContent = '';
    }
    const refreshStatus = async () => {
      const request = ++statusRequest;
      el('mineru-status').textContent = '读取中…';
      el('translation-status').textContent = '读取中…';
      try {
        const status = await app.credentialStatus({ ...config,
          mineruBase: el('mineruBase').value.trim(), serviceBase: el('serviceBase').value.trim() });
        if (disposed || request !== statusRequest) return false;
        el('mineru-status').textContent = status.mineru ? '已为该地址保存' : '尚未保存';
        el('translation-status').textContent = status.translation ? '已为该地址保存' : '尚未保存';
        return true;
      } catch (_) {
        if (disposed || request !== statusRequest) return false;
        el('mineru-status').textContent = '无法读取，请检查地址';
        el('translation-status').textContent = '无法读取，请检查地址';
        return false;
      }
    };
    el('close').addEventListener('click', () => window.close());
    window.addEventListener('unload', () => { disposed = true; statusRequest++; }, { once: true });
    if (!app) { setBusy('unavailable'); message('无法连接插件，请重新打开设置。', 'error'); return; }
    try { selects = PTSelectControls.attach(document, ['mineruModel', 'provider', 'sourceLang', 'targetLang', 'referenceMode']); }
    catch (error) { setBusy('unavailable'); message('无法加载设置选项：' + (error.message || error), 'error'); return; }
    try { config = app.getConfig(); fillForm(config); }
    catch (error) { setBusy('unavailable'); message('无法读取设置：' + (error.message || error), 'error'); return; }
    for (const id of ['mineruBase', 'serviceBase']) {
      el(id).addEventListener('input', () => {
        if (id === 'serviceBase') clearKeyForChangedEndpoint();
        statusRequest++;
        el(id === 'mineruBase' ? 'mineru-status' : 'translation-status').textContent = '地址已更改，待检查';
      });
      el(id).addEventListener('change', () => {
        if (id === 'serviceBase') clearKeyForChangedEndpoint();
        return refreshStatus();
      });
    }
    el('provider').addEventListener('change', async () => {
      if (busy || disposed) return;
      updateProviderHint();
      if (el('provider').value !== 'deepseek') return;
      // Only an explicit user selection applies this preset. Loading saved
      // settings must not overwrite a custom model or endpoint.
      el('serviceBase').value = 'https://api.deepseek.com';
      el('model').value = 'deepseek-flash';
      clearKeyForChangedEndpoint();
      message('已填入 DeepSeek 官方地址和模型；请使用对应的 DeepSeek API Key。更改尚未保存。');
      await refreshStatus();
    });
    el('referenceMode').addEventListener('change', updatePreview);
    for (const link of document.querySelectorAll('.settings-sidebar nav a')) {
      link.addEventListener('click', () => {
        for (const other of document.querySelectorAll('.settings-sidebar nav a')) other.setAttribute('aria-current', String(other === link));
      });
    }
    form.addEventListener('input', () => {
      if (busy || disposed) return;
      clearTestResult();
      updatePreview();
      message('表单有未保存的更改。');
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (disposed || busy || !form.reportValidity()) return;
      const next = formConfig();
      const secrets = { mineru: el('mineru-secret').value, translation: el('translation-secret').value,
        clearMineru: el('clear-mineru').checked, clearTranslation: el('clear-translation').checked };
      statusRequest++;
      setBusy('saving'); message('正在保存设置与凭证…');
      try {
        config = await app.saveSettings(next, secrets);
        if (disposed) return;
        fillForm(config);
        el('mineru-secret').value = ''; el('translation-secret').value = '';
        el('clear-mineru').checked = false; el('clear-translation').checked = false;
        const readable = await refreshStatus();
        message(readable ? '设置已保存。可关闭此窗口并开始翻译。' : '设置已保存，但暂时无法读取凭证状态。', 'success');
      } catch (error) { message(error.message || '保存失败', 'error'); }
      finally { setBusy(''); }
    });
    el('test-translation').addEventListener('click', async () => {
      if (disposed || busy || !form.reportValidity()) return;
      const next = formConfig();
      const secrets = { translation: el('translation-secret').value, clearTranslation: el('clear-translation').checked };
      clearTestResult(); setBusy('testing'); message('正在发送一次短文本翻译测试，请稍候…');
      try {
        const result = await app.testTranslation(next, secrets);
        if (disposed) return;
        if (typeof result?.translation !== 'string' || !result.translation.trim()) throw new Error('测试接口未返回译文。');
        el('translation-test-output').textContent = safeText(result.translation);
        el('translation-test-result').hidden = false;
        const elapsed = Number.isFinite(result.elapsedMs) ? '，耗时 ' + (result.elapsedMs / 1000).toFixed(1) + ' 秒' : '';
        message('测试通过：' + (result.model || next.model) + elapsed + '。测试不会保存设置。', 'success');
      } catch (error) { message(error.message || '测试失败', 'error'); }
      finally { setBusy(''); }
    });
    await refreshStatus();
  }, { once: true });
})();
