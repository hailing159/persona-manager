(function () {
  'use strict';

  const EXT = 'persona-manager';

  // ---------- 工具函数（放最前面，避免 TDZ） ----------
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function blobToDataUri(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error || new Error('读取图片失败'));
      fr.readAsDataURL(blob);
    });
  }

  function dataUriToBlob(uri) {
    const comma = uri.indexOf(',');
    if (!uri.startsWith('data:') || comma < 0) throw new Error('不是有效的 data URI');
    const head = uri.slice(5, comma);
    const body = uri.slice(comma + 1);
    const isB64 = /;base64$/i.test(head);
    const mime = head.replace(/;base64$/i, '').split(';')[0] || 'image/png';
    const bin = isB64 ? atob(body) : decodeURIComponent(body);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  function safeFileName(name) {
    let n = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
    n = n.replace(/\.[^.]+$/, '');
    if (!n) n = 'persona_' + Date.now();
    return n + '.png';
  }

  // ---------- 酒馆接口（优先 getContext，失败再动态 import） ----------
  let apiCache = null;
  async function getApi() {
    if (apiCache) return apiCache;
    const api = {};
    try {
      const c = window.SillyTavern && window.SillyTavern.getContext && window.SillyTavern.getContext();
      if (c) {
        api.getRequestHeaders = c.getRequestHeaders;
        api.power_user = c.powerUserSettings;
        api.saveSettingsDebounced = c.saveSettingsDebounced;
      }
    } catch (e) { console.warn(`[${EXT}]`, e); }
    if (!api.getRequestHeaders || !api.saveSettingsDebounced) {
      try {
        const m = await import('/script.js');
        api.getRequestHeaders = api.getRequestHeaders || m.getRequestHeaders;
        api.saveSettingsDebounced = api.saveSettingsDebounced || m.saveSettingsDebounced;
      } catch (e) { console.warn(`[${EXT}] import script.js 失败`, e); }
    }
    if (!api.power_user) {
      try {
        const m = await import('/scripts/power-user.js');
        api.power_user = m.power_user;
      } catch (e) { console.warn(`[${EXT}] import power-user.js 失败`, e); }
    }
    if (!api.getRequestHeaders || !api.power_user || !api.saveSettingsDebounced) {
      throw new Error('无法访问酒馆内部接口（版本过旧？），请升级酒馆到较新版本');
    }
    api.power_user.personas = api.power_user.personas || {};
    api.power_user.persona_descriptions = api.power_user.persona_descriptions || {};
    apiCache = api;
    return api;
  }

  async function listServerAvatars() {
    const api = await getApi();
    const r = await fetch('/api/avatars/get', { method: 'POST', headers: api.getRequestHeaders(), body: '{}' });
    if (!r.ok) throw new Error('获取头像列表失败 (' + r.status + ')');
    const list = await r.json();
    return Array.isArray(list) ? list : [];
  }

  async function uploadAvatar(blob, fileName) {
    const api = await getApi();
    const headers = Object.assign({}, api.getRequestHeaders());
    Object.keys(headers).forEach(k => { if (k.toLowerCase() === 'content-type') delete headers[k]; });
    const fd = new FormData();
    fd.append('avatar', new File([blob], fileName, { type: blob.type || 'image/png' }));
    fd.append('overwrite_name', fileName);
    const r = await fetch('/api/avatars/upload', { method: 'POST', headers, body: fd });
    if (!r.ok) throw new Error('上传失败 (' + r.status + ')');
    return fileName;
  }

  async function fetchAvatarDataUri(file) {
    const urls = [
      '/User%20Avatars/' + encodeURIComponent(file),
      '/thumbnail?type=persona&file=' + encodeURIComponent(file),
    ];
    for (const u of urls) {
      try {
        const r = await fetch(u, { cache: 'no-store' });
        if (r.ok) return await blobToDataUri(await r.blob());
      } catch (e) { /* 试下一个 */ }
    }
    return null;
  }

  async function refreshStUi() {
    try {
      const m = await import('/scripts/personas.js');
      if (m.getUserAvatars) await m.getUserAvatars(true);
    } catch (e) { /* 老版本没有就算了 */ }
  }

  // ---------- 导入解析 / 构建 ----------
  // 格式：{ persona_descriptions: { "x.png": { description, nickname } }, avatars: { "x.png": "data:image/..." } }
  function parseImport(text) {
    let obj;
    try { obj = JSON.parse(String(text).replace(/^﻿/, '')); } catch (e) { throw new Error('不是有效的 JSON'); }
    if (!obj || typeof obj !== 'object') throw new Error('JSON 内容不对');
    const descs = obj.persona_descriptions && typeof obj.persona_descriptions === 'object' ? obj.persona_descriptions : {};
    const avatars = obj.avatars && typeof obj.avatars === 'object' ? obj.avatars : {};
    const files = Array.from(new Set([...Object.keys(descs), ...Object.keys(avatars)]));
    if (!files.length) throw new Error('没有找到 persona_descriptions 或 avatars');
    return files.map(file => {
      const d = descs[file];
      const isObj = d && typeof d === 'object';
      return {
        file,
        nickname: String((isObj ? (d.nickname ?? d.name) : '') || file.replace(/\.[^.]+$/, '')),
        description: String(isObj ? (d.description ?? '') : (typeof d === 'string' ? d : '')),
        extras: isObj ? { position: d.position, depth: d.depth, role: d.role, lorebook: d.lorebook, title: d.title } : {},
        image: typeof avatars[file] === 'string' && avatars[file] ? avatars[file] : null,
      };
    });
  }

  async function imageToBlob(src) {
    if (src.startsWith('data:')) return dataUriToBlob(src);
    if (/^https?:\/\//i.test(src)) {
      const r = await fetch(src);
      if (!r.ok) throw new Error('下载图片失败');
      return await r.blob();
    }
    throw new Error('不支持的图片格式');
  }

  async function importEntries(entries, overwrite, onProgress) {
    const api = await getApi();
    const pu = api.power_user;
    const server = new Set(await listServerAvatars());
    const result = { ok: 0, renamed: 0, skipped: [], failed: [] };
    let seq = 0;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (onProgress) onProgress(i + 1, entries.length, e.nickname);
      try {
        let target = safeFileName(e.file);
        // 原文件名已存在：没勾选覆盖就改名，避免顶掉你现有的人设
        const exists = server.has(target) || pu.personas[target] !== undefined || pu.persona_descriptions[target] !== undefined;
        if (exists && !overwrite) {
          target = safeFileName('persona_' + Date.now() + '_' + (seq++));
          result.renamed++;
        }

        if (e.image) {
          const blob = await imageToBlob(e.image);
          await uploadAvatar(blob, target);
          server.add(target);
        } else if (!server.has(target)) {
          result.skipped.push(e.nickname + '（没有图片）');
          continue;
        }

        const old = pu.persona_descriptions[target] || {};
        const next = Object.assign(
          { description: '', position: 0, depth: 2, role: 0, lorebook: '', title: '' },
          old
        );
        next.description = e.description;
        ['position', 'depth', 'role', 'lorebook', 'title'].forEach(k => {
          if (e.extras && e.extras[k] !== undefined && e.extras[k] !== null) next[k] = e.extras[k];
        });
        pu.persona_descriptions[target] = next;
        pu.personas[target] = e.nickname;
        result.ok++;
        await sleep(30);
      } catch (err) {
        console.error(`[${EXT}] 导入失败`, e.file, err);
        result.failed.push(e.nickname + '：' + err.message);
      }
    }
    api.saveSettingsDebounced();
    await refreshStUi();
    return result;
  }

  async function buildExport(files, onProgress) {
    const api = await getApi();
    const pu = api.power_user;
    const out = { persona_descriptions: {}, avatars: {} };
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (onProgress) onProgress(i + 1, files.length);
      const d = pu.persona_descriptions[f] || {};
      out.persona_descriptions[f] = {
        description: String(d.description || ''),
        nickname: String(pu.personas[f] || f.replace(/\.[^.]+$/, '')),
      };
      const img = await fetchAvatarDataUri(f);
      if (img) out.avatars[f] = img;
    }
    return out;
  }

  // ---------- 状态 ----------
  let root = null;
  let items = [];           // {file, name, description}
  let selected = new Set();
  let searchText = '';
  let statusTimer = null;
  let busy = false;

  function status(text, bad, sticky) {
    const el = root && root.querySelector('#pm-status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('bad', !!bad);
    clearTimeout(statusTimer);
    if (!sticky) statusTimer = setTimeout(() => { el.textContent = ''; }, 6000);
  }

  async function reload() {
    try {
      const api = await getApi();
      const pu = api.power_user;
      let server = null;
      try { server = new Set(await listServerAvatars()); } catch (e) { /* 拿不到就不过滤 */ }
      const files = Array.from(new Set([...Object.keys(pu.personas), ...Object.keys(pu.persona_descriptions)]))
        .filter(f => !server || server.has(f));
      items = files.map(f => ({
        file: f,
        name: String(pu.personas[f] || f.replace(/\.[^.]+$/, '')),
        description: String((pu.persona_descriptions[f] || {}).description || ''),
      }));
      selected = new Set(Array.from(selected).filter(f => files.includes(f)));
    } catch (e) {
      items = [];
      render();
      status(e.message, true, true);
      return;
    }
    render();
  }

  // ---------- 弹窗 ----------
  function showModal(title, html, done, label) {
    document.querySelector('#pm-modal')?.remove();
    const m = document.createElement('div');
    m.id = 'pm-modal';
    m.className = 'pm-modal-bg';
    m.innerHTML =
      `<section class="pm-modal"><header>${esc(title)}<button type="button" class="pm-x">×</button></header>` +
      `<div class="pm-modal-content">${html}</div>` +
      `<footer><button type="button" class="pm-btn pm-light pm-cancel">取消</button>` +
      `<button type="button" class="pm-btn pm-primary pm-ok">${esc(label || '确定')}</button></footer></section>`;
    document.body.appendChild(m);
    const close = () => m.remove();
    m.querySelector('.pm-x').onclick = close;
    m.querySelector('.pm-cancel').onclick = close;
    m.onclick = e => { if (e.target === m) close(); };
    m.querySelector('.pm-ok').onclick = async () => {
      const r = await done(m);
      if (r !== false) close();
    };
    return m;
  }

  function importModal(entries, fileName) {
    const server = window.__pmServerSet || new Set();
    const rows = entries.map((e, i) =>
      `<label class="pm-row"><input type="checkbox" data-i="${i}" checked>` +
      `<img class="pm-thumb" data-i="${i}" alt="">` +
      `<div class="pm-row-info"><b>${esc(e.nickname)}</b>` +
      `<span>${esc(e.description.slice(0, 60) || '（无描述）')}</span>` +
      `<small>${e.image ? '含图片' : '无图片'} · ${esc(e.file)}${server.has(safeFileName(e.file)) ? ' · 同名已存在' : ''}</small></div></label>`
    ).join('');
    const m = showModal(
      '导入人设：' + fileName,
      `<p>共 ${entries.length} 个人设。图片会一起上传到酒馆的头像库。</p>` +
      `<label class="pm-check"><input type="checkbox" id="pm-all" checked> 全选</label>` +
      `<div class="pm-rows">${rows}</div>` +
      `<label class="pm-check"><input type="checkbox" id="pm-overwrite"> 覆盖同名人设（不勾选则同名的自动改名新增）</label>`,
      async mm => {
        const picked = Array.from(mm.querySelectorAll('input[data-i]:checked')).map(cb => entries[Number(cb.dataset.i)]);
        if (!picked.length) { status('请至少选一个', true); return false; }
        const overwrite = mm.querySelector('#pm-overwrite').checked;
        if (busy) return false;
        busy = true;
        try {
          const res = await importEntries(picked, overwrite, (n, total, name) => status(`导入中 ${n}/${total}：${name}`, false, true));
          await reload();
          let msg = `导入完成：成功 ${res.ok} 个`;
          if (res.renamed) msg += `，其中 ${res.renamed} 个同名已自动改名`;
          if (res.skipped.length) msg += `，跳过 ${res.skipped.length} 个`;
          if (res.failed.length) msg += `，失败 ${res.failed.length} 个`;
          status(msg + '。若酒馆人设列表没更新，请刷新页面', res.failed.length > 0);
          if (res.failed.length) console.warn(`[${EXT}] 失败详情`, res.failed);
        } catch (err) {
          status('导入失败：' + err.message, true);
        } finally { busy = false; }
      },
      '导入'
    );
    // 图片预览用 DOM 赋值，避免超大字符串塞进 innerHTML
    m.querySelectorAll('img.pm-thumb').forEach(img => {
      const e = entries[Number(img.dataset.i)];
      if (e.image) img.src = e.image; else img.style.visibility = 'hidden';
    });
    m.querySelector('#pm-all').onchange = ev => {
      m.querySelectorAll('input[data-i]').forEach(cb => { cb.checked = ev.target.checked; });
    };
  }

  // ---------- 渲染 ----------
  function visibleItems() {
    const q = searchText.trim().toLowerCase();
    if (!q) return items;
    return items.filter(x => (x.name + ' ' + x.description + ' ' + x.file).toLowerCase().includes(q));
  }

  function render() {
    if (!root) return;
    const list = visibleItems();
    const allChecked = list.length > 0 && list.every(x => selected.has(x.file));
    root.innerHTML =
      `<div class="pm-wrap">` +
      `<div class="pm-top"><div><b>人设导入导出</b><small>${items.length} 个人设 · 已选 ${selected.size} 个</small></div>` +
      `<button class="pm-btn pm-primary" data-a="import">导入文件</button></div>` +
      `<div class="pm-tools">` +
      `<button class="pm-btn pm-light" data-a="export">导出${selected.size ? '选中' : '全部'}（含图片）</button>` +
      `<button class="pm-btn pm-light" data-a="refresh">刷新列表</button>` +
      `<input id="pm-file-input" type="file" accept=".json,application/json,text/plain" hidden></div>` +
      `<div class="pm-tools"><input id="pm-search" class="pm-input" placeholder="搜索人设…" value="${esc(searchText)}">` +
      `<label class="pm-check"><input type="checkbox" id="pm-sel-all" ${allChecked ? 'checked' : ''}> 全选</label></div>` +
      `<div class="pm-list">` +
      list.map(x =>
        `<label class="pm-card"><input type="checkbox" data-sel="${esc(x.file)}" ${selected.has(x.file) ? 'checked' : ''}>` +
        `<img class="pm-avatar" loading="lazy" src="/thumbnail?type=persona&file=${encodeURIComponent(x.file)}" alt="">` +
        `<div class="pm-card-info"><b title="${esc(x.name)}">${esc(x.name)}</b><span>${esc(x.description.slice(0, 50) || '（无描述）')}</span></div></label>`
      ).join('') +
      (!items.length ? '<div class="pm-empty">没有读取到人设</div>' : '') +
      (items.length && !list.length ? '<div class="pm-empty">没有匹配的人设</div>' : '') +
      `</div><div id="pm-status"></div></div>`;

    root.querySelectorAll('[data-a]').forEach(b => { b.onclick = () => action(b.dataset.a); });
    root.querySelectorAll('[data-sel]').forEach(cb => {
      cb.onchange = () => {
        if (cb.checked) selected.add(cb.dataset.sel); else selected.delete(cb.dataset.sel);
        render();
      };
    });
    root.querySelector('#pm-sel-all').onchange = e => {
      visibleItems().forEach(x => { if (e.target.checked) selected.add(x.file); else selected.delete(x.file); });
      render();
    };
    root.querySelector('#pm-search').oninput = e => {
      const p = e.target.selectionStart;
      searchText = e.target.value;
      render();
      const n = root.querySelector('#pm-search');
      n.focus();
      try { n.setSelectionRange(p, p); } catch (err) { /* ignore */ }
    };
    root.querySelector('#pm-file-input').onchange = async e => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const entries = parseImport(await file.text());
        try { window.__pmServerSet = new Set(await listServerAvatars()); } catch (err) { window.__pmServerSet = new Set(); }
        importModal(entries, file.name);
      } catch (err) {
        status('读取失败：' + err.message, true);
      }
    };
  }

  async function action(a) {
    if (a === 'import') root.querySelector('#pm-file-input')?.click();
    else if (a === 'refresh') { await reload(); status('已刷新'); }
    else if (a === 'export') {
      if (busy) return;
      const files = selected.size ? items.filter(x => selected.has(x.file)).map(x => x.file) : items.map(x => x.file);
      if (!files.length) { status('没有可导出的人设', true); return; }
      busy = true;
      try {
        const out = await buildExport(files, (n, total) => status(`正在读取头像 ${n}/${total}…`, false, true));
        const missing = files.filter(f => !out.avatars[f]).length;
        const d = new Date();
        const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
        const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json;charset=utf-8' });
        const u = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = u;
        link.download = `personas-${stamp}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(u), 2000);
        status(`已导出 ${files.length} 个人设` + (missing ? `（${missing} 个头像读取失败）` : '（含头像）'), missing > 0);
      } catch (err) {
        status('导出失败：' + err.message, true);
      } finally { busy = false; }
    }
  }

  // ---------- 挂载 ----------
  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'persona-manager-inline';
    panel.innerHTML =
      `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>人设导入导出</b>` +
      `<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>` +
      `<div class="inline-drawer-content"><div id="pm-manager-root"></div></div></div>`;
    root = panel.querySelector('#pm-manager-root');
    panel.querySelector('.inline-drawer-toggle').addEventListener('click', () => { reload(); });
    render();
    return panel;
  }

  function mount() {
    if (document.getElementById('persona-manager-inline')) return true;
    const target =
      document.querySelector('#persona-management-block') ||
      document.querySelector('#persona-management-button .drawer-content') ||
      document.querySelector('#extensions_settings2');
    if (!target) return false;
    target.appendChild(createPanel());
    console.log(`[${EXT}] 面板已挂载`);
    reload();
    return true;
  }

  function init() {
    if (mount()) return;
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      if (mount() || tries > 120) clearInterval(t);
    }, 1000);
  }

  window.personaManager = { parseImport, importEntries, buildExport, safeFileName };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
