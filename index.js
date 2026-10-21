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

  function fetchT(url, opt, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms || 30000);
    return fetch(url, Object.assign({}, opt, { signal: ctrl.signal }))
      .catch(e => { throw new Error(e && e.name === 'AbortError' ? '请求超时' : (e && e.message) || '网络错误'); })
      .finally(() => clearTimeout(t));
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
    const r = await fetchT('/api/avatars/get', { method: 'POST', headers: api.getRequestHeaders(), body: '{}' }, 15000);
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
    const r = await fetchT('/api/avatars/upload', { method: 'POST', headers, body: fd }, 60000);
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 120); } catch (e) { /* ignore */ }
      throw new Error('上传失败 (' + r.status + ') ' + detail);
    }
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
    log('正在获取服务器头像列表…');
    const server = new Set(await listServerAvatars());
    log(`服务器已有头像 ${server.size} 个，开始逐个导入`);
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
          log(`跳过 ${e.nickname}：没有图片`);
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
        log(`✔ ${e.nickname} → ${target}`);
        await sleep(30);
      } catch (err) {
        console.error(`[${EXT}] 导入失败`, e.file, err);
        result.failed.push(e.nickname + '：' + err.message);
        log(`✘ ${e.nickname}（${e.file}）：${err.message}`);
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
  const logs = [];
  let root = null;
  let items = [];           // {file, name, description}
  let selected = new Set();
  let searchText = '';
  let statusTimer = null;
  let busy = false;

  function log(msg) {
    logs.push(new Date().toLocaleTimeString() + ' ' + msg);
    while (logs.length > 60) logs.shift();
    const el = root && root.querySelector('#pm-log');
    if (el) el.textContent = logs.join('\n');
  }

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
      log(`读取到 ${items.length} 个人设（酒馆设置中 ${Object.keys(pu.personas).length} 个，服务器头像 ${server ? server.size : '未知'} 个）`);
    } catch (e) {
      log('读取人设失败：' + e.message);
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
    const okBtn = m.querySelector('.pm-ok');
    okBtn.onclick = async () => {
      okBtn.disabled = true;
      try {
        const r = await done(m);
        if (r !== false) close();
      } catch (err) {
        log('弹窗操作出错：' + (err && err.message));
        const box = m.querySelector('.pm-modal-content');
        if (box) box.insertAdjacentHTML('beforeend', `<p class="pm-err">出错了：${esc(err && err.message)}</p>`);
      } finally {
        if (okBtn.isConnected) okBtn.disabled = false;
      }
    };
    return m;
  }

  function importModal(entries, fileName) {
    const rows = entries.map((e, i) =>
      `<label class="pm-row"><input type="checkbox" data-i="${i}" checked>` +
      `<img class="pm-thumb" data-i="${i}" alt="">` +
      `<div class="pm-row-info"><b>${esc(e.nickname)}</b>` +
      `<span>${esc(e.description.slice(0, 60) || '（无描述）')}</span>` +
      `<small>${e.image ? '含图片' : '无图片'} · ${esc(e.file)}</small></div></label>`
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
        const box = mm.querySelector('.pm-modal-content');
        box.insertAdjacentHTML('afterbegin', '<p class="pm-progress">准备导入…</p>');
        const prog = box.querySelector('.pm-progress');
        log(`开始导入 ${picked.length} 个：` + picked.map(p => p.nickname).join('、'));
        let res;
        try {
          res = await importEntries(picked, overwrite, (n, total, name) => { prog.textContent = `导入中 ${n}/${total}：${name}`; });
        } finally { busy = false; }
        await reload();
        const lines = [`<p><b>成功 ${res.ok} 个</b>（共选 ${picked.length} 个）</p>`];
        if (res.renamed) lines.push(`<p>其中 ${res.renamed} 个因为同名已自动改名新增</p>`);
        if (res.skipped.length) lines.push('<p class="pm-err">跳过：<br>' + res.skipped.map(esc).join('<br>') + '</p>');
        if (res.failed.length) lines.push('<p class="pm-err">失败：<br>' + res.failed.map(esc).join('<br>') + '</p>');
        lines.push('<p>若酒馆的人设列表没有更新，请刷新页面。</p>');
        log(`导入结束：成功 ${res.ok}，跳过 ${res.skipped.length}，失败 ${res.failed.length}`);
        res.failed.forEach(f => log('失败详情：' + f));
        box.innerHTML = lines.join('');
        const foot = mm.querySelector('footer');
        foot.innerHTML = '<button type="button" class="pm-btn pm-primary pm-done">关闭</button>';
        foot.querySelector('.pm-done').onclick = () => mm.remove();
        return false;
      },
      '导入'
    );
    // 图片预览分批赋值，避免几十张大图一次性卡死手机
    const imgs = Array.from(m.querySelectorAll('img.pm-thumb'));
    let k = 0;
    (function next() {
      const end = Math.min(k + 6, imgs.length);
      for (; k < end; k++) {
        const e = entries[Number(imgs[k].dataset.i)];
        if (e.image) imgs[k].src = e.image; else imgs[k].style.visibility = 'hidden';
      }
      if (k < imgs.length && imgs[0].isConnected) setTimeout(next, 80);
    })();
    // 后台标注同名（拿不到也不影响导入）
    listServerAvatars().then(list => {
      const set = new Set(list);
      m.querySelectorAll('.pm-row small').forEach((el, i) => {
        if (set.has(safeFileName(entries[i].file))) el.textContent += ' · 同名已存在';
      });
    }).catch(err => log('标注同名失败（不影响导入）：' + err.message));
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
      `</div><div id="pm-status"></div>` +
      `<details class="pm-details"><summary>运行日志（出问题时把这里的内容发给我）</summary><pre id="pm-log">${esc(logs.join('\n'))}</pre></details></div>`;

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
        log(`选择了文件：${file.name}（${Math.round(file.size / 1024)} KB）`);
        const entries = parseImport(await file.text());
        log(`文件里识别到 ${entries.length} 个人设：` + entries.map(x => `${x.nickname}${x.image ? '' : '（无图）'}`).join('、'));
        importModal(entries, file.name);
        log('预览窗口已打开，请勾选后点「导入」');
      } catch (err) {
        log('读取文件失败：' + err.message);
        const m = showModal('读取失败', `<p class="pm-err">${esc(err.message)}</p>`, () => true, '好的');
        m.querySelector('.pm-cancel').style.display = 'none';
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
    log('面板已挂载到：' + (target.id || target.className));
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

  window.addEventListener('error', e => {
    if (String(e.filename || '').includes(EXT)) log('脚本错误：' + e.message);
  });
  window.addEventListener('unhandledrejection', e => {
    const msg = String((e.reason && e.reason.message) || e.reason || '');
    if (msg) log('未处理的异常：' + msg);
  });

  window.personaManager = { parseImport, importEntries, buildExport, safeFileName };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
