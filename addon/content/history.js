(function () {
 'use strict';
 const $ = id => document.getElementById(id), HTML = 'http://www.w3.org/1999/xhtml';
 const STATUS = { complete: '已完成', partial: '部分完成', cancelled: '未完成', error: '失败', queued: '排队中', parsing: '解析中', translating: '翻译中', corrupt: '损坏' };
 let app, records = [], selected = '', details = null, filter = 'all', side = 'translated', busy = false, disposed = false, detailToken = 0, deleteID = '';
 function feedback(value, level = 'info') { if (!disposed) { $('feedback').textContent = value; $('feedback').dataset.level = level; } }
 function date(value) { const d = new Date(value); return Number.isNaN(d.getTime()) ? '日期未知' : d.toLocaleDateString(); }
 function buttonState() {
  const record = records.find(row => row.id === selected);
  $('openRecord').disabled = busy || !record || record.corrupt;
  $('copyOriginal').disabled = busy || !details?.canCopyOriginal;
  $('copyTranslation').disabled = busy || !details?.canCopyTranslation;
  $('deleteRecord').disabled = busy || !record?.canDelete;
  $('deleteRecord').title = record?.canDelete ? '手动删除本地翻译记录' : '请先打开任务取消，等待任务或回存结束后删除';
  $('refresh').disabled = busy;
  $('cleanupProcess').disabled = busy;
 }
 function preview() {
  $('previewTranslation').setAttribute('aria-pressed', String(side === 'translated'));
  $('previewOriginal').setAttribute('aria-pressed', String(side === 'original'));
  const value = details ? side === 'original' ? details.originalMarkdown : details.translatedMarkdown : '';
  $('preview').textContent = value ? value.slice(0, 12000) : side === 'translated' ? '当前记录尚无完整译文，可打开任务复制已完成段落。' : '原文尚未解析，或该记录无法读取。';
  $('previewHint').textContent = value?.length > 12000 ? '仅预览前 12000 字符；复制按钮会复制全文。' : '复制使用缓存中的 Markdown。';
 }
 function visibleRows() {
  const query = $('search').value.trim().toLowerCase();
  return records.filter(row => (!query || [row.title,row.model,row.targetLang].join(' ').toLowerCase().includes(query))
   && (filter === 'all' || filter === 'corrupt' ? filter === 'all' || row.corrupt : filter === 'complete' ? row.status === 'complete' : !row.corrupt && row.status !== 'complete'));
 }
 function drawList() {
  const rows = visibleRows();
  $('historyCount').textContent = rows.length + ' / ' + records.length + ' 条记录';
  const nodes = rows.map(row => {
   const button = document.createElementNS(HTML,'button'); button.type = 'button'; button.className = 'history-row'; button.dataset.id = row.id; button.setAttribute('aria-current',String(row.id === selected));
   const title = document.createElementNS(HTML,'span'); title.className = 'row-title'; title.textContent = row.title;
   const meta = document.createElementNS(HTML,'span'); meta.className = 'row-meta';
   const kind = document.createElementNS(HTML,'span'); kind.textContent = (row.type === 'selection' ? '选区' : '全文') + ' · ' + (row.targetLang || '未知语言') + ' · ' + (STATUS[row.status] || row.status);
   const time = document.createElementNS(HTML,'span'); time.textContent = date(row.createdAt); meta.append(kind,time); button.append(title,meta);
   button.addEventListener('click',()=>select(row.id)); return button;
  });
  if (!nodes.length) { const empty=document.createElementNS(HTML,'p');empty.className='empty';empty.textContent=records.length?'没有匹配的记录。':'暂无翻译历史。';nodes.push(empty); }
  $('historyList').replaceChildren(...nodes);
 }
 async function select(id) {
  selected = id; details = null; const token = ++detailToken; drawList();
  const record = records.find(row=>row.id===id);
  $('detailEmpty').hidden = Boolean(record); $('detail').hidden = !record;
  if (!record) return;
  $('recordTitle').textContent = record.title; $('recordStatus').textContent = STATUS[record.status] || record.status;
  $('recordMeta').textContent = [record.targetLang,record.model,date(record.createdAt)].filter(Boolean).join(' · ');
  $('recordProgress').textContent = record.corrupt ? '缓存格式损坏，原文件保留。' : '已完成 ' + record.completed + ' / ' + record.paragraphs + ' 段';
  $('recordHint').textContent = record.corrupt ? '损坏记录不会被自动覆盖，可手动删除后重新翻译。' : '打开只读取已有缓存；继续翻译需要在阅读抽屉中手动操作。';
  preview(); buttonState();
  if (record.corrupt) return;
  try {
   const next = await app.historyDetails(id);
   if (disposed || token !== detailToken || selected !== id) return;
   details = next; preview(); buttonState();
  } catch (error) { if (!disposed && token === detailToken) feedback(error.message || '无法读取记录。','error'); }
 }
 async function refresh() {
  const next = await app.listHistory(); if (disposed) return;
  records = next; const rows = visibleRows();
  await select(rows.some(row=>row.id===selected)?selected:rows[0]?.id || '');
 }
 async function action(callback) {
  if (busy) return; busy=true;buttonState();feedback('');
  try { await callback(); } catch(error) { feedback(error.message || '操作失败。','error'); }
  finally { busy=false;if(!disposed)buttonState(); }
 }
 window.addEventListener('DOMContentLoaded',async()=>{
  const raw=window.arguments?.[0];app=(raw?.wrappedJSObject||raw)?.app || window.opener?.Zotero?.Tidal;
  $('close').addEventListener('click',()=>window.close());
  window.addEventListener('unload',()=>{disposed=true;detailToken++;},{once:true});
  if(!app){feedback('无法连接 Tidal，请重新打开历史。','error');return;}
  window.PTAppearance?.apply(app.getConfig());
  $('refresh').addEventListener('click',()=>action(refresh));
  $('cleanupProcess').addEventListener('click',()=>action(async()=>{
   const result=await app.cleanupProcessFiles();
   const size=result.bytes>=1024**2?(result.bytes/1024**2).toFixed(1)+' MiB':(result.bytes/1024).toFixed(1)+' KiB';
   feedback('已清理 '+result.files+' 个过程文件（'+size+'），历史已保留。'+(result.skipped?'跳过 '+result.skipped+' 个运行中目录。':'')+(result.warnings?.join('')||''),result.warnings?.length?'error':'info');
  }));
  $('search').addEventListener('input',()=>{drawList();const rows=visibleRows();if(!rows.some(row=>row.id===selected))select(rows[0]?.id||'');});
  for(const button of document.querySelectorAll('[data-filter]'))button.addEventListener('click',()=>{
   filter=button.dataset.filter;for(const other of document.querySelectorAll('[data-filter]'))other.setAttribute('aria-pressed',String(other===button));
   drawList();const rows=visibleRows();if(!rows.some(row=>row.id===selected))select(rows[0]?.id||'');
  });
  $('previewOriginal').addEventListener('click',()=>{side='original';preview();});$('previewTranslation').addEventListener('click',()=>{side='translated';preview();});
  $('openRecord').addEventListener('click',()=>action(async()=>{await app.openHistoryJob(selected);feedback('已打开缓存记录。');}));
  for(const [id,kind] of [['copyOriginal','original'],['copyTranslation','translated']])$(id).addEventListener('click',()=>action(async()=>{await app.copyMarkdown(selected,kind,null);feedback('已复制全文 Markdown。');}));
  $('deleteRecord').addEventListener('click',()=>{const record=records.find(row=>row.id===selected);if(!record?.canDelete)return;deleteID=selected;$('deleteName').textContent=record.title;$('removeParsed').checked=true;$('deleteDialog').showModal();});
  $('cancelDelete').addEventListener('click',()=>{$('deleteDialog').close();deleteID='';});
  $('confirmDelete').addEventListener('click',()=>{const id=deleteID,removeParsed=$('removeParsed').checked;$('deleteDialog').close();deleteID='';action(async()=>{
   const result=await app.deleteHistory(id,{removeParsed});await refresh();
   feedback('记录已删除。'+(result.sharedParseKept?'共享解析缓存已保留。':'')+(result.warnings?.join('')||''),result.warnings?.length?'error':'info');
  });});
  await action(refresh);
 },{once:true});
})();
