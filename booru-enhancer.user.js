// ==UserScript==
// @name         Booru Enhancer
// @namespace    https://sleazyfork.org/en/scripts/587810-booru-enhancer
// @version      1.1.1
// @description  Modular enhancement suite for Danbooru/Gelbooru/Moebooru-family booru sites — original-quality media, smart downloads, fullscreen viewer, tag tools, blacklist filtering, infinite scroll, reverse image search, and more.
// @author       itachi-re
// @license      MIT
// @match        *://danbooru.donmai.us/*
// @match        *://*.donmai.us/*
// @match        *://atfbooru.ninja/*
// @match        *://gelbooru.com/*
// @match        *://safebooru.org/*
// @match        *://rule34.xxx/*
// @match        *://rule34.us/*
// @match        *://realbooru.com/*
// @match        *://tbib.org/*
// @match        *://xbooru.com/*
// @match        *://hypnohub.net/*
// @match        *://konachan.com/*
// @match        *://konachan.net/*
// @match        *://yande.re/*
// @match        *://lolibooru.moe/*
// @match        *://e621.net/*
// @match        *://e926.net/*
// @match        *://chan.sankakucomplex.com/*
// @match        *://idol.sankakucomplex.com/*
// @match        *://beta.sankakucomplex.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_info
// @connect      donmai.us
// @connect      atfbooru.ninja
// @connect      gelbooru.com
// @connect      safebooru.org
// @connect      rule34.xxx
// @connect      rule34.us
// @connect      realbooru.com
// @connect      tbib.org
// @connect      xbooru.com
// @connect      hypnohub.net
// @connect      konachan.com
// @connect      konachan.net
// @connect      yande.re
// @connect      lolibooru.moe
// @connect      e621.net
// @connect      e926.net
// @connect      sankakucomplex.com
// @connect      sankakuapi.com
// @connect      saucenao.com
// @connect      iqdb.org
// @run-at       document-end
// @noframes
// ==/UserScript==

/**
 * =============================================================================
 *  BOORU ENHANCER  —  v1.1.1
 * =============================================================================
 *  CHANGELOG (1.1.0 → 1.1.1)
 *  --------------------------
 *  - Fixed infinite scrolling failing on Safebooru (and other Gelbooru 0.2
 *    clones) where the paginator uses a[alt="next"] instead of a[rel="next"].
 *  - Pagination logic moved from BE.modules.gallery into per-adapter
 *    `pagination` API: getNextUrl(doc), getPageIdentity(url),
 *    getPostIdentity(el), calculateNextUrl(url).
 *  - Gallery now asks `adapter.pagination.getNextUrl()` instead of
 *    hard-coding CSS selectors.
 *  - Added duplicate-page protection (loadedPages Set) and duplicate-post
 *    protection (loadedPostIds Set).
 *  - Pagination state (nextPageUrl) stored in JS, not re-read from the live
 *    DOM every cycle — survives paginator DOM replacement.
 *  - Added explicit state machine: IDLE → LOADING → SUCCESS/ERROR/EXHAUSTED.
 *  - Prevents concurrent loadNextPage() calls.
 *  - If sentinel remains visible after a page loads, automatically continues.
 *  - Fetched-document validation: HTTP status, non-empty body, gallery
 *    container present, post thumbnails present, login-page detection.
 *  - Retry UI ("Retry" button) on error instead of silently stopping.
 *  - Correct error messages: "No more posts" only when truly exhausted;
 *    "Unable to determine the next page" when detection fails.
 *  - Native paginator hidden via reversible class (be-pagination-hidden),
 *    not style.display = 'none'.
 *  - Preserves all query params (tags, rating, sort, s, page, pid) when
 *    calculating a fallback next URL.
 * =============================================================================
 */
(function booruEnhancer() {
	'use strict';

	if (window.top !== window.self) return;
	if (window.__BOORU_ENHANCER_LOADED__) return;
	window.__BOORU_ENHANCER_LOADED__ = true;

	const BE = (window.BE = window.BE || {});
	BE.VERSION = '1.1.1';

	/* ============================================================ *
	 *  EVENT BUS
	 * ============================================================ */
	BE.bus = (() => {
		const listeners = new Map();
		return {
			on(evt, fn) {
				if (!listeners.has(evt)) listeners.set(evt, new Set());
				listeners.get(evt).add(fn);
				return () => listeners.get(evt)?.delete(fn);
			},
			once(evt, fn) {
				const off = this.on(evt, (p) => { off(); fn(p); });
				return off;
			},
			emit(evt, payload) {
				const set = listeners.get(evt);
				if (!set) return;
				for (const fn of [...set]) {
					try { fn(payload); } catch (err) { BE.log.error(`[bus:${evt}]`, err); }
				}
			},
		};
	})();

	/* ============================================================ *
	 *  LOGGER
	 * ============================================================ */
	BE.log = (() => {
		const PREFIX = '%c[Booru Enhancer]';
		const STYLE = 'color:#ff8ac6;font-weight:bold';
		const enabled = () => BE.settings?.get('debug.verboseLogging') ?? false;
		return {
			debug: (...a) => enabled() && console.debug(PREFIX, STYLE, ...a),
			  info: (...a) => console.info(PREFIX, STYLE, ...a),
			  warn: (...a) => console.warn(PREFIX, STYLE, ...a),
			  error: (...a) => console.error(PREFIX, STYLE, ...a),
		};
	})();

	/* ============================================================ *
	 *  GM SHIM
	 * ============================================================ */
	const _GM = {
		getValue: (typeof GM_getValue === 'function') ? GM_getValue : (k, d) => GM.getValue(k, d),
 setValue: (typeof GM_setValue === 'function') ? GM_setValue : (k, v) => GM.setValue(k, v),
 deleteValue: (typeof GM_deleteValue === 'function') ? GM_deleteValue : (k) => GM.deleteValue(k),
 listValues: (typeof GM_listValues === 'function') ? GM_listValues : () => GM.listValues(),
 xhr: (typeof GM_xmlhttpRequest === 'function') ? GM_xmlhttpRequest : (opts) => GM.xmlHttpRequest(opts),
 download: (typeof GM_download === 'function') ? GM_download : (opts) => GM.download(opts),
 addStyle: (typeof GM_addStyle === 'function') ? GM_addStyle : (css) => {
	 const s = document.createElement('style');
	 s.textContent = css;
	 document.head.appendChild(s);
	 return s;
 },
 notification: (typeof GM_notification === 'function') ? GM_notification : (opts) => {
	 try { new Notification(opts.title || 'Booru Enhancer', { body: opts.text }); } catch { /* noop */ }
 },
 registerMenuCommand: (typeof GM_registerMenuCommand === 'function') ? GM_registerMenuCommand : () => {},
	};
	BE.gm = _GM;

	/* ============================================================ *
	 *  DOM UTILITIES
	 * ============================================================ */
	BE.dom = {
		qs: (sel, root = document) => root.querySelector(sel),
 qsa: (sel, root = document) => Array.from(root.querySelectorAll(sel)),

 create(tag, attrs = {}, children = []) {
	 const el = document.createElement(tag);
	 for (const [k, v] of Object.entries(attrs)) {
		 if (k === 'class') el.className = v;
		 else if (k === 'html') el.innerHTML = v;
		 else if (k === 'text') el.textContent = v;
		 else if (k === 'dataset') Object.assign(el.dataset, v);
		 else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
		 else if (v !== null && v !== undefined) el.setAttribute(k, v);
	 }
	 for (const c of [].concat(children)) {
		 if (c === null || c === undefined) continue;
		 el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
	 }
	 return el;
 },

 debounce(fn, ms = 150) {
	 let t;
	 return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
 },

 throttle(fn, ms = 150) {
	 let last = 0, timer = null;
	 return (...args) => {
		 const now = Date.now();
		 if (now - last >= ms) { last = now; fn(...args); }
		 else {
			 clearTimeout(timer);
			 timer = setTimeout(() => { last = Date.now(); fn(...args); }, ms - (now - last));
		 }
	 };
 },

 ready(fn) {
	 if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
	 else fn();
 },

 onVisible(el, fn, opts = { rootMargin: '600px 0px' }) {
	 const io = new IntersectionObserver((entries) => {
		 for (const e of entries) if (e.isIntersecting) { fn(el); io.unobserve(el); }
	 }, opts);
	 io.observe(el);
	 return () => io.unobserve(el);
 },

 sanitizeFilename(name, maxLen = 180) {
	 return String(name)
	 .replace(/[/\\?%*:|"<>]/g, '_')
	 .replace(/\s+/g, ' ')
	 .trim()
	 .slice(0, maxLen) || 'untitled';
 },

 formatBytes(bytes) {
	 if (!bytes && bytes !== 0) return '?';
	 const units = ['B', 'KB', 'MB', 'GB'];
	 let i = 0, n = bytes;
	 while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
	 return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
 },
	};

	/* ============================================================ *
	 *  STORAGE
	 * ============================================================ */
	BE.store = (() => {
		const NS = 'be:';
		const cache = new Map();
		let ready = false;
		const readyCallbacks = [];

		function safeParse(raw) {
			if (raw === undefined || raw === null) return { ok: false };
			if (typeof raw !== 'string') return { ok: true, value: raw };
			try { return { ok: true, value: JSON.parse(raw) }; }
			catch { return { ok: false }; }
		}

		async function init() {
			try {
				const keys = await _GM.listValues();
				await Promise.all((keys || []).filter((k) => typeof k === 'string' && k.startsWith(NS)).map(async (k) => {
					let raw;
					try { raw = await _GM.getValue(k); } catch (err) { BE.log.error('store.get failed for', k, err); return; }
					const parsed = safeParse(raw);
					if (parsed.ok) cache.set(k.slice(NS.length), parsed.value);
				}));
			} catch (err) { BE.log.error('store init failed', err); }
			ready = true;
			readyCallbacks.splice(0).forEach((cb) => cb());
		}

		return {
			whenReady(cb) { ready ? cb() : readyCallbacks.push(cb); },
				get isReady() { return ready; },
				get(key, fallback) { return cache.has(key) ? cache.get(key) : fallback; },
				set(key, value) {
					cache.set(key, value);
					Promise.resolve(_GM.setValue(NS + key, JSON.stringify(value))).catch((e) => {
						BE.log.error('store.set failed to persist', key, e);
					});
				},
				delete(key) {
					cache.delete(key);
					Promise.resolve(_GM.deleteValue(NS + key)).catch(() => {});
				},
				keys(prefix = '') { return [...cache.keys()].filter((k) => k.startsWith(prefix)); },
				_init: init,
		};
	})();
	BE.store._init();

	/* ============================================================ *
	 *  SETTINGS SCHEMA
	 * ============================================================ */
	BE.settings = (() => {
		const SCHEMA = {
			'general.enabled': { cat: 'General', type: 'bool', def: true, label: 'Enable Booru Enhancer on this site' },
			'general.theme': { cat: 'General', type: 'select', def: 'dark', choices: ['dark', 'light'], label: 'Theme' },
			'general.accentColor': { cat: 'General', type: 'color', def: '#ff8ac6', label: 'Accent color' },
			'general.toolbarPosition': { cat: 'General', type: 'select', def: 'bottom-right', choices: ['bottom-right', 'bottom-left', 'top-right', 'top-left'], label: 'Toolbar position' },

			'media.mode': { cat: 'Media', type: 'select', def: 'post-page', choices: ['always', 'post-page', 'on-click', 'disabled'], label: 'Load original media' },
			'media.neverUpscale': { cat: 'Media', type: 'bool', def: true, label: 'Never upscale beyond native resolution' },
			'media.hoverPreview': { cat: 'Media', type: 'bool', def: true, label: 'Hover preview on thumbnails' },
			'media.thumbQuality': { cat: 'Media', type: 'select', def: 'sample', choices: ['preview', 'sample', 'original'], label: 'Grid thumbnail quality' },

			'download.filenameTemplate': { cat: 'Downloads', type: 'text', def: '{character} - {artist} ({id})', label: 'Filename template' },
				   'download.maxCharacters': { cat: 'Downloads', type: 'number', def: 3, min: 1, max: 10, label: 'Max characters in filename' },
				   'download.tagDelimiter': { cat: 'Downloads', type: 'text', def: ', ', label: 'Tag delimiter' },
				   'download.retries': { cat: 'Downloads', type: 'number', def: 3, min: 0, max: 10, label: 'Retry attempts on failure' },
				   'download.openMode': { cat: 'Downloads', type: 'select', def: 'new-tab', choices: ['new-tab', 'background-tab', 'popup', 'browser-viewer'], label: '"Open original" behavior' },

				   'viewer.enabled': { cat: 'Viewer', type: 'bool', def: true, label: 'Enable fullscreen viewer' },
				   'viewer.autoplayVideo': { cat: 'Viewer', type: 'bool', def: true, label: 'Autoplay videos/animations' },
				   'viewer.loopVideo': { cat: 'Viewer', type: 'bool', def: true, label: 'Loop videos' },
				   'viewer.muteVideo': { cat: 'Viewer', type: 'bool', def: true, label: 'Start videos muted' },
				   'viewer.rememberVolume': { cat: 'Viewer', type: 'bool', def: true, label: 'Remember volume between videos' },
				   'viewer.fitMode': { cat: 'Viewer', type: 'select', def: 'fit-both', choices: ['fit-both', 'fit-width', 'fit-height', 'original-size'], label: 'Default fit mode' },

				   'gallery.infiniteScroll': { cat: 'Gallery', type: 'bool', def: true, label: 'Infinite scrolling (replaces pagination)' },
				   'gallery.gridDensity': { cat: 'Gallery', type: 'range', def: 6, min: 3, max: 10, label: 'Grid columns' },
				   'gallery.compactMode': { cat: 'Gallery', type: 'bool', def: false, label: 'Compact mode' },

				   'tags.colorize': { cat: 'Tags', type: 'bool', def: true, label: 'Colorize tags by category' },
				   'tags.showCounts': { cat: 'Tags', type: 'bool', def: true, label: 'Show tag post counts' },
				   'tags.collapseThreshold': { cat: 'Tags', type: 'number', def: 25, min: 5, max: 200, label: 'Collapse tag list above N tags' },

				   'filter.blacklist': { cat: 'Filters', type: 'textarea', def: '', label: 'Blacklisted tags (one per line, supports rating:*, -tag)' },
				   'filter.whitelist': { cat: 'Filters', type: 'textarea', def: '', label: 'Whitelist overrides (one per line)' },
				   'filter.hideVideos': { cat: 'Filters', type: 'bool', def: false, label: 'Hide videos' },
				   'filter.hideAnimations': { cat: 'Filters', type: 'bool', def: false, label: 'Hide animated images/GIFs' },
				   'filter.minResolution': { cat: 'Filters', type: 'number', def: 0, min: 0, max: 10000, label: 'Hide posts below width (px), 0 = off' },
				   'filter.hideAIGenerated': { cat: 'Filters', type: 'bool', def: false, label: 'Hide posts tagged ai-generated' },

				   'keys.download': { cat: 'Keybinds', type: 'text', def: 'd', label: 'Download' },
				   'keys.favorite': { cat: 'Keybinds', type: 'text', def: 'f', label: 'Favorite' },
				   'keys.openOriginal': { cat: 'Keybinds', type: 'text', def: 'o', label: 'Open original (new tab)' },
				   'keys.viewOriginal': { cat: 'Keybinds', type: 'text', def: 'v', label: 'Toggle viewer' },
				   'keys.next': { cat: 'Keybinds', type: 'text', def: 'ArrowRight', label: 'Next post' },
				   'keys.prev': { cat: 'Keybinds', type: 'text', def: 'ArrowLeft', label: 'Previous post' },
				   'keys.close': { cat: 'Keybinds', type: 'text', def: 'Escape', label: 'Close viewer' },
				   'keys.playPause': { cat: 'Keybinds', type: 'text', def: ' ', label: 'Play/pause video' },
				   'keys.commandPalette': { cat: 'Keybinds', type: 'text', def: 'k', label: 'Command palette (needs Ctrl)' },

				   'debug.verboseLogging': { cat: 'Debug', type: 'bool', def: false, label: 'Verbose console logging' },
		};

		const values = new Map();
		let loaded = false;

		function keyDefault(key) { return SCHEMA[key]?.def; }

		function load() {
			for (const key of Object.keys(SCHEMA)) {
				const stored = BE.store.get('setting:' + key);
				values.set(key, stored !== undefined ? stored : keyDefault(key));
			}
			loaded = true;
		}

		return {
			SCHEMA,
			get isLoaded() { return loaded; },
				   get(key) {
					   if (!loaded) {
						   BE.log.debug('settings.get() called before load — returning default for', key);
						   return keyDefault(key);
					   }
					   return values.has(key) ? values.get(key) : keyDefault(key);
				   },
				   set(key, val) {
					   values.set(key, val);
					   BE.store.set('setting:' + key, val);
					   BE.bus.emit('settings:changed', { key, val });
				   },
				   reset(key) {
					   const def = keyDefault(key);
					   this.set(key, def);
					   return def;
				   },
				   resetAll() { for (const key of Object.keys(SCHEMA)) this.reset(key); },
				   categories() {
					   const set = [];
					   for (const def of Object.values(SCHEMA)) if (!set.includes(def.cat)) set.push(def.cat);
					   return set;
				   },
				   byCategory(cat) { return Object.entries(SCHEMA).filter(([, d]) => d.cat === cat).map(([k]) => k); },
				   exportJSON() {
					   const out = {};
					   for (const key of Object.keys(SCHEMA)) out[key] = this.get(key);
					   return JSON.stringify({ __booruEnhancerSettings: true, version: BE.VERSION, values: out }, null, 2);
				   },
				   importJSON(json) {
					   try {
						   const parsed = JSON.parse(json);
						   const values_ = parsed.values || parsed;
						   for (const [key, val] of Object.entries(values_)) {
							   if (SCHEMA[key] !== undefined) this.set(key, val);
						   }
						   return true;
					   } catch (err) {
						   BE.log.error('settings import failed', err);
						   return false;
					   }
				   },
				   blacklistTags() {
					   return String(this.get('filter.blacklist')).split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
				   },
				   whitelistTags() {
					   return String(this.get('filter.whitelist')).split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
				   },
				   _load: load,
		};
	})();

	/* ============================================================ *
	 *  NETWORK
	 * ============================================================ */
	BE.net = {
		request(opts, retries = 0) {
			return new Promise((resolve, reject) => {
				const attempt = (n) => {
					_GM.xhr({
						method: 'GET',
						...opts,
						onload: (res) => {
							if (res.status >= 200 && res.status < 300) resolve(res);
							else if (n > 0) setTimeout(() => attempt(n - 1), 400 * (retries - n + 1));
							else reject(new Error(`HTTP ${res.status} for ${opts.url}`));
						},
						onerror: (err) => (n > 0 ? setTimeout(() => attempt(n - 1), 400 * (retries - n + 1)) : reject(err)),
							ontimeout: (err) => (n > 0 ? setTimeout(() => attempt(n - 1), 400 * (retries - n + 1)) : reject(err)),
					});
				};
				attempt(retries);
			});
		},
 async json(url, opts = {}) {
	 const res = await this.request({ url, headers: { Accept: 'application/json', ...(opts.headers || {}) }, ...opts }, opts.retries ?? 2);
	 return JSON.parse(res.responseText);
 },
	};

	/* ============================================================ *
	 *  POST MODEL
	 * ============================================================ */
	function emptyPost(overrides = {}) {
		return {
			id: '', originalUrl: '', sampleUrl: '', previewUrl: '', mediaType: 'unknown',
 width: 0, height: 0, fileSize: 0, md5: '', rating: 'unknown', score: 0, favCount: 0,
 artists: [], characters: [], copyrights: [], generalTags: [], metaTags: [], allTags: [],
 source: '', postUrl: location.href, createdAt: '', siteId: '', ...overrides,
		};
	}

	function guessMediaType(url) {
		if (!url) return 'unknown';
		const ext = (url.split('?')[0].split('.').pop() || '').toLowerCase();
		if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
		if (ext === 'gif') return 'gif';
		if (['jpg', 'jpeg', 'png', 'webp', 'bmp'].includes(ext)) return 'image';
		return 'unknown';
	}

	/* ============================================================ *
	 *  ADAPTER REGISTRY
	 * ============================================================ */
	BE.adapters = { registry: [], active: null };

	BE.core = BE.core || {};
	BE.core.registerAdapter = function registerAdapter(adapter) {
		BE.adapters.registry.push({ priority: 0, ...adapter });
	};

	BE.core.detectAdapter = function detectAdapter() {
		const candidates = BE.adapters.registry
		.filter((a) => a.hostPattern.test(location.hostname))
		.sort((a, b) => b.priority - a.priority);
		return candidates[0] || BE.adapters.registry.find((a) => a.id === 'generic');
	};

	/* ============================================================ *
	 *  PAGINATION HELPER UTILITIES
	 * ============================================================ */

	/** Safely parse a URL, tolerating relative hrefs against location.href. */
	function safeURL(href, base = location.href) {
		try { return new URL(href, base); } catch { return null; }
	}

	/** Search a document for the first anchor matching any selector that has a
	 *  real href and, optionally, represents an advancing page. */
	function findFirstNextLink(doc, selectors) {
		for (const sel of selectors) {
			try {
				const link = doc.querySelector(sel);
				if (link && link.href) return link;
			} catch { /* invalid selector for this doc type */ }
		}
		return null;
	}

	/** Among all anchors containing `pid=` (or the given param), find the one
	 *  with the smallest value greater than currentVal. Returns the href or null. */
	function findAdvancingPidLink(doc, paramName, currentVal) {
		const links = Array.from(doc.querySelectorAll(`a[href*="${paramName}="]`));
		const candidates = [];
		for (const a of links) {
			const u = safeURL(a.href);
			if (!u) continue;
			const val = parseInt(u.searchParams.get(paramName) || '0', 10);
			if (!isNaN(val) && val > currentVal) candidates.push({ href: a.href, val });
		}
		if (!candidates.length) return null;
		candidates.sort((a, b) => a.val - b.val);
		return candidates[0].href;
	}

	/* ============================================================ *
	 *  DANBOORU ADAPTER
	 * ============================================================ */
	BE.core.registerAdapter({
		id: 'danbooru',
		hostPattern: /donmai\.us$|atfbooru\.ninja$/,
		priority: 10,
		isPostPage: () => /\/posts\/\d+/.test(location.pathname),
							getPostId: () => (location.pathname.match(/\/posts\/(\d+)/) || [])[1] || null,
							getThumbElements: (root) => BE.dom.qsa('article[id^="post_"] img, .post-preview img', root),
							getThumbPostId: (img) => {
								const art = img.closest('[id^="post_"]') || img.closest('a[href*="/posts/"]');
								const idAttr = art?.id?.match(/post_(\d+)/)?.[1];
								if (idAttr) return idAttr;
								const href = art?.getAttribute?.('href') || img.closest('a')?.getAttribute('href') || '';
								return (href.match(/\/posts\/(\d+)/) || [])[1] || null;
							},
							async fetchPost(id) {
								const data = await BE.net.json(`${location.origin}/posts/${id}.json`);
								return normalizeDanbooru(data);
							},
							async fetchThumbBatch(ids) {
								if (!ids.length) return [];
								const tags = `id:${ids.join(',')}`;
								const data = await BE.net.json(`${location.origin}/posts.json?tags=${encodeURIComponent(tags)}&limit=${ids.length}`);
								return data.map(normalizeDanbooru);
							},
							favoriteSelector: 'a#post-favorite-link, button[data-post-id] .favorite, .post-vote-favorite-count',
							gridContainerSelector: '#posts-container, .posts-container',
							pagination: {
								containerSelectors: ['.paginator', '#paginator', 'nav.pagination', 'section#paginating-nav'],
								getPageIdentity(url) {
									const u = safeURL(url);
									if (!u) return '1';
									return u.searchParams.get('page') || '1';
								},
								getNextUrl(doc) {
									const link = findFirstNextLink(doc, [
										'a[rel="next"]', 'a.next', 'a.next_page',
										'.paginator a[rel="next"]', 'nav.pagination a[rel="next"]',
										'section#paginating-nav a[rel="next"]',
									]);
									return link?.href || null;
								},
								calculateNextUrl(currentUrl) {
									const u = safeURL(currentUrl);
									if (!u) return null;
									const page = parseInt(u.searchParams.get('page') || '1', 10);
									u.searchParams.set('page', String(page + 1));
									return u.toString();
								},
								getPostIdentity(el) {
									const art = el.closest('[id^="post_"], article.post-preview');
									return art?.id?.match(/post_(\d+)/)?.[1] || null;
								},
							},
	});

	function normalizeDanbooru(d) {
		const original = d.file_url || d.large_file_url || '';
		return emptyPost({
			id: String(d.id),
						 originalUrl: original,
						 sampleUrl: d.large_file_url || original,
						 previewUrl: d.preview_file_url || d.large_file_url || original,
						 mediaType: d.is_video ? 'video' : (guessMediaType(original) === 'unknown' ? guessMediaType(d.preview_file_url) : guessMediaType(original)),
						 width: d.image_width || 0,
						 height: d.image_height || 0,
						 fileSize: d.file_size || 0,
						 md5: d.md5 || '',
						 rating: { s: 'safe', q: 'questionable', e: 'explicit', g: 'safe' }[d.rating] || d.rating || 'unknown',
						 score: d.score || 0,
						 favCount: d.fav_count || 0,
						 artists: (d.tag_string_artist || '').split(' ').filter(Boolean),
						 characters: (d.tag_string_character || '').split(' ').filter(Boolean),
						 copyrights: (d.tag_string_copyright || '').split(' ').filter(Boolean),
						 generalTags: (d.tag_string_general || '').split(' ').filter(Boolean),
						 metaTags: (d.tag_string_meta || '').split(' ').filter(Boolean),
						 allTags: (d.tag_string || '').split(' ').filter(Boolean),
						 source: d.source || '',
						 postUrl: `${location.origin}/posts/${d.id}`,
						 createdAt: d.created_at || '',
						 siteId: 'danbooru',
		});
	}

	/* ============================================================ *
	 *  GELBOORU-FAMILY ADAPTER
	 *  Supports: Gelbooru, Safebooru, Rule34.xxx, Realbooru, TBIB,
	 *  Xbooru, HypnoHub — all Gelbooru 0.2 derivatives.
	 *
	 *  Pagination strategy (in priority order):
	 *    1. Explicit next link: #paginator a[alt="next"], a.next, a[rel="next"]
	 *    2. PID-advancing link: smallest pid greater than current pid
	 *    3. Calculated fallback: current pid + observed page size
	 *
	 *  The observed page size is captured the first time a real next link
	 *  is found, then reused for all future calculated fallbacks. This
	 *  avoids hard-coding a universal page size (Safebooru uses 42,
	 *  Gelbooru proper uses 100 with API limits, etc.).
	 * ============================================================ */

	/** Extracts a post ID from a Gelbooru-family thumbnail element using
	 *  multiple patterns since markup drifts across forks/versions. */
	function gelbooruPostId(el) {
		const a = el.closest('a');
		const href = a?.getAttribute('href') || '';
		const byHref = href.match(/[?&]id=(\d+)/);
		if (byHref) return byHref[1];
		const byAnchorId = a?.id?.match(/^p(\d+)$/);
		if (byAnchorId) return byAnchorId[1];
		const wrapper = el.closest('[data-id], [data-post-id]');
		if (wrapper) return wrapper.dataset.id || wrapper.dataset.postId;
		const byImgId = el.id?.match(/\d+/);
		return byImgId ? byImgId[0] : null;
	}

	/** Observed page-size cache for Gelbooru-family calculated fallbacks.
	 *  Populated the first time a real next-link yields a pid delta. */
	let _gelbooruObservedPageSize = null;

	BE.core.registerAdapter({
		id: 'gelbooru-family',
		hostPattern: /gelbooru\.com$|safebooru\.org$|rule34\.xxx$|realbooru\.com$|tbib\.org$|xbooru\.com$|hypnohub\.net$/,
		priority: 10,
		isPostPage: () => {
			const p = new URLSearchParams(location.search);
			return p.get('page') === 'post' && p.get('s') === 'view';
		},
		getPostId: () => new URLSearchParams(location.search).get('id'),
							getThumbElements: (root) => BE.dom.qsa(
								'.thumbnail-preview img, article.thumbnail-preview img, span.thumb img, #post-list img.preview, #post-list-posts img, .thumb img',
								root,
							),
							getThumbPostId: (img) => gelbooruPostId(img),
							async fetchPost(id) {
								try {
									const posts = await gelbooruApiFetch([id]);
									if (posts[0]) return posts[0];
								} catch (err) {
									BE.log.warn('gelbooru: dapi fetchPost failed, falling back to HTML parse', err);
								}
								return gelbooruFetchPostHTML(id);
							},
							async fetchThumbBatch(ids) {
								if (!ids.length) return [];
								try {
									const results = await gelbooruApiFetch(ids);
									if (results.length) return results;
								} catch (err) {
									BE.log.warn('gelbooru: dapi batch fetch failed, falling back to HTML parsing', err);
								}
								return gelbooruFetchPostsHTMLBounded(ids, 3);
							},
							favoriteSelector: 'a[href*="s=favorite"], #favorite-button',
							gridContainerSelector: '.content, #post-list, #post-list-posts',
							pagination: {
								containerSelectors: ['#paginator', '.pagination', '.pagination-controls'],

								getPageIdentity(url) {
									const u = safeURL(url);
									if (!u) return '0';
									// Gelbooru-family uses pid= for page offset. Combined with
									// tags/s/page/s params for full identity.
									const pid = u.searchParams.get('pid') || '0';
									const tags = u.searchParams.get('tags') || '';
									const s = u.searchParams.get('s') || '';
									return `${tags}|${s}|${pid}`;
								},

								getNextUrl(doc) {
									// Strategy 1: Explicit "next" links. The primary selector that
									// works on Safebooru and Gelbooru 0.2 clones is
									// #paginator a[alt="next"]. We also try a.next and a[rel="next"]
									// for newer Gelbooru versions.
									const nextLink = findFirstNextLink(doc, [
										'#paginator a[alt="next"]',
										'#paginator a[title="next"]',
										'#paginator a.next',
										'.pagination a[alt="next"]',
										'.pagination a[title="next"]',
										'.pagination a.next',
										'a[alt="next"]',
										'a[rel="next"]',
										'a.next',
									]);
									if (nextLink) {
										// Observe the page-size delta for future calculated fallbacks.
										const currentPid = parseInt(this.getPageIdentity(location.href).split('|').pop() || '0', 10) || 0;
										const nextPid = parseInt(this.getPageIdentity(nextLink.href).split('|').pop() || '0', 10) || 0;
										if (nextPid > currentPid && nextPid - currentPid <= 200) {
											_gelbooruObservedPageSize = nextPid - currentPid;
											BE.log.debug(`[Gallery] observed gelbooru page size: ${_gelbooruObservedPageSize}`);
										}
										return nextLink.href;
									}

									// Strategy 2: Among all pid= links, find the smallest pid
									// greater than the current pid. This catches numbered
									// pagination (1, 2, 3...) where no alt="next" exists.
									const currentPidStr = this.getPageIdentity(location.href).split('|').pop() || '0';
									const currentPid = parseInt(currentPidStr, 10) || 0;
									const advancingHref = findAdvancingPidLink(doc, 'pid', currentPid);
									if (advancingHref) {
										const advPid = parseInt(safeURL(advancingHref)?.searchParams.get('pid') || '0', 10) || 0;
										if (advPid > currentPid && advPid - currentPid <= 200) {
											_gelbooruObservedPageSize = advPid - currentPid;
										}
										return advancingHref;
									}

									return null;
								},

								calculateNextUrl(currentUrl) {
									const u = safeURL(currentUrl);
									if (!u) return null;
									const currentPid = parseInt(u.searchParams.get('pid') || '0', 10) || 0;
									// Use observed page size if available, otherwise default to 42
									// (Safebooru's default). This is a last-resort fallback — the
									// real next link is always preferred.
									const pageSize = _gelbooruObservedPageSize || 42;
									u.searchParams.set('pid', String(currentPid + pageSize));
									// Preserve all other params: page=post, s=list, tags=, etc.
									return u.toString();
								},

								getPostIdentity(el) {
									return gelbooruPostId(el);
								},
							},
	});

	let _gelbooruApiHealthy = true;

	async function gelbooruApiFetch(ids) {
		const url = `${location.origin}/index.php?page=dapi&s=post&q=index&json=1&tags=${encodeURIComponent('id:' + ids.join(','))}&limit=${ids.length}`;
		let data;
		try {
			const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			data = await res.json();
			_gelbooruApiHealthy = true;
		} catch (fetchErr) {
			BE.log.debug('gelbooru: same-origin fetch failed, trying GM.xhr', fetchErr);
			data = await BE.net.json(url, { retries: 1 });
			_gelbooruApiHealthy = true;
		}
		const list = Array.isArray(data) ? data : (data?.post || []);
		if (!Array.isArray(list) || !list.length) return [];
		return list.map(normalizeGelbooru);
	}

	async function gelbooruFetchPostHTML(id) {
		try {
			const url = `${location.origin}/index.php?page=post&s=view&id=${id}`;
			const res = await BE.net.request({ url }, 1);
			return parseGelbooruPostHTML(res.responseText, id);
		} catch (err) {
			BE.log.warn(`gelbooru: HTML fallback failed for post ${id}`, err);
			return null;
		}
	}

	async function gelbooruFetchPostsHTMLBounded(ids, concurrency = 3) {
		const results = [];
		let i = 0;
		async function worker() {
			while (i < ids.length) {
				const id = ids[i++];
				const post = await gelbooruFetchPostHTML(id);
				if (post) results.push(post);
				await new Promise((r) => setTimeout(r, 150));
			}
		}
		await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
		return results;
	}

	function parseGelbooruPostHTML(html, id) {
		const doc = new DOMParser().parseFromString(html, 'text/html');
		const img = doc.querySelector('#image, img#image');
		const video = doc.querySelector('video source, video#gelcomVideoPlayer source, video');
		const originalLink = doc.querySelector('a.download-link, a[download], li a[href*="/samples/"], li a[href*="/images/"]');
		const original = video?.getAttribute('src') || originalLink?.getAttribute('href') || img?.getAttribute('src') || '';
		const sample = img?.getAttribute('src') || original;
		const tagLinks = Array.from(doc.querySelectorAll('.tag-list li, #tag-sidebar li, li[class*="tag-type-"]'));
		const tags = [];
		const artists = [], characters = [], copyrights = [];
		for (const li of tagLinks) {
			const a = li.querySelector('a[href*="tags="]') || li.querySelector('a');
			const text = (a?.textContent || '').trim().replace(/\s+/g, '_').toLowerCase();
			if (!text) continue;
			tags.push(text);
			const cls = li.className || '';
			if (/tag-type-artist|category-1/.test(cls)) artists.push(text);
			else if (/tag-type-character|category-4/.test(cls)) characters.push(text);
			else if (/tag-type-copyright|category-3/.test(cls)) copyrights.push(text);
		}
		const ratingText = (doc.querySelector('[id*="rating"]')?.textContent || '').toLowerCase();
		const rating = ratingText.includes('explicit') ? 'explicit' : ratingText.includes('question') ? 'questionable' : ratingText.includes('safe') ? 'safe' : 'unknown';
		const dims = (img?.getAttribute('data-original-width') && img?.getAttribute('data-original-height'))
		? { w: Number(img.getAttribute('data-original-width')), h: Number(img.getAttribute('data-original-height')) }
		: { w: img?.naturalWidth || 0, h: img?.naturalHeight || 0 };

		if (!original && !tags.length) return null;

		return emptyPost({
			id: String(id),
						 originalUrl: original,
						 sampleUrl: sample,
						 previewUrl: sample,
						 mediaType: video ? 'video' : guessMediaType(original),
						 width: dims.w,
						 height: dims.h,
						 rating,
						 artists, characters, copyrights,
						 generalTags: tags,
						 allTags: tags,
						 postUrl: `${location.origin}/index.php?page=post&s=view&id=${id}`,
						 siteId: 'gelbooru-family',
		});
	}

	function normalizeGelbooru(d) {
		const original = d.file_url || '';
		return emptyPost({
			id: String(d.id),
						 originalUrl: original,
						 sampleUrl: d.sample_url || original,
						 previewUrl: d.preview_url || d.sample_url || original,
						 mediaType: guessMediaType(original),
						 width: d.width || 0,
						 height: d.height || 0,
						 fileSize: d.file_size || 0,
						 md5: d.md5 || '',
						 rating: d.rating || 'unknown',
						 score: Number(d.score) || 0,
						 favCount: 0,
						 artists: [], characters: [], copyrights: [],
						 generalTags: String(d.tags || '').split(' ').filter(Boolean),
						 metaTags: [],
						 allTags: String(d.tags || '').split(' ').filter(Boolean),
						 source: d.source || '',
						 postUrl: `${location.origin}/index.php?page=post&s=view&id=${d.id}`,
						 createdAt: d.created_at || '',
						 siteId: 'gelbooru-family',
		});
	}

	/* ============================================================ *
	 *  MOEBOORU ADAPTER
	 * ============================================================ */
	BE.core.registerAdapter({
		id: 'moebooru',
		hostPattern: /yande\.re$|konachan\.(com|net)$|lolibooru\.moe$/,
							priority: 10,
							isPostPage: () => /\/post\/show\/\d+/.test(location.pathname),
							getPostId: () => (location.pathname.match(/\/post\/show\/(\d+)/) || [])[1] || null,
							getThumbElements: (root) => BE.dom.qsa('a.thumb img, ul#post-list-posts img.preview, .post-preview img', root),
							getThumbPostId: (img) => {
								const a = img.closest('a');
								const href = a?.getAttribute('href') || '';
								return (href.match(/\/post\/show\/(\d+)/) || [])[1] || null;
							},
							async fetchPost(id) {
								const data = await BE.net.json(`${location.origin}/post.json?tags=id:${id}`);
								return data[0] ? normalizeMoebooru(data[0]) : null;
							},
							async fetchThumbBatch(ids) {
								if (!ids.length) return [];
								const tags = `id:${ids.join(',')}`;
								const data = await BE.net.json(`${location.origin}/post.json?tags=${encodeURIComponent(tags)}&limit=${ids.length}`);
								return data.map(normalizeMoebooru);
							},
							favoriteSelector: 'a.favorite-button-fav, #post-vote-fav-link',
							gridContainerSelector: '#post-list, .content',
							pagination: {
								containerSelectors: ['.pagination', '#paginator', '.pagination-controls'],
								getPageIdentity(url) {
									const u = safeURL(url);
									if (!u) return '1';
									return u.searchParams.get('page') || '1';
								},
								getNextUrl(doc) {
									const link = findFirstNextLink(doc, [
										'a.next_page', 'a[rel="next"]', 'a.next',
										'.pagination a.next_page', '.pagination a[rel="next"]',
									]);
									return link?.href || null;
								},
								calculateNextUrl(currentUrl) {
									const u = safeURL(currentUrl);
									if (!u) return null;
									const page = parseInt(u.searchParams.get('page') || '1', 10);
									u.searchParams.set('page', String(page + 1));
									return u.toString();
								},
								getPostIdentity(el) {
									const a = el.closest('a');
									const href = a?.getAttribute('href') || '';
									return (href.match(/\/post\/show\/(\d+)/) || [])[1] || null;
								},
							},
	});

	function normalizeMoebooru(d) {
		const original = d.file_url || '';
		return emptyPost({
			id: String(d.id),
						 originalUrl: original,
						 sampleUrl: d.sample_url || original,
						 previewUrl: d.preview_url || original,
						 mediaType: guessMediaType(original),
						 width: d.width || 0,
						 height: d.height || 0,
						 fileSize: d.file_size || 0,
						 md5: d.md5 || '',
						 rating: { s: 'safe', q: 'questionable', e: 'explicit' }[d.rating] || 'unknown',
						 score: d.score || 0,
						 favCount: d.fav_count || 0,
						 artists: [], characters: [], copyrights: [],
						 generalTags: String(d.tags || '').split(' ').filter(Boolean),
						 metaTags: [],
						 allTags: String(d.tags || '').split(' ').filter(Boolean),
						 source: d.source || '',
						 postUrl: `${location.origin}/post/show/${d.id}`,
						 createdAt: d.created_at ? new Date(d.created_at * 1000).toISOString() : '',
						 siteId: 'moebooru',
		});
	}

	/* ============================================================ *
	 *  E621 / E926 ADAPTER
	 * ============================================================ */
	BE.core.registerAdapter({
		id: 'e621',
		hostPattern: /e621\.net$|e926\.net$/,
		priority: 10,
		isPostPage: () => /\/posts\/\d+/.test(location.pathname),
							getPostId: () => (location.pathname.match(/\/posts\/(\d+)/) || [])[1] || null,
							getThumbElements: (root) => BE.dom.qsa('article.post-preview img, #posts-container img', root),
							getThumbPostId: (img) => {
								const art = img.closest('article[id^="post_"]');
								return art?.id?.match(/post_(\d+)/)?.[1] || (img.closest('a')?.getAttribute('href')?.match(/\/posts\/(\d+)/) || [])[1] || null;
							},
							async fetchPost(id) {
								const data = await BE.net.json(`${location.origin}/posts/${id}.json`, {
									headers: { 'User-Agent': `BooruEnhancer/${BE.VERSION} (userscript)` },
								});
								return data.post ? normalizeE621(data.post) : null;
							},
							async fetchThumbBatch(ids) {
								if (!ids.length) return [];
								const tags = `id:${ids.join(',')}`;
								const data = await BE.net.json(`${location.origin}/posts.json?tags=${encodeURIComponent(tags)}&limit=${ids.length}`, {
									headers: { 'User-Agent': `BooruEnhancer/${BE.VERSION} (userscript)` },
								});
								return (data.posts || []).map(normalizeE621);
							},
							favoriteSelector: '#add-to-favorites, #remove-from-favorites',
							gridContainerSelector: '#posts-container',
							pagination: {
								containerSelectors: ['#paginator', 'nav.paginator', 'section#paginating-nav'],
								getPageIdentity(url) {
									const u = safeURL(url);
									if (!u) return '1';
									// e621 uses page= or cursor-based b=/a= params
									return u.searchParams.get('page') || u.searchParams.get('b') || u.searchParams.get('a') || '1';
								},
								getNextUrl(doc) {
									const link = findFirstNextLink(doc, [
										'a[rel="next"]', 'a.next',
										'#paginator a[rel="next"]', 'nav.paginator a[rel="next"]',
										'section#paginating-nav a[rel="next"]',
									]);
									return link?.href || null;
								},
								calculateNextUrl(currentUrl) {
									const u = safeURL(currentUrl);
									if (!u) return null;
									// If cursor-based (b= or a= params present), can't calculate —
									// must rely on the next link from the fetched page.
									if (u.searchParams.has('b') || u.searchParams.has('a')) return null;
									const page = parseInt(u.searchParams.get('page') || '1', 10);
									u.searchParams.set('page', String(page + 1));
									return u.toString();
								},
								getPostIdentity(el) {
									const art = el.closest('article[id^="post_"]');
									return art?.id?.match(/post_(\d+)/)?.[1] || null;
								},
							},
	});

	function normalizeE621(p) {
		const original = p.file?.url || '';
		return emptyPost({
			id: String(p.id),
						 originalUrl: original,
						 sampleUrl: p.sample?.url || original,
						 previewUrl: p.preview?.url || original,
						 mediaType: p.file?.ext === 'webm' || p.file?.ext === 'mp4' ? 'video' : (p.file?.ext === 'gif' ? 'gif' : 'image'),
						 width: p.file?.width || 0,
						 height: p.file?.height || 0,
						 fileSize: p.file?.size || 0,
						 md5: p.file?.md5 || '',
						 rating: { s: 'safe', q: 'questionable', e: 'explicit' }[p.rating] || 'unknown',
						 score: p.score?.total ?? 0,
						 favCount: p.fav_count || 0,
						 artists: p.tags?.artist || [],
						 characters: p.tags?.character || [],
						 copyrights: p.tags?.copyright || [],
						 generalTags: p.tags?.general || [],
						 metaTags: p.tags?.meta || [],
						 allTags: Object.values(p.tags || {}).flat(),
						 source: (p.sources || [])[0] || '',
						 postUrl: `${location.origin}/posts/${p.id}`,
						 createdAt: p.created_at || '',
						 siteId: 'e621',
		});
	}

	/* ============================================================ *
	 *  GENERIC ADAPTER
	 * ============================================================ */
	BE.core.registerAdapter({
		id: 'generic',
		hostPattern: /.*/,
		priority: -1,
		isPostPage: () => !!BE.dom.qs('#image, #main_image, .image-container img, main img.post-image'),
							getPostId: () => (location.pathname.match(/(\d{3,})/) || [])[1] || location.href,
							getThumbElements: (root) => BE.dom.qsa('img.preview, img.thumb, .thumbnail img, .post-thumbnail img', root),
							getThumbPostId: (img) => {
								const a = img.closest('a');
								const href = a?.getAttribute('href') || '';
								return (href.match(/(\d{3,})/) || [])[0] || href || null;
							},
							async fetchPost() {
								const img = BE.dom.qs('#image, #main_image, .image-container img, main img.post-image');
								const video = BE.dom.qs('video source, video');
								const original = video?.src || video?.currentSrc || img?.src || '';
								return emptyPost({
									id: this.getPostId(),
												 originalUrl: original,
												 sampleUrl: original,
												 previewUrl: img?.src || original,
												 mediaType: video ? 'video' : guessMediaType(original),
												 width: img?.naturalWidth || 0,
												 height: img?.naturalHeight || 0,
												 allTags: BE.dom.qsa('a[href*="tags="], .tag-link, li.tag a').map((a) => a.textContent.trim()).filter(Boolean),
												 postUrl: location.href,
												 siteId: 'generic',
								});
							},
							async fetchThumbBatch() { return []; },
							favoriteSelector: 'a[href*="favorite" i], button[class*="favorite" i]',
							gridContainerSelector: 'body',
							pagination: {
								containerSelectors: ['.pagination', '#paginator', '.pagination-controls', 'nav.paginator'],
								getPageIdentity(url) {
									const u = safeURL(url);
									if (!u) return '1';
									return u.searchParams.get('pid') || u.searchParams.get('page') || '1';
								},
								getNextUrl(doc) {
									const link = findFirstNextLink(doc, [
										'a[rel="next"]', 'a.next',
										'a[aria-label*="next" i]', 'a[title*="next" i]',
										'.pagination a[rel="next"]', '#paginator a[rel="next"]',
									]);
									if (link) return link.href;
									// Try pid-advancing links
									const currentPid = parseInt(this.getPageIdentity(location.href), 10) || 0;
									if (currentPid > 0 || location.href.includes('pid=')) {
										const adv = findAdvancingPidLink(doc, 'pid', currentPid);
										if (adv) return adv;
									}
									// Try page-advancing links
									const currentPage = parseInt(safeURL(location.href)?.searchParams.get('page') || '1', 10) || 1;
									const pageLinks = Array.from(doc.querySelectorAll('a[href*="page="]'));
									const candidates = [];
									for (const a of pageLinks) {
										const u = safeURL(a.href);
										if (!u) continue;
										const pg = parseInt(u.searchParams.get('page') || '1', 10);
										if (!isNaN(pg) && pg > currentPage) candidates.push({ href: a.href, pg });
									}
									if (candidates.length) {
										candidates.sort((a, b) => a.pg - b.pg);
										return candidates[0].href;
									}
									return null;
								},
								calculateNextUrl(currentUrl) {
									const u = safeURL(currentUrl);
									if (!u) return null;
									if (u.searchParams.has('pid')) {
										const pid = parseInt(u.searchParams.get('pid'), 10) || 0;
										u.searchParams.set('pid', String(pid + 42));
										return u.toString();
									}
									if (u.searchParams.has('page')) {
										const page = parseInt(u.searchParams.get('page'), 10) || 1;
										u.searchParams.set('page', String(page + 1));
										return u.toString();
									}
									return null;
								},
								getPostIdentity(el) {
									const a = el.closest('a');
									const href = a?.getAttribute('href') || '';
									return (href.match(/(\d{3,})/) || [])[0] || href || null;
								},
							},
	});

	/* ============================================================ *
	 *  NAMING
	 * ============================================================ */
	BE.naming = {
		build(post) {
			const tpl = BE.settings.get('download.filenameTemplate') || '{id}';
			const delim = BE.settings.get('download.tagDelimiter') || ', ';
			const maxChars = BE.settings.get('download.maxCharacters') || 3;

			const charList = post.characters.length
			? post.characters.slice(0, maxChars).map(prettyTag)
			: ['Unknown Character'];

			const fields = {
				character: charList.join(delim),
 artist: (post.artists.length ? post.artists.map(prettyTag) : ['Unknown Artist']).join(delim),
 copyright: (post.copyrights.length ? post.copyrights.map(prettyTag) : ['Unknown Copyright']).join(delim),
 id: post.id,
 md5: post.md5 || post.id,
 rating: post.rating,
 score: String(post.score),
 resolution: post.width && post.height ? `${post.width}x${post.height}` : '',
 date: post.createdAt ? post.createdAt.slice(0, 10) : '',
			};

			let name = tpl.replace(/\{(\w+)\}/g, (_, key) => (fields[key] !== undefined ? fields[key] : ''));
			name = name.replace(/\s{2,}/g, ' ').replace(/^[\s\-,]+|[\s\-,]+$/g, '');
			if (!name) name = post.id || 'download';
			return BE.dom.sanitizeFilename(name);
		},
 extensionFor(post) {
	 const url = post.originalUrl || post.sampleUrl || '';
	 const m = url.split('?')[0].match(/\.([a-z0-9]+)$/i);
	 return m ? m[1] : (post.mediaType === 'video' ? 'mp4' : 'jpg');
 },
	};
	function prettyTag(tag) {
		return tag.replace(/_/g, ' ').replace(/\s+\(.*?\)$/, '').replace(/\b\w/g, (c) => c.toUpperCase());
	}

	/* ============================================================ *
	 *  DOWNLOADER
	 * ============================================================ */
	BE.modules = BE.modules || {};
	BE.modules.downloader = (() => {
		const queue = new Map();

		function statusFor(id) { return queue.get(id) || { status: 'idle', progress: 0 }; }

		async function downloadPost(post) {
			if (!post || !post.originalUrl) {
				BE.log.warn('downloader: post has no original URL', post);
				BE.modules.ui.toast('No downloadable file was found for this post.');
				return false;
			}
			const name = `${BE.naming.build(post)}.${BE.naming.extensionFor(post)}`;
			queue.set(post.id, { status: 'downloading', progress: 0 });
			BE.bus.emit('download:start', { post, name });

			const retries = BE.settings.get('download.retries') ?? 3;
			for (let attempt = 0; attempt <= retries; attempt++) {
				try {
					await tryDownload(post, name, (pct) => {
						queue.set(post.id, { status: 'downloading', progress: pct });
						BE.bus.emit('download:progress', { post, name, progress: pct });
					});
					queue.set(post.id, { status: 'done', progress: 100 });
					BE.bus.emit('download:done', { post, name });
					return true;
				} catch (err) {
					BE.log.warn(`downloader attempt ${attempt + 1}/${retries + 1} failed`, err);
					if (attempt === retries) {
						queue.set(post.id, { status: 'error', progress: 0 });
						BE.bus.emit('download:error', { post, name, error: err });
						_GM.notification({ title: 'Download failed', text: `${name} — ${err.message || err}` });
						BE.modules.ui.toast(`Download failed: ${name}`);
						return false;
					}
					await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
				}
			}
			return false;
		}

		function tryDownload(post, name, onProgress) {
			return new Promise((resolve, reject) => {
				try {
					_GM.download({
						url: post.originalUrl,
						name,
						saveAs: false,
						onload: () => resolve(),
								 onerror: (e) => reject(new Error(e?.error || 'GM_download error')),
								 onprogress: (p) => { if (p.lengthComputable) onProgress(Math.round((p.loaded / p.total) * 100)); },
					});
				} catch (err) {
					_GM.xhr({
						url: post.originalUrl,
						method: 'GET',
						responseType: 'blob',
						onprogress: (p) => { if (p.lengthComputable) onProgress(Math.round((p.loaded / p.total) * 100)); },
							onload: (res) => {
								if (res.status < 200 || res.status >= 300) return reject(new Error(`HTTP ${res.status}`));
								const blobUrl = URL.createObjectURL(res.response);
								const a = BE.dom.create('a', { href: blobUrl, download: name });
								document.body.appendChild(a);
								a.click();
								a.remove();
								setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
								resolve();
							},
							onerror: () => reject(new Error('network error')),
					});
				}
			});
		}

		function bulkDownload(posts) {
			if (!posts.length) { BE.modules.ui.toast('Select one or more posts first.'); return; }
			BE.bus.emit('download:bulk-start', { count: posts.length });
			BE.modules.ui.toast(`Downloading ${posts.length} post${posts.length === 1 ? '' : 's'}…`);
			let i = 0;
			const next = () => {
				if (i >= posts.length) { BE.bus.emit('download:bulk-done', {}); return; }
				const p = posts[i++];
				downloadPost(p).finally(() => setTimeout(next, 250));
			};
			next();
		}

		return { downloadPost, bulkDownload, statusFor };
	})();

	/* ============================================================ *
	 *  MEDIA LOADER
	 * ============================================================ */
	BE.modules.mediaLoader = (() => {
		function shouldSwap(imgEl, post) {
			if (BE.settings.get('media.neverUpscale') && post.width && imgEl) {
				const displayW = imgEl.getBoundingClientRect().width || imgEl.width;
				if (displayW && post.width < displayW) return false;
			}
			return true;
		}

		function swapImage(imgEl, post) {
			if (!post?.originalUrl || !shouldSwap(imgEl, post)) return;
			if (post.mediaType === 'video') {
				const video = BE.dom.create('video', {
					class: imgEl.className, controls: '', loop: BE.settings.get('viewer.loopVideo') ? '' : null,
											muted: BE.settings.get('viewer.muteVideo') ? '' : null,
											autoplay: BE.settings.get('viewer.autoplayVideo') ? '' : null,
											style: imgEl.getAttribute('style') || '',
				}, [BE.dom.create('source', { src: post.originalUrl })]);
				imgEl.replaceWith(video);
				BE.bus.emit('media:swapped', { post, el: video });
			} else {
				imgEl.dataset.beOriginalSwapped = 'true';
				imgEl.src = post.originalUrl;
				BE.bus.emit('media:swapped', { post, el: imgEl });
			}
		}

		function onPostPage(post) {
			const mode = BE.settings.get('media.mode');
			if (mode === 'disabled') return;
			const mainImg = BE.dom.qs('#image, #main_image, .image-container img, main img.post-image, article img.image');
			if (!mainImg) return;
			if (mode === 'always' || mode === 'post-page') {
				swapImage(mainImg, post);
			} else if (mode === 'on-click') {
				mainImg.style.cursor = 'zoom-in';
				mainImg.title = 'Click to load original';
				mainImg.addEventListener('click', function handler(e) {
					e.preventDefault();
					swapImage(mainImg, post);
					mainImg.removeEventListener('click', handler);
				}, { once: false });
			}
		}

		function applyThumbQuality(imgEl, post) {
			if (!post) return;
			const q = BE.settings.get('media.thumbQuality');
			if (q === 'original' && post.originalUrl) imgEl.src = post.originalUrl;
			else if (q === 'sample' && post.sampleUrl) imgEl.src = post.sampleUrl;
		}

		return { swapImage, onPostPage, applyThumbQuality };
	})();

	/* ============================================================ *
	 *  FAVORITES
	 * ============================================================ */
	BE.modules.favorites = (() => {
		const LOCAL_KEY = 'favorites:' + location.hostname;

		function localList() { return BE.store.get(LOCAL_KEY, []); }
		function isFavorited(id) { return localList().includes(id); }

		function toggleLocal(post) {
			const list = localList();
			const idx = list.indexOf(post.id);
			if (idx === -1) list.push(post.id); else list.splice(idx, 1);
			BE.store.set(LOCAL_KEY, list);
			BE.bus.emit('favorite:changed', { post, favorited: idx === -1 });
			return idx === -1;
		}

		function triggerNativeFavorite(container) {
			const adapter = BE.adapters.active;
			const btn = container ? BE.dom.qs(adapter.favoriteSelector, container) : BE.dom.qs(adapter.favoriteSelector);
			if (btn) { btn.click(); return true; }
			return false;
		}

		function favoritePost(post, container) {
			const favorited = toggleLocal(post);
			const native = triggerNativeFavorite(container);
			if (!native) {
				BE.modules.ui.toast('Saved to local favorites — no native favorite control was found to sync with the site.');
			}
			return favorited;
		}

		return { isFavorited, favoritePost, localList };
	})();

	/* ============================================================ *
	 *  FILTERS / BLACKLIST
	 * ============================================================ */
	BE.modules.filters = (() => {
		function postMatchesBlacklist(post) {
			const blacklist = BE.settings.get('filter.blacklist') ? BE.settings.blacklistTags() : [];
			const whitelist = new Set(BE.settings.whitelistTags());
			const tagSet = new Set(post.allTags.map((t) => t.toLowerCase()));

			if (BE.settings.get('filter.hideVideos') && post.mediaType === 'video') return true;
			if (BE.settings.get('filter.hideAnimations') && post.mediaType === 'gif') return true;
			if (BE.settings.get('filter.hideAIGenerated') && (tagSet.has('ai-generated') || tagSet.has('ai_generated'))) return true;
			const minRes = BE.settings.get('filter.minResolution');
			if (minRes && post.width && post.width < minRes) return true;

			for (const rule of blacklist) {
				if (whitelist.has(rule)) continue;
				if (rule.startsWith('rating:')) {
					if (post.rating === rule.slice(7)) return true;
				} else if (tagSet.has(rule)) {
					return true;
				}
			}
			return false;
		}

		function applyToThumb(el, post) {
			const hidden = postMatchesBlacklist(post);
			el.closest('article, .thumbnail-preview, span.thumb, .post-preview')?.classList.toggle('be-filtered-hidden', hidden);
			return hidden;
		}

		return { postMatchesBlacklist, applyToThumb };
	})();

	/* ============================================================ *
	 *  TAG TOOLS
	 * ============================================================ */
	const TAG_CATEGORY_COLORS = {
		artist: '#f2ac08', character: '#00aa00', copyright: '#d0d', general: '#0073ff',
 meta: '#eaa8f5', species: '#ed5d1f', lore: '#228822', invalid: '#ff3d3d',
	};

	BE.modules.tagTools = (() => {
		function colorizeCategory(el, category) {
			if (!BE.settings.get('tags.colorize')) return;
			el.style.setProperty('--be-tag-color', TAG_CATEGORY_COLORS[category] || TAG_CATEGORY_COLORS.general);
			el.classList.add('be-tag-colored');
		}

		function copyTagsToClipboard(post, opts = {}) {
			const tags = opts.selected || post.allTags;
			const text = tags.join(' ');
			navigator.clipboard?.writeText(text).then(
				() => _GM.notification({ title: 'Tags copied', text: `${tags.length} tags copied to clipboard` }),
													  () => { BE.log.warn('clipboard write failed'); BE.modules.ui.toast('Could not copy tags to clipboard.'); },
			);
		}

		function searchSelectedTags(tags) {
			if (!tags || !tags.length) { BE.modules.ui.toast('No tags selected.'); return; }
			const adapter = BE.adapters.active;
			const q = tags.join(' ');
			let url;
			if (adapter.id === 'gelbooru-family') url = `${location.origin}/index.php?page=post&s=list&tags=${encodeURIComponent(q)}`;
			else if (adapter.id === 'moebooru' || adapter.id === 'danbooru' || adapter.id === 'e621') url = `${location.origin}/posts?tags=${encodeURIComponent(q)}`;
			else url = `${location.origin}/?tags=${encodeURIComponent(q)}`;
			window.open(url, '_blank', 'noopener');
		}

		function buildCollapsible(listEl, threshold) {
			const items = BE.dom.qsa('li, .tag-item', listEl);
			if (items.length <= threshold) return;
			items.slice(threshold).forEach((li) => li.classList.add('be-tag-collapsed'));
			const toggle = BE.dom.create('button', {
				class: 'be-tag-expand-btn',
				text: `Show ${items.length - threshold} more tags`,
				onclick: () => {
					items.slice(threshold).forEach((li) => li.classList.remove('be-tag-collapsed'));
					toggle.remove();
				},
			});
			listEl.appendChild(toggle);
		}

		return { colorizeCategory, copyTagsToClipboard, searchSelectedTags, buildCollapsible, TAG_CATEGORY_COLORS };
	})();

	/* ============================================================ *
	 *  IMAGE INFO PANEL
	 * ============================================================ */
	BE.modules.imageInfo = {
		render(post) {
			const aspect = post.width && post.height ? (post.width / post.height).toFixed(3) : 'Unknown';
			const rows = [
				['Resolution', post.width && post.height ? `${post.width} × ${post.height}` : 'Unknown'],
 ['Aspect ratio', aspect],
 ['File size', post.fileSize ? BE.dom.formatBytes(post.fileSize) : 'Unknown'],
 ['Format', BE.naming.extensionFor(post).toUpperCase()],
 ['Uploaded', post.createdAt ? post.createdAt.slice(0, 10) : 'Unknown'],
 ['Score', post.score || 'Unknown'],
 ['Favorites', post.favCount || 'Unknown'],
 ['Rating', post.rating || 'Unknown'],
 ['MD5', post.md5 || 'Unknown'],
 ['Artists', post.artists.length ? post.artists.map(prettyTag).join(', ') : 'Unknown'],
 ['Characters', post.characters.length ? post.characters.map(prettyTag).join(', ') : 'Unknown'],
			];
			return BE.dom.create('table', { class: 'be-info-table' },
								 rows.map(([k, v]) => BE.dom.create('tr', {}, [
									 BE.dom.create('td', { class: 'be-info-key', text: k }),
																	BE.dom.create('td', { class: 'be-info-val', text: String(v) }),
								 ])));
		},
	};

	/* ============================================================ *
	 *  REVERSE IMAGE SEARCH
	 * ============================================================ */
	BE.modules.reverseSearch = {
		ENGINES: {
			saucenao: (url) => `https://saucenao.com/search.php?url=${encodeURIComponent(url)}`,
 iqdb: (url) => `https://iqdb.org/?url=${encodeURIComponent(url)}`,
 googleLens: (url) => `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(url)}`,
 yandex: (url) => `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(url)}`,
 bing: (url) => `https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:${encodeURIComponent(url)}`,
		},
 open(engine, imageUrl) {
	 if (!imageUrl) {
		 BE.modules.ui.toast('Open a post or select a thumbnail first.');
		 return;
	 }
	 const build = this.ENGINES[engine];
	 if (!build) return BE.log.warn('unknown reverse search engine', engine);
	 window.open(build(imageUrl), '_blank', 'noopener');
 },
	};

	/* ============================================================ *
	 *  SOURCE LINK DETECTION
	 * ============================================================ */
	BE.modules.sourceLinks = (() => {
		const PLATFORMS = [
			{ id: 'pixiv', re: /pixiv\.net/i, icon: '🎨' },
			{ id: 'twitter', re: /twitter\.com|x\.com/i, icon: '🐦' },
			{ id: 'fanbox', re: /fanbox\.cc/i, icon: '📦' },
			{ id: 'fantia', re: /fantia\.jp/i, icon: '💠' },
			{ id: 'skeb', re: /skeb\.jp/i, icon: '✏️' },
			{ id: 'deviantart', re: /deviantart\.com/i, icon: '🖌️' },
			{ id: 'artstation', re: /artstation\.com/i, icon: '🚀' },
			{ id: 'nijie', re: /nijie\.info/i, icon: '🈲' },
		];
		function detect(sourceUrl) {
			if (!sourceUrl) return null;
			return PLATFORMS.find((p) => p.re.test(sourceUrl)) || null;
		}
		function archiveUrlFor(sourceUrl) {
			return `https://web.archive.org/web/2/${sourceUrl}`;
		}
		return { detect, archiveUrlFor, PLATFORMS };
	})();

	/* ============================================================ *
	 *  VIEWER
	 * ============================================================ */
	BE.modules.viewer = (() => {
		let root, mediaHost, currentIndex = -1, posts = [];
		let zoom = 1, panX = 0, panY = 0, rotation = 0, flipX = 1, flipY = 1;
		let dragging = false, dragStart = null;
		let rememberedVolume = 1;

		function ensureRoot() {
			if (root) return root;
			rememberedVolume = BE.store.get('viewer:volume', 1);
			root = BE.dom.create('div', { class: 'be-viewer be-hidden' }, [
				BE.dom.create('div', { class: 'be-viewer-toolbar' }, [
					iconBtn('be-v-close', '✕', 'Close (Esc)', close),
							  iconBtn('be-v-prev', '‹', 'Previous (←)', () => go(-1)),
							  iconBtn('be-v-next', '›', 'Next (→)', () => go(1)),
							  iconBtn('be-v-zoomin', '+', 'Zoom in', () => applyZoom(0.2)),
							  iconBtn('be-v-zoomout', '−', 'Zoom out', () => applyZoom(-0.2)),
							  iconBtn('be-v-fit', '⤢', 'Fit to window', resetTransform),
							  iconBtn('be-v-rotate', '⟳', 'Rotate', () => { rotation += 90; renderTransform(); }),
							  iconBtn('be-v-fliph', '⇋', 'Flip horizontal', () => { flipX *= -1; renderTransform(); }),
							  iconBtn('be-v-flipv', '⇵', 'Flip vertical', () => { flipY *= -1; renderTransform(); }),
							  iconBtn('be-v-download', '⬇', 'Download', () => posts[currentIndex] && BE.modules.downloader.downloadPost(posts[currentIndex])),
							  iconBtn('be-v-fav', '♥', 'Favorite (F)', () => posts[currentIndex] && BE.modules.favorites.favoritePost(posts[currentIndex])),
							  iconBtn('be-v-info', 'ℹ', 'Toggle info', toggleInfo),
							  BE.dom.create('span', { class: 'be-v-counter' }),
				]),
				(mediaHost = BE.dom.create('div', { class: 'be-viewer-media' })),
								 BE.dom.create('div', { class: 'be-viewer-info-panel be-hidden' }),
			]);
			root.addEventListener('wheel', onWheel, { passive: false });
			root.addEventListener('mousedown', onDragStart);
			window.addEventListener('mousemove', onDragMove);
			window.addEventListener('mouseup', onDragEnd);
			root.addEventListener('touchstart', onTouchStart, { passive: true });
			root.addEventListener('touchmove', onTouchMove, { passive: false });
			root.addEventListener('touchend', onTouchEnd);
			root.addEventListener('click', (e) => { if (e.target === root || e.target === mediaHost) close(); });
			document.body.appendChild(root);
			return root;
		}

		function iconBtn(cls, label, title, onClick) {
			return BE.dom.create('button', { class: `be-v-btn ${cls}`, title, text: label, onclick: onClick });
		}

		function toggleInfo() {
			const panel = BE.dom.qs('.be-viewer-info-panel', root);
			panel.classList.toggle('be-hidden');
			if (!panel.classList.contains('be-hidden')) {
				panel.innerHTML = '';
				panel.appendChild(BE.modules.imageInfo.render(posts[currentIndex]));
			}
		}

		function open(postList, startIndex = 0) {
			if (!BE.settings.get('viewer.enabled')) return;
			posts = postList;
			ensureRoot();
			root.classList.remove('be-hidden');
			document.documentElement.classList.add('be-viewer-open');
			renderIndex(startIndex);
			BE.bus.emit('viewer:open', { index: startIndex });
		}

		function close() {
			if (!root) return;
			root.classList.add('be-hidden');
			document.documentElement.classList.remove('be-viewer-open');
			mediaHost.innerHTML = '';
			BE.bus.emit('viewer:close', {});
		}

		function isOpen() { return root && !root.classList.contains('be-hidden'); }

		function go(delta) { renderIndex((currentIndex + delta + posts.length) % posts.length); }

		function resetTransform() {
			zoom = 1; panX = 0; panY = 0; rotation = 0; flipX = 1; flipY = 1;
			renderTransform();
		}

		function renderTransform() {
			const el = mediaHost.firstElementChild;
			if (!el) return;
			el.style.transform = `translate(${panX}px, ${panY}px) rotate(${rotation}deg) scale(${zoom * flipX}, ${zoom * flipY})`;
		}

		function applyZoom(delta, centerX, centerY) {
			zoom = Math.max(0.1, Math.min(8, zoom + delta));
			renderTransform();
		}

		function onWheel(e) {
			if (!mediaHost.contains(e.target) && e.target !== mediaHost) return;
			e.preventDefault();
			applyZoom(e.deltaY < 0 ? 0.15 : -0.15);
		}

		function onDragStart(e) {
			if (e.target.closest('.be-viewer-toolbar')) return;
			dragging = true;
			dragStart = { x: e.clientX - panX, y: e.clientY - panY };
		}
		function onDragMove(e) {
			if (!dragging) return;
			panX = e.clientX - dragStart.x;
			panY = e.clientY - dragStart.y;
			renderTransform();
		}
		function onDragEnd() { dragging = false; }

		let touchState = null;
		function onTouchStart(e) {
			if (e.touches.length === 2) {
				touchState = { type: 'pinch', dist: touchDist(e.touches), zoom };
			} else if (e.touches.length === 1) {
				touchState = { type: 'pan', x: e.touches[0].clientX - panX, y: e.touches[0].clientY - panY, startX: e.touches[0].clientX, t: Date.now() };
			}
		}
		function onTouchMove(e) {
			if (!touchState) return;
			e.preventDefault();
			if (touchState.type === 'pinch' && e.touches.length === 2) {
				const d = touchDist(e.touches);
				zoom = Math.max(0.1, Math.min(8, touchState.zoom * (d / touchState.dist)));
				renderTransform();
			} else if (touchState.type === 'pan' && e.touches.length === 1) {
				panX = e.touches[0].clientX - touchState.x;
				panY = e.touches[0].clientY - touchState.y;
				renderTransform();
			}
		}
		function onTouchEnd(e) {
			if (touchState?.type === 'pan' && zoom <= 1.05) {
				const dx = (e.changedTouches[0]?.clientX ?? 0) - touchState.startX;
				const dt = Date.now() - touchState.t;
				if (dt < 400 && Math.abs(dx) > 60) go(dx < 0 ? 1 : -1);
			}
			touchState = null;
		}
		function touchDist(touches) {
			const [a, b] = touches;
			return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
		}

		function renderIndex(idx) {
			currentIndex = idx;
			resetTransform();
			const post = posts[idx];
			mediaHost.innerHTML = '';
			if (!post) return;

			let el;
			if (post.mediaType === 'video') {
				el = BE.dom.create('video', {
					src: post.originalUrl, controls: '', autoplay: BE.settings.get('viewer.autoplayVideo') ? '' : null,
								   loop: BE.settings.get('viewer.loopVideo') ? '' : null, playsinline: '',
				});
				el.muted = BE.settings.get('viewer.muteVideo');
				if (BE.settings.get('viewer.rememberVolume')) el.volume = rememberedVolume;
				el.addEventListener('volumechange', () => { rememberedVolume = el.volume; BE.store.set('viewer:volume', el.volume); });
			} else {
				el = BE.dom.create('img', { src: post.originalUrl, alt: post.id, draggable: 'false' });
			}
			el.className = `be-viewer-fit-${BE.settings.get('viewer.fitMode')}`;
			mediaHost.appendChild(el);

			BE.dom.qs('.be-v-counter', root).textContent = `${idx + 1} / ${posts.length}`;
			const info = BE.dom.qs('.be-viewer-info-panel', root);
			if (info && !info.classList.contains('be-hidden')) { info.innerHTML = ''; info.appendChild(BE.modules.imageInfo.render(post)); }
			BE.bus.emit('viewer:navigate', { post, index: idx });

			[idx + 1, idx - 1].forEach((n) => {
				const p = posts[(n + posts.length) % posts.length];
				if (p?.mediaType !== 'video' && p?.originalUrl) { const pre = new Image(); pre.src = p.originalUrl; }
			});
		}

		function activeVideo() { return mediaHost?.querySelector('video') || null; }
		function togglePlayPause() { const v = activeVideo(); if (v) v.paused ? v.play() : v.pause(); }
		function screenshotCurrentFrame() {
			const v = activeVideo();
			if (!v) return null;
			const canvas = document.createElement('canvas');
			canvas.width = v.videoWidth; canvas.height = v.videoHeight;
			canvas.getContext('2d').drawImage(v, 0, 0);
			return canvas.toDataURL('image/png');
		}
		function stepFrame(dir) {
			const v = activeVideo();
			if (!v) return;
			v.pause();
			v.currentTime = Math.max(0, v.currentTime + dir * (1 / 30));
		}
		function setPlaybackRate(rate) { const v = activeVideo(); if (v) v.playbackRate = rate; }
		function requestPiP() { const v = activeVideo(); v?.requestPictureInPicture?.().catch((e) => BE.log.warn('PiP failed', e)); }

		return {
			open, close, isOpen, go, applyZoom, resetTransform,
			togglePlayPause, screenshotCurrentFrame, stepFrame, setPlaybackRate, requestPiP,
			get currentPost() { return posts[currentIndex]; },
		};
	})();

	/* ============================================================ *
	 *  GALLERY — thumbnail grid enrichment, infinite scroll, bulk ops
	 *
	 *  v1.1.1 CHANGES:
	 *  - Infinite scroll completely rewritten to use adapter.pagination API.
	 *  - State machine: IDLE → LOADING → SUCCESS/ERROR/EXHAUSTED.
	 *  - loadedPages Set prevents duplicate page loads.
	 *  - loadedPostIds Set prevents duplicate post insertion.
	 *  - nextPageUrl stored in JS state, not re-read from live DOM.
	 *  - Sentinel with Retry button on error.
	 *  - Auto-continues if sentinel still visible after a successful load.
	 *  - No concurrent loadNextPage() calls.
	 * ============================================================ */
	BE.modules.gallery = (() => {
		const postCache = new Map();
		const thumbToPost = new WeakMap();
		let orderedPosts = [];
		let selectionMode = false;
		const selected = new Set();
		let pendingIds = new Set();
		let gridContainerEl = null;
		let _infiniteScrollInit = false;

		const flushBatch = BE.dom.debounce(async () => {
			const ids = [...pendingIds];
			pendingIds.clear();
			if (!ids.length) return;
			try {
				const results = await BE.adapters.active.fetchThumbBatch(ids);
				for (const post of results) postCache.set(post.id, post);
				BE.bus.emit('gallery:batch-loaded', { ids, count: results.length });
				refreshEnrichedThumbs();
			} catch (err) {
				BE.log.warn('thumb batch fetch failed — thumbnails stay visually enhanced, only overlay/filter metadata is unavailable', err);
			}
		}, 120);

		function applyGridSettings() {
			const container = BE.dom.qs(BE.adapters.active.gridContainerSelector);
			if (!container) return;
			gridContainerEl = container;
			container.classList.add('be-gallery-grid');
			container.classList.toggle('be-gallery-compact', !!BE.settings.get('gallery.compactMode'));
			container.style.setProperty('--be-grid-columns', String(BE.settings.get('gallery.gridDensity') || 6));
		}

		function applyVisualEnhancement(img) {
			if (img.dataset.beVisual) return;
			img.dataset.beVisual = '1';
			img.removeAttribute('width');
			img.removeAttribute('height');
			img.classList.add('be-thumb-img');
			const wrap = img.closest('article, .thumbnail-preview, span.thumb, .post-preview') || img.parentElement;
			wrap?.classList.add('be-thumb-wrap');
		}

		function collectThumbs() {
			return BE.adapters.active.getThumbElements().filter((img) => !img.dataset.beCollected);
		}

		function queueForFetch(img) {
			const id = BE.adapters.active.getThumbPostId(img);
			if (!id) return;
			img.dataset.bePostId = id;
			img.dataset.beEnriched = 'pending';
			if (postCache.has(id)) { enrichThumb(img, postCache.get(id)); return; }
			pendingIds.add(id);
			flushBatch();
		}

		function refreshEnrichedThumbs() {
			BE.dom.qsa('img[data-be-enriched="pending"]').forEach((img) => {
				const post = postCache.get(img.dataset.bePostId);
				if (post) enrichThumb(img, post);
			});
		}

		function enrichThumb(img, post) {
			img.dataset.beEnriched = 'done';
			thumbToPost.set(img, post);
			orderedPosts.push(post);

			BE.modules.mediaLoader.applyThumbQuality(img, post);
			const hidden = BE.modules.filters.applyToThumb(img, post);
			if (hidden) return;

			const wrap = img.closest('article, .thumbnail-preview, span.thumb, .post-preview') || img.parentElement;
			if (!wrap || wrap.dataset.beWired) return;
			wrap.dataset.beWired = '1';
			wrap.classList.add('be-thumb-wrap');

			const overlay = BE.dom.create('div', { class: 'be-thumb-overlay' }, [
				BE.dom.create('button', {
					class: `be-thumb-fav ${BE.modules.favorites.isFavorited(post.id) ? 'be-active' : ''}`,
							  title: 'Favorite', text: '♥',
							  onclick: (e) => { e.preventDefault(); e.stopPropagation(); const on = BE.modules.favorites.favoritePost(post, wrap); e.currentTarget.classList.toggle('be-active', on); },
				}),
				BE.dom.create('button', {
					class: 'be-thumb-dl', title: 'Download original', text: '⬇',
					onclick: (e) => { e.preventDefault(); e.stopPropagation(); BE.modules.downloader.downloadPost(post); },
				}),
				post.mediaType === 'video' ? BE.dom.create('span', { class: 'be-thumb-badge', text: 'VIDEO' }) : null,
										  post.mediaType === 'gif' ? BE.dom.create('span', { class: 'be-thumb-badge', text: 'GIF' }) : null,
			]);
			wrap.appendChild(overlay);

			if (BE.settings.get('media.hoverPreview')) {
				let hoverTimer;
				wrap.addEventListener('mouseenter', () => {
					hoverTimer = setTimeout(() => showHoverPreview(wrap, post), 350);
				});
				wrap.addEventListener('mouseleave', () => { clearTimeout(hoverTimer); hideHoverPreview(); });
			}

			img.addEventListener('click', (e) => {
				if (selectionMode) { e.preventDefault(); toggleSelect(wrap, post); return; }
				if (!BE.settings.get('viewer.enabled')) return;
				if (e.button === 1 || e.ctrlKey || e.metaKey) return;
				e.preventDefault();
				BE.modules.viewer.open(orderedPosts, orderedPosts.indexOf(post));
			});
			img.addEventListener('auxclick', (e) => {
				if (e.button === 1) { e.preventDefault(); window.open(post.originalUrl, '_blank', 'noopener'); }
			});
		}

		let hoverEl = null;
		function showHoverPreview(wrap, post) {
			hideHoverPreview();
			hoverEl = BE.dom.create('div', { class: 'be-hover-preview' }, [
				BE.dom.create('img', { src: post.sampleUrl || post.originalUrl }),
			]);
			document.body.appendChild(hoverEl);
			const rect = wrap.getBoundingClientRect();
			hoverEl.style.left = `${Math.min(rect.right + 12, window.innerWidth - 340)}px`;
			hoverEl.style.top = `${Math.max(8, rect.top)}px`;
		}
		function hideHoverPreview() { hoverEl?.remove(); hoverEl = null; }

		function toggleSelect(wrap, post) {
			if (selected.has(post.id)) { selected.delete(post.id); wrap.classList.remove('be-selected'); }
			else { selected.add(post.id); wrap.classList.add('be-selected'); }
			BE.bus.emit('gallery:selection-changed', { count: selected.size });
		}
		function setSelectionMode(on) {
			selectionMode = on;
			document.documentElement.classList.toggle('be-selection-mode', on);
			if (!on) { selected.clear(); BE.dom.qsa('.be-selected').forEach((el) => el.classList.remove('be-selected')); }
		}
		function selectedPosts() { return [...selected].map((id) => postCache.get(id)).filter(Boolean); }

		function scan() {
			applyGridSettings();
			const thumbs = collectThumbs();
			for (const img of thumbs) {
				img.dataset.beCollected = '1';
				applyVisualEnhancement(img);
				BE.dom.onVisible(img, queueForFetch);
			}
		}

		/* ============================================================
		 *  INFINITE SCROLL — v1.1.1 Rewrite
		 *
		 *  State machine:
		 *    IDLE → LOADING → SUCCESS → (READY_FOR_NEXT or EXHAUSTED)
		 *                    → ERROR → (RETRY or EXHAUSTED)
		 *
		 *  Pagination discovery (all delegated to adapter.pagination):
		 *    1. adapter.pagination.getNextUrl(fetchedDoc) — explicit next link
		 *    2. adapter.pagination.calculateNextUrl(currentUrl) — calculated
		 *    3. EXHAUSTED only when both fail AND fetched page had no new posts
		 * ============================================================ */
		function initInfiniteScroll() {
			if (_infiniteScrollInit) return;
			if (!BE.settings.get('gallery.infiniteScroll')) return;
			_infiniteScrollInit = true;

			const adapter = BE.adapters.active;
			if (!adapter.pagination) {
				BE.log.warn('[Gallery] adapter has no pagination API — infinite scroll disabled');
				return;
			}

			const pag = adapter.pagination;
			const container = BE.dom.qs(adapter.gridContainerSelector) || document.body;
			if (!container) return;

			// Find and hide native paginator using reversible class.
			const findPaginator = (root) => {
				const sels = pag.containerSelectors || ['.pagination', '#paginator'];
				for (const s of sels) {
					const el = BE.dom.qs(s, root);
					if (el) return el;
				}
				return null;
			};
			const nativePaginator = findPaginator(document);
			if (nativePaginator) {
				nativePaginator.classList.add('be-pagination-hidden');
			}

			// --- State ---
			const state = {
				status: 'IDLE',
				nextPageUrl: pag.getNextUrl(document),
						  loadedPages: new Set(),
						  loadedPostIds: new Set(),
						  error: null,
						  consecutiveEmptyPages: 0,
			};

			// Seed: mark current page identity as loaded.
			const currentPageId = pag.getPageIdentity(location.href);
			state.loadedPages.add(currentPageId);

			// Seed: mark current page's posts as loaded (for dedup).
			const initThumbs = adapter.getThumbElements();
			for (const img of initThumbs) {
				const pid = pag.getPostIdentity(img);
				if (pid) state.loadedPostIds.add(pid);
			}

			BE.log.debug('[Gallery] pagination initialized', {
				currentPage: location.href,
				pageIdentity: currentPageId,
				nextPageUrl: state.nextPageUrl,
				initialPostCount: state.loadedPostIds.size,
			});

			// --- Sentinel element with dynamic status UI ---
			const sentinel = BE.dom.create('div', { class: 'be-scroll-sentinel' });
			container.appendChild(sentinel);

			/** Render the sentinel's content based on current state. */
			function renderSentinel(status, message, showRetry, retryUrl) {
				sentinel.innerHTML = '';
				const text = BE.dom.create('span', { class: 'be-sentinel-text', text: message });
				sentinel.appendChild(text);
				if (showRetry) {
					const retryBtn = BE.dom.create('button', {
						class: 'be-sentinel-retry',
						text: 'Retry',
						onclick: (e) => {
							e.preventDefault();
							if (retryUrl) {
								state.nextPageUrl = retryUrl;
								loadNextPage();
							}
						},
					});
					sentinel.appendChild(retryBtn);
				}
			}

			renderSentinel('IDLE', 'Scroll for more…', false);

			// --- Loading state guard ---
			let loading = false;

			/** Validate that the fetched response is a real gallery page
			 *  with post thumbnails, not an error/login page. */
			function validateResponse(doc) {
				// Check for login page indicators
				const title = (doc.title || '').toLowerCase();
				if (/log\s*in|sign\s*in|not\s*found|error|access\s*denied/.test(title)) {
					// Title-based heuristic — but some valid pages have "login" in nav,
					// so only treat as login page if there's a password field.
					if (doc.querySelector('input[type="password"]')) {
						return { valid: false, reason: 'Response appears to be a login page' };
					}
				}
				// Check for gallery container
				const newContainer = doc.querySelector(adapter.gridContainerSelector);
				if (!newContainer) {
					return { valid: false, reason: 'Gallery container not found in response' };
				}
				return { valid: true, container: newContainer };
			}

			/** The main load function. Guarded against concurrent calls. */
			async function loadNextPage() {
				if (loading) {
					BE.log.debug('[Gallery] loadNextPage() called while already loading — ignored');
					return;
				}
				if (state.status === 'EXHAUSTED') return;

				// If we don't have a next URL, try calculating one.
				if (!state.nextPageUrl) {
					BE.log.debug('[Gallery] no next URL from site, trying calculated fallback');
					const calc = pag.calculateNextUrl?.(location.href);
					if (calc) {
						state.nextPageUrl = calc;
					} else {
						state.status = 'EXHAUSTED';
						renderSentinel('EXHAUSTED', 'No more posts', false);
						return;
					}
				}

				// Dedup: check page identity
				const pageId = pag.getPageIdentity(state.nextPageUrl);
				if (state.loadedPages.has(pageId)) {
					BE.log.debug(`[Gallery] page identity "${pageId}" already loaded — advancing`);
					const calc = pag.calculateNextUrl?.(state.nextPageUrl);
					if (calc) {
						state.nextPageUrl = calc;
						loadNextPage();
						return;
					}
					state.status = 'EXHAUSTED';
					renderSentinel('EXHAUSTED', 'No more posts', false);
					return;
				}

				// --- Begin loading ---
				loading = true;
				state.status = 'LOADING';
				renderSentinel('LOADING', 'Loading more…', false);
				BE.log.debug('[Gallery] requesting next page:', state.nextPageUrl);

				const requestUrl = state.nextPageUrl;

				try {
					const res = await BE.net.request({ url: requestUrl }, 2);

					// HTTP status validation
					if (!res || res.status < 200 || res.status >= 300) {
						throw new Error(`HTTP ${res?.status || 'unknown'}`);
					}
					if (!res.responseText || res.responseText.length < 200) {
						throw new Error('Empty or truncated response');
					}

					const doc = new DOMParser().parseFromString(res.responseText, 'text/html');

					// Validate the response is a real gallery page
					const validation = validateResponse(doc);
					if (!validation.valid) {
						throw new Error(validation.reason);
					}
					const newContainer = validation.container;

					// Extract thumbnail images from the fetched document
					const newThumbImgs = BE.dom.qsa(
						'.thumbnail-preview img, article.thumbnail-preview img, span.thumb img, #post-list img.preview, #post-list-posts img, .thumb img, article.post-preview img, a.thumb img, img.preview',
						newContainer,
					).filter((img) => {
						// Filter: must have a recognizable post ID
						return pag.getPostIdentity(img) || adapter.getThumbPostId(img);
					});

					if (!newThumbImgs.length) {
						// No thumbnails found — could be end of results or error page
						BE.log.debug('[Gallery] no post thumbnails found in response');
						state.consecutiveEmptyPages++;
						if (state.consecutiveEmptyPages >= 2) {
							state.status = 'EXHAUSTED';
							renderSentinel('EXHAUSTED', 'No more posts', false);
							loading = false;
							return;
						}
						// Try advancing via calculated URL
						const calc = pag.calculateNextUrl?.(requestUrl);
						if (calc) {
							state.nextPageUrl = calc;
							loading = false;
							loadNextPage();
							return;
						}
						state.status = 'EXHAUSTED';
						renderSentinel('EXHAUSTED', 'No more posts', false);
						loading = false;
						return;
					}

					// Extract next URL from the fetched document BEFORE mutating DOM.
					// This is critical: we store it in JS state so we never need
					// to re-read the live paginator after DOM replacement.
					const newNextUrl = pag.getNextUrl(doc);
					BE.log.debug('[Gallery] received next page', {
						postCount: newThumbImgs.length,
						nextDetected: newNextUrl || '(none)',
					});

					// Insert unique posts
					let inserted = 0;
					let skipped = 0;
					for (const img of newThumbImgs) {
						const postId = pag.getPostIdentity(img) || adapter.getThumbPostId(img);
						if (!postId) continue;
						if (state.loadedPostIds.has(postId)) {
							skipped++;
							continue;
						}
						state.loadedPostIds.add(postId);

						// Find the wrapper element to insert (not just the img)
						const wrap = img.closest('article, .thumbnail-preview, span.thumb, .post-preview, li, div.thumb') || img.parentElement;
						const node = wrap || img;
						// Insert before the sentinel to maintain correct order
						container.insertBefore(node, sentinel);
						inserted++;
					}

					BE.log.debug(`[Gallery] extracted posts: ${newThumbImgs.length}, inserted: ${inserted}, duplicate posts skipped: ${skipped}`);

					// Mark this page as loaded
					state.loadedPages.add(pageId);

					// Update next URL for the next cycle
					if (newNextUrl) {
						state.nextPageUrl = newNextUrl;
					} else {
						// No explicit next link in the response — try calculated
						const calc = pag.calculateNextUrl?.(requestUrl);
						state.nextPageUrl = calc || null;
					}

					// Decide next state
					if (inserted === 0 && skipped === newThumbImgs.length) {
						// All posts were duplicates — try advancing
						state.consecutiveEmptyPages++;
						if (state.consecutiveEmptyPages >= 3 || !state.nextPageUrl) {
							state.status = 'EXHAUSTED';
							renderSentinel('EXHAUSTED', 'No more posts', false);
							loading = false;
							return;
						}
						BE.log.debug('[Gallery] all posts were duplicates, trying next page');
						loading = false;
						loadNextPage();
						return;
					}

					// Success — reset empty counter
					state.consecutiveEmptyPages = 0;

					if (!state.nextPageUrl) {
						state.status = 'EXHAUSTED';
						renderSentinel('EXHAUSTED', 'No more posts', false);
					} else {
						state.status = 'SUCCESS';
						renderSentinel('SUCCESS', 'Scroll for more…', false);
					}

					// Process newly inserted thumbnails through the gallery pipeline
					// (visual enhancement, metadata fetch, filters, overlays, viewer)
					scan();

					// If the sentinel is still visible after insertion (e.g.
					// on very large monitors where one page doesn't fill the
					// viewport), automatically continue loading the next page.
					if (state.status !== 'EXHAUSTED') {
						setTimeout(() => {
							if (loading) return;
							const rect = sentinel.getBoundingClientRect();
							const isVisible = rect.top < (window.innerHeight + 1200);
							if (isVisible) {
								BE.log.debug('[Gallery] sentinel still visible after load — auto-continuing');
								loadNextPage();
							}
						}, 150);
					}

				} catch (err) {
					BE.log.error('[Gallery] pagination error:', err.message || err);
					state.error = err;
					state.status = 'ERROR';
					// Show retry UI with the URL that failed
					renderSentinel('ERROR', 'Unable to load the next page.', true, requestUrl);
				} finally {
					loading = false;
				}
			}

			// --- IntersectionObserver ---
			// Observes the sentinel and triggers loadNextPage() when it
			// enters the viewport. The observer stays active for the
			// lifetime of the gallery — it is never disconnected.
			const io = new IntersectionObserver((entries) => {
				if (state.status === 'EXHAUSTED') return;
				if (loading) return;
				for (const e of entries) {
					if (e.isIntersecting) {
						loadNextPage();
						break;
					}
				}
			}, { rootMargin: '1200px 0px' });
			io.observe(sentinel);

			// Expose for debugging
			BE.modules.gallery._scrollState = state;
		}

		return {
			scan, initInfiniteScroll, setSelectionMode, toggleSelect, selectedPosts, applyGridSettings,
			get selectionMode() { return selectionMode; },
						  get orderedPosts() { return orderedPosts; },
						  postFor(img) { return thumbToPost.get(img); },
		};
	})();

	/* ============================================================ *
	 *  KEYBINDS
	 * ============================================================ */
	BE.modules.keybinds = (() => {
		function normalize(k) { return k.length === 1 ? k.toLowerCase() : k; }
		function eventKey(e) { return normalize(e.key); }

		function handler(e) {
			const tag = document.activeElement?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

			const key = eventKey(e);
			const noContext = () => BE.modules.ui.toast('Open a post or select a thumbnail first.');
			const binds = {
				[BE.settings.get('keys.close')]: () => BE.modules.viewer.isOpen() && BE.modules.viewer.close(),
						   [BE.settings.get('keys.next')]: () => BE.modules.viewer.isOpen() && BE.modules.viewer.go(1),
						   [BE.settings.get('keys.prev')]: () => BE.modules.viewer.isOpen() && BE.modules.viewer.go(-1),
						   [BE.settings.get('keys.playPause')]: () => { if (BE.modules.viewer.isOpen()) { e.preventDefault(); BE.modules.viewer.togglePlayPause(); } },
						   [BE.settings.get('keys.download')]: () => currentContextPost() ? BE.modules.downloader.downloadPost(currentContextPost()) : noContext(),
						   [BE.settings.get('keys.favorite')]: () => currentContextPost() ? BE.modules.favorites.favoritePost(currentContextPost()) : noContext(),
						   [BE.settings.get('keys.openOriginal')]: () => currentContextPost() ? window.open(currentContextPost().originalUrl, '_blank', 'noopener') : noContext(),
						   [BE.settings.get('keys.viewOriginal')]: () => toggleViewerFromContext(),
			};

			if (e.ctrlKey && key === BE.settings.get('keys.commandPalette')) {
				e.preventDefault();
				BE.bus.emit('ui:command-palette-toggle', {});
				return;
			}
			const fn = binds[key];
			if (fn) fn();
		}

		function currentContextPost() {
			if (BE.modules.viewer.isOpen()) return BE.modules.viewer.currentPost;
			return BE.core.currentPost || null;
		}

		function toggleViewerFromContext() {
			if (BE.modules.viewer.isOpen()) { BE.modules.viewer.close(); return; }
			if (BE.core.currentPost) { BE.modules.viewer.open([BE.core.currentPost], 0); return; }
			BE.modules.ui.toast('Open a post or select a thumbnail first.');
		}

		function init() { window.addEventListener('keydown', handler); }
		return { init };
	})();

	/* ============================================================ *
	 *  UI
	 * ============================================================ */
	BE.modules.ui = (() => {
		let toolbar;
		let toastHost;
		const RELOAD_REQUIRED_KEYS = new Set([
			'general.enabled', 'general.toolbarPosition', 'media.mode', 'gallery.infiniteScroll',
		]);

		function toast(message, ms = 3200) {
			if (!toastHost) {
				toastHost = BE.dom.create('div', { class: 'be-toast-host' });
				document.body.appendChild(toastHost);
			}
			const el = BE.dom.create('div', { class: 'be-toast', text: message });
			toastHost.appendChild(el);
			requestAnimationFrame(() => el.classList.add('be-toast-in'));
			setTimeout(() => {
				el.classList.remove('be-toast-in');
				setTimeout(() => el.remove(), 220);
			}, ms);
		}

		function buildToolbar() {
			toolbar = BE.dom.create('div', { class: `be-toolbar be-toolbar-${BE.settings.get('general.toolbarPosition')}` }, [
				toolbarBtn('⚙', 'Settings', () => BE.modules.settingsPanel.open()),
									toolbarBtn('☰', 'Select posts', () => {
										const on = !document.documentElement.classList.contains('be-selection-mode');
										BE.modules.gallery.setSelectionMode(on);
										toast(on ? 'Selection mode on — click thumbnails to select them.' : 'Selection mode off.');
									}),
						   toolbarBtn('⬇', 'Bulk download selected', () => {
							   BE.modules.downloader.bulkDownload(BE.modules.gallery.selectedPosts());
						   }),
						   toolbarBtn('🔍', 'Reverse search current', () => {
							   const selectedOnes = BE.modules.gallery.selectedPosts();
							   const post = BE.core.currentPost || (selectedOnes.length === 1 ? selectedOnes[0] : null);
							   BE.modules.reverseSearch.open('saucenao', post?.originalUrl);
						   }),
			]);
			document.body.appendChild(toolbar);
		}
		function toolbarBtn(icon, title, onClick) {
			return BE.dom.create('button', { class: 'be-toolbar-btn', title, text: icon, onclick: onClick });
		}

		function init() {
			buildToolbar();
			applyTheme();
			BE.bus.on('settings:changed', ({ key }) => {
				if (key === 'general.theme' || key === 'general.accentColor') applyTheme();
				if (key === 'gallery.gridDensity' || key === 'gallery.compactMode') BE.modules.gallery.applyGridSettings();
				if (key === 'media.thumbQuality') {
					BE.dom.qsa('img[data-be-enriched="done"]').forEach((img) => {
						const post = BE.modules.gallery.postFor(img);
						if (post) BE.modules.mediaLoader.applyThumbQuality(img, post);
					});
				}
			});
		}

		function applyTheme() {
			document.documentElement.style.setProperty('--be-accent', BE.settings.get('general.accentColor'));
			document.documentElement.dataset.beTheme = BE.settings.get('general.theme');
		}

		return { init, toast, RELOAD_REQUIRED_KEYS, get toolbar() { return toolbar; } };
	})();

	BE.modules.settingsPanel = (() => {
		let overlay;

		function fieldControl(key, def) {
			const val = BE.settings.get(key);
			const onChange = (v) => BE.settings.set(key, v);
			switch (def.type) {
				case 'bool':
					return BE.dom.create('input', { type: 'checkbox', checked: val ? 'checked' : null, onchange: (e) => onChange(e.target.checked) });
				case 'select':
					return BE.dom.create('select', { onchange: (e) => onChange(e.target.value) },
										 def.choices.map((c) => BE.dom.create('option', { value: c, selected: c === val ? 'selected' : null, text: c })));
				case 'color':
					return BE.dom.create('input', { type: 'color', value: val, onchange: (e) => onChange(e.target.value) });
				case 'range':
					return BE.dom.create('input', { type: 'range', min: def.min, max: def.max, value: val, oninput: (e) => onChange(Number(e.target.value)) });
				case 'number':
					return BE.dom.create('input', { type: 'number', min: def.min, max: def.max, value: val, onchange: (e) => onChange(Number(e.target.value)) });
				case 'textarea':
					return BE.dom.create('textarea', { rows: 4, onchange: (e) => onChange(e.target.value) }, [val]);
				default:
					return BE.dom.create('input', { type: 'text', value: val, onchange: (e) => onChange(e.target.value) });
			}
		}

		function buildContent(filterText = '') {
			const content = BE.dom.create('div', { class: 'be-settings-content' });
			const cats = BE.settings.categories();
			for (const cat of cats) {
				const keys = BE.settings.byCategory(cat).filter((k) => {
					if (!filterText) return true;
					const def = BE.settings.SCHEMA[k];
					return def.label.toLowerCase().includes(filterText) || k.toLowerCase().includes(filterText);
				});
				if (!keys.length) continue;
				const section = BE.dom.create('div', { class: 'be-settings-section' }, [
					BE.dom.create('h3', { text: cat }),
				]);
				for (const key of keys) {
					const def = BE.settings.SCHEMA[key];
					const needsReload = BE.modules.ui.RELOAD_REQUIRED_KEYS.has(key);
					const row = BE.dom.create('div', { class: 'be-settings-row' }, [
						BE.dom.create('label', {}, [def.label, needsReload ? BE.dom.create('span', { class: 'be-reload-badge', text: 'Reload required' }) : null]),
											  fieldControl(key, def),
					]);
					section.appendChild(row);
				}
				content.appendChild(section);
			}
			return content;
		}

		function rebuild(filterText) {
			const content = BE.dom.qs('.be-settings-content', overlay);
			content.replaceWith(buildContent(filterText));
		}

		function open() {
			if (!overlay) {
				const search = BE.dom.create('input', {
					type: 'text', placeholder: 'Search settings…', class: 'be-settings-search',
					oninput: BE.dom.debounce((e) => rebuild(e.target.value.toLowerCase()), 120),
				});
				overlay = BE.dom.create('div', { class: 'be-settings-overlay be-hidden' }, [
					BE.dom.create('div', { class: 'be-settings-modal' }, [
						BE.dom.create('div', { class: 'be-settings-header' }, [
							BE.dom.create('h2', { text: `Booru Enhancer — Settings (v${BE.VERSION})` }),
									  search,
					BE.dom.create('button', { class: 'be-settings-close', text: '✕', onclick: close }),
						]),
				   buildContent(),
								  BE.dom.create('div', { class: 'be-settings-footer' }, [
									  BE.dom.create('button', { text: 'Export JSON', onclick: exportSettings }),
												BE.dom.create('button', { text: 'Import JSON', onclick: importSettings }),
												BE.dom.create('button', { text: 'Reset all to defaults', class: 'be-danger', onclick: () => { if (confirm('Reset ALL settings to defaults?')) { BE.settings.resetAll(); rebuild(''); } } }),
								  ]),
					]),
				]);
				overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
				document.body.appendChild(overlay);
			}
			overlay.classList.remove('be-hidden');
		}
		function close() { overlay?.classList.add('be-hidden'); }

		function exportSettings() {
			const blob = new Blob([BE.settings.exportJSON()], { type: 'application/json' });
			const a = BE.dom.create('a', { href: URL.createObjectURL(blob), download: 'booru-enhancer-settings.json' });
			document.body.appendChild(a); a.click(); a.remove();
		}
		function importSettings() {
			const input = BE.dom.create('input', { type: 'file', accept: 'application/json' });
			input.addEventListener('change', () => {
				const file = input.files[0];
				if (!file) return;
				const reader = new FileReader();
				reader.onload = () => { if (BE.settings.importJSON(reader.result)) rebuild(''); };
				reader.readAsText(file);
			});
			input.click();
		}

		return { open, close };
	})();

	/* ============================================================ *
	 *  STYLES  (includes new v1.1.1 pagination-related styles)
	 * ============================================================ */
	_GM.addStyle(`
	:root {
		--be-accent: #ff8ac6;
		--be-bg: #16161c;
		--be-bg-elevated: #202028;
		--be-fg: #eaeaf0;
		--be-fg-dim: #9a9aa8;
		--be-radius: 10px;
		--be-shadow: 0 8px 30px rgba(0,0,0,.45);
		--be-grid-columns: 6;
		--be-thumb-gap: 10px;
	}
	[data-be-theme="light"] {
		--be-bg: #f4f4f8; --be-bg-elevated: #ffffff; --be-fg: #1b1b22; --be-fg-dim: #666676;
	}
	.be-hidden { display: none !important; }

	/* Reversible pagination hiding — replaced style.display = 'none'
	 *      so disabling infinite scroll restores native pagination. */
	.be-pagination-hidden { display: none !important; }

	/* Gallery grid */
	.be-gallery-grid {
		display: grid !important;
		grid-template-columns: repeat(var(--be-grid-columns), 1fr) !important;
		gap: var(--be-thumb-gap) !important;
	}
	.be-gallery-grid.be-gallery-compact { --be-thumb-gap: 4px; }
	.be-gallery-grid .be-thumb-wrap {
		width: 100% !important; height: auto !important; margin: 0 !important;
		aspect-ratio: 1 / 1; overflow: hidden; border-radius: 6px;
	}
	img.be-thumb-img {
		width: 100% !important; height: 100% !important; max-width: none !important; max-height: none !important;
		object-fit: cover; display: block;
	}

	/* Toolbar */
	.be-toolbar { position: fixed; z-index: 999997; display: flex; gap: 6px; padding: 6px;
		background: var(--be-bg-elevated); border-radius: var(--be-radius); box-shadow: var(--be-shadow); }
		.be-toolbar-bottom-right { right: 16px; bottom: 16px; }
		.be-toolbar-bottom-left { left: 16px; bottom: 16px; }
		.be-toolbar-top-right { right: 16px; top: 16px; }
		.be-toolbar-top-left { left: 16px; top: 16px; }
		.be-toolbar-btn { width: 38px; height: 38px; border-radius: 8px; border: none; cursor: pointer;
			background: transparent; color: var(--be-fg); font-size: 16px; transition: background .15s; }
			.be-toolbar-btn:hover { background: var(--be-accent); color: #111; }

			/* Toast notifications */
			.be-toast-host { position: fixed; z-index: 9999999; left: 50%; bottom: 76px; transform: translateX(-50%);
				display: flex; flex-direction: column; gap: 6px; align-items: center; pointer-events: none; }
				.be-toast { background: rgba(20,20,26,.94); color: #fff; padding: 9px 16px; border-radius: 8px;
					font-size: 13px; box-shadow: var(--be-shadow); opacity: 0; transform: translateY(8px);
					transition: opacity .18s ease, transform .18s ease; max-width: 60vw; text-align: center; }
					.be-toast-in { opacity: 1; transform: translateY(0); }

					/* Thumbnail overlay */
					.be-thumb-wrap { position: relative; }
					.be-thumb-overlay { position: absolute; top: 4px; right: 4px; display: flex; gap: 4px; opacity: 0;
						transition: opacity .12s; z-index: 5; }
						.be-thumb-wrap:hover .be-thumb-overlay { opacity: 1; }
						.be-thumb-fav, .be-thumb-dl { width: 26px; height: 26px; border-radius: 50%; border: none; cursor: pointer;
							background: rgba(0,0,0,.65); color: #fff; font-size: 13px; line-height: 26px; padding: 0; }
							.be-thumb-fav.be-active { background: var(--be-accent); color: #111; }
							.be-thumb-badge { position: absolute; left: 4px; bottom: 4px; background: rgba(0,0,0,.7); color: #fff;
								font-size: 10px; padding: 2px 5px; border-radius: 4px; letter-spacing: .04em; }
								.be-filtered-hidden { display: none !important; }
								.be-selection-mode .be-thumb-wrap { outline: 2px dashed transparent; cursor: pointer; }
								.be-selected { outline: 2px solid var(--be-accent) !important; }

								/* Hover preview */
								.be-hover-preview { position: fixed; z-index: 999996; max-width: 320px; max-height: 420px;
									border-radius: var(--be-radius); overflow: hidden; box-shadow: var(--be-shadow); pointer-events: none; }
									.be-hover-preview img { display: block; width: 100%; height: auto; }

									/* Infinite scroll sentinel — v1.1.1 with retry button support */
									.be-scroll-sentinel {
										width: 100%; text-align: center; padding: 24px; color: var(--be-fg-dim);
										grid-column: 1/-1; display: flex; align-items: center; justify-content: center; gap: 10px;
										font-size: 14px; min-height: 24px;
									}
									.be-sentinel-text { color: var(--be-fg-dim); }
									.be-sentinel-retry {
										padding: 5px 16px; border-radius: 6px; border: 1px solid var(--be-accent);
										background: transparent; color: var(--be-accent); cursor: pointer; font-size: 13px;
										transition: background .15s, color .15s;
									}
									.be-sentinel-retry:hover { background: var(--be-accent); color: #111; }

									/* Viewer */
									.be-viewer { position: fixed; inset: 0; z-index: 999999; background: rgba(6,6,10,.97);
										display: flex; flex-direction: column; }
										html.be-viewer-open { overflow: hidden; }
										.be-viewer-toolbar { display: flex; align-items: center; gap: 4px; padding: 8px 12px;
											background: rgba(0,0,0,.4); }
											.be-v-btn { width: 36px; height: 36px; border-radius: 8px; border: none; background: transparent;
												color: #eee; font-size: 16px; cursor: pointer; }
												.be-v-btn:hover { background: var(--be-accent); color: #111; }
												.be-v-counter { margin-left: auto; color: #ccc; font-variant-numeric: tabular-nums; padding-right: 8px; }
												.be-viewer-media { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden;
													position: relative; cursor: grab; }
													.be-viewer-media img, .be-viewer-media video { transition: transform .05s linear; user-select: none; }
													.be-viewer-fit-fit-both { max-width: 96vw; max-height: 82vh; }
													.be-viewer-fit-fit-width { width: 96vw; height: auto; }
													.be-viewer-fit-fit-height { height: 82vh; width: auto; }
													.be-viewer-fit-original-size { max-width: none; max-height: none; }
													.be-viewer-info-panel { position: absolute; right: 16px; top: 60px; background: rgba(20,20,26,.92);
														border-radius: var(--be-radius); padding: 12px 16px; box-shadow: var(--be-shadow); }
														.be-info-table td { padding: 3px 10px 3px 0; font-size: 13px; color: #ddd; }
														.be-info-key { color: var(--be-fg-dim); }

														/* Tags */
														.be-tag-colored { color: var(--be-tag-color) !important; }
														.be-tag-collapsed { display: none !important; }
														.be-tag-expand-btn { display: block; margin-top: 6px; background: none; border: none;
															color: var(--be-accent); cursor: pointer; font-size: 12px; }

															/* Settings panel */
															.be-settings-overlay { position: fixed; inset: 0; z-index: 999998; background: rgba(0,0,0,.6);
																display: flex; align-items: center; justify-content: center; }
																.be-settings-modal { width: min(760px, 92vw); max-height: 84vh; display: flex; flex-direction: column;
																	background: var(--be-bg); color: var(--be-fg); border-radius: var(--be-radius); box-shadow: var(--be-shadow); overflow: hidden; }
																	.be-settings-header { display: flex; align-items: center; gap: 10px; padding: 14px 16px;
																		background: var(--be-bg-elevated); }
																		.be-settings-header h2 { font-size: 15px; margin: 0; white-space: nowrap; }
																		.be-settings-search { flex: 1; padding: 6px 10px; border-radius: 6px; border: 1px solid #3a3a46;
																			background: var(--be-bg); color: var(--be-fg); }
																			.be-settings-close { background: none; border: none; color: var(--be-fg); font-size: 16px; cursor: pointer; }
																			.be-settings-content { flex: 1; overflow-y: auto; padding: 8px 16px; }
																			.be-settings-section h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
																				color: var(--be-accent); margin: 16px 0 6px; }
																				.be-settings-row { display: flex; align-items: center; justify-content: space-between; gap: 12px;
																					padding: 6px 0; border-bottom: 1px solid rgba(128,128,128,.12); }
																					.be-settings-row label { font-size: 13px; color: var(--be-fg); flex: 1; display: flex; align-items: center; gap: 8px; }
																					.be-reload-badge { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #ffb454;
																						border: 1px solid rgba(255,180,84,.5); border-radius: 4px; padding: 1px 5px; white-space: nowrap; }
																						.be-settings-row input[type="text"], .be-settings-row textarea, .be-settings-row select, .be-settings-row input[type="number"] {
																							background: var(--be-bg-elevated); color: var(--be-fg); border: 1px solid #3a3a46; border-radius: 6px; padding: 4px 8px; min-width: 160px; }
																							.be-settings-footer { display: flex; gap: 8px; padding: 12px 16px; background: var(--be-bg-elevated); }
																							.be-settings-footer button { padding: 7px 12px; border-radius: 6px; border: none; cursor: pointer;
																								background: var(--be-accent); color: #111; font-weight: 600; }
																								.be-settings-footer button.be-danger { background: #c0392b; color: #fff; }
																								`);

	/* ============================================================ *
	 *  BOOTSTRAP
	 * ============================================================ */
	BE.core.currentPost = null;

	async function initCurrentPostPage(adapter) {
		if (!adapter.isPostPage()) return;
		const id = adapter.getPostId();
		if (!id) return;
		try {
			const post = await adapter.fetchPost(id);
			if (!post) return;
			BE.core.currentPost = post;
			BE.bus.emit('post:loaded', post);
			BE.modules.mediaLoader.onPostPage(post);
			decoratePostPage(post, adapter);
		} catch (err) {
			BE.log.error('failed to load post metadata', err);
			BE.modules.ui.toast('Could not load full post metadata — some features (tags, info panel) may be limited on this page.');
		}
	}

	function decoratePostPage(post, adapter) {
		if (BE.settings.get('tags.colorize')) {
			const categoryMap = {
				artist: post.artists, character: post.characters, copyright: post.copyrights,
 general: post.generalTags, meta: post.metaTags,
			};
			for (const [cat, tags] of Object.entries(categoryMap)) {
				const set = new Set(tags);
				BE.dom.qsa('a[href*="tags="], .tag-link, li[class*="tag-type-"] a, li[class*="category-"] a').forEach((a) => {
					const t = (a.textContent || '').trim().replace(/\s+/g, '_').toLowerCase();
					if (set.has(t)) BE.modules.tagTools.colorizeCategory(a.closest('li') || a, cat);
				});
			}
		}
		const tagList = BE.dom.qs('#tag-list, ul#tag-sidebar, .tag-list');
		if (tagList) BE.modules.tagTools.buildCollapsible(tagList, BE.settings.get('tags.collapseThreshold'));

		const dock = BE.dom.create('div', { class: 'be-post-dock' });
		const infoToggle = BE.dom.create('button', { class: 'be-toolbar-btn', text: 'ℹ', title: 'Image info', onclick: () => {
			panel.classList.toggle('be-hidden');
		} });
		const panel = BE.dom.create('div', { class: 'be-hidden' }, [BE.modules.imageInfo.render(post)]);
		const reverseBtns = Object.keys(BE.modules.reverseSearch.ENGINES).map((engine) =>
		BE.dom.create('button', { class: 'be-toolbar-btn', text: engine[0].toUpperCase(), title: `Reverse search: ${engine}`, onclick: () => BE.modules.reverseSearch.open(engine, post.originalUrl) }));
		dock.append(infoToggle, ...reverseBtns, panel);

		if (post.source) {
			const platform = BE.modules.sourceLinks.detect(post.source);
			const srcRow = BE.dom.create('div', {}, [
				BE.dom.create('a', { href: post.source, target: '_blank', rel: 'noopener', text: `${platform ? platform.icon + ' ' : ''}Source` }),
			]);
			dock.appendChild(srcRow);
		}
		const insertTarget = BE.dom.qs(adapter.gridContainerSelector) || document.body;
		(BE.dom.qs('#image, #main_image')?.closest('div') || insertTarget).appendChild(dock);
	}

	function initGalleryPage(adapter) {
		BE.modules.gallery.scan();
		BE.modules.gallery.initInfiniteScroll();
		const observer = new MutationObserver(BE.dom.debounce(() => BE.modules.gallery.scan(), 200));
		const container = BE.dom.qs(adapter.gridContainerSelector) || document.body;
		observer.observe(container, { childList: true, subtree: true });
	}

	function init() {
		if (!BE.settings.get('general.enabled')) { BE.log.info('disabled for this site, skipping init'); return; }

		BE.adapters.active = BE.core.detectAdapter();
		BE.log.info(`v${BE.VERSION} initializing with adapter "${BE.adapters.active.id}" on ${location.hostname}`);

		BE.modules.ui.init();
		BE.modules.keybinds.init();

		initCurrentPostPage(BE.adapters.active);
		initGalleryPage(BE.adapters.active);

		_GM.registerMenuCommand('Booru Enhancer: Settings', () => BE.modules.settingsPanel.open());
		_GM.registerMenuCommand('Booru Enhancer: Toggle enabled', () => {
			BE.settings.set('general.enabled', !BE.settings.get('general.enabled'));
			location.reload();
		});

		BE.bus.emit('core:ready', {});
	}

	const STORE_SCHEMA_VERSION = 1;
	BE.store.whenReady(() => {
		const storedVersion = BE.store.get('__schemaVersion', 0);
		if (storedVersion < STORE_SCHEMA_VERSION) {
			BE.store.set('__schemaVersion', STORE_SCHEMA_VERSION);
		}
		BE.settings._load();
		BE.dom.ready(init);
	});
})();
