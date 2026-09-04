// ==UserScript==
// @name             ChatGPT Bulk Deleter
// @description      Deletes or archives ChatGPT conversations in bulk. Loads the list via the API instead of the DOM, with search, confirmation, progress, rate-limit handling and honest error reporting.
// @version          3.0.0
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
 *    no loading of foreign code. Every request goes to an absolute URL built
 *    from a hard-coded path on the current origin, and the origin itself is
 *    verified before anything starts.
 * 2. The access token is read from your own session and only ever used in
 *    the Authorization header of requests to chatgpt.com. It is never logged,
 *    never rendered, never stored outside of memory.
 * 3. "Delete" sets is_visible to false. That's the same call the official
 *    delete button in the UI makes. It's a soft delete: OpenAI removes the
 *    data in the background afterwards.
 * 4. Everything the server sends back is treated as untrusted input: ids are
 *    validated against a strict pattern, titles are sanitised, and text only
 *    ever enters the DOM as text, never as markup.
 * 5. Auto-update is disabled via @downloadURL none / @updateURL none.
 *    Please pull updates deliberately and skim the diff first.
 */

(function () {
    'use strict';

    /* ------------------------------------------------------------- Guards */

    const HOST_ID = 'cgpt-bulk-deleter-host';
    const FLAG = '__cgptBulkDeleterActive';
    const ALLOWED_HOSTS = new Set(['chatgpt.com', 'www.chatgpt.com']);

    // Top frame only, expected origin only, once per document only.
    if (window.top !== window.self) return;
    if (location.protocol !== 'https:') return;
    if (!ALLOWED_HOSTS.has(location.hostname)) return;
    if (window[FLAG] === true || document.getElementById(HOST_ID)) return;
    try {
        Object.defineProperty(window, FLAG, { value: true, configurable: false });
    } catch {
        window[FLAG] = true;
    }

    /* ------------------------------------------------------------- Config */

    const CFG = {
        pageSize: 100,            // conversations per list request
        pageDelayMs: 120,         // delay between list requests
        writeConcurrency: 3,      // parallel delete/archive requests
        writeDelayMs: 220,        // per-worker spacing between writes
        writeDelayMaxMs: 2500,    // upper bound once the server pushes back
        maxRetries: 5,            // attempts on 429 / 5xx / network error
        backoffCapMs: 20000,      // cap for the exponential backoff
        retryAfterCapMs: 60000,   // cap for a Retry-After header
        requestTimeoutMs: 30000,  // per-request timeout
        maxPages: 500,            // hard stop, 50k conversations per pass
        maxLogLines: 300,         // log lines kept in the DOM
        rowHeight: 34,            // fixed row height, required by the virtual list
        overscan: 6,              // rows rendered above and below the viewport
        confirmArmMs: 700,        // dead time before the destructive button arms
        maxTitleChars: 300,       // titles are truncated before they reach the DOM
    };

    const ORIGIN = location.origin;
    const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

    const EP = {
        session: '/api/auth/session',
        list: '/backend-api/conversations',
        one: (id) => `/backend-api/conversation/${encodeURIComponent(id)}`,
    };

    /* ------------------------------------------------------------- Basics */

    const nf = new Intl.NumberFormat();
    let df;
    try {
        df = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
        df = { format: (d) => d.toISOString().slice(0, 10) };
    }

    const num = (n) => nf.format(n);
    const plural = (n) => (n === 1 ? 'chat' : 'chats');

    function abortError(message = 'Cancelled') {
        try {
            return new DOMException(message, 'AbortError');
        } catch {
            const err = new Error(message);
            err.name = 'AbortError';
            return err;
        }
    }

    const isCancel = (err) => !!err && err.name === 'AbortError';

    function throwIfAborted(signal) {
        if (signal && signal.aborted) throw abortError();
    }

    /** Strips control characters and truncates. Everything from the server passes through here. */
    function clean(value, max) {
        let s = typeof value === 'string' ? value : String(value == null ? '' : value);
        s = s.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (s.length > max) s = s.slice(0, max - 1) + '…';
        return s;
    }

    /** Readable error text that never carries a token or raw markup. */
    function describe(err) {
        if (!err) return 'Unknown error';
        if (typeof err === 'string') return clean(err, 200);
        if (err.name === 'TimeoutError') return 'Request timed out';
        if (err.name === 'AbortError') return 'Cancelled';
        return clean(err.message || String(err), 200);
    }

    /** A sleep that wakes up early when the run is cancelled. */
    function sleep(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) {
                reject(abortError());
                return;
            }
            const timer = setTimeout(() => {
                detach();
                resolve();
            }, Math.max(0, ms));
            const onAbort = () => {
                clearTimeout(timer);
                detach();
                reject(abortError());
            };
            function detach() {
                if (signal) signal.removeEventListener('abort', onAbort);
            }
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    /* ---------------------------------------------------------------- Auth */

    // Deliberately outside `state`: no UI code can reach the token.
    const auth = { token: null, expiresAt: 0, inflight: null };

    async function fetchToken() {
        const res = await fetch(ORIGIN + EP.session, {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
            await drain(res);
            throw new Error(res.status === 401 || res.status === 403
                ? 'Not logged in. Sign in to chatgpt.com in this tab first.'
                : `Session endpoint responded with HTTP ${res.status}`);
        }
        const data = await readJson(res);
        const token = data && typeof data.accessToken === 'string' ? data.accessToken : '';
        if (!token) throw new Error('No access token in the session. Are you logged in?');

        // Trust the session expiry when it looks sane, otherwise assume 20 minutes.
        const parsed = data.expires ? Date.parse(data.expires) : NaN;
        auth.expiresAt = Number.isFinite(parsed) && parsed > Date.now()
            ? parsed - 60000
            : Date.now() + 20 * 60 * 1000;
        auth.token = token;
        return token;
    }

    /** Single flight: parallel workers share one refresh instead of stampeding the endpoint. */
    function getToken(force = false) {
        if (!force && auth.token && Date.now() < auth.expiresAt) return Promise.resolve(auth.token);
        if (!auth.inflight) {
            if (force) auth.token = null;
            auth.inflight = fetchToken().finally(() => { auth.inflight = null; });
        }
        return auth.inflight;
    }

    /* ------------------------------------------------------------ Network */

    // Shared by all workers: one 429 slows the whole pool down, not just one request.
    const pacing = { cooldownUntil: 0, writeDelayMs: CFG.writeDelayMs, streak: 0 };

    function throttle(waitMs) {
        pacing.cooldownUntil = Math.max(pacing.cooldownUntil, Date.now() + waitMs);
        pacing.writeDelayMs = Math.min(Math.round(pacing.writeDelayMs * 1.8) + 50, CFG.writeDelayMaxMs);
        pacing.streak = 0;
    }

    function relax() {
        pacing.streak++;
        if (pacing.streak >= 25 && pacing.writeDelayMs > CFG.writeDelayMs) {
            pacing.writeDelayMs = Math.max(CFG.writeDelayMs, Math.round(pacing.writeDelayMs * 0.8));
            pacing.streak = 0;
        }
    }

    async function waitForCooldown(signal) {
        const wait = pacing.cooldownUntil - Date.now();
        if (wait > 0) await sleep(wait, signal);
    }

    /** Frees the connection for a response we are about to throw away. */
    function drain(res) {
        try {
            if (res.body && typeof res.body.cancel === 'function') return res.body.cancel().catch(() => {});
            return res.text().then(() => {}, () => {});
        } catch {
            return Promise.resolve();
        }
    }

    async function readJson(res) {
        const text = await res.text();
        try {
            return JSON.parse(text);
        } catch {
            // A login redirect or an interstitial lands here. Say that, don't throw SyntaxError.
            throw new Error(`Unexpected non-JSON response (HTTP ${res.status}). The API may have moved, or the session expired.`);
        }
    }

    /** External signal plus per-request timeout, without leaking timers or listeners. */
    function linkSignal(external, timeoutMs) {
        const ctl = new AbortController();
        let timer = null;
        const onExternal = () => ctl.abort(abortError());
        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                let reason;
                try {
                    reason = new DOMException('Request timed out', 'TimeoutError');
                } catch {
                    reason = abortError('Request timed out');
                }
                ctl.abort(reason);
            }, timeoutMs);
        }
        if (external) {
            if (external.aborted) onExternal();
            else external.addEventListener('abort', onExternal, { once: true });
        }
        return {
            signal: ctl.signal,
            release() {
                if (timer !== null) clearTimeout(timer);
                if (external) external.removeEventListener('abort', onExternal);
            },
        };
    }

    function parseRetryAfter(value) {
        if (!value) return 0;
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, CFG.retryAfterCapMs);
        const date = Date.parse(value);
        if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), CFG.retryAfterCapMs);
        return 0;
    }

    function backoff(attempt) {
        const base = Math.min(2 ** attempt * 500, CFG.backoffCapMs);
        return Math.round(base * (0.75 + Math.random() * 0.5)); // jitter, so parallel workers spread out
    }

    /**
     * One request with retries. Iterative instead of recursive, and the auth refresh
     * has its own budget so a rate limit can't eat the single 401 retry.
     */
    async function api(path, { method = 'GET', body = null, signal = null } = {}) {
        let attempt = 0;
        let authRetries = 0;

        for (;;) {
            throwIfAborted(signal);
            await waitForCooldown(signal);

            const token = await getToken(false);
            const link = linkSignal(signal, CFG.requestTimeoutMs);
            let res;

            try {
                res = await fetch(ORIGIN + path, {
                    method,
                    body,
                    credentials: 'same-origin',
                    cache: 'no-store',
                    referrerPolicy: 'same-origin',
                    headers: Object.assign(
                        { Accept: 'application/json', Authorization: `Bearer ${token}` },
                        body ? { 'Content-Type': 'application/json' } : null
                    ),
                    signal: link.signal,
                });
            } catch (err) {
                if (signal && signal.aborted) throw abortError();
                if (attempt < CFG.maxRetries) {
                    attempt++;
                    await sleep(backoff(attempt), signal);
                    continue;
                }
                throw new Error(describe(err));
            } finally {
                link.release();
            }

            // Expired token: refresh once, then let the status speak for itself.
            if ((res.status === 401 || res.status === 403) && authRetries < 1) {
                authRetries++;
                await drain(res);
                await getToken(true);
                continue;
            }

            if ((res.status === 429 || res.status >= 500) && attempt < CFG.maxRetries) {
                attempt++;
                const wait = parseRetryAfter(res.headers.get('retry-after')) || backoff(attempt);
                await drain(res);
                if (res.status === 429) throttle(wait);
                log(`HTTP ${res.status}. Retrying in ${Math.max(1, Math.round(wait / 1000))}s.`);
                await sleep(wait, signal);
                continue;
            }

            if (res.ok) relax();
            return res;
        }
    }

    /** Turns a failed response into an error that says something useful. */
    async function httpError(res, what) {
        let detail = '';
        try {
            const data = JSON.parse((await res.text()).slice(0, 500));
            const raw = data && (data.detail || data.message || (data.error && (data.error.message || data.error)));
            if (typeof raw === 'string') detail = clean(raw, 120);
        } catch {
            /* not JSON, the status has to carry the message */
        }
        const hint = res.status === 401 || res.status === 403
            ? ' Session expired, reload the page.'
            : res.status === 429
                ? ' Rate limited, try a smaller batch.'
                : '';
        return new Error(`${what}: HTTP ${res.status}${detail ? ` (${detail})` : ''}${hint}`);
    }

    /* --------------------------------------------------------------- Data */

    function toEpoch(value) {
        if (value == null) return 0;
        if (typeof value === 'number') return Number.isFinite(value) ? value * 1000 : 0;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function formatDate(epoch) {
        if (!epoch) return '';
        try {
            return df.format(new Date(epoch));
        } catch {
            return '';
        }
    }

    /**
     * Server payload in, safe view model out. Anything malformed is dropped rather
     * than carried around, so no later stage has to second-guess the shape.
     */
    function normalize(raw, archivedPass) {
        if (!raw || typeof raw !== 'object') return null;
        const id = typeof raw.id === 'string' ? raw.id : '';
        if (!ID_RE.test(id)) return null;
        const title = clean(raw.title, CFG.maxTitleChars) || 'Untitled';
        const updated = toEpoch(raw.update_time);
        return {
            id,
            title,
            search: title.toLowerCase(),
            updated,
            date: formatDate(updated),
            archived: archivedPass === true || raw.is_archived === true,
        };
    }

    async function listPage(offset, archived, signal) {
        const url = `${EP.list}?offset=${offset}&limit=${CFG.pageSize}&order=updated`
            + (archived ? '&is_archived=true' : '');
        const res = await api(url, { signal });
        if (!res.ok) throw await httpError(res, 'Failed to load the list');
        return readJson(res);
    }

    /**
     * Walks both passes page by page. Termination is driven by the page length,
     * not by a `total` the server may omit, and a page counter caps the worst case.
     */
    async function loadAll(signal, onProgress) {
        const byId = new Map();
        const passes = state.includeArchived ? [false, true] : [false];
        let truncated = false;

        for (const archived of passes) {
            let offset = 0;
            let pages = 0;

            for (;;) {
                throwIfAborted(signal);

                if (pages >= CFG.maxPages) {
                    truncated = true;
                    break;
                }

                const data = await listPage(offset, archived, signal);
                const page = Array.isArray(data && data.items) ? data.items : [];

                for (const raw of page) {
                    const item = normalize(raw, archived);
                    if (!item) continue;
                    const seen = byId.get(item.id);
                    // The archived pass may re-list a chat: keep the stronger flag.
                    if (seen) seen.archived = seen.archived || item.archived;
                    else byId.set(item.id, item);
                }

                pages++;
                onProgress(byId.size);

                if (page.length < CFG.pageSize) break;      // short page means last page
                // Advance by what we asked for, capped by what arrived. A page that is longer
                // than the limit must not push the cursor past conversations we never saw.
                offset += Math.min(page.length, CFG.pageSize);
                const total = data && Number(data.total);
                if (Number.isFinite(total) && offset >= total) break;

                await sleep(CFG.pageDelayMs, signal);
            }
        }

        const items = [...byId.values()].sort((a, b) => b.updated - a.updated);
        return { items, truncated };
    }

    // The mode is passed in, not read from state: a running job keeps doing what it was started for.
    async function applyTo(item, mode, signal) {
        const body = mode === 'archive' ? { is_archived: true } : { is_visible: false };
        const res = await api(EP.one(item.id), { method: 'PATCH', body: JSON.stringify(body), signal });
        if (res.status === 404) {                            // already gone, that is the desired end state
            await drain(res);
            return;
        }
        if (!res.ok) throw await httpError(res, mode === 'archive' ? 'Archive failed' : 'Delete failed');
        await drain(res);
    }

    /* -------------------------------------------------------------- State */

    const state = {
        items: [],                 // normalized conversations, newest first
        selected: new Set(),
        failed: new Set(),
        done: new Set(),           // finished during the current run, still shown as struck through
        query: '',
        mode: 'delete',            // 'delete' | 'archive'
        includeArchived: false,
        loaded: false,
        stale: false,              // the archived toggle changed after loading
        busy: false,
        confirming: false,
        abort: null,               // AbortController for the running job
        activeIndex: -1,           // keyboard cursor into the filtered list
        anchorIndex: -1,           // shift-click / shift-arrow anchor
        progress: { done: 0, total: 0, label: '' },
    };

    let filterCache = { query: null, source: null, result: [] };

    function visibleItems() {
        const q = state.query.trim().toLowerCase();
        if (filterCache.source === state.items && filterCache.query === q) return filterCache.result;
        const result = q ? state.items.filter((it) => it.search.includes(q)) : state.items;
        filterCache = { query: q, source: state.items, result };
        return result;
    }

    function setItems(items) {
        state.items = items;
        filterCache = { query: null, source: null, result: [] };
    }

    /* ----------------------------------------------------------------- UI */

    const CSS = `
:host { all: initial; display: block; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
button, input, select { font: inherit; color: inherit; margin: 0; }

.wrap {
  --bg: #16181c; --bg2: #131519; --bg3: #101215;
  --line: #24282e; --line2: #2c3037; --line3: #3d434c;
  --fg: #e6e8ea; --dim: #8b929c; --dim2: #6b7280;
  --hover: #1c1f24; --sel: #202a3a; --chip: #1e2126;
  --accent: #6ea8fe; --danger: #e0483d; --danger2: #c93c32;
  --good: #62b28a; --bad: #d97066; --shadow: rgba(0,0,0,.45);
  font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px; line-height: 1.45; color: var(--fg);
}
.wrap[data-theme="light"] {
  --bg: #ffffff; --bg2: #f7f8fa; --bg3: #ffffff;
  --line: #e6e8ec; --line2: #d8dbe1; --line3: #b9bfc9;
  --fg: #14161a; --dim: #5b6270; --dim2: #868d99;
  --hover: #f1f3f6; --sel: #e6effd; --chip: #f2f4f7;
  --accent: #2563eb; --danger: #d33a2f; --danger2: #b52f26;
  --good: #1f8b5f; --bad: #b3382b; --shadow: rgba(15,20,30,.18);
}

.num { font-variant-numeric: tabular-nums; }

.launcher {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  display: inline-flex; align-items: center; gap: 8px;
  padding: 9px 15px;
  border: 1px solid var(--line2); border-radius: 8px;
  background: var(--bg); color: var(--fg);
  font-size: 13px; font-weight: 500; letter-spacing: .01em;
  cursor: pointer; box-shadow: 0 6px 20px var(--shadow);
}
.launcher:hover { background: var(--hover); border-color: var(--line3); }
.launcher:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.launcher .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--danger); }

.scrim {
  position: fixed; inset: 0; z-index: 2147483001;
  background: rgba(6,7,9,.72);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}

.panel {
  width: min(760px, 100%); max-height: min(82vh, 900px);
  display: flex; flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--line2); border-radius: 12px;
  box-shadow: 0 24px 60px var(--shadow);
  overflow: hidden;
}

.head { display: flex; align-items: baseline; gap: 12px; padding: 16px 18px 14px; border-bottom: 1px solid var(--line); }
.head h2 { margin: 0; font-size: 15px; font-weight: 600; }
.head .meta { color: var(--dim); font-size: 13px; }
.head .close {
  margin-left: auto; background: none; border: 0; color: var(--dim);
  font-size: 20px; line-height: 1; cursor: pointer; padding: 2px 6px; border-radius: 6px;
}
.head .close:hover { color: var(--fg); background: var(--line); }

.bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 18px; border-bottom: 1px solid var(--line); }
.bar input[type="search"] {
  flex: 1 1 200px; min-width: 160px; padding: 7px 10px;
  background: var(--bg3); border: 1px solid var(--line2); border-radius: 7px; color: var(--fg);
}
.bar input[type="search"]::placeholder { color: var(--dim2); }
.bar input[type="search"]:focus { outline: none; border-color: var(--line3); }

.ghost {
  padding: 7px 11px; border-radius: 7px;
  background: var(--chip); border: 1px solid var(--line2); color: var(--fg);
  font-size: 13px; cursor: pointer; white-space: nowrap;
}
.ghost:hover:not(:disabled) { background: var(--hover); border-color: var(--line3); }
.ghost:disabled { opacity: .45; cursor: default; }
.ghost:focus-visible, .primary:focus-visible, .danger:focus-visible, .mode:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.toggle { display: inline-flex; align-items: center; gap: 7px; color: var(--dim); font-size: 13px; cursor: pointer; }
.toggle input { accent-color: var(--accent); }

.list {
  position: relative; flex: 1 1 auto; overflow-y: auto; overflow-x: hidden;
  padding: 6px 10px; min-height: 140px; outline: none;
  overscroll-behavior: contain;
}
.list:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
.list::-webkit-scrollbar { width: 10px; }
.list::-webkit-scrollbar-thumb { background: var(--line2); border-radius: 6px; }
.sizer { position: relative; width: 100%; }

.row {
  position: absolute; top: 0; left: 0; right: 0; height: ${CFG.rowHeight}px;
  display: flex; align-items: center; gap: 11px;
  padding: 0 9px; border-radius: 7px; cursor: pointer;
  border: 1px solid transparent; user-select: none; contain: layout paint;
}
.row:hover { background: var(--hover); }
.row.sel { background: var(--sel); }
.row.active { border-color: var(--line3); }
.row .box {
  flex: none; width: 15px; height: 15px; border-radius: 4px;
  border: 1px solid var(--line3); background: var(--bg3); position: relative;
}
.row.sel .box { background: var(--accent); border-color: var(--accent); }
.row.sel .box::after {
  content: ""; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px;
  border: solid var(--bg); border-width: 0 2px 2px 0; transform: rotate(45deg);
}
.row .title { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .date { flex: none; color: var(--dim2); font-size: 12px; }
.row .tag { flex: none; font-size: 11px; color: var(--dim); border: 1px solid var(--line2); border-radius: 5px; padding: 1px 6px; }
.row.failed { border-color: var(--bad); }
.row.failed .date { color: var(--bad); }
.row.done { opacity: .4; }
.row.done .title { text-decoration: line-through; }

.empty { padding: 34px 18px; text-align: center; color: var(--dim2); }

.log { border-top: 1px solid var(--line); max-height: 116px; overflow-y: auto; padding: 9px 18px; font-size: 12.5px; color: var(--dim); }
.log div + div { margin-top: 3px; }
.log .bad { color: var(--bad); }
.log .good { color: var(--good); }

.progress { height: 3px; background: var(--line); }
.progress > i { display: block; height: 100%; width: 0; background: var(--good); transition: width .15s linear; }

.foot { padding: 13px 18px; border-top: 1px solid var(--line); background: var(--bg2); }
.grp { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.count { color: var(--dim); font-size: 13px; margin-right: auto; }
.count b { color: var(--fg); font-weight: 600; }
.hint { color: var(--dim2); font-size: 12px; flex-basis: 100%; }

select.mode {
  padding: 7px 9px; border-radius: 7px;
  background: var(--chip); border: 1px solid var(--line2); color: var(--fg); font-size: 13px; cursor: pointer;
}

.primary {
  padding: 7px 14px; border-radius: 7px; cursor: pointer;
  background: var(--fg); border: 1px solid var(--fg); color: var(--bg); font-weight: 600; font-size: 13px;
}
.primary:hover:not(:disabled) { opacity: .88; }
.primary:disabled { opacity: .35; cursor: default; }

.danger {
  padding: 7px 14px; border-radius: 7px; cursor: pointer;
  background: var(--danger); border: 1px solid var(--danger); color: #fff; font-weight: 600; font-size: 13px;
}
.danger:hover:not(:disabled) { background: var(--danger2); }
.danger:disabled { opacity: .5; cursor: default; }

.confirm { color: var(--fg); font-size: 13px; margin-right: auto; }
.confirm b { font-weight: 700; }

@media (prefers-reduced-motion: reduce) { .progress > i { transition: none; } }
`;

    let host = null;
    let root = null;
    let wrap = null;
    const el = {};
    const rowPool = [];
    const logBuffer = [];
    let docKeyHandler = null;
    let confirmTimer = null;
    let searchTimer = null;
    let listResize = null;
    let lastFocus = null;

    /* ----------------------------------------------------- Render batching */

    const dirty = new Set();
    let frameQueued = false;

    function schedule(...parts) {
        for (const part of parts) dirty.add(part);
        if (frameQueued) return;
        frameQueued = true;
        requestAnimationFrame(flush);
    }

    function flush() {
        frameQueued = false;
        const parts = new Set(dirty);
        dirty.clear();
        if (parts.has('list')) renderList();
        if (parts.has('foot')) renderFoot();
        if (parts.has('meta')) renderMeta();
        if (parts.has('progress')) renderProgress();
    }

    /* --------------------------------------------------------- Shell/mount */

    function detectTheme() {
        const html = document.documentElement;
        if (html.classList.contains('dark')) return 'dark';
        if (html.classList.contains('light')) return 'light';
        const scheme = (html.style.colorScheme || '').trim();
        if (scheme === 'dark' || scheme === 'light') return scheme;
        try {
            return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        } catch {
            return 'dark';
        }
    }

    function applyTheme() {
        if (wrap) wrap.dataset.theme = detectTheme();
    }

    function build() {
        host = document.createElement('div');
        host.id = HOST_ID;
        root = host.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = CSS;

        wrap = document.createElement('div');
        wrap.className = 'wrap';

        const launcher = document.createElement('button');
        launcher.className = 'launcher';
        launcher.type = 'button';
        const dot = document.createElement('span');
        dot.className = 'dot';
        const label = document.createElement('span');
        label.textContent = 'Clean up chats';
        launcher.append(dot, label);
        launcher.addEventListener('click', openPanel);

        wrap.appendChild(launcher);
        root.append(style, wrap);

        el.launcher = launcher;
        applyTheme();
    }

    /**
     * The SPA replaces large parts of the DOM. Re-attaching the same host keeps the
     * shadow tree, the open panel and a running job alive instead of rebuilding them.
     */
    function ensureMounted() {
        if (!document.body) return;
        if (!host) build();
        if (!document.body.contains(host)) document.body.appendChild(host);
    }

    /* --------------------------------------------------------------- Panel */

    const PANEL_HTML = `
<div class="head">
  <h2 id="title">Clean up chats</h2>
  <span class="meta" id="meta">Nothing loaded yet</span>
  <button class="close" id="close" type="button" aria-label="Close">&times;</button>
</div>
<div class="bar">
  <button class="ghost" id="load" type="button">Load chats</button>
  <input type="search" id="search" placeholder="Filter by title" autocomplete="off" spellcheck="false" aria-label="Filter by title">
  <button class="ghost" id="selAll" type="button" disabled>Select visible</button>
  <button class="ghost" id="selNone" type="button" disabled>Clear selection</button>
  <label class="toggle"><input type="checkbox" id="arch"> Include archived</label>
</div>
<div class="list" id="list" role="listbox" aria-multiselectable="true" aria-label="Conversations" tabindex="0">
  <div class="sizer" id="sizer"></div>
  <div class="empty" id="empty"></div>
</div>
<div class="log" id="log" role="log" aria-live="polite" hidden></div>
<div class="progress" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="progress"><i id="bar"></i></div>
<div class="foot">
  <div class="grp" id="grpIdle">
    <span class="count" id="count"></span>
    <button class="ghost" id="export" type="button" title="Download the current selection as JSON">Export list</button>
    <button class="ghost" id="retry" type="button" hidden></button>
    <select class="mode" id="mode" aria-label="Action">
      <option value="delete">Delete</option>
      <option value="archive">Archive</option>
    </select>
    <button class="primary" id="go" type="button" disabled>Delete</button>
    <span class="hint" id="hint" hidden></span>
  </div>
  <div class="grp" id="grpConfirm" hidden>
    <span class="confirm" id="confirmText"></span>
    <button class="ghost" id="back" type="button">Back</button>
    <button class="danger" id="doIt" type="button" disabled>Delete</button>
  </div>
  <div class="grp" id="grpBusy" hidden>
    <span class="count" id="busyText">Working…</span>
    <button class="ghost" id="cancel" type="button">Cancel</button>
  </div>
</div>`;

    function openPanel() {
        ensureMounted();
        if (el.scrim) return;

        lastFocus = document.activeElement;

        const scrim = document.createElement('div');
        scrim.className = 'scrim';
        scrim.addEventListener('mousedown', (e) => {
            if (e.target === scrim) closePanel();
        });

        const panel = document.createElement('div');
        panel.className = 'panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-labelledby', 'title');
        panel.innerHTML = PANEL_HTML;

        scrim.appendChild(panel);
        wrap.appendChild(scrim);

        el.scrim = scrim;
        el.panel = panel;
        for (const id of ['meta', 'list', 'sizer', 'empty', 'log', 'progress', 'bar', 'load', 'search',
            'selAll', 'selNone', 'arch', 'count', 'export', 'retry', 'mode', 'go', 'hint',
            'grpIdle', 'grpConfirm', 'grpBusy', 'confirmText', 'back', 'doIt', 'busyText', 'cancel']) {
            el[id] = panel.querySelector('#' + id);
        }
        rowPool.length = 0;

        panel.querySelector('#close').addEventListener('click', closePanel);
        panel.addEventListener('keydown', onPanelKeydown);

        el.load.addEventListener('click', doLoad);
        el.arch.addEventListener('change', () => {
            state.includeArchived = el.arch.checked;
            state.stale = state.loaded;
            schedule('foot');
        });

        el.search.addEventListener('input', onSearchInput);
        el.search.addEventListener('search', onSearchInput);

        el.selAll.addEventListener('click', () => {
            if (state.busy) return;
            for (const it of visibleItems()) state.selected.add(it.id);
            schedule('list', 'foot');
        });
        el.selNone.addEventListener('click', () => {
            if (state.busy) return;
            state.selected.clear();
            schedule('list', 'foot');
        });

        el.list.addEventListener('scroll', () => schedule('list'), { passive: true });
        el.list.addEventListener('click', onRowClick);
        el.list.addEventListener('keydown', onListKeydown);

        // The rendered window is derived from the viewport height, so it has to follow resizes.
        if (typeof ResizeObserver === 'function') {
            listResize = new ResizeObserver(() => schedule('list'));
            listResize.observe(el.list);
        }

        el.mode.addEventListener('change', () => {
            state.mode = el.mode.value === 'archive' ? 'archive' : 'delete';
            schedule('foot');
        });
        el.export.addEventListener('click', exportSelection);
        el.retry.addEventListener('click', () => {
            if (state.busy) return;
            state.selected = new Set(state.failed);
            schedule('list', 'foot');
        });
        el.go.addEventListener('click', () => {
            if (state.busy || !state.selected.size) return;
            enterConfirm();
        });
        el.back.addEventListener('click', leaveConfirm);
        el.doIt.addEventListener('click', () => {
            if (el.doIt.disabled) return;
            leaveConfirm();
            run();
        });
        el.cancel.addEventListener('click', () => {
            if (state.abort) state.abort.abort(abortError());
            el.cancel.disabled = true;
            el.cancel.textContent = 'Cancelling…';
        });

        // One document-level listener for Escape, in case focus sits outside the panel.
        removeDocKeyHandler();
        docKeyHandler = (e) => {
            if (e.key !== 'Escape' || !el.scrim) return;
            if (state.confirming) leaveConfirm();     // step back out of the confirmation, don't close
            else closePanel();
        };
        document.addEventListener('keydown', docKeyHandler);

        el.arch.checked = state.includeArchived;
        el.mode.value = state.mode;
        el.search.value = state.query;

        if (logBuffer.length) {
            for (const entry of logBuffer.splice(0)) log(entry.text, entry.kind);
        }

        renderList();
        renderFoot();
        renderMeta();
        renderProgress();
        el.search.focus();
    }

    function closePanel() {
        if (state.busy) {
            log('Still running. Cancel it or wait for it to finish.', 'bad');
            return;
        }
        removeDocKeyHandler();
        clearConfirmTimer();
        if (searchTimer) {
            clearTimeout(searchTimer);
            searchTimer = null;
        }
        if (listResize) {
            listResize.disconnect();
            listResize = null;
        }
        if (el.scrim) el.scrim.remove();
        for (const key of Object.keys(el)) {
            if (key !== 'launcher') delete el[key];
        }
        rowPool.length = 0;
        state.confirming = false;
        state.activeIndex = -1;
        state.anchorIndex = -1;
        if (lastFocus && typeof lastFocus.focus === 'function') {
            try { lastFocus.focus(); } catch { /* element went away */ }
        } else if (el.launcher) {
            el.launcher.focus();
        }
        lastFocus = null;
    }

    function removeDocKeyHandler() {
        if (!docKeyHandler) return;
        document.removeEventListener('keydown', docKeyHandler);
        docKeyHandler = null;
    }

    function focusables() {
        if (!el.panel) return [];
        return [...el.panel.querySelectorAll('button, select, input, [tabindex]:not([tabindex="-1"])')]
            .filter((node) => !node.disabled && !node.hidden && node.offsetParent !== null);
    }

    function onPanelKeydown(e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            e.preventDefault();
            if (state.confirming) leaveConfirm();     // step back out of the confirmation, don't close
            else closePanel();
            return;
        }
        if (e.key !== 'Tab') return;
        // Focus trap: a modal that lets Tab wander into the page behind it is not modal.
        const stops = focusables();
        if (!stops.length) return;
        const current = stops.indexOf(root.activeElement);
        let next;
        if (e.shiftKey) next = current <= 0 ? stops.length - 1 : current - 1;
        else next = current === -1 || current === stops.length - 1 ? 0 : current + 1;
        e.preventDefault();
        stops[next].focus();
    }

    function onSearchInput() {
        if (searchTimer) clearTimeout(searchTimer);
        // Debounced: without this every keystroke filters and re-renders the whole list.
        searchTimer = setTimeout(() => {
            searchTimer = null;
            if (!el.search) return;
            state.query = el.search.value;
            state.activeIndex = -1;
            state.anchorIndex = -1;
            if (el.list) el.list.scrollTop = 0;
            schedule('list', 'foot');
        }, 120);
    }

    /* ---------------------------------------------------------- Virtual list */

    function makeRow() {
        const row = document.createElement('div');
        row.className = 'row';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', 'false');

        const box = document.createElement('span');
        box.className = 'box';
        box.setAttribute('aria-hidden', 'true');

        const title = document.createElement('span');
        title.className = 'title';

        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'archived';
        tag.hidden = true;

        const date = document.createElement('span');
        date.className = 'date num';

        row.append(box, title, tag, date);
        row._parts = { title, tag, date };
        el.sizer.appendChild(row);
        return row;
    }

    function updateRow(row, item, index) {
        const parts = row._parts;
        if (row._id !== item.id) {
            row._id = item.id;
            parts.title.textContent = item.title;
            parts.title.title = item.title;
            parts.date.textContent = item.date;
            parts.tag.hidden = !item.archived;
        }
        if (row._index !== index) {
            row._index = index;
            row.id = 'cbd-row-' + index;
            row.dataset.index = String(index);
            row.style.transform = `translateY(${index * CFG.rowHeight}px)`;
        }
        const selected = state.selected.has(item.id);
        if (row._sel !== selected) {
            row._sel = selected;
            row.classList.toggle('sel', selected);
            row.setAttribute('aria-selected', selected ? 'true' : 'false');
        }
        const failed = state.failed.has(item.id);
        if (row._failed !== failed) {
            row._failed = failed;
            row.classList.toggle('failed', failed);
        }
        const done = state.done.has(item.id);
        if (row._done !== done) {
            row._done = done;
            row.classList.toggle('done', done);
        }
        const active = index === state.activeIndex;
        if (row._active !== active) {
            row._active = active;
            row.classList.toggle('active', active);
        }
        if (row.hidden) row.hidden = false;
    }

    /**
     * Only the rows in view exist in the DOM. An account with 20k conversations
     * costs the same ~30 nodes as one with 30.
     */
    function renderList() {
        if (!el.list) return;
        const items = visibleItems();

        el.empty.hidden = items.length > 0;
        if (!items.length) {
            el.empty.textContent = state.loaded
                ? 'No chat matches this filter.'
                : 'Click "Load chats". The list comes straight from the API, so you don\'t have to scroll through the sidebar.';
        }

        el.sizer.style.height = `${items.length * CFG.rowHeight}px`;

        const viewport = el.list.clientHeight || 320;
        const first = Math.max(0, Math.floor(el.list.scrollTop / CFG.rowHeight) - CFG.overscan);
        const last = Math.min(items.length, Math.ceil((el.list.scrollTop + viewport) / CFG.rowHeight) + CFG.overscan);
        const need = Math.max(0, last - first);

        while (rowPool.length < need) rowPool.push(makeRow());

        for (let i = 0; i < rowPool.length; i++) {
            const row = rowPool[i];
            if (i < need) updateRow(row, items[first + i], first + i);
            else if (!row.hidden) row.hidden = true;
        }

        // Keep the pool from growing forever after the window shrinks.
        if (rowPool.length > need + 40) {
            for (const row of rowPool.splice(need)) row.remove();
        }

        el.list.setAttribute('aria-activedescendant',
            state.activeIndex >= 0 && state.activeIndex < items.length ? 'cbd-row-' + state.activeIndex : '');
    }

    function toggleAt(index, extend) {
        const items = visibleItems();
        if (index < 0 || index >= items.length) return;

        if (extend && state.anchorIndex >= 0 && state.anchorIndex < items.length) {
            const from = Math.min(state.anchorIndex, index);
            const to = Math.max(state.anchorIndex, index);
            const select = !state.selected.has(items[index].id);
            for (let i = from; i <= to; i++) {
                if (select) state.selected.add(items[i].id);
                else state.selected.delete(items[i].id);
            }
        } else {
            const item = items[index];
            if (state.selected.has(item.id)) state.selected.delete(item.id);
            else state.selected.add(item.id);
            state.anchorIndex = index;
        }
        state.activeIndex = index;
        schedule('list', 'foot');
    }

    function onRowClick(e) {
        if (state.busy) return;
        const row = e.target && e.target.closest ? e.target.closest('.row') : null;
        if (!row || !el.sizer.contains(row)) return;
        const index = Number(row.dataset.index);
        if (!Number.isInteger(index)) return;
        toggleAt(index, e.shiftKey);
        el.list.focus({ preventScroll: true });
    }

    function moveActive(delta, extend) {
        const items = visibleItems();
        if (!items.length) return;
        const next = state.activeIndex < 0
            ? 0
            : Math.min(items.length - 1, Math.max(0, state.activeIndex + delta));
        state.activeIndex = next;
        if (extend) {
            if (state.anchorIndex < 0) state.anchorIndex = next;
            const from = Math.min(state.anchorIndex, next);
            const to = Math.max(state.anchorIndex, next);
            for (let i = from; i <= to; i++) state.selected.add(items[i].id);
        }
        scrollIntoView(next);
        schedule('list', 'foot');
    }

    function scrollIntoView(index) {
        const top = index * CFG.rowHeight;
        const bottom = top + CFG.rowHeight;
        if (top < el.list.scrollTop) el.list.scrollTop = top;
        else if (bottom > el.list.scrollTop + el.list.clientHeight) el.list.scrollTop = bottom - el.list.clientHeight;
    }

    function onListKeydown(e) {
        if (state.busy) return;
        const items = visibleItems();
        switch (e.key) {
            case 'ArrowDown': e.preventDefault(); moveActive(1, e.shiftKey); break;
            case 'ArrowUp': e.preventDefault(); moveActive(-1, e.shiftKey); break;
            case 'PageDown': e.preventDefault(); moveActive(10, e.shiftKey); break;
            case 'PageUp': e.preventDefault(); moveActive(-10, e.shiftKey); break;
            case 'Home': e.preventDefault(); state.activeIndex = 0; scrollIntoView(0); schedule('list'); break;
            case 'End':
                if (!items.length) break;
                e.preventDefault();
                state.activeIndex = items.length - 1;
                scrollIntoView(state.activeIndex);
                schedule('list');
                break;
            case ' ':
            case 'Enter':
                if (state.activeIndex < 0) break;
                e.preventDefault();
                toggleAt(state.activeIndex, e.shiftKey);
                break;
            case 'a':
            case 'A':
                if (!(e.ctrlKey || e.metaKey)) break;
                e.preventDefault();
                for (const it of items) state.selected.add(it.id);
                schedule('list', 'foot');
                break;
            default: break;
        }
    }

    /* ----------------------------------------------------------- Chrome/foot */

    function log(text, kind = '') {
        const line = clean(text, 400);
        if (!el.log) {
            if (logBuffer.length < 50) logBuffer.push({ text: line, kind });
            return;
        }
        el.log.hidden = false;
        const node = document.createElement('div');
        if (kind) node.className = kind;
        node.textContent = line;
        el.log.appendChild(node);
        while (el.log.childElementCount > CFG.maxLogLines) el.log.removeChild(el.log.firstElementChild);
        el.log.scrollTop = el.log.scrollHeight;
    }

    function renderMeta() {
        if (!el.meta) return;
        el.meta.textContent = state.loaded
            ? `${num(state.items.length)} ${plural(state.items.length)} loaded`
            : 'Nothing loaded yet';
    }

    function renderProgress() {
        if (!el.bar) return;
        const { done, total, label } = state.progress;
        const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
        el.bar.style.width = `${pct}%`;
        el.progress.setAttribute('aria-valuenow', String(Math.round(pct)));
        if (el.busyText && label) el.busyText.textContent = label;
    }

    function setProgress(done, total, label) {
        state.progress = { done, total, label: label || '' };
        schedule('progress');
    }

    function renderFoot() {
        if (!el.grpIdle) return;

        const selectedCount = state.selected.size;
        const visible = visibleItems();

        el.grpBusy.hidden = !state.busy;
        el.grpConfirm.hidden = state.busy || !state.confirming;
        el.grpIdle.hidden = state.busy || state.confirming;

        el.load.disabled = state.busy;
        el.search.disabled = state.busy;
        el.arch.disabled = state.busy;
        el.selAll.disabled = state.busy || !visible.length;
        el.selNone.disabled = state.busy || selectedCount === 0;

        if (state.busy) return;

        if (state.confirming) {
            const verb = state.mode === 'archive' ? 'Archive' : 'Delete';
            el.confirmText.replaceChildren(
                document.createTextNode(`${verb} `),
                strong(`${num(selectedCount)} ${plural(selectedCount)}`),
                document.createTextNode(state.mode === 'archive'
                    ? '? They stay reachable under settings.'
                    : '? This hides them from your account right away.')
            );
            el.doIt.textContent = verb;
            return;
        }

        el.count.replaceChildren(
            strong(num(selectedCount)),
            document.createTextNode(` of ${num(visible.length)} selected`)
        );

        el.mode.value = state.mode;
        el.go.textContent = state.mode === 'archive' ? 'Archive' : 'Delete';
        el.go.disabled = selectedCount === 0;
        el.export.disabled = selectedCount === 0;

        el.retry.hidden = state.failed.size === 0;
        if (state.failed.size) el.retry.textContent = `Select failed (${num(state.failed.size)})`;

        const stale = state.stale && state.loaded;
        el.hint.hidden = !stale;
        if (stale) el.hint.textContent = 'The archived filter changed. Load chats again to apply it.';
    }

    function strong(text) {
        const b = document.createElement('b');
        b.className = 'num';
        b.textContent = text;
        return b;
    }

    function clearConfirmTimer() {
        if (confirmTimer === null) return;
        clearTimeout(confirmTimer);
        confirmTimer = null;
    }

    /**
     * The confirm step sits in its own button row and the destructive button stays
     * dead for a moment, so a double click on "Delete" can't blow straight through it.
     */
    function enterConfirm() {
        state.confirming = true;
        clearConfirmTimer();
        renderFoot();
        el.doIt.disabled = true;
        el.back.focus();
        confirmTimer = setTimeout(() => {
            confirmTimer = null;
            if (state.confirming && el.doIt) el.doIt.disabled = false;
        }, CFG.confirmArmMs);
    }

    function leaveConfirm() {
        clearConfirmTimer();
        state.confirming = false;
        schedule('foot');
    }

    /* ------------------------------------------------------------- Actions */

    function exportSelection() {
        const chosen = state.items.filter((it) => state.selected.has(it.id));
        if (!chosen.length) return;
        const payload = {
            exported_at: new Date().toISOString(),
            count: chosen.length,
            conversations: chosen.map((it) => ({
                id: it.id,
                title: it.title,
                updated: it.updated ? new Date(it.updated).toISOString() : null,
                archived: it.archived,
                url: `${ORIGIN}/c/${it.id}`,
            })),
        };
        let url = null;
        try {
            url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `chatgpt-chats-${new Date().toISOString().slice(0, 10)}.json`;
            a.rel = 'noopener';
            document.body.appendChild(a);
            a.click();
            a.remove();
            log(`Exported ${num(chosen.length)} ${plural(chosen.length)}.`, 'good');
        } catch (err) {
            log(`Export failed: ${describe(err)}`, 'bad');
        } finally {
            if (url) setTimeout(() => URL.revokeObjectURL(url), 30000);
        }
    }

    function startJob() {
        state.busy = true;
        state.abort = new AbortController();
        state.confirming = false;
        clearConfirmTimer();
        renderFoot();
        if (el.cancel) {
            el.cancel.disabled = false;
            el.cancel.textContent = 'Cancel';
        }
        return state.abort.signal;
    }

    function endJob() {
        state.busy = false;
        state.abort = null;
        setProgress(0, 0, '');
        schedule('list', 'foot', 'meta');
    }

    async function doLoad() {
        if (state.busy) return;
        const signal = startJob();

        state.selected.clear();
        state.failed.clear();
        state.done.clear();
        state.activeIndex = -1;
        state.anchorIndex = -1;
        log('Loading conversations…');

        try {
            const { items, truncated } = await loadAll(signal, (count) => {
                setProgress(0, 0, `${num(count)} loaded…`);
            });
            setItems(items);
            state.loaded = true;
            state.stale = false;
            if (truncated) log(`Stopped at the page limit (${num(CFG.maxPages)} pages per pass).`, 'bad');
            log(`${num(items.length)} ${plural(items.length)} loaded.`, 'good');
        } catch (err) {
            if (isCancel(err)) log('Loading cancelled.', 'bad');
            else log(describe(err), 'bad');
        } finally {
            if (el.list) el.list.scrollTop = 0;
            endJob();
        }
    }

    /**
     * A small worker pool instead of one strictly serial loop. The shared cooldown in
     * the network layer keeps the pool polite: one 429 pauses every worker at once.
     */
    async function run() {
        const mode = state.mode === 'archive' ? 'archive' : 'delete';
        const chosen = state.items.filter((it) => state.selected.has(it.id));
        const targets = mode === 'archive' ? chosen.filter((it) => !it.archived) : chosen;
        const skipped = chosen.length - targets.length;
        if (!targets.length) {
            if (skipped) log(`Nothing to do, ${num(skipped)} ${plural(skipped)} already archived.`);
            return;
        }

        const signal = startJob();
        state.failed.clear();
        state.done.clear();
        pacing.writeDelayMs = CFG.writeDelayMs;
        pacing.streak = 0;

        const verb = mode === 'archive' ? 'Archived' : 'Deleted';
        const total = targets.length;
        let cursor = 0;
        let finished = 0;
        let ok = 0;
        let cancelled = false;
        const succeeded = new Set();

        setProgress(0, total, `0 of ${num(total)}`);
        if (skipped) log(`Skipping ${num(skipped)} already archived ${plural(skipped)}.`);

        const worker = async (slot) => {
            if (slot > 0) {
                try {
                    await sleep(slot * 90, signal); // stagger the starts
                } catch {
                    return;
                }
            }
            for (;;) {
                if (signal.aborted) return;
                const index = cursor++;
                if (index >= total) return;
                const item = targets[index];

                try {
                    await applyTo(item, mode, signal);
                    ok++;
                    succeeded.add(item.id);
                    state.done.add(item.id);
                } catch (err) {
                    if (isCancel(err)) {
                        cursor = total;               // stop the other workers from picking up more
                        return;
                    }
                    state.failed.add(item.id);
                    log(`Failed: ${item.title} — ${describe(err)}`, 'bad');
                }

                finished++;
                setProgress(finished, total, `${num(finished)} of ${num(total)}`);
                schedule('list');

                if (cursor < total) {
                    try {
                        await sleep(pacing.writeDelayMs, signal);
                    } catch {
                        return;
                    }
                }
            }
        };

        try {
            const slots = Math.max(1, Math.min(CFG.writeConcurrency, total));
            await Promise.all(Array.from({ length: slots }, (_, i) => worker(i)));
        } finally {
            cancelled = signal.aborted;

            // One pass over the list instead of one filter per deleted item.
            if (succeeded.size) {
                setItems(state.items.filter((it) => !succeeded.has(it.id)));
                for (const id of succeeded) state.selected.delete(id);
            }
            state.done.clear();
            state.activeIndex = -1;
            state.anchorIndex = -1;

            const failedCount = state.failed.size;
            if (cancelled) log(`Cancelled after ${num(finished)} of ${num(total)}.`, 'bad');
            log(`${verb}: ${num(ok)}. Failed: ${num(failedCount)}.`, failedCount ? 'bad' : 'good');
            endJob();
        }
    }

    /* ---------------------------------------------------------------- Boot */

    function watchDom() {
        // Cheap and targeted: body children for our own host, documentElement for a body swap.
        let bodyObserver = null;
        const attach = () => {
            if (!document.body) return;
            if (bodyObserver) bodyObserver.disconnect();
            bodyObserver = new MutationObserver(() => ensureMounted());
            bodyObserver.observe(document.body, { childList: true });
        };
        new MutationObserver(() => {
            ensureMounted();
            attach();
        }).observe(document.documentElement, { childList: true });
        attach();

        new MutationObserver(applyTheme).observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'style', 'data-theme'],
        });

        try {
            const mq = window.matchMedia('(prefers-color-scheme: light)');
            if (typeof mq.addEventListener === 'function') mq.addEventListener('change', applyTheme);
        } catch { /* no matchMedia, the class check still works */ }
    }

    function boot() {
        ensureMounted();
        watchDom();
        window.addEventListener('beforeunload', (e) => {
            if (!state.busy) return;
            e.preventDefault();
            e.returnValue = '';
        });
    }

    if (document.body) boot();
    else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
