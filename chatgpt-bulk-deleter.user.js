// ==UserScript==
// @name             ChatGPT Bulk Deleter
// @description      Deletes or archives ChatGPT conversations in bulk. Loads the list via the API instead of the DOM, with search, confirmation, progress, rate-limit handling and honest error reporting.
// @version          2.0.0
// @author           Zora
// @homepageURL      https://github.com/Zorakidd/chatgpt-bulk-deleter
// @supportURL       https://github.com/Zorakidd/chatgpt-bulk-deleter/issues
// @namespace        https://github.com/Zorakidd/chatgpt-bulk-deleter
// @match            *://chatgpt.com/*
// @match            *://www.chatgpt.com/*
// @grant            none
// @run-at           document-idle
// @license          MIT
// @downloadURL      none
// @updateURL        none
// @contributionURL  https://ko-fi.com/zora_kidd
// ==/UserScript==

/*
 * Security notes, short version:
 *
 * 1. This script only talks to chatgpt.com. No external domain, no eval,
 *    no loading of foreign code.
 * 2. The access token is read from your own session and only ever used in
 *    the Authorization header of requests to chatgpt.com.
 * 3. "Delete" sets is_visible to false. That's the same call the official
 *    delete button in the UI makes. It's a soft delete: OpenAI removes the
 *    data in the background afterwards.
 * 4. Auto-update is disabled via @downloadURL none / @updateURL none.
 *    Please pull updates deliberately and skim the diff first.
 */

(function () {
    'use strict';

    /* --------------------------------------------------------------- Config */

    const CFG = {
        pageSize: 100,          // conversations per list request
        pageDelayMs: 100,       // delay between list requests
        writeDelayMs: 300,      // delay between write requests
        maxRetries: 5,          // attempts on 429 / 5xx
        backoffCapMs: 20000,    // cap for the backoff
    };

    const EP = {
        session: '/api/auth/session',
        list: '/backend-api/conversations',
        one: (id) => `/backend-api/conversation/${encodeURIComponent(id)}`,
    };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    /* ---------------------------------------------------------------- State */

    const state = {
        token: null,
        items: [],              // loaded conversations
        selected: new Set(),
        failed: new Set(),
        query: '',
        mode: 'delete',         // 'delete' | 'archive'
        includeArchived: false,
        loaded: false,
        busy: false,
        cancel: false,
        confirming: false,
    };

    /* ------------------------------------------------------------------ API */

    async function getToken(force = false) {
        if (state.token && !force) return state.token;
        const res = await fetch(EP.session, { credentials: 'include' });
        if (!res.ok) throw new Error(`Session endpoint responded with HTTP ${res.status}`);
        const data = await res.json().catch(() => ({}));
        if (!data || !data.accessToken) {
            throw new Error('No access token in the session. Are you logged in?');
        }
        state.token = data.accessToken;
        return state.token;
    }

    async function api(path, options = {}, attempt = 0) {
        const token = await getToken();

        const res = await fetch(path, {
            credentials: 'include',
            ...options,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                ...(options.headers || {}),
            },
        });

        // Token expired: fetch a new one once and retry.
        if (res.status === 401 && attempt < 1) {
            await getToken(true);
            return api(path, options, attempt + 1);
        }

        // Rate limit or server error: wait and retry.
        if ((res.status === 429 || res.status >= 500) && attempt < CFG.maxRetries) {
            const header = Number(res.headers.get('retry-after'));
            const wait = Number.isFinite(header) && header > 0
                ? header * 1000
                : Math.min(2 ** attempt * 1000, CFG.backoffCapMs);
            log(`HTTP ${res.status}. Retrying in ${Math.round(wait / 1000)}s.`);
            await sleep(wait);
            return api(path, options, attempt + 1);
        }

        return res;
    }

    async function listPage(offset, archived) {
        const url = `${EP.list}?offset=${offset}&limit=${CFG.pageSize}&order=updated`
            + (archived ? '&is_archived=true' : '');
        const res = await api(url);
        if (!res.ok) throw new Error(`Failed to load list: HTTP ${res.status}`);
        return res.json();
    }

    async function loadAll(onProgress) {
        const byId = new Map();
        const passes = state.includeArchived ? [false, true] : [false];

        for (const archived of passes) {
            let offset = 0;
            let total = Infinity;

            while (offset < total && !state.cancel) {
                const data = await listPage(offset, archived);
                const page = Array.isArray(data.items) ? data.items : [];
                for (const item of page) {
                    byId.set(item.id, { ...item, is_archived: archived || !!item.is_archived });
                }
                total = Number.isFinite(data.total) ? data.total : byId.size;
                offset += CFG.pageSize;
                onProgress(byId.size);
                if (page.length === 0) break;
                await sleep(CFG.pageDelayMs);
            }
        }

        return [...byId.values()].sort(
            (a, b) => (toDate(b.update_time)?.getTime() || 0) - (toDate(a.update_time)?.getTime() || 0)
        );
    }

    async function applyTo(id) {
        const body = state.mode === 'archive'
            ? { is_archived: true }
            : { is_visible: false };
        const res = await api(EP.one(id), { method: 'PATCH', body: JSON.stringify(body) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }

    /* -------------------------------------------------------------- Helpers */

    function toDate(value) {
        if (value == null) return null;
        if (typeof value === 'number') return new Date(value * 1000);
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    function formatDate(value) {
        const d = toDate(value);
        if (!d) return '';
        return d.toLocaleDateString(undefined, {
            year: 'numeric', month: '2-digit', day: '2-digit',
        });
    }

    function visibleItems() {
        const q = state.query.trim().toLowerCase();
        if (!q) return state.items;
        return state.items.filter((it) => (it.title || '').toLowerCase().includes(q));
    }

    /* ------------------------------------------------------------------- UI */

    const CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
button, input, select { font: inherit; color: inherit; }

.wrap {
  font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  color: #e6e8ea;
}

.num { font-variant-numeric: tabular-nums; }

.launcher {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  display: inline-flex; align-items: center; gap: 8px;
  padding: 9px 15px;
  border: 1px solid #33383f; border-radius: 8px;
  background: #16181c; color: #e6e8ea;
  font-size: 13px; font-weight: 500; letter-spacing: .01em;
  cursor: pointer;
  box-shadow: 0 6px 20px rgba(0,0,0,.4);
}
.launcher:hover { background: #1e2126; border-color: #454b54; }
.launcher:focus-visible { outline: 2px solid #6ea8fe; outline-offset: 2px; }
.launcher .dot { width: 7px; height: 7px; border-radius: 50%; background: #e0483d; }

.scrim {
  position: fixed; inset: 0; z-index: 2147483001;
  background: rgba(6,7,9,.72);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}

.panel {
  width: min(760px, 100%); max-height: min(82vh, 900px);
  display: flex; flex-direction: column;
  background: #16181c;
  border: 1px solid #2c3037; border-radius: 12px;
  box-shadow: 0 24px 60px rgba(0,0,0,.55);
  overflow: hidden;
}

.head {
  display: flex; align-items: baseline; gap: 12px;
  padding: 16px 18px 14px;
  border-bottom: 1px solid #24282e;
}
.head h2 { margin: 0; font-size: 15px; font-weight: 600; }
.head .meta { color: #8b929c; font-size: 13px; }
.head .close {
  margin-left: auto; background: none; border: 0; color: #8b929c;
  font-size: 20px; line-height: 1; cursor: pointer; padding: 2px 6px; border-radius: 6px;
}
.head .close:hover { color: #e6e8ea; background: #24282e; }

.bar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 12px 18px; border-bottom: 1px solid #24282e;
}
.bar input[type="search"] {
  flex: 1 1 200px; min-width: 160px;
  padding: 7px 10px;
  background: #101215; border: 1px solid #2c3037; border-radius: 7px; color: #e6e8ea;
}
.bar input[type="search"]::placeholder { color: #6b7280; }
.bar input[type="search"]:focus { outline: none; border-color: #4d5966; }

.ghost {
  padding: 7px 11px; border-radius: 7px;
  background: #1e2126; border: 1px solid #2c3037; color: #cfd4da;
  font-size: 13px; cursor: pointer; white-space: nowrap;
}
.ghost:hover:not(:disabled) { background: #262a31; border-color: #3d434c; }
.ghost:disabled { opacity: .45; cursor: default; }
.ghost:focus-visible, .primary:focus-visible, .danger:focus-visible { outline: 2px solid #6ea8fe; outline-offset: 2px; }

.toggle { display: inline-flex; align-items: center; gap: 7px; color: #8b929c; font-size: 13px; cursor: pointer; }

.list { flex: 1 1 auto; overflow-y: auto; padding: 6px 10px; min-height: 120px; }
.list::-webkit-scrollbar { width: 10px; }
.list::-webkit-scrollbar-thumb { background: #2c3037; border-radius: 6px; }

.row {
  display: flex; align-items: center; gap: 11px;
  padding: 7px 9px; border-radius: 7px; cursor: pointer;
  border: 1px solid transparent;
}
.row:hover { background: #1c1f24; }
.row input { accent-color: #7f8794; width: 15px; height: 15px; flex: none; cursor: pointer; }
.row .title {
  flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.row .date { flex: none; color: #6b7280; font-size: 12px; }
.row .tag {
  flex: none; font-size: 11px; color: #8b929c;
  border: 1px solid #333940; border-radius: 5px; padding: 1px 6px;
}
.row.failed { border-color: #5c2a26; background: #241618; }
.row.failed .date { color: #d97066; }

.empty { padding: 34px 18px; text-align: center; color: #6b7280; }

.log {
  border-top: 1px solid #24282e;
  max-height: 116px; overflow-y: auto;
  padding: 9px 18px;
  font-size: 12.5px; color: #8b929c;
}
.log div + div { margin-top: 3px; }
.log .bad { color: #d97066; }
.log .good { color: #62b28a; }

.progress { height: 3px; background: #24282e; }
.progress > i { display: block; height: 100%; width: 0; background: #62b28a; transition: width .15s linear; }

.foot {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 13px 18px; border-top: 1px solid #24282e; background: #131519;
}
.foot .count { color: #8b929c; font-size: 13px; margin-right: auto; }
.foot .count b { color: #e6e8ea; font-weight: 600; }

select.mode {
  padding: 7px 9px; border-radius: 7px;
  background: #1e2126; border: 1px solid #2c3037; color: #cfd4da; font-size: 13px; cursor: pointer;
}

.primary {
  padding: 7px 14px; border-radius: 7px; cursor: pointer;
  background: #e6e8ea; border: 1px solid #e6e8ea; color: #16181c; font-weight: 600; font-size: 13px;
}
.primary:hover:not(:disabled) { background: #fff; }
.primary:disabled { opacity: .35; cursor: default; }

.danger {
  padding: 7px 14px; border-radius: 7px; cursor: pointer;
  background: #e0483d; border: 1px solid #e0483d; color: #fff; font-weight: 600; font-size: 13px;
}
.danger:hover { background: #c93c32; }

.confirm { color: #f0b9b3; font-size: 13px; margin-right: auto; }

@media (prefers-reduced-motion: reduce) { .progress > i { transition: none; } }
`;

    let host = null;
    let root = null;
    let el = {};
    let escHandler = null;

    function mount() {
        if (host && document.body.contains(host)) return;

        el = {};
        escHandler = null;

        host = document.createElement('div');
        host.id = 'cgpt-bulk-deleter-host';
        root = host.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = CSS;

        const wrap = document.createElement('div');
        wrap.className = 'wrap';

        const launcher = document.createElement('button');
        launcher.className = 'launcher';
        launcher.type = 'button';
        launcher.innerHTML = '<span class="dot"></span><span>Clean up chats</span>';
        launcher.addEventListener('click', openPanel);

        wrap.appendChild(launcher);
        root.append(style, wrap);
        document.body.appendChild(host);

        el.wrap = wrap;
        el.launcher = launcher;
    }

    function openPanel() {
        if (el.scrim) return;

        const scrim = document.createElement('div');
        scrim.className = 'scrim';
        scrim.addEventListener('mousedown', (e) => {
            if (e.target === scrim) closePanel();
        });

        const panel = document.createElement('div');
        panel.className = 'panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');

        panel.innerHTML = `
      <div class="head">
        <h2>Clean up chats</h2>
        <span class="meta" id="meta">Nothing loaded yet</span>
        <button class="close" id="close" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="bar">
        <button class="ghost" id="load" type="button">Load chats</button>
        <input type="search" id="search" placeholder="Filter by title" autocomplete="off">
        <button class="ghost" id="selAll" type="button" disabled>Select visible</button>
        <button class="ghost" id="selNone" type="button" disabled>Clear selection</button>
        <label class="toggle"><input type="checkbox" id="arch"> Include archived</label>
      </div>
      <div class="list" id="list">
        <div class="empty">Click "Load chats". The list comes straight from the API, so you don't have to scroll through the sidebar.</div>
      </div>
      <div class="log" id="log" hidden></div>
      <div class="progress"><i id="bar"></i></div>
      <div class="foot" id="foot"></div>
    `;

        scrim.appendChild(panel);
        el.wrap.appendChild(scrim);

        el.scrim = scrim;
        el.panel = panel;
        el.meta = panel.querySelector('#meta');
        el.list = panel.querySelector('#list');
        el.log = panel.querySelector('#log');
        el.progress = panel.querySelector('#bar');
        el.foot = panel.querySelector('#foot');
        el.load = panel.querySelector('#load');
        el.search = panel.querySelector('#search');
        el.selAll = panel.querySelector('#selAll');
        el.selNone = panel.querySelector('#selNone');
        el.arch = panel.querySelector('#arch');

        panel.querySelector('#close').addEventListener('click', closePanel);
        el.load.addEventListener('click', doLoad);
        el.arch.addEventListener('change', () => { state.includeArchived = el.arch.checked; });
        el.search.addEventListener('input', () => {
            state.query = el.search.value;
            renderList();
            renderFoot();
        });
        el.selAll.addEventListener('click', () => {
            for (const it of visibleItems()) state.selected.add(it.id);
            renderList();
            renderFoot();
        });
        el.selNone.addEventListener('click', () => {
            state.selected.clear();
            renderList();
            renderFoot();
        });

        escHandler = (e) => { if (e.key === 'Escape') closePanel(); };
        document.addEventListener('keydown', escHandler);

        if (state.loaded) {
            el.arch.checked = state.includeArchived;
            renderList();
        }
        renderFoot();
        renderMeta();
        el.search.focus();
    }

    function closePanel() {
        if (state.busy) {
            log('Still running. Cancel or wait first.', 'bad');
            return;
        }
        if (escHandler) {
            document.removeEventListener('keydown', escHandler);
            escHandler = null;
        }
        if (el.scrim) el.scrim.remove();
        el.scrim = null;
        state.confirming = false;
    }

    function log(text, kind = '') {
        if (!el.log) return;
        el.log.hidden = false;
        const line = document.createElement('div');
        if (kind) line.className = kind;
        line.textContent = text;
        el.log.appendChild(line);
        el.log.scrollTop = el.log.scrollHeight;
    }

    function setProgress(done, total) {
        if (!el.progress) return;
        el.progress.style.width = total > 0 ? `${(done / total) * 100}%` : '0';
    }

    function plural(n) {
        return n === 1 ? 'chat' : 'chats';
    }

    function renderMeta() {
        if (!el.meta) return;
        el.meta.textContent = state.loaded
            ? `${state.items.length} ${plural(state.items.length)} loaded`
            : 'Nothing loaded yet';
    }

    function renderList() {
        if (!el.list) return;
        const items = visibleItems();
        el.list.replaceChildren();

        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = state.loaded
                ? 'No chat matches this filter.'
                : 'Click "Load chats". The list comes straight from the API, so you don\'t have to scroll through the sidebar.';
            el.list.appendChild(empty);
            return;
        }

        const frag = document.createDocumentFragment();
        for (const it of items) {
            const row = document.createElement('label');
            row.className = 'row' + (state.failed.has(it.id) ? ' failed' : '');
            row.dataset.id = it.id;

            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = state.selected.has(it.id);
            box.addEventListener('change', () => {
                if (box.checked) state.selected.add(it.id);
                else state.selected.delete(it.id);
                renderFoot();
            });

            const title = document.createElement('span');
            title.className = 'title';
            title.textContent = it.title || 'Untitled';

            row.append(box, title);

            if (it.is_archived) {
                const tag = document.createElement('span');
                tag.className = 'tag';
                tag.textContent = 'archived';
                row.appendChild(tag);
            }

            const date = document.createElement('span');
            date.className = 'date num';
            date.textContent = formatDate(it.update_time);
            row.appendChild(date);

            frag.appendChild(row);
        }
        el.list.appendChild(frag);
    }

    function renderFoot() {
        if (!el.foot) return;
        el.foot.replaceChildren();

        const n = state.selected.size;
        const canAct = n > 0 && !state.busy;

        if (el.selAll) el.selAll.disabled = !state.loaded || state.busy;
        if (el.selNone) el.selNone.disabled = n === 0 || state.busy;
        if (el.load) el.load.disabled = state.busy;

        if (state.busy) {
            const info = document.createElement('span');
            info.className = 'count';
            info.id = 'busyText';
            info.textContent = 'Running...';

            const cancel = document.createElement('button');
            cancel.className = 'ghost';
            cancel.type = 'button';
            cancel.textContent = 'Cancel';
            cancel.addEventListener('click', () => {
                state.cancel = true;
                cancel.disabled = true;
                cancel.textContent = 'Cancelling...';
            });

            el.foot.append(info, cancel);
            el.busyText = info;
            return;
        }

        if (state.confirming) {
            const verb = state.mode === 'archive' ? 'archive' : 'delete';
            const q = document.createElement('span');
            q.className = 'confirm';
            q.innerHTML = `Really ${verb} <b class="num">${n}</b> ${plural(n)}?`;

            const back = document.createElement('button');
            back.className = 'ghost';
            back.type = 'button';
            back.textContent = 'Back';
            back.addEventListener('click', () => { state.confirming = false; renderFoot(); });

            const go = document.createElement('button');
            go.className = 'danger';
            go.type = 'button';
            go.textContent = state.mode === 'archive' ? 'Archive' : 'Delete';
            go.addEventListener('click', () => { state.confirming = false; run(); });

            el.foot.append(q, back, go);
            go.focus();
            return;
        }

        const count = document.createElement('span');
        count.className = 'count';
        count.innerHTML = `<b class="num">${n}</b> of <span class="num">${visibleItems().length}</span> selected`;

        const mode = document.createElement('select');
        mode.className = 'mode';
        mode.innerHTML = `
      <option value="delete">Delete</option>
      <option value="archive">Archive</option>
    `;
        mode.value = state.mode;
        mode.addEventListener('change', () => { state.mode = mode.value; renderFoot(); });

        el.foot.append(count, mode);

        if (state.failed.size) {
            const retry = document.createElement('button');
            retry.className = 'ghost';
            retry.type = 'button';
            retry.textContent = `Select failed (${state.failed.size})`;
            retry.addEventListener('click', () => {
                state.selected = new Set(state.failed);
                renderList();
                renderFoot();
            });
            el.foot.appendChild(retry);
        }

        const go = document.createElement('button');
        go.className = 'primary';
        go.type = 'button';
        go.disabled = !canAct;
        go.textContent = state.mode === 'archive' ? 'Archive' : 'Delete';
        go.addEventListener('click', () => { state.confirming = true; renderFoot(); });
        el.foot.appendChild(go);
    }

    /* ------------------------------------------------------------- Actions */

    async function doLoad() {
        if (state.busy) return;
        state.busy = true;
        state.cancel = false;
        state.selected.clear();
        state.failed.clear();
        renderFoot();
        log('Loading conversations...');

        try {
            const items = await loadAll((count) => {
                if (el.busyText) el.busyText.textContent = `${count} loaded...`;
            });
            state.items = items;
            state.loaded = true;
            log(`${items.length} ${plural(items.length)} loaded.`, 'good');
        } catch (err) {
            log(String(err.message || err), 'bad');
        } finally {
            state.busy = false;
            setProgress(0, 1);
            renderList();
            renderFoot();
            renderMeta();
        }
    }

    async function run() {
        const targets = state.items.filter((it) => state.selected.has(it.id));
        if (!targets.length) return;

        state.busy = true;
        state.cancel = false;
        state.failed.clear();
        renderFoot();

        const verb = state.mode === 'archive' ? 'Archived' : 'Deleted';
        let ok = 0;
        let bad = 0;

        setProgress(0, targets.length);

        for (let i = 0; i < targets.length; i++) {
            if (state.cancel) {
                log(`Cancelled after ${i} of ${targets.length}.`, 'bad');
                break;
            }
            const it = targets[i];
            try {
                await applyTo(it.id);
                ok++;
                state.items = state.items.filter((x) => x.id !== it.id);
                state.selected.delete(it.id);
                const row = el.list.querySelector(`.row[data-id="${CSS_ESCAPE(it.id)}"]`);
                if (row) row.remove();
            } catch (err) {
                bad++;
                state.failed.add(it.id);
                const row = el.list.querySelector(`.row[data-id="${CSS_ESCAPE(it.id)}"]`);
                if (row) row.classList.add('failed');
                log(`Failed: ${it.title || 'Untitled'} (${err.message})`, 'bad');
            }

            setProgress(i + 1, targets.length);
            if (el.busyText) el.busyText.textContent = `${i + 1} of ${targets.length}`;
            if (i < targets.length - 1) await sleep(CFG.writeDelayMs);
        }

        state.busy = false;
        log(`${verb}: ${ok}. Failed: ${bad}.`, bad ? 'bad' : 'good');
        renderList();
        renderFoot();
        renderMeta();
    }

    // CSS.escape isn't available everywhere, hence a small fallback.
    function CSS_ESCAPE(value) {
        if (window.CSS && typeof window.CSS.escape === 'function') {
            return window.CSS.escape(value);
        }
        return String(value).replace(/["\\]/g, '\\$&');
    }

    /* ----------------------------------------------------------------- Boot */

    mount();
    // ChatGPT is an SPA. If the host ever gets removed from the DOM, remount it.
    setInterval(() => {
        if (!host || !document.body.contains(host)) {
            host = null;
            mount();
        }
    }, 4000);
})();
