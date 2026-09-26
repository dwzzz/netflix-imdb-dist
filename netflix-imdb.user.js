// ==UserScript==
// @name         映尺 · Netflix IMDb 评分
// @namespace    https://github.com/dwzzz/netflix-imdb-dist
// @version      1.0.1
// @description  在 Netflix 页面显示 IMDb / 豆瓣评分，自动匹配作品，必要时可手动纠正。
// @antifeature  membership 需要邀请码注册并生成 API key 才能使用；服务完全免费，邀请机制仅用于防止接口被爬虫或滥用。
// @license      MIT
// @supportURL   https://github.com/dwzzz/netflix-imdb-dist/issues
// @compatible   chrome
// @compatible   firefox
// @compatible   edge
// @match        https://www.netflix.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_removeValueChangeListener
// @grant        GM_addValueChangeListener
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      ratings.op13.uk
// @noframes
// ==/UserScript==

/*
 * Netflix userscript for displaying IMDb / Douban ratings through ratings.op13.uk.
 * The browser talks only to the configured ratings service; matching and upstream data collection happen on the backend.
 * Ratings and confirmed title mappings are cached locally, with manual corrections taking precedence over automatic matches.
 * No analytics, remote executable code, or embedded credentials.
 */
(() => {
  'use strict';
  function netflixId(href) {
    try {
      if (typeof href !== 'string' || href.length > 4096) return null;
      const url = new URL(href, 'https://www.netflix.com');
      if (url.origin !== 'https://www.netflix.com') return null;
      const path = url.pathname.replace(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/)/i,'');
      if (/^\/games?(?:\/|$)/.test(path)) return null;
      const watch = /^\/watch\/\d+\/?$/.test(path);
      if (/^\/watch(?:\/|$)/.test(path) && !watch) return null;
      const ids = url.searchParams.getAll('jbv');
      const title = path.match(/^\/title\/(\d+)\/?$/)?.[1];
      if (title) ids.push(title);
      // The watch path can identify an episode. Only its explicit Video context identifies the poster.
      for (const context of watch ? url.searchParams.getAll('tctx') : []) {
        for (const field of context.split(',')) {
          if (field.startsWith('Video:')) ids.push(field.slice(6));
        }
      }
      if (!ids.length || ids.some(id => !/^\d{6,10}$/.test(id))) return null;
      if (/^\/watch\//.test(path) && !url.searchParams.getAll('tctx').some(value => value.split(',').some(field => /^Video:\d{6,10}$/.test(field)))) return null;
      return new Set(ids).size === 1 ? ids[0] : null;
    } catch { return null; }
  }
  // Only the main player supplies identity. Never interpret an episode watch ID as a title ID.
  function readDetail(root) {
    if (!root.isConnected || /\/watch\//.test(location.pathname)) return null;
    const player = root.querySelector('.previewModal--player_container');
    const mini = root.classList.contains('mini-modal');
    const play = player?.querySelector('a[data-uia="play-button"]') || (mini
      ? root.querySelector('.previewModal--info .previewModal--metadatAndControls-container .buttonControls--container a[data-uia="play-button"]') : null);
    const title = (player?.querySelector('.storyArt img[alt]')
      || player?.querySelector('img.previewModal--boxart[alt]'))?.alt?.trim();
    const host = root.querySelector('.previewModal--detailsMetadata-info')
      || root.querySelector('.previewModal--info > .videoMetadata--container');
    if (!player || !play || !title || title.length > 200 || (!mini && !host)) return null;
    let url;
    try { url = new URL(play.getAttribute('href'), 'https://www.netflix.com'); } catch { return null; }
    if (url.hostname !== 'www.netflix.com') return null;
    const ids = [...(url.searchParams.get('tctx') || '').matchAll(/(?:^|,)Video:(\d+)(?=,|$)/g)].map(match => match[1]);
    if (!ids.length || new Set(ids).size !== 1) return null;
    const id = ids[0], addressId = new URL(location.href).searchParams.get('jbv');
    if ((addressId && addressId !== id) || (url.searchParams.has('jbv') && url.searchParams.get('jbv') !== id)) return null;
    const wrapperId = mini ? netflixId(root.querySelector('.previewModal--info > a[href]')?.getAttribute('href')) : null;
    if (wrapperId && wrapperId !== id) return null;
    return {id,title,mount:mini ? player : host,mini};
  }
  // Only a completed identity and a usable official snapshot can become a local cache entry.
  function parseServiceResponse(data, requestedId, netflix = false) {
    const fail = message => { throw Object.assign(new Error(message),{safeServiceError:true}); };
    if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('评分服务响应不完整');
    // Scope is authoritative only as a complete structural tuple, never a title-search candidate.
    const own = data.identity?.data;
    const scoped = own && (Object.hasOwn(own,'mapping_scope') || Object.hasOwn(own,'rating_scope'));
    if (scoped) {
      const evidence = own.evidence;
      const qid = value => typeof value === 'string' && /^Q[1-9]\d{0,15}$/.test(value);
      if (!netflix || data.status !== 'ok' || data.netflix_id !== requestedId
        || own.mapping_scope !== 'parent_series' || own.rating_scope !== 'series'
        || data.kind !== 'series' || own.kind !== 'series' || own.imdb_id !== data.imdb_id
        || data.identity.status !== 'ok' || Object.hasOwn(data,'match')
        || !qid(own.wikidata_id) || own.source !== `https://www.wikidata.org/wiki/${own.wikidata_id}`
        || own.tmdb_id !== null || own.douban_id !== null || own.douban_link_checked !== true
        || (own.douban_link_id !== null && (!Number.isSafeInteger(own.douban_link_id) || own.douban_link_id <= 0))
        || (own.douban_link_id === null ? own.douban_link_scope !== null : own.douban_link_scope !== 'season')
        || !evidence || typeof evidence !== 'object' || Array.isArray(evidence)
        || evidence.own_imdb_present !== false || evidence.parent_property !== 'P179'
        || !qid(evidence.parent_wikidata_id) || evidence.parent_wikidata_id === own.wikidata_id
        || evidence.parent_imdb_id !== data.imdb_id
        || !Array.isArray(evidence.item_kinds) || !evidence.item_kinds.includes('season')
        || evidence.item_kinds.length > 2 || new Set(evidence.item_kinds).size !== evidence.item_kinds.length
        || !evidence.item_kinds.every(kind => kind === 'season' || kind === 'series')) {
        return fail('评分服务父剧集范围或结构证据不一致');
      }
    }
    if (netflix && data.netflix_id !== undefined && data.netflix_id !== requestedId) return fail('评分服务 Netflix 编号不一致');
    if (['pending','busy','temporary_failure','rate_limited','unavailable'].includes(data.status)) {
      throw Object.assign(new Error(data.status === 'pending' ? '评分服务仍在查询，请稍后重试' : '评分服务暂时不可用'),
        {safeServiceError:true,retryable:true,pending:data.status === 'pending'});
    }
    if (netflix && data.netflix_id !== requestedId) return fail('评分服务 Netflix 编号不一致');
    if (data.status === 'missing' && netflix) return {status:'missing'};
    if (data.status === 'ambiguous') {
      throw Object.assign(new Error('仅凭 Netflix 编号不足以确认作品，展开详情可继续自动匹配'),
        {safeServiceError:true,needsSelection:true});
    }
    if (data.status !== 'ok' || !/^tt\d{7,10}$/.test(data.imdb_id || '')
      || (!netflix && data.imdb_id !== requestedId)) return fail('评分服务 IMDb 编号不一致');
    if (!['movie','series','unknown'].includes(data.kind)) return fail('当前仅支持电影和整剧，不支持单季或单集评分');
    const identity = data.identity;
    if (identity?.status !== 'ok' || (netflix && (identity.data?.imdb_id !== data.imdb_id
      || identity.data?.kind !== data.kind))) return fail('评分服务身份数据不一致');
    const rating = data.rating;
    if (rating?.status !== 'ok' && rating?.status !== 'missing') {
      throw Object.assign(new Error('官方评分索引暂时不可用'),{safeServiceError:true,retryable:true});
    }
    if (rating.status === 'ok' && (typeof rating.score !== 'number' || !Number.isFinite(rating.score)
      || rating.score <= 0 || rating.score > 10 || !Number.isSafeInteger(rating.votes) || rating.votes < 0)) return fail('评分服务分数格式异常');
    const extra = data.tmdb?.status === 'ok' ? data.tmdb.data : null;
    const compatible = extra?.imdb_id === data.imdb_id && ['movie','series'].includes(extra.kind)
      && (data.kind === 'unknown' || data.kind === extra.kind);
    const title = compatible && typeof extra.title === 'string' && extra.title.trim().length <= 200 ? extra.title.trim() : '';
    const wikidataEntity = /^Q[1-9]\d{0,15}$/.test(own?.wikidata_id || '')
      && own.source === `https://www.wikidata.org/wiki/${own.wikidata_id}`;
    const linkChecked = netflix && !Object.hasOwn(data,'match') && ['movie','series'].includes(data.kind)
      && wikidataEntity && own?.douban_link_checked === true;
    if (linkChecked && data.kind === 'series' && !scoped) {
      const present = own.douban_link_id !== null;
      if ((present && (!Number.isSafeInteger(own.douban_link_id) || own.douban_link_id <= 0 || own.douban_link_scope !== 'representative'))
        || (!present && own.douban_link_scope !== null)) return fail('评分服务电视剧豆瓣链接结构异常');
    }
    let doubanId = null, doubanLinkScope, doubanRatingMeta = {};
    if (linkChecked && data.kind === 'movie' && Number.isSafeInteger(own.douban_id) && own.douban_id > 0) {
      doubanId = own.douban_id;
    } else if (linkChecked && data.kind === 'series' && Number.isSafeInteger(own.douban_link_id) && own.douban_link_id > 0
      && ['representative','season'].includes(own.douban_link_scope)) {
      doubanId = own.douban_link_id; doubanLinkScope = own.douban_link_scope;
    }
    if (linkChecked && data.kind === 'movie' && doubanId && data.douban?.status === 'ok') {
      const value = data.douban.data, source = `https://movie.douban.com/subject/${doubanId}/`;
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.id !== doubanId
        || value.kind !== 'movie' || value.source !== source
        || (value.score !== null && (typeof value.score !== 'number' || !Number.isFinite(value.score)
          || value.score <= 0 || value.score > 10))) return fail('评分服务豆瓣评分结构异常');
      if (typeof value.score === 'number') {
        const historical = value.historical === true, updated = value.source_updated_at;
        if (historical && (typeof updated !== 'string'
          || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(updated))) return fail('评分服务豆瓣历史评分时间异常');
        doubanRatingMeta = {doubanRatingChecked:true,doubanRating:value.score.toFixed(1),
          ...(data.douban.stale === true ? {doubanStale:true} : {}),
          ...(historical ? {doubanHistorical:true,doubanUpdatedAt:updated} : {})};
      } else doubanRatingMeta = {doubanRatingChecked:true};
    }
    return {status:'ok', data:{id:data.imdb_id,title:title || data.imdb_id,year:'',type:compatible ? extra.kind : data.kind,
      ...(scoped ? {mappingScope:'parent_series',ratingScope:'series'} : {}),
      ...(linkChecked ? {doubanLinkChecked:true} : {}),
      ...(doubanId ? {doubanId,...(doubanLinkScope ? {doubanLinkScope} : {})} : {}),
      ...doubanRatingMeta,
      rating:rating.status === 'ok' ? rating.score.toFixed(1) : null,
      votes:rating.status === 'ok' ? String(rating.votes) : 'N/A',provider:'ratings',
      stale:identity.stale === true || rating.stale === true || (compatible && data.tmdb.stale === true),updatedAt:rating.updated_at,
      identityRefreshStatus:typeof identity.refresh_status === 'string' ? identity.refresh_status.slice(0,40) : ''}};
  }
  // Read bounded title hints only from the current full-detail metadata mount; previews retain ID-only queries.
  function readHints(root, info) {
    if (!root?.isConnected || !info || info.mini || !info.mount || !root.contains(info.mount)) return null;
    if (typeof info.title !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(info.title)) return null;
    const title = info.title.trim();
    if (!title || new TextEncoder().encode(title).byteLength > 240) return null;
    const mount = root.querySelector('.previewModal--detailsMetadata-info .videoMetadata--container') || info.mount;
    const yearText = mount.querySelector('.year')?.textContent?.trim() || '';
    const duration = mount.querySelector('.duration')?.textContent?.trim() || '';
    const seasons = mount.querySelector('.numberOfSeasons')?.textContent?.trim() || '';
    // Count labels identify the whole series; ordinal season/episode labels are not scope evidence.
    const seriesLabel = /^(?:共\s*)?\d+\s*(?:集|季|episodes?|seasons?)$|^(?:限定[剧劇]集?|limited series)$/i;
    const series = [duration,seasons].some(value => value.length <= 100 && seriesLabel.test(value));
    const movie = duration.length <= 100 && /^(?:\d+\s*(?:小时|小時|hours?|hrs?|h|分钟|分鐘|minutes?|mins?|m)\s*)+$/i.test(duration);
    if (series === movie) return null;
    const rawLanguage = document.documentElement.lang?.trim() || '';
    const language = rawLanguage.length <= 35 && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(rawLanguage)
      ? rawLanguage : 'zh-CN';
    const hints = {title,kind:series ? 'series' : 'movie',language};
    if (/^\d{4}$/.test(yearText) && Number(yearText) >= 1870 && Number(yearText) <= 2100) hints.year = Number(yearText);
    return hints;
  }
  // Validate detail POST responses without promoting hint-based matches into ID-only mappings.
  function parseDetailResponse(raw, id) {
    const fail = message => { throw Object.assign(new Error(message), {safeServiceError:true}); };
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    if (!/^\d{6,10}$/.test(id) || typeof id !== 'string' || !object(raw) || raw.netflix_id !== id) {
      return fail('详情服务 Netflix 编号或响应格式不一致');
    }
    if (raw.status !== 'ok' && raw.identity?.data
      && (Object.hasOwn(raw.identity.data,'mapping_scope') || Object.hasOwn(raw.identity.data,'rating_scope'))) {
      return fail('详情服务父剧集范围与状态不一致');
    }
    const now = Date.now();
    const seconds = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const retrySeconds = seconds(raw.retry_after_seconds);
    const identityRetry = seconds(raw.identity?.retry_at);
    const retryAfter = Math.max(
      retrySeconds === null ? 0 : retrySeconds * 1000,
      identityRetry === null ? 0 : identityRetry * 1000 - now,
      0
    );
    const reason = typeof raw.reason === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(raw.reason) ? raw.reason : '';
    if (['busy','temporary_failure','rate_limited','unavailable'].includes(raw.status)) {
      throw Object.assign(new Error('详情匹配暂时不可用，请稍后重试'),
        {safeServiceError:true,retryable:true,retryAfter});
    }
    if (raw.status === 'pending') return {status:'pending'};
    const text = (value, required = false) => {
      if (value === undefined || value === null) return required ? fail('详情候选缺少标题') : '';
      if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)) {
        return fail('详情候选标题格式异常');
      }
      const clean = value.trim();
      if (new TextEncoder().encode(clean).byteLength > 240 || (required && !clean)) return fail('详情候选标题长度异常');
      return clean;
    };
    const year = value => value === undefined || value === null ? null
      : Number.isInteger(value) && value >= 1870 && value <= 2100 ? value : fail('详情候选年份异常');
    if (raw.status === 'ok') {
      let parsed;
      try { parsed = parseServiceResponse(raw, id, true); }
      catch (error) {
        if (error.retryable) error.retryAfter = retryAfter;
        throw error;
      }
      if (!raw.match) return parsed;
      const match = raw.match;
      if (!object(match) || match.source !== 'tmdb_title_search'
        || !['automatic','user_selected'].includes(match.method)
        || !['movie','series'].includes(match.scope) || match.scope !== raw.kind
        || match.persisted_global_mapping !== false) return fail('详情匹配来源或作品层级异常');
      const title = text(raw.identity.data.title, true);
      const candidate = raw.identity.data;
      let link = {};
      if (raw.kind === 'series' && candidate.douban_link_id !== undefined) {
        if (!Number.isSafeInteger(candidate.douban_link_id) || candidate.douban_link_id <= 0
          || candidate.douban_link_scope !== 'season' || !Number.isSafeInteger(candidate.douban_link_season)
          || candidate.douban_link_season < 1 || candidate.douban_link_season > 99) return fail('详情豆瓣季链接结构异常');
        link = {doubanId:candidate.douban_link_id,doubanLinkScope:'season',doubanSeason:candidate.douban_link_season};
        const scoreFields = ['douban_score','douban_votes','douban_historical','douban_source_updated_at'];
        const hasScore = scoreFields.some(field => Object.hasOwn(candidate,field));
        if (hasScore) {
          if (!scoreFields.every(field => Object.hasOwn(candidate,field))
            || typeof candidate.douban_score !== 'number' || !Number.isFinite(candidate.douban_score)
            || candidate.douban_score <= 0 || candidate.douban_score > 10
            || !Number.isSafeInteger(candidate.douban_votes) || candidate.douban_votes <= 0
            || candidate.douban_historical !== true
            || typeof candidate.douban_source_updated_at !== 'string'
            || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(candidate.douban_source_updated_at)) {
            return fail('详情豆瓣季评分结构异常');
          }
          link = {...link,doubanRatingChecked:true,doubanRating:candidate.douban_score.toFixed(1),
            doubanHistorical:true,doubanStale:true,doubanUpdatedAt:candidate.douban_source_updated_at};
        }
      }
      return {...parsed, data:{...parsed.data,title,year:year(raw.identity.data.year),...link},
        detail:{source:match.source,method:match.method,scope:match.scope}};
    }
    if (!['missing','ambiguous','insufficient_details','disabled','unsupported_scope','selection_expired'].includes(raw.status)) {
      return fail('详情服务返回未知状态');
    }
    if (raw.candidates !== undefined && (!Array.isArray(raw.candidates) || raw.candidates.length > 3)) {
      return fail('详情候选数量或格式异常');
    }
    const seen = new Set();
    const candidates = (raw.candidates || []).map(candidate => {
      if (!object(candidate)) return fail('详情候选格式异常');
      const identifier = typeof candidate.candidate_id === 'string'
        ? candidate.candidate_id.match(/^(movie|series):([1-9]\d{0,14})$/) : null;
      if (!identifier || !Number.isSafeInteger(Number(identifier[2]))
        || candidate.kind !== identifier[1] || !/^tt\d{7,10}$/.test(candidate.imdb_id || '')
        || (candidate.tmdb_id !== undefined && candidate.tmdb_id !== Number(identifier[2]))
        || seen.has(candidate.candidate_id)) return fail('详情候选身份不一致');
      seen.add(candidate.candidate_id);
      return {candidate_id:candidate.candidate_id,tmdb_id:Number(identifier[2]),imdb_id:candidate.imdb_id,
        kind:candidate.kind,title:text(candidate.title,true),original_title:text(candidate.original_title),year:year(candidate.year),
        source:`https://www.themoviedb.org/${candidate.kind === 'series' ? 'tv' : 'movie'}/${identifier[2]}`};
    });
    const retryAt = seconds(raw.retry_at);
    return {status:raw.status,reason,candidates,truncated:raw.truncated === true,
      unresolved_candidates:raw.unresolved_candidates === true,
      retryAt:retryAt === null ? now + 900000 : Math.max(now,Math.min(now + 900000,retryAt * 1000))};
  }
  function cacheFresh(entry, now = Date.now()) {
    const needsLinkCapability = entry?.data?.source === 'service' && ['movie','series'].includes(entry.data.type)
      && entry.data.doubanLinkChecked !== true;
    return !!entry?.data && Number.isFinite(entry.time) && entry.time <= now && !entry.data.stale && !needsLinkCapability
      && now-entry.time < (entry.data?.rating ? 86400000 : 3600000);
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {netflixId, parseServiceResponse, cacheFresh, readHints, parseDetailResponse}; return;
  }
  if (document.getElementById('nli-style')) return;
  const QUEUE_MAX = 828, CARDS_MAX = 800;
  let ratingsToken = GM_getValue('ratingsApiToken', '');
  if (typeof ratingsToken !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(ratingsToken)) ratingsToken = '';
  const TITLE_PREFIX = 'nli-title-v1:', TITLE_MEMORY_MAX = 1500;
  const titleRecords = new Map(), titleListeners = new Map();
  const cache = Object.create(null), mappings = Object.create(null);
  const cards = createCardTable(), detailRoots = new Map(), dirtyDetails = new Set();
  const pending = new Map(), settled = new Map(), revisions = new Map(), editing = new Set();
  const detailCache = Object.create(null);
  const detailFlights = new Map();
  const detailRatings = new Map();
  let detailExpiryTimer;
  const requestQueue = [];
  const queryWaits = new Map();
  let active = 0, activeRefreshes = 0, readyAt = 0, requests = 0;
  let detailTimer, pumpTimer, resumeTimer, hoverTimer, hoverCandidate, hoverItem, focusItem, scanTimer;
  let halted = '', lastError = '', diagnostic = '';
  let authGeneration = 0, connectionUi = null;
  let identityStorage = null;

  const IDENTITY_DAY = 86400000, AUTHORITY_RETRY_GUARD = 3600000;
  const authorityChecks = new Map();
  let authorityTimer;

  // Own both indexes in one table so replacement, removal and SPA cleanup cannot leave stale groups.
  function createCardTable(entries = []) {
    const byId = new Map(), table = new Map(), empty = Object.freeze([]);
    table.deferred = new Set();
    const unlink = item => {
      table.deferred.delete(item);
      const group = byId.get(item.id);
      if (group) { group.delete(item); if (!group.size) byId.delete(item.id); }
    };
    table.set = (card,item) => {
      const previous = table.get(card);
      if (previous) unlink(previous);
      let group = byId.get(item.id);
      if (!group) { group = new Set(); byId.set(item.id,group); }
      group.add(item); Map.prototype.set.call(table,card,item);
      if (item.deferred) table.deferred.add(item);
      return table;
    };
    table.delete = card => {
      const previous = table.get(card);
      if (!previous) return false;
      unlink(previous); return Map.prototype.delete.call(table,card);
    };
    table.clear = () => { byId.clear(); table.deferred.clear(); Map.prototype.clear.call(table); };
    table.defer = (item,value) => {
      item.deferred = value;
      if (value && table.get(item.card) === item) table.deferred.add(item);
      else table.deferred.delete(item);
    };
    table.forId = id => byId.get(id) || empty;
    table.titleIds = () => byId.keys();
    for (const [card,item] of entries) table.set(card,item);
    return table;
  }
  function normalizeScore(x) {
    return x && Number.isFinite(x.time) && x.time <= Date.now()
      && /^tt\d{7,10}$/.test(x.data?.id || '') && ['movie','series','unknown'].includes(x.data.type)
      && ((!Object.hasOwn(x.data,'mappingScope') && !Object.hasOwn(x.data,'ratingScope'))
        || (x.data.mappingScope === 'parent_series' && x.data.ratingScope === 'series' && x.data.type === 'series'
          && x.mapping === undefined && x.data.source !== 'manual'))
      && (x.data.doubanLinkChecked === undefined || x.data.doubanLinkChecked === true)
      && (x.data.doubanId === undefined || (Number.isSafeInteger(x.data.doubanId) && x.data.doubanId > 0))
      && (x.data.doubanLinkScope === undefined || ['representative','season'].includes(x.data.doubanLinkScope))
      && (x.data.doubanSeason === undefined || (Number.isSafeInteger(x.data.doubanSeason) && x.data.doubanSeason >= 1 && x.data.doubanSeason <= 99))
      && (x.data.doubanRatingChecked === undefined || (x.data.doubanRatingChecked === true
        && Number.isSafeInteger(x.data.doubanId) && x.data.doubanId > 0))
      && (x.data.doubanRating === undefined || (x.data.doubanRatingChecked === true
        && typeof x.data.doubanRating === 'string' && /^\d{1,2}\.\d$/.test(x.data.doubanRating)
        && Number(x.data.doubanRating) > 0 && Number(x.data.doubanRating) <= 10
        && (x.data.type === 'movie' || (x.data.type === 'series' && x.data.doubanLinkScope === 'season'
          && Number.isSafeInteger(x.data.doubanSeason) && x.data.doubanSeason >= 1 && x.data.doubanSeason <= 99))))
      && (x.data.doubanStale === undefined || (x.data.doubanStale === true && x.data.doubanRating !== undefined))
      && (x.data.doubanHistorical === undefined || (x.data.doubanHistorical === true && x.data.doubanRating !== undefined))
      && (x.data.doubanUpdatedAt === undefined || (x.data.doubanHistorical === true && typeof x.data.doubanUpdatedAt === 'string'
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(x.data.doubanUpdatedAt)))
      && (x.data.rating === null || (typeof x.data.rating === 'string' && /^\d{1,2}\.\d$/.test(x.data.rating)
        && Number(x.data.rating) > 0 && Number(x.data.rating) <= 10)) ? x : null;
  }
  function validDetailEntry(value) {
    return !!value && Number.isFinite(value.time) && Number.isFinite(value.until)
      && value.time <= Date.now() && value.until <= Date.now()+86400000
      && !!value.raw && typeof value.raw === 'object' && !Array.isArray(value.raw);
  }
  // Per-title storage stays lazy; normal browsing never scans history.
  function emptyTitleRecord() {
    return {schema:1,epoch:0,manual:null,automatic:null,score:null,detail:null};
  }
  function normalizeTitleRecord(raw, id) {
    if (raw === null) return emptyTitleRecord();
    const invalid = () => ({invalid:true,epoch:-1});
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schema !== 1
      || !Number.isSafeInteger(raw.epoch) || raw.epoch < 0) return invalid();
    const imdb = value => typeof value === 'string' && /^tt\d{7,10}$/.test(value);
    if (raw.manual !== null && !imdb(raw.manual)) return invalid();
    let automatic = null;
    if (raw.automatic !== null) {
      const a = raw.automatic;
      if (!a || typeof a !== 'object' || !imdb(a.imdbId) || !['movie','series'].includes(a.kind)
        || !Number.isSafeInteger(a.confirmedAt) || a.confirmedAt < 0 || a.confirmedAt > Date.now()
        || !Number.isSafeInteger(a.lastIdentityCheckAt) || a.lastIdentityCheckAt < 0 || a.lastIdentityCheckAt > Date.now()
        || raw.manual !== null) return invalid();
      automatic = {imdbId:a.imdbId,kind:a.kind,confirmedAt:a.confirmedAt,lastIdentityCheckAt:a.lastIdentityCheckAt};
    }
    let score = normalizeScore(raw.score);
    if (score) {
      const mapping = raw.manual || automatic?.imdbId;
      if (mapping ? score.mapping !== mapping || score.data.id !== mapping
        : score.mapping !== undefined || score.data.source !== 'service') score = null;
      if (score && (raw.manual ? score.data.source !== 'manual' : automatic && score.data.source !== 'automatic')) score = null;
    }
    let detail = null;
    const d = raw.detail;
    if (d && typeof d === 'object' && typeof d.key === 'string' && d.key.length <= 2048
      && d.key.startsWith(`["${id}",`) && d.entry?.raw?.netflix_id === id
      && d.entry.epoch === raw.epoch && validDetailEntry(d.entry)) {
      detail = {key:d.key,entry:d.entry};
    }
    return {schema:1,epoch:raw.epoch,manual:raw.manual,automatic,score,detail};
  }
  function rememberTitleRecord(id, record) {
    const old = titleRecords.get(id);
    if (old?.detail) delete detailCache[old.detail.key];
    if (record.score) cache[id] = record.score; else delete cache[id];
    if (record.manual) mappings[id] = record.manual; else delete mappings[id];
    if (record.detail) detailCache[record.detail.key] = record.detail.entry;
    titleRecords.delete(id); titleRecords.set(id,record);
    // Bound the decoded working set, retaining currently mounted titles. Persistent identities are durable.
    if (titleRecords.size > TITLE_MEMORY_MAX) {
      const mounted = new Set(cards.titleIds());
      for (const [other,value] of titleRecords) {
        if (other === id || mounted.has(other)) continue;
        titleRecords.delete(other); delete cache[other]; delete mappings[other]; detailRatings.delete(other);
        if (value.detail) delete detailCache[value.detail.key];
        const listener = titleListeners.get(other);
        if (listener !== undefined) GM_removeValueChangeListener(listener);
        titleListeners.delete(other);
        if (titleRecords.size <= TITLE_MEMORY_MAX) break;
      }
    }
    return record;
  }
  function readTitleRecord(id, fresh = false) {
    if (typeof id !== 'string' || !/^\d{6,10}$/.test(id)) throw new Error('Netflix 编号异常');
    if (identityStorage?.has(id)) return identityStorage.get(id);
    if (!titleListeners.has(id)) {
      const listener = GM_addValueChangeListener(TITLE_PREFIX+id,(_key,_old,_new,remote) => {
        if (remote) importIdentityStorage(id);
      });
      titleListeners.set(id,listener);
    }
    let record = !fresh && !identityStorage && titleRecords.get(id);
    if (!record) record = rememberTitleRecord(id,normalizeTitleRecord(GM_getValue(TITLE_PREFIX+id,null),id));
    identityStorage?.set(id,record);
    if (record.invalid) lastError = '作品持久状态异常，已停止该作品的自动写入';
    return record;
  }
  function writeTitleRecord(id, record) {
    const next = normalizeTitleRecord(record,id);
    if (next.invalid) throw new Error('作品持久状态异常，未保存');
    GM_setValue(TITLE_PREFIX+id,next);
    identityStorage?.set(id,next);
    return rememberTitleRecord(id,next);
  }
  async function withIdentityLock(action) {
    if (!globalThis.navigator?.locks?.request) {
      lastError = 'Web Locks 不可用，无法安全保存跨标签页作品匹配';
      throw new Error(lastError);
    }
    return navigator.locks.request('netflix-imdb:title-records-v1',() => {
      const previous = identityStorage; identityStorage = new Map();
      try { return action(); } finally { identityStorage = previous; }
    });
  }
  function importIdentityStorage(id) {
    const before = titleRecords.get(id), previous = before?.score;
    const signature = record => {
      const route = recordIdentity(record);
      return route ? JSON.stringify([route.source,route.imdbId,route.scope]) : '';
    };
    const record = readTitleRecord(id,true);
    if (signature(before) !== signature(record) || (before && before.epoch !== record.epoch) || (previous && !record.score)) {
      revisions.set(id,(revisions.get(id) || 0)+1); syncIdentity(id);
    } else if (JSON.stringify(previous) !== JSON.stringify(record.score)) {
      const entry = identityCache(id);
      if (entry) for (const item of cards.forId(id)) if (item.card.isConnected) paint(item,entry.data);
    }
    if (JSON.stringify(before?.detail) !== JSON.stringify(record.detail)) refreshDetailRatings();
  }
  function automaticEpoch(id) {
    return readTitleRecord(id).epoch;
  }
  function isAuthoritativeEntry(entry) {
    return !!entry && entry.mapping === undefined && Number.isFinite(entry.time) && entry.time <= Date.now()
      && /^tt\d{7,10}$/.test(entry.data?.id || '') && ['movie','series','unknown'].includes(entry.data.type)
      && ((!Object.hasOwn(entry.data,'mappingScope') && !Object.hasOwn(entry.data,'ratingScope'))
        || (entry.data.mappingScope === 'parent_series' && entry.data.ratingScope === 'series' && entry.data.type === 'series'));
  }
  function identityRoute(id) {
    return recordIdentity(readTitleRecord(id));
  }
  function recordIdentity(record) {
    if (!record || record.invalid) return null;
    if (record.manual) return {source:'manual',imdbId:record.manual,mapping:record.manual};
    if (isAuthoritativeEntry(record.score)) return {source:'service',imdbId:record.score.data.id,mapping:undefined,scope:record.score.data.mappingScope};
    const state = record.automatic;
    return state ? {source:'automatic',imdbId:state.imdbId,mapping:state.imdbId,state:{...state,epoch:record.epoch}} : null;
  }
  function persistedIdentityConflict(id, route) {
    importIdentityStorage(id);
    const current = identityRoute(id);
    return (current?.source || '') !== (route?.source || '') || current?.imdbId !== route?.imdbId || current?.scope !== route?.scope;
  }
  function identityCache(id, route = identityRoute(id)) {
    const entry = cache[id];
    return entry && route && entry.mapping === route.mapping && entry.data?.id === route.imdbId ? entry : null;
  }
  // Explicit maintenance only: browsing never enumerates historical keys or rewrites other titles.
  async function clearScoreCachePreservingMappings() {
    const keys = GM_listValues().filter(key=>key.startsWith(TITLE_PREFIX) && /^\d{6,10}$/.test(key.slice(TITLE_PREFIX.length)));
    for (const key of keys) await withIdentityLock(() => {
      const id = key.slice(TITLE_PREFIX.length), record = readTitleRecord(id,true);
      if (record.invalid || record.epoch >= Number.MAX_SAFE_INTEGER) throw new Error('作品版本异常，清理未完成');
      let score = null;
      if (isAuthoritativeEntry(record.score)) {
        const {rating:_rating,votes:_votes,updatedAt:_updatedAt,...data} = record.score.data;
        score = {time:0,data:{...data,rating:null,votes:'N/A'}};
      }
      writeTitleRecord(id,{...record,epoch:record.epoch+1,score,detail:null});
      revisions.set(id,(revisions.get(id) || 0)+1);
    });
    detailRatings.clear();
  }
  function syncIdentity(id) {
    const route = identityRoute(id), entry = identityCache(id,route);
    for (const item of cards.forId(id)) {
      item.detailKey = null; item.detailBase = null; item.detailRun = null; item.detailBusy = false;
      item.error = ''; item.loaded = !!entry; item.loading = false; item.retrying = false; item.retryable = false; item.needsSelection = false; cards.defer(item,false);
      if (item.matchButton) item.matchButton.hidden = true;
      paint(item,entry?.data || null);
    }
    refreshDetailRatings();
    if (!entry) refreshId(id);
  }
  async function saveAutomatic(id, result, epoch, time = Date.now()) {
    if (result.status !== 'ok' || result.detail?.method !== 'automatic' || !result.data) return false;
    return withIdentityLock(() => saveAutomaticLocked(id,result,epoch,time));
  }
  function saveAutomaticLocked(id, result, epoch, time) {
    importIdentityStorage(id);
    const record = readTitleRecord(id);
    if (epoch < 0 || record.epoch !== epoch || identityRoute(id)) return false;
    if (epoch >= Number.MAX_SAFE_INTEGER) throw new Error('作品版本已达上限');
    const data = {...result.data,source:'automatic'};
    writeTitleRecord(id,{...record,epoch:epoch+1,automatic:{imdbId:data.id,kind:data.type,confirmedAt:time,lastIdentityCheckAt:time},
      score:{time,mapping:data.id,data},detail:null});
    revisions.set(id,(revisions.get(id) || 0)+1);
    return true;
  }
  async function commitAuthoritative(id, data, expected = null) {
    return withIdentityLock(() => {
      importIdentityStorage(id);
      const record = readTitleRecord(id);
      if (record.invalid || record.manual || (expected && (record.epoch !== expected.epoch || (revisions.get(id) || 0) !== expected.revision))) return false;
      if (record.epoch >= Number.MAX_SAFE_INTEGER) throw new Error('作品版本已达上限');
      const previous = record.score, retain = !data.rating && previous?.data?.id === data.id && previous.data.rating;
      const retainDouban = previous?.data?.id === data.id && data.doubanRatingChecked !== true
        && Number.isSafeInteger(data.doubanId) && data.doubanId === previous.data.doubanId
        && previous.data.doubanRatingChecked === true;
      const score = {time:retain ? previous.time : Date.now(),data:{...data,source:'service',
        ...(retain ? {rating:previous.data.rating,votes:previous.data.votes} : {}),
        ...(retainDouban ? {doubanRatingChecked:true,
          ...(typeof previous.data.doubanRating === 'string' ? {doubanRating:previous.data.doubanRating} : {}),
          ...(previous.data.doubanStale === true ? {doubanStale:true} : {}),
          ...(previous.data.doubanHistorical === true ? {doubanHistorical:true} : {}),
          ...(typeof previous.data.doubanUpdatedAt === 'string' ? {doubanUpdatedAt:previous.data.doubanUpdatedAt} : {})} : {})}};
      writeTitleRecord(id,{...record,epoch:record.epoch+1,manual:null,automatic:null,score,detail:null});
      revisions.set(id,(revisions.get(id) || 0)+1);
      syncIdentity(id);
      return true;
    });
  }
  async function updateIdentityCheck(id, state) {
    return withIdentityLock(() => {
      importIdentityStorage(id);
      const record = readTitleRecord(id);
      if (identityRoute(id)?.source !== 'automatic' || record.epoch !== state.epoch || record.automatic?.imdbId !== state.imdbId) return false;
      writeTitleRecord(id,{...record,automatic:{...record.automatic,lastIdentityCheckAt:Date.now()}});
      return true;
    });
  }
  async function saveScore(id, route, epoch, data) {
    return withIdentityLock(() => {
      if (persistedIdentityConflict(id,route) || automaticEpoch(id) !== epoch || epoch < 0) throw Object.assign(new Error('作品匹配已更新'),{cancelled:true});
      const record = readTitleRecord(id), previous = identityCache(id,route);
      if (data && !data.rating && previous?.data.rating) throw new Error('评分服务暂未返回评分，更新未完成');
      const retainedDouban = previous?.data?.doubanRatingChecked === true ? {
        doubanRatingChecked:true,
        ...(typeof previous.data.doubanRating === 'string' ? {doubanRating:previous.data.doubanRating} : {}),
        ...(previous.data.doubanStale === true ? {doubanStale:true} : {}),
        ...(previous.data.doubanHistorical === true ? {doubanHistorical:true} : {}),
        ...(typeof previous.data.doubanUpdatedAt === 'string' ? {doubanUpdatedAt:previous.data.doubanUpdatedAt} : {})
      } : {};
      if (data && previous?.data?.id === data.id && data.doubanId === undefined
        && Number.isSafeInteger(previous.data.doubanId) && previous.data.doubanId > 0
        && previous.data.doubanLinkScope === 'season'
        && Number.isSafeInteger(previous.data.doubanSeason) && previous.data.doubanSeason >= 1 && previous.data.doubanSeason <= 99) {
        data = {...data,doubanId:previous.data.doubanId,doubanLinkScope:'season',doubanSeason:previous.data.doubanSeason,...retainedDouban};
      }
      if (data && previous?.data?.id === data.id && data.doubanRatingChecked !== true
        && Number.isSafeInteger(data.doubanId) && data.doubanId === previous.data.doubanId
        && previous.data.doubanRatingChecked === true) data = {...data,...retainedDouban};
      if (data || record.score) writeTitleRecord(id,{...record,score:data ? {time:Date.now(),mapping:route?.mapping,data} : null});
    });
  }
  function wakeAuthorityChecks() {
    clearTimeout(authorityTimer);
    authorityTimer = setTimeout(scheduleAuthorityChecks,0);
  }
  function scheduleAuthorityChecks() {
    clearTimeout(authorityTimer);
    for (const [id,check] of authorityChecks) if (check.until <= Date.now()) authorityChecks.delete(id);
    if (!document.hidden && ratingsToken && !halted) {
      const priorities = prioritySnapshot();
      for (const [id,priority] of priorities) {
        if (!priority || authorityChecks.has(id) || authorityChecks.size >= CARDS_MAX) continue;
        const route = identityRoute(id);
        if (route?.source !== 'automatic' || Date.now()-route.state.lastIdentityCheckAt < IDENTITY_DAY) continue;
        const revision = revisions.get(id) || 0, epoch = route.state.epoch;
        const valid = () => (revisions.get(id) || 0) === revision && automaticEpoch(id) === epoch
          && identityRoute(id)?.source === 'automatic';
        const job = (async () => {
          try {
            const result = await api({netflix:id},{id,revision,background:true,refresh:true,authorityCheck:true,maxAttempts:1,valid});
            if (!valid()) return;
            if (result.status === 'ok' && result.data) { await commitAuthoritative(id,result.data,{epoch,revision}); return; }
            if (result.status !== 'missing') return;
          } catch (error) {
            if (!valid() || (!error.needsSelection && !error.pending)) { if (!error.cancelled) lastError = error.message; return; }
          }
          if (valid()) await updateIdentityCheck(id,route.state);
        })().catch(error => { lastError = '作品身份复查未完成：'+error.message; }).finally(() => { const check = authorityChecks.get(id); if (check) check.until = Date.now()+AUTHORITY_RETRY_GUARD; });
        authorityChecks.set(id,{job,until:Infinity});
      }
    }
    // Transient failures remain due, but unrelated DOM events cannot cause a retry storm.
    authorityTimer = setTimeout(scheduleAuthorityChecks,60000);
  }

  const style = document.createElement('style');
  style.id = 'nli-style';
  style.textContent = `
    :where(.nli-static) { position:relative; }
    .nli-badge { position:absolute !important; left:auto; right:6px; top:6px; z-index:20;
      background:#f5c518 !important; color:#151515 !important; border-radius:5px;
      padding:4px 7px; font:600 12px/1.4 system-ui !important; cursor:pointer;
      box-shadow:0 1px 6px #0009; max-width:90%; white-space:nowrap; }
    .nli-badge[data-state="muted"] { background:#252525 !important; color:#eee !important; }
    .nli-host > .nli-badge:not([data-action="select"]) { pointer-events:none !important; cursor:default !important; user-select:none; }
    .nli-host > .nli-badge[data-action="select"] { pointer-events:auto !important; cursor:pointer !important; }
    .nli-badge[hidden], .nli-detail[hidden] { display:none !important; }
    .nli-detail { display:flex; align-items:center; gap:10px; margin:10px 0; font:14px/1.4 system-ui; }
    .nli-detail .nli-badge { position:static !important; max-width:none; text-decoration:none; }
    .nli-detail .nli-douban-link { padding:4px 7px; color:white; background:#007722; border:1px solid #007722;
      border-radius:5px; cursor:pointer; font:600 12px/1.4 system-ui; text-decoration:none; box-shadow:0 1px 6px #0009; }
    .nli-detail .nli-douban-link:hover { background:#005f1b; border-color:#005f1b; }
    .nli-detail button { background:transparent; border:0; padding:3px; color:#b3b3b3; cursor:pointer; font:inherit; }
    .nli-detail button:hover { color:white; }
    .nli-detail :focus-visible { outline:2px solid white; outline-offset:3px; }
    .nli-detail.nli-mini { position:absolute; right:8px; top:8px; margin:0; z-index:30; }
    .nli-mini > button { display:none; }
    .nli-mini > .nli-douban-link { display:none; }
  `;
  document.head.append(style);
  // One closed shadow tree isolates styles and avoids exposing credentials through page markup.
  // This is not a security boundary against a malicious host page or another installed extension.
  function initConnectionUi() {
    const host = document.createElement('div'); host.id = 'nli-connection'; host.hidden = true;
    ownBadges.add(host);
    const root = host.attachShadow({mode:'closed'});
    root.innerHTML = `<style>
      :host { all:initial; position:fixed !important; right:24px !important; bottom:24px !important;
        width:min(320px,calc(100vw - 32px)) !important; z-index:10000 !important; pointer-events:none !important;
        color-scheme:dark; font:13px/1.5 "Netflix Sans","Helvetica Neue",Arial,sans-serif; color:#eee; }
      :host([hidden]), [hidden] { display:none !important; }
      * { box-sizing:border-box; }
      .panel { pointer-events:auto; background:#202020; border:1px solid #ffffff1c; border-radius:8px;
        padding:18px; box-shadow:0 8px 28px #0005; }
      h2 { margin:0; color:#f2f2f2; font:600 15px/1.4 "Netflix Sans","Helvetica Neue",Arial,sans-serif; }
      p { margin:8px 0 0; color:#b3b3b3; font-size:13px; line-height:1.65; }
      button, input { font:inherit; }
      button { border:0; border-radius:4px; padding:8px 13px; cursor:pointer; min-height:34px;
        background:transparent; color:#b3b3b3; line-height:1.4; }
      button:hover { background:#ffffff12; color:#fff; }
      button:focus-visible, input:focus-visible { outline:2px solid #eee; outline-offset:3px; }
      .primary { background:#e9e9e9; color:#181818; font-weight:600; }
      .primary:hover { background:#fff; color:#111; }
      button:disabled { opacity:.55; cursor:default; }
      .actions { display:flex; align-items:center; gap:8px; margin-top:14px; }
      .chip { display:block; margin-left:auto; pointer-events:auto; background:#202020eb; color:#b3b3b3;
        border:1px solid #ffffff1c; border-radius:5px; padding:6px 10px; font-size:12px; }
      label { display:block; color:#b3b3b3; font-size:12px; margin:14px 0 6px; }
      input { width:100%; min-width:0; background:#141414; border:1px solid #666; border-radius:4px;
        color:#fff; padding:10px 11px; font-size:14px; }
      input[aria-invalid="true"] { border-color:#cfaa71; }
      .note { color:#999; font-size:11px; line-height:1.6; margin-top:12px; }
      .message { color:#dcc39e; font-size:12px; }
      .announcement { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
      .disconnect { padding:0; min-height:28px; font-size:11px; margin-top:6px; color:#999; }
      .disconnect:hover { background:none; text-decoration:underline; }
      @media(max-width:600px) { :host { right:16px !important; bottom:16px !important; } }
    </style>
    <button class="chip" type="button" aria-label="连接 IMDb 评分服务" hidden>IMDb · 连接</button>
    <section class="panel" aria-labelledby="connection-title">
      <h2 id="connection-title">IMDb 评分</h2><p class="description"></p>
      <div class="actions welcome-actions"><button class="primary connect" type="button">连接</button><button class="later" type="button">稍后</button></div>
      <form hidden>
        <label for="connection-token">访问 Token</label>
        <input id="connection-token" type="password" autocomplete="off" spellcheck="false" maxlength="256" placeholder="粘贴访问 Token" aria-describedby="connection-note connection-message">
        <p id="connection-message" class="message" role="status" aria-live="polite" hidden></p>
        <div class="actions"><button class="primary save" type="submit">保存并连接</button><button class="cancel" type="button">取消</button></div>
        <p id="connection-note" class="note">仅用于 ratings.op13.uk，保存在脚本存储。<br>没有 Token？请联系邀请人。</p>
        <button class="disconnect" type="button" hidden>断开连接</button>
      </form>
      <span class="announcement" role="status" aria-live="polite"></span>
    </section>`;
    const get = selector => root.querySelector(selector);
    connectionUi = {host,root,panel:get('.panel'),chip:get('.chip'),title:get('h2'),description:get('.description'),
      actions:get('.welcome-actions'),form:get('form'),input:get('input'),message:get('.message'),save:get('.save'),
      disconnect:get('.disconnect'),announcement:get('.announcement'),open:false,busy:false,success:false,serial:0,
      dismissed:GM_getValue('ratingsSetupDismissed',false) === true,returnFocus:null};
    get('.connect').addEventListener('click',configure); get('.chip').addEventListener('click',configure);
    get('.later').addEventListener('click',closeConnection); get('.cancel').addEventListener('click',closeConnection);
    get('form').addEventListener('submit',event => { event.preventDefault(); submitConnection(); });
    get('.disconnect').addEventListener('click',() => {
      try { GM_setValue('ratingsApiToken',''); }
      catch { connectionUi.message.textContent = '未能保存设置，请重试。'; updateConnectionUi(); return; }
      closeConnection(); activateToken('');
    });
    root.addEventListener('keydown',event => {
      if (event.key === 'Escape') { event.preventDefault(); closeConnection(); }
    });
    // Let controls handle their events, then keep Netflix shortcuts and card clicks out of the widget.
    for (const type of ['keydown','keyup','keypress','click','dblclick','pointerdown','pointerup','input','change','paste']) {
      root.addEventListener(type,event => event.stopPropagation());
    }
    document.body.append(host);
    document.addEventListener('fullscreenchange',updateConnectionUi);
    window.addEventListener('popstate',updateConnectionUi);
  }
  function installConnectionListeners() {
    GM_addValueChangeListener('ratingsApiToken',(_key,_old,value,remote) => {
      if (!remote) return;
      if (connectionUi) {
        connectionUi.serial++; connectionUi.open = false; connectionUi.busy = false; connectionUi.success = false;
        connectionUi.input.value = ''; connectionUi.message.textContent = '';
      }
      activateToken(typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : '');
    });
    GM_addValueChangeListener('ratingsSetupDismissed',(_key,_old,value,remote) => {
      if (remote && connectionUi) { connectionUi.dismissed = value === true; updateConnectionUi(); }
    });
  }
  function updateConnectionUi() {
    if (!connectionUi && (!ratingsToken || halted)) initConnectionUi();
    const ui = connectionUi;
    if (!ui) return;
    if (!ui.host.isConnected) document.body.append(ui.host);
    const playing = /(?:^|\/)watch(?:\/|$)/.test(location.pathname) || !!document.fullscreenElement;
    const needed = !ratingsToken || !!halted;
    const renderKey = JSON.stringify([playing,document.hidden,!!cards.size,needed,halted,ui.open,ui.dismissed,ui.success,ui.busy,!!ratingsToken,ui.message.textContent]);
    if (ui.renderKey === renderKey) return;
    ui.renderKey = renderKey;
    ui.host.hidden = playing || document.hidden || (!cards.size && !ui.open) || !(needed || ui.open || ui.success);
    // Navigating into playback cancels an unfinished form rather than retaining a hidden credential.
    if (playing && ui.open) { ui.serial++; ui.open = false; ui.busy = false; ui.input.value = ''; }
    const collapsed = ui.dismissed && !ui.open && !ui.success;
    ui.panel.hidden = collapsed; ui.chip.hidden = !collapsed;
    ui.form.hidden = !ui.open; ui.actions.hidden = ui.open || ui.success;
    ui.title.textContent = ui.open ? '连接 IMDb 评分' : ui.success ? '已连接' : halted ? '评分服务已暂停' : 'IMDb 评分';
    ui.description.textContent = ui.open ? '粘贴访问 Token，评分会在当前页面自动出现。'
      : ui.success ? '正在加载 IMDb 评分。' : halted ? 'Token 无效或权限不足，重新连接即可继续。'
      : '还差一步：连接评分服务，即可在海报上查看评分。';
    ui.save.disabled = ui.busy; ui.input.readOnly = ui.busy; ui.disconnect.disabled = ui.busy;
    ui.save.textContent = ui.busy ? '验证中…' : '保存并连接';
    ui.message.hidden = !ui.open || !ui.message.textContent;
    ui.disconnect.hidden = !ratingsToken;
    ui.announcement.textContent = ui.success ? '评分服务已连接。' : '';
  }
  function configure() {
    if (!connectionUi) initConnectionUi();
    const ui = connectionUi;
    if (!ui) return;
    ui.returnFocus = ui.root.activeElement || document.activeElement;
    ui.serial++; ui.open = true; ui.success = false; ui.busy = false;
    ui.input.value = ''; ui.input.removeAttribute('aria-invalid'); ui.message.textContent = '';
    updateConnectionUi();
    if (!ui.host.hidden) ui.input.focus({preventScroll:true});
  }
  function closeConnection() {
    const ui = connectionUi;
    if (!ui) return;
    ui.serial++; ui.open = false; ui.busy = false; ui.success = false; ui.dismissed = true;
    ui.input.value = ''; ui.message.textContent = '';
    try { GM_setValue('ratingsSetupDismissed',true); } catch { /* The current-page dismissal still works. */ }
    updateConnectionUi(); pumpRequests();
    if (!ui.host.hidden && (!ratingsToken || halted)) ui.chip.focus({preventScroll:true});
    else if (ui.returnFocus?.isConnected) ui.returnFocus.focus({preventScroll:true});
  }
  async function submitConnection() {
    const ui = connectionUi;
    if (!ui || !ui.open || ui.busy) return;
    const token = ui.input.value.trim();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
      ui.message.textContent = token ? 'Token 格式不正确，请确认复制完整。' : '请粘贴访问 Token。';
      ui.input.setAttribute('aria-invalid','true'); updateConnectionUi(); ui.input.focus(); return;
    }
    const serial = ++ui.serial;
    ui.busy = true; ui.message.textContent = ''; ui.input.removeAttribute('aria-invalid'); updateConnectionUi();
    try {
      await api({health:true},{validationToken:token,valid:()=>ui.open && ui.serial === serial});
      if (!ui.open || ui.serial !== serial) return;
      try { GM_setValue('ratingsApiToken',token); }
      catch { throw Object.assign(new Error('Credential storage unavailable'),{storageFailure:true}); }
      ui.input.value = ''; ui.open = false; ui.busy = false;
      activateToken(token); ui.success = true; updateConnectionUi();
      const generation = authGeneration;
      setTimeout(() => { if (authGeneration === generation) { ui.success = false; updateConnectionUi(); } },2200);
      if (ui.returnFocus?.isConnected) ui.returnFocus.focus({preventScroll:true});
    } catch (error) {
      if (!ui.open || ui.serial !== serial) return;
      ui.busy = false;
      ui.message.textContent = error.storageFailure ? '未能保存到脚本存储，请重试。'
        : error.httpStatus === 401 || error.httpStatus === 403 ? 'Token 无效或权限不足，请重新确认。'
        : error.httpStatus === 429 ? '服务正在限流，请稍后再试。'
        : '暂时无法连接评分服务。Token 尚未保存，可稍后重试。';
      updateConnectionUi();
      if (ui.root && !ui.host.hidden && (document.activeElement === document.body || document.activeElement === ui.host)) {
        ui.input.focus({preventScroll:true});
      }
    }
  }
  function activateToken(token) {
    ratingsToken = token; authGeneration++; halted = ''; settled.clear();
    const ids = new Set(cards.titleIds());
    for (const id of ids) revisions.set(id,(revisions.get(id) || 0)+1);
    for (const item of cards.values()) {
      item.loaded = false; item.loading = false; item.retryable = false; item.retrying = false; cards.defer(item,false);
      item.detailKey = null; item.detailBase = null; item.detailRun = null; item.detailBusy = false; item.detailUntil = 0;
      item.error = ''; paint(item,identityCache(item.id)?.data || item.baseData || item.data || null);
      if (item.card.isConnected && (item.visible || item.prefetch || item.detail)) {
        if (item.detail) scheduleDetails(item.card); else load(item);
      }
    }
    pumpRequests(); wakeAuthorityChecks(); updateConnectionUi();
  }
  function connectionAuthFailed() {
    if (connectionUi) { connectionUi.success = false; connectionUi.dismissed = false; }
    for (const item of cards.values()) paint(item,identityCache(item.id)?.data || item.baseData || item.data || null);
    updateConnectionUi();
  }
  function networkState() {
    return halted || `自建评分服务；${ratingsToken ? 'Token 已设置' : '未设置 Token'}；在途${active}，排队${requestQueue.length}；冷却${Math.max(0,Math.ceil((readyAt-performance.now())/1000))}秒`;
  }

  // One linear snapshot per dispatch; never rescan all cards once per queued request.
  function prioritySnapshot(tasks = null) {
    const priorities = new Map();
    const add = item => {
      if (!item.card.isConnected) return;
      const priority = item.detail || item === hoverItem || item === focusItem ? 2 : item.visible ? 1 : item.prefetch && item.near ? 0.5 : 0;
      priorities.set(item.id,Math.max(priorities.get(item.id) ?? 0,priority));
    };
    if (tasks) {
      for (const {context} of tasks) if (context && !priorities.has(context.id)) {
        for (const item of cards.forId(context.id)) add(item);
      }
    } else for (const item of cards.values()) add(item);
    return priorities;
  }
  // Retain pending deadlines across manual continuation without an unbounded history.
  function queryWait(key, delay = 0) {
    const now = performance.now();
    if ((queryWaits.get(key) || 0) <= now) queryWaits.delete(key);
    if (delay > 0) {
      const until = Math.max(queryWaits.get(key) || 0,now+delay);
      if (!queryWaits.has(key) && queryWaits.size >= 1500) {
        for (const [query,expiry] of queryWaits) if (expiry <= now) queryWaits.delete(query);
      }
      if (queryWaits.has(key) || queryWaits.size < 1500) queryWaits.set(key,until);
      else readyAt = Math.max(readyAt,until);
    }
    return queryWaits.get(key) || 0;
  }
  function pumpRequests() {
    if (pumpRequests.queued || !requestQueue.length) return;
    clearTimeout(pumpTimer); pumpTimer = null;
    pumpRequests.queued = true;
    queueMicrotask(() => { pumpRequests.queued = false; dispatchRequests(); });
  }
  function dispatchRequests() {
      pumpTimer = null;
      const priorities = prioritySnapshot(requestQueue), checkedAt = performance.now();
      let retained = 0, deadlineAt = Infinity;
      // Compact once. Mass cancellation must not shift the rest of the queue once per removed task.
      for (let i=0;i<requestQueue.length;i++) {
        const task = requestQueue[i], context = task.context;
        if (Math.max(checkedAt,readyAt,task.notBefore)+6000 > task.deadline) {
          task.reject(Object.assign(new Error('查询预算不足，请稍后手动重试'),{budgetExhausted:true})); continue;
        }
        const authChanged = !task.validation && (!ratingsToken || halted || task.generation !== authGeneration);
        const irrelevant = task.validation ? context?.valid && !context.valid()
          : context && (!priorities.has(context.id) || (revisions.get(context.id) || 0) !== context.revision
            || (context.valid && !context.valid()));
        if (authChanged || irrelevant) {
          task.reject(Object.assign(new Error(authChanged ? '评分连接已暂停或更新' : '作品已离开页面或匹配已更新'),{cancelled:true})); continue;
        }
        requestQueue[retained++] = task;
        deadlineAt = Math.min(deadlineAt,task.deadline-6000+1);
      }
      requestQueue.length = retained;
      while (active < 2 && requestQueue.length) {
        const now = performance.now();
        let best = -1, score = -1, nextReady = Infinity;
        for (let i=0;i<requestQueue.length;i++) {
          const context = requestQueue[i].context;
          const pagePriority = requestQueue[i].validation ? 3 : context ? priorities.get(context.id) ?? 0 : 3;
          if (context?.background && pagePriority === 0) continue;
          // Speculative work never consumes both HTTP slots; refreshes remain lower priority.
          if (context?.background && pagePriority === 0.5 && active >= 1) continue;
          if (context?.refresh && activeRefreshes >= 1) continue;
          const priority = context?.refresh ? 0 : pagePriority;
          const due = Math.max(readyAt,requestQueue[i].notBefore);
          if (due > now) { nextReady = Math.min(nextReady,due); continue; }
          if (priority > score) { best = i; score = priority; }
        }
        if (best < 0) {
          if (Number.isFinite(nextReady)) pumpTimer = setTimeout(dispatchRequests,Math.min(60000,Math.max(1,Math.min(nextReady,deadlineAt)-now)));
          break;
        }
        const task = requestQueue.splice(best,1)[0];
        if (task.context?.background && task.context.state === 'queued') {
          task.context.state = 'querying'; task.context.queryStartedAt = now;
        }
        active++; task.attempt++; readyAt = now+100;
        if (task.context?.refresh) activeRefreshes++;
        if (task.context?.background) task.context.attempt = task.attempt;
        const complete = (data,error) => {
          active--;
          if (task.context?.refresh) activeRefreshes--;
          const waiting = !!(error?.pending || error?.waiting);
          if (error?.retryable && !error.cancelled) {
            if (task.posterPoll && waiting) task.waits++; else task.failures++;
            if (task.context?.background) {
              Object.assign(task.context,{failures:task.failures,waits:task.waits,
                state:error.pending ? 'polling' : error.waiting ? 'waiting' : 'retrying',
                waitReason:error.waiting || '',responseHint:error.message
                  +(error.httpStatus ? `；HTTP ${error.httpStatus}` : '')
                  +(error.provider ? `；来源 ${error.provider} / ${error.reason}` : '')});
            }
          }
          if (error && task.context?.background) paintRequestStates(task.context);
          const withinBudget = task.posterPoll ? task.failures < task.maxAttempts && task.waits < 32 : task.attempt < task.maxAttempts;
          if (error?.retryable && !error.stopRequests && !halted && task.generation === authGeneration && withinBudget) {
            requestQueue.push(task);
          }
          else if (error) {
            if (error.retryable && !withinBudget && task.maxAttempts > 1) {
              error.message += waiting ? '；本轮等待已暂停，可手动继续查询' : task.posterPoll
                ? `；已发生${task.failures}次临时失败，请手动重试` : `；已尝试${task.attempt}次，请手动重试`;
            }
            task.reject(error);
          } else task.resolve(data);
          pumpRequests();
        };
        if (task.context?.background) paintRequestStates(task.context);
        task.run(task.attempt).then(data => complete(data,null),error => complete(undefined,error));
      }
      if (!pumpTimer && requestQueue.length && Number.isFinite(deadlineAt)) pumpTimer = setTimeout(dispatchRequests,Math.min(60000,Math.max(1,deadlineAt-performance.now())));
  }
  // One dispatch, no private retry loop: pending uses the same bounded priority queue as failures.
  function requestServiceJson(params, attempt = 1, credential = ratingsToken) {
    return new Promise((resolve,reject) => {
      let done = false, handle, mustAbort = false, earlyFailure;
      const post = !!params.hints, health = params.health === true;
      const error = (message, extra = {}) => Object.assign(new Error(message),{safeServiceError:true,...extra});
      const waitFor = (data, headers) => {
        const waits = [], now = Date.now(), pending = data?.status === 'pending';
        if (pending && Number.isFinite(data?.poll_after_seconds) && data.poll_after_seconds >= 0) waits.push(data.poll_after_seconds*1000);
        if (Number.isFinite(data?.retry_after_seconds) && data.retry_after_seconds >= 0) waits.push(data.retry_after_seconds*1000);
        // identity.retry_at is a reservation/failure deadline, not the pending poll cadence.
        if (!pending) {
          const retryAt = data?.identity?.retry_at;
          if (typeof retryAt === 'number' && Number.isFinite(retryAt)) waits.push(Math.max(0,retryAt*1000-now));
          else if (typeof retryAt === 'string' && Number.isFinite(Date.parse(retryAt))) waits.push(Math.max(0,Date.parse(retryAt)-now));
        }
        for (const match of typeof headers === 'string' ? headers.matchAll(/^Retry-After\s*:\s*([^\r\n]+)/gim) : []) {
          const value = match[1].trim(), seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
          if (!Number.isNaN(seconds)) waits.push(seconds*1000);
          else if (/^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})$/.test(value) && Number.isFinite(Date.parse(value))) waits.push(Math.max(0,Date.parse(value)-now));
        }
        return (waits.length ? Math.max(...waits) : 1000*2**Math.min(6,attempt-1))+Math.random()*500;
      };
      // Only a complete identity-bound response may narrow a shared transport failure.
      const retryBoundary = (data,status) => {
        if (status !== 503 || !data || typeof data !== 'object' || Array.isArray(data)
          || (netflix ? data.netflix_id !== id : data.imdb_id !== id)
          || !['wikidata','tmdb','douban'].includes(data.provider)) return {};
        const local = (data.status === 'busy' && (
          (data.scope === 'source' && data.reason === 'source_queue_full')
          || (data.scope === 'account' && data.reason === 'account_cold_tasks')))
          || (data.scope === 'source' && data.reason === 'source_cooldown'
            && ['temporary_failure','rate_limited'].includes(data.status))
          || (data.scope === 'resource' && ['busy','temporary_failure','rate_limited'].includes(data.status)
            && data.reason === data.status);
        if (!local) return {};
        const waiting = data.reason === 'source_queue_full' || data.reason === 'account_cold_tasks' ? 'capacity'
          : data.reason === 'source_cooldown' ? 'source' : '';
        return {retryScope:'query',scope:data.scope,reason:data.reason,provider:data.provider,...(waiting ? {waiting} : {})};
      };
      const finish = (failure,data) => {
        if (done) return;
        done = true; clearTimeout(timer);
        if (failure) reject(failure); else resolve(data);
      };
      const stop = (message,retryable = false) => {
        if (done) return;
        finish(earlyFailure || error(message,{retryable})); mustAbort = true;
        try { handle?.abort(); } catch { /* Finalized before abort callbacks. */ }
      };
      const timer = setTimeout(()=>stop('评分服务查询超过6秒',true),6000);
      const netflix = params.netflix !== undefined, id = netflix ? params.netflix : params.i;
      if (!health && !(netflix ? /^\d{6,10}$/ : /^tt\d{7,10}$/).test(id || '')) { finish(error('作品编号格式错误')); return; }
      try {
        let body;
        if (post) {
          if (!netflix || typeof params.hints !== 'object' || Array.isArray(params.hints)) { finish(error('详情提示格式错误')); return; }
          body = JSON.stringify(params.hints);
          if (typeof body !== 'string' || new TextEncoder().encode(body).byteLength > 2048) { finish(error('详情提示超过2048字节')); return; }
        }
        handle = GM_xmlhttpRequest({method:post ? 'POST' : 'GET',url:'https://ratings.op13.uk/api/v1/'+(health ? 'health' : (netflix ? 'netflix/' : 'imdb/')+id),
          anonymous:true,redirect:'error',timeout:6000,headers:{Authorization:'Bearer '+credential,Accept:'application/json',...(post ? {'Content-Type':'application/json'} : {})},
          ...(post ? {data:body} : {}),
          onreadystatechange:response=>{
            if (!done && (response.status === 429 || response.status >= 500)) earlyFailure = error('评分服务繁忙，响应已中止，请稍后重试',
              {retryable:true,httpStatus:response.status,retryAfter:waitFor(null,response.responseHeaders)});
          },
          onprogress:event=>{ if (event.loaded > 16384) stop('评分服务响应超过16KiB'); },
          onload(response) {
            if (done) return;
            try {
              const status = response.status;
              if (status === 401 || status === 403) throw error('评分服务 Token 无效或访问被拒绝，请检查设置',{stopRequests:true,httpStatus:status});
              const transient = status === 429 || status >= 500;
              const text = response.responseText;
              const small = typeof text === 'string' && text.length <= 16384 && new TextEncoder().encode(text).byteLength <= 16384;
              let data;
              if (small) { try { data = JSON.parse(text); } catch { /* HTML errors still carry useful HTTP status and headers. */ } }
              if (transient) {
                const boundary = retryBoundary(data,status);
                const message = boundary.waiting === 'capacity' ? '评分服务队列繁忙，等待受理'
                  : boundary.waiting === 'source' ? '数据源处于冷却期，等待恢复'
                  : status === 429 ? '评分服务限流，请稍后重试' : '评分服务暂时不可用，请稍后重试';
                throw error(message,{retryable:true,httpStatus:status,retryAfter:waitFor(data,response.responseHeaders),...boundary});
              }
              if ((!post && status !== 200 && status !== 202) || (post && ![200,202,409].includes(status))) {
                throw error(({400:'请求参数无效',404:'接口路径不存在',405:'接口方法不兼容',413:'请求体过大'})[status] || '评分服务 HTTP 异常',{httpStatus:status});
              }
              if (!small) { stop('评分服务响应超过16KiB'); return; }
              if (!data) throw error('评分服务 JSON 格式异常',{httpStatus:status});
              if (health) {
                if (status !== 200 || data.status !== 'ok' || data.version !== 1
                  || !Array.isArray(data.capabilities) || !data.capabilities.includes('netflix_detail_match_v1')) {
                  throw error('评分服务验证响应异常',{httpStatus:status});
                }
                finish(null,{status:'ok'}); return;
              }
              let parsed;
              try { parsed = post ? {...parseDetailResponse(data,id),raw:data} : parseServiceResponse(data,id,netflix); }
              catch (failure) {
                failure.httpStatus ??= status;
                if (failure.retryable) failure.retryAfter = waitFor(data,response.responseHeaders);
                throw failure;
              }
              if (parsed.status === 'pending') parsed.retryAfter = waitFor(data,response.responseHeaders);
              finish(null,parsed);
            } catch (failure) { finish(failure); }
          },
          ontimeout:()=>stop('评分服务查询超过6秒',true),
          onerror:()=>stop('评分服务连接失败',true),
          onabort:()=>finish(error('评分服务请求已中止'))
        });
        if (mustAbort) { try { handle?.abort(); } catch { /* Synchronous callbacks may precede the handle. */ } }
      } catch { finish(error('评分服务请求执行失败')); }
    });
  }
  function api(params, context = null) {
    const validation = typeof context?.validationToken === 'string';
    const credential = validation ? context.validationToken : ratingsToken, generation = authGeneration;
    if (!credential || (!validation && halted)) return Promise.reject(Object.assign(new Error('评分服务尚未连接'),{cancelled:true}));
    if (requestQueue.length+active >= QUEUE_MAX) return Promise.reject(new Error('查询队列已满，请稍后重试'));
    const deadline = context?.background ? Infinity : context?.deadline ?? performance.now()+40000;
    const queryKey = JSON.stringify(params), posterPoll = !!context?.background && !context?.authorityCheck && !validation;
    let task;
    const run = async attempt => {
      if (!validation && (halted || generation !== authGeneration)) throw Object.assign(new Error('评分连接已更新'),{cancelled:true});
      if (context && ((context.valid && !context.valid()))) {
        throw Object.assign(new Error('详情已变化或本轮查询已到期'),{cancelled:true});
      }
      if (performance.now()+6000 > deadline) throw Object.assign(new Error('查询预算不足，请手动重试'),{budgetExhausted:true});
      requests++;
      try {
        const data = await requestServiceJson(params,context?.retryAttempt ?? (posterPoll ? task.failures+1 : attempt),credential);
        if (!validation && generation !== authGeneration) throw Object.assign(new Error('评分连接已更新'),{cancelled:true});
        if (data.status === 'pending') task.notBefore = queryWait(queryKey,data.retryAfter ?? 1000);
        return data;
      } catch (error) {
        if (!validation && generation !== authGeneration) throw Object.assign(new Error('评分连接已更新'),{cancelled:true});
        if (error?.cancelled) throw error;
        if (!error?.safeServiceError) error = new Error('评分服务请求执行失败');
        diagnostic = `时间：${new Date().toLocaleTimeString()}\nHTTP：${error.httpStatus ?? '无响应'}\n提示：${error.message}`
          +(error.provider ? `\n来源：${error.provider}\n原因：${error.reason}\n范围：${error.scope}` : '');
        if (error.stopRequests && !validation && !halted) { halted = error.message; connectionAuthFailed(); }
        if (error.retryable && !error.stopRequests) {
          const count = context?.retryAttempt ?? (posterPoll ? task.failures+1 : attempt);
          error.retryAfter ??= 1000*2**Math.min(6,count-1)+Math.random()*500;
          // Normal admission/polling waits do not spend the genuine-failure budget or hammer a queue.
          if (posterPoll && (error.pending || error.waiting)) error.retryAfter = Math.max(error.retryAfter,1000*2**Math.min(3,task.waits));
          if (error.pending || error.retryScope === 'query') task.notBefore = queryWait(queryKey,error.retryAfter);
          else readyAt = Math.max(readyAt,performance.now()+error.retryAfter);
        }
        throw error;
      }
    };
    return new Promise((resolve,reject) => {
      task = {context,deadline,run,resolve,reject,validation,generation,posterPoll,
        failures:context?.resumeFailures ?? context?.resumeAttempt ?? 0,waits:context?.resumeWaits || 0,
        notBefore:queryWait(queryKey),attempt:context?.resumeAttempt || 0,maxAttempts:validation ? 1 : context?.authorityCheck && Number.isInteger(context.maxAttempts) && context.maxAttempts >= 1 && context.maxAttempts <= 8 ? context.maxAttempts : params.hints ? 1 : context?.background ? 8 : 6};
      requestQueue.push(task); pumpRequests();
    });
  }
  async function resolve(item) {
    const route = identityRoute(item.id), mapping = route?.mapping, revision = revisions.get(item.id) || 0;
    const epoch = automaticEpoch(item.id);
    if (epoch < 0) throw new Error('作品持久状态异常，请清理本脚本存储后重试');
    const cached = identityCache(item.id,route);
    if (cached?.mapping === mapping && cacheFresh(cached)) return cached.data;
    if (!ratingsToken) throw new Error('请先设置评分服务 Token');
    const taskKey = `${item.id}:${revision}`;
    let resumeAttempt = 0, resumeFailures, resumeWaits = 0;
    if (settled.has(taskKey)) {
      const prior = settled.get(taskKey);
      if (prior.error) throw prior.error;
      if (prior.resumeAttempt === undefined) return prior.data;
      resumeAttempt = prior.resumeAttempt; resumeFailures = prior.resumeFailures; resumeWaits = prior.resumeWaits || 0;
      settled.delete(taskKey);
    }
    if (pending.has(taskKey)) return pending.get(taskKey);
    // Keep this context on the shared promise so duplicate cards observe one retry round.
    const refresh = !!(cached?.mapping === mapping && cached?.data?.rating && (!mapping || cached.data.id === mapping));
    const requestContext = {id:item.id,revision,background:true,refresh,state:'queued',resumeAttempt,resumeFailures,resumeWaits,
      attempt:resumeAttempt,failures:resumeFailures,waits:resumeWaits};
    const stillRelevant = (checkStorage = true) => (revisions.get(item.id) || 0) === revision && automaticEpoch(item.id) === epoch && (!checkStorage || !persistedIdentityConflict(item.id,route))
      && ([...cards.forId(item.id)].some(other => other.card.isConnected)
        || (requestContext.parkedCard?.isConnected && netflixId(requestContext.parkedCard.getAttribute('href')) === item.id));
    const job = (async () => {
      const result = await api(mapping ? {i:mapping} : {netflix:item.id},requestContext);
      if (!stillRelevant(false)) {
        throw Object.assign(new Error('作品已移除或匹配已更新'),{cancelled:true});
      }
      const data = result.data ? {...result.data,source:mapping ? route.source : 'service'} : null;
      if (mapping && !data) throw new Error('已确认作品暂时无法更新评分');
      if (!mapping && data) {
        if (data.title === data.id && !data.mappingScope) data.title = item.title;
        if (!await commitAuthoritative(item.id,data,{epoch,revision})) throw Object.assign(new Error('作品匹配已更新'),{cancelled:true});
        return cache[item.id].data;
      }
      if (data && data.title === data.id && !data.mappingScope) data.title = item.title;
      await saveScore(item.id,route,epoch,data);
      return data;
    })();
    job.requestContext = requestContext;
    pending.set(taskKey,job);
    try {
      const data = await job; settled.set(taskKey,{data}); return data;
    } catch (error) {
      if (!stillRelevant()) {
        throw Object.assign(new Error('作品已移除或匹配已更新'),{cancelled:true});
      }
      if (error.cancelled && requestContext.parkedCard) settled.set(taskKey,{resumeAttempt:requestContext.attempt,resumeFailures:requestContext.failures,resumeWaits:requestContext.waits});
      else if (!error.cancelled) settled.set(taskKey,{error});
      throw error;
    } finally {
      clearTimeout(requestContext.progressTimer); requestContext.progressTimer = null;
      pending.delete(taskKey);
      while (settled.size > 1500) settled.delete(settled.keys().next().value);
    }
  }
  // Hint-keyed decisions remain temporary until startDetail commits a validated identity.
  function hintKey(id, hints) {
    return JSON.stringify([id,hints.title,hints.year ?? null,hints.kind,hints.language,hints.select ?? null]);
  }
  function detailValid(item, key, revision) {
    const info = readDetail(item.card), hints = info && readHints(item.card,info);
    return cards.get(item.card) === item && item.card.isConnected && !identityRoute(item.id)
      && (revisions.get(item.id) || 0) === revision && item.detailKey === key
      && info?.id === item.id && hints && hintKey(item.id,hints) === item.detailBase;
  }
  async function detailRequest(item, hints, key, revision, force, epoch = automaticEpoch(item.id)) {
    const saved = detailCache[key];
    if (!force && saved && (saved.epoch ?? 0) === epoch && saved.until > Date.now() && saved.until <= Date.now()+86400000) {
      try { return parseDetailResponse(saved.raw,item.id); } catch { await saveDetailCache(item.id,true); }
    }
    const flightKey = key+':'+revision;
    if (detailFlights.has(flightKey)) return detailFlights.get(flightKey);
    if (detailFlights.size >= 4) throw new Error('详情任务已满，请稍后重试');
    const valid = () => automaticEpoch(item.id) === epoch && [...cards.forId(item.id)].some(other => other.detail && detailValid(other,key,revision));
    const deadline = performance.now()+40000;
    const job = (async () => {
      let requestHints = {...hints}, expired = false;
      for (let attempt=0; attempt<6 && performance.now()+6000 <= deadline; attempt++) {
        if (!valid()) throw Object.assign(new Error('详情已变化'),{cancelled:true});
        let result;
        try { result = await api({netflix:item.id,hints:requestHints},{id:item.id,revision,deadline,valid,retryAttempt:attempt+1}); }
        catch (error) {
          if (!error.retryable || error.stopRequests || attempt === 5) throw error;
          result = {status:'pending',retryAfter:error.retryAfter ?? 1000*2**Math.min(3,attempt)+Math.random()*500};
        }
        if (!valid()) throw Object.assign(new Error('详情已变化'),{cancelled:true});
        if (result.status === 'selection_expired' && requestHints.select) {
          await saveDetailCache(item.id,true);
          delete requestHints.select; expired = true; continue;
        }
        if (result.status !== 'pending') {
          if (expired && result.status === 'ok' && result.detail) {
            const raw = {status:'ambiguous',netflix_id:item.id,candidates:[result.raw.identity.data]};
            result = {...parseDetailResponse(raw,item.id),raw};
          }
          if (result.status === 'ok') return {...result,selectionExpired:expired};
          if (['ok','missing','ambiguous'].includes(result.status)) {
            const until = result.status === 'ok' ? Date.now()+86400000 : result.retryAt;
            detailCache[hintKey(item.id,requestHints)] = {time:Date.now(),until,epoch,raw:result.raw};
            const keys = Object.keys(detailCache).sort((a,b)=>detailCache[a].time-detailCache[b].time);
            while (Object.keys(detailCache).length > 1024) delete detailCache[keys.shift()];
            await saveDetailCache(item.id);
          } else await saveDetailCache(item.id,true);
          return {...result,selectionExpired:expired};
        }
        const wait = result.retryAfter ?? 1000*2**Math.min(3,attempt)+Math.random()*500;
        if (attempt < 5 && performance.now()+wait+6000 <= deadline) await new Promise(resolve=>setTimeout(resolve,wait));
        else break;
      }
      return {status:'match_timeout',poll_exhausted:true,automatic_retry:false,selectionExpired:expired};
    })();
    detailFlights.set(flightKey,job);
    try { return await job; } finally { detailFlights.delete(flightKey); }
  }
  function showDetail(item, result) {
    const hasCandidates = !!result.candidates?.length;
    const messages = {match_timeout:'IMDb 匹配超时，请手动重试',pending:'IMDb 仍在匹配',missing:'IMDb 待匹配',ambiguous:hasCandidates ? 'IMDb 请选择作品' : 'IMDb 暂无可选作品',
      insufficient_details:'IMDb 详情不足',disabled:'IMDb 名称匹配未启用',unsupported_scope:'IMDb 不支持此层级'};
    const data = result.data ? {...result.data,source:'service'} : null;
    paint(item,data,data ? undefined : messages[result.status] || 'IMDb 匹配失败');
    item.matchButton.hidden = false;
    item.matchButton.textContent = hasCandidates ? '选择匹配作品' : '重新匹配';
    item.matchButton.disabled = false;
    if (result.detail) item.badge.title += '\n详情名称匹配 · '+(result.detail.method === 'user_selected' ? '用户选择' : '自动确认');
    if (result.status === 'pending') item.badge.title = '仍在匹配，可稍后手动重试；本轮自动查询已停止';
    if (result.status === 'match_timeout') item.badge.title = '本轮自动查询已停止，点击重新匹配可手动重试';
    if (result.status === 'ambiguous' && !hasCandidates) item.badge.title += '\n可以手动输入 IMDb 或重新匹配';
    if (result.truncated) item.badge.title += hasCandidates ? '\n候选未完整检查，请核对后选择或手动纠正' : '\n搜索结果未完整检查，可以手动输入 IMDb 或重新匹配';
    if (result.selectionExpired) item.badge.title += hasCandidates ? '\n原候选已过期，请重新选择' : '\n原候选已过期，当前暂无可选作品，可以手动输入 IMDb 或重新匹配';
  }
  async function startDetail(item, hints, force = false) {
    if (!ratingsToken || halted) { load(item); return; }
    if (identityRoute(item.id) || automaticEpoch(item.id) < 0) { item.detailKey = null; load(item); return; }
    const epoch = automaticEpoch(item.id);
    const key = hintKey(item.id,hints), revision = revisions.get(item.id) || 0;
    if (item.detailKey === key && (item.detailBusy || (!force && item.detailUntil > Date.now()))) return;
    item.detailKey = key; item.detailBase = hintKey(item.id,{...hints,select:undefined});
    const saved = detailCache[key];
    let previous = null;
    if (saved?.until > Date.now()) { try { previous = parseDetailResponse(saved.raw,item.id).data || null; } catch { /* Invalid cache cannot preserve a score. */ } }
    const run = {}; item.detailRun = run;
    item.detailHints = {...hints,select:undefined}; item.detailBusy = true; item.detailUntil = Infinity;
    item.detailResult = null; item.error = ''; item.matchButton.hidden = false; item.matchButton.disabled = true;
    paint(item,previous,previous ? undefined : 'IMDb 详情匹配中');
    try {
      const result = await detailRequest(item,hints,key,revision,force,epoch);
      if (!detailValid(item,key,revision) || automaticEpoch(item.id) !== epoch) return;
      if (hints.select && !result.selectionExpired && result.status === 'ok' && result.detail?.method === 'user_selected') {
        await saveMapping(item,result.data);
        return;
      }
      if (result.status === 'ok' && result.data) {
        if (!result.detail) { await commitAuthoritative(item.id,result.data,{epoch,revision}); return; }
        if (result.detail.method === 'automatic') {
          try {
            if (await saveAutomatic(item.id,result,epoch)) { syncIdentity(item.id); return; }
            return;
          } catch (error) { lastError = '自动匹配保存失败：'+error.message; }
          detailCache[key] = {time:Date.now(),until:Date.now()+86400000,epoch,raw:result.raw};
          await saveDetailCache(item.id);
        }
      }
      item.detailResult = result;
      if (result.selectionExpired) item.detailKey = item.detailBase;
      item.detailUntil = result.status === 'ok' ? Date.now()+86400000 : result.retryAt ?? Infinity;
      showDetail(item,result);
      if (result.status === 'match_timeout' && previous) { paint(item,previous); item.badge.title += '\n匹配超时，保留已有评分；可手动重试'; }
    } catch (error) {
      if (!detailValid(item,key,revision) && (item.detailRun !== run || cards.get(item.card) !== item
        || !item.card.isConnected || readDetail(item.card)?.id !== item.id)) return;
      lastError = error.message;
      item.error = error.message;
      item.detailUntil = Infinity;
      item.detailResult = {status:error.budgetExhausted ? 'match_timeout' : 'failed'};
      paint(item,previous,previous ? undefined : error.budgetExhausted ? 'IMDb 匹配超时，请手动重试' : 'IMDb 匹配失败');
      item.badge.title += '\n'+error.message+(previous ? '；保留已有评分' : '');
      item.matchButton.textContent = '重新匹配'; item.matchButton.disabled = false;
    } finally {
      if (item.detailRun === run) item.detailBusy = false;
    }
  }
  function candidatePrompt(candidates) {
    if (!candidates?.length) return null;
    const lines = candidates.map((c,i)=>`${i+1}. ${c.title} / ${c.original_title || c.title}\n${c.year ?? '年份未知'} · ${c.kind === 'series' ? '整剧' : '电影'}\n${c.source}`);
    const value = prompt('请选择作品编号；取消则保持未确认。\n'+lines.join('\n'));
    return /^[1-3]$/.test(value || '') ? candidates[Number(value)-1] || null : null;
  }
  async function posterSelectionAction(item) {
    if (!item.posterSelectable || item.data) return;
    const candidates = item.posterCandidates || [];
    if (!candidates.length) { edit(item,true); return; }
    if (editing.has(item.id)) return;
    const selected = candidatePrompt(candidates);
    if (!selected || !item.posterSelectable || item.data) return;
    if (editing.size >= 24) { alert('请先完成已有的匹配操作'); return; }
    editing.add(item.id);
    try {
      const data = (await api({i:selected.imdb_id})).data;
      if (!item.posterSelectable || item.data || mappings[item.id]) return;
      await saveMapping(item,data);
    } catch (error) { lastError = error.message; alert(error.message); }
    finally { editing.delete(item.id); }
  }
  function detailAction(item) {
    if (!ratingsToken || halted) { configure(); return; }
    if (item.detailBusy || !item.detailHints) return;
    const key = item.detailKey, revision = revisions.get(item.id) || 0;
    if (!detailValid(item,key,revision)) { scheduleDetails(item.card); return; }
    const candidates = item.detailResult?.candidates || [];
    const hints = {...item.detailHints};
    if (candidates.length) {
      const selected = candidatePrompt(candidates);
      if (!selected || !detailValid(item,key,revision)) return;
      hints.select = selected.candidate_id;
    }
    startDetail(item,hints,true);
  }
  // Keep only the latest decision for an affected title, so revoked older hints cannot reappear.
  async function saveDetailCache(id, drop = false) {
    const prefix = `["${id}",`, epoch = automaticEpoch(id);
    const entries = Object.entries(detailCache).filter(([key])=>key.startsWith(prefix)).sort((a,b)=>b[1].time-a[1].time);
    const newest = entries[0];
    try {
      await withIdentityLock(() => {
        importIdentityStorage(id);
        const record = readTitleRecord(id);
        if (record.epoch !== epoch || epoch < 0) return;
        const detail = !drop && newest && newest[1].epoch === epoch && !identityRoute(id)
          ? {key:newest[0],entry:newest[1]} : null;
        writeTitleRecord(id,{...record,detail});
      });
    } catch { lastError = '详情缓存保存失败'; }
    refreshDetailRatings();
  }
  // Rebuild only on cache changes/expiry. Painting remains O(1), and never starts network requests.
  function refreshDetailRatings() {
    clearTimeout(detailExpiryTimer);
    if (!detailRatings.size && !Object.keys(detailCache).length) return;
    detailRatings.clear();
    const latest = new Map(), now = Date.now();
    for (const [key,entry] of Object.entries(detailCache)) {
      let id;
      try { id = JSON.parse(key)[0]; } catch { continue; }
      if (typeof id !== 'string' || !/^\d{6,10}$/.test(id) || entry.raw?.netflix_id !== id) continue;
      if (!latest.has(id) || entry.time >= latest.get(id).time) latest.set(id,{...entry,key});
    }
    for (const [key,entry] of Object.entries(detailCache)) {
      if (latest.get(entry.raw?.netflix_id)?.key !== key) delete detailCache[key];
    }
    let expiry = Infinity;
    for (const [id,entry] of latest) {
      if (entry.until <= now || entry.until > now+86400000 || (entry.epoch ?? 0) !== automaticEpoch(id)) continue;
      try {
        const result = parseDetailResponse(entry.raw,id);
        if (result.data || result.status === 'ambiguous') {
          // An ambiguous decision supplies text only, never a confirmed IMDb identity.
          detailRatings.set(id,{until:entry.until,data:result.data ? {...result.data,source:'detail'} : null,
            message:result.status === 'ambiguous' ? (result.candidates.length ? 'IMDb 请选择作品' : 'IMDb 暂无可选作品') : '',
            candidates:result.status === 'ambiguous' ? result.candidates : []});
          expiry = Math.min(expiry,entry.until);
        }
      } catch { /* Invalid saved responses never become an identity fallback. */ }
    }
    for (const item of cards.values()) {
      if (item.detailKey) continue;
      if (detailRatings.has(item.id) || item.data?.source === 'detail' || item.detailMessage) paint(item,item.baseData || null);
    }
    if (Number.isFinite(expiry)) detailExpiryTimer = setTimeout(refreshDetailRatings,Math.max(1,expiry-now));
  }
  function setPosterSelection(item, enabled) {
    if (item.detail) return;
    enabled = !!enabled;
    if (item.posterSelectable === enabled) return;
    item.posterSelectable = enabled;
    const badge = item.badge;
    if (enabled) {
      const click = event => {
        if (!item.posterSelectable) return;
        event.preventDefault(); event.stopPropagation(); posterSelectionAction(item);
      };
      const keydown = event => {
        if (item.posterSelectable && (event.key === 'Enter' || event.key === ' ')) click(event);
      };
      item.posterSelectClick = click; item.posterSelectKeydown = keydown;
      badge.addEventListener?.('click',click,true); badge.addEventListener?.('keydown',keydown);
      if (badge.dataset) badge.dataset.action = 'select';
      badge.setAttribute?.('role','button'); badge.setAttribute?.('aria-label','选择此作品对应的 IMDb 作品');
      badge.tabIndex = 0;
    } else {
      if (item.posterSelectClick) badge.removeEventListener?.('click',item.posterSelectClick,true);
      if (item.posterSelectKeydown) badge.removeEventListener?.('keydown',item.posterSelectKeydown);
      item.posterSelectClick = null; item.posterSelectKeydown = null;
      if (badge.dataset) delete badge.dataset.action;
      badge.removeAttribute?.('role'); badge.removeAttribute?.('tabindex'); badge.removeAttribute?.('aria-label');
    }
  }
  function paint(item, data, message) {
    if (item.detail && readDetail(item.card)?.id !== item.id) return;
    item.detailMessage = '';
    let fallback = null;
    if (!item.detailKey) {
      if (data?.source !== 'detail') item.baseData = data;
      fallback = !mappings[item.id] && !item.baseData ? detailRatings.get(item.id) : null;
      data = item.baseData || (fallback?.until > Date.now() ? fallback.data : null);
      item.detailMessage = fallback?.until > Date.now() ? fallback.message || '' : '';
      if (data?.source === 'detail') message = undefined;
      else if (item.detailMessage) message = item.detailMessage;
    }
    const authHidden = (!ratingsToken || !!halted) && !data?.rating;
    if (item.badge.hidden !== authHidden) item.badge.hidden = authHidden;
    if (item.row && item.row.hidden !== authHidden) item.row.hidden = authHidden;
    const scoped = data?.mappingScope === 'parent_series' && data.ratingScope === 'series';
    const text = (message || (data ? (data.rating ? `IMDb ${data.rating}` : 'IMDb 暂未获取评分') : 'IMDb 待匹配'))
      + (scoped ? ' · 整剧' : '');
    if (item.badge.textContent !== text) {
      const node = item.badge.firstChild;
      if (node?.nodeType === 3 && !node.nextSibling) node.data = text;
      else item.badge.textContent = text;
    }
    const state = data?.rating ? 'rated' : 'muted';
    if (item.badge.dataset.state !== state) item.badge.dataset.state = state;
    let title = item.error || (data ? `${data.title} · ${data.votes} 人评分\n${data.source === 'manual' ? '手动确认' : data.source === 'automatic' ? '详情自动确认（已保存）' : '自建服务匹配'}\n${item.detail ? '点击查看或纠正' : '展开详情查看或纠正'}` : item.detail ? '服务未找到映射，可点击输入 IMDb 编号或链接纠正' : '服务未找到映射；展开详情可手动输入 IMDb');
    if (!data && !item.error && message === 'IMDb 等待查询') title = '等待查询，优先处理当前可见作品';
    if (item.detailMessage) title = item.detailMessage === 'IMDb 请选择作品'
      ? '来自详情匹配的多个可能作品；点击角标可直接选择候选作品，或展开详情查看更多信息'
      : '来自此作品的详情匹配，尚未确认身份；请展开详情查看匹配结果，或手动输入 IMDb';
    item.data = data;
    item.posterCandidates = !item.detail && fallback?.until > Date.now() && fallback.candidates?.length ? fallback.candidates : null;
    setPosterSelection(item,!data && !!ratingsToken && !halted && (item.needsSelection || item.posterCandidates?.length));
    if (item.detail) {
      if (data) {
        const href = `https://www.imdb.com/title/${data.id}/`;
        if (item.badge.href !== href) item.badge.href = href;
      } else if (item.badge.href) item.badge.removeAttribute('href');
      if (Number.isSafeInteger(data?.doubanId) && data.doubanId > 0 && !item.row.classList.contains('nli-mini')) {
        const href = `https://movie.douban.com/subject/${data.doubanId}/`;
        const season = data.doubanLinkScope === 'season' && Number.isSafeInteger(data.doubanSeason) ? data.doubanSeason : null;
        const score = typeof data.doubanRating === 'string' ? data.doubanRating : '';
        const label = score ? `豆瓣 ${score}${season ? ` · 第${season}季` : ''}` : '豆瓣';
        let hint = data.doubanLinkScope === 'season'
          ? `打开豆瓣${season ? ` · 第${season}季` : '对应季'}`
          : data.doubanLinkScope === 'representative' ? '打开豆瓣对应剧集条目' : '打开豆瓣条目';
        if (score) hint += ` · 评分 ${score}`;
        if (score && data.doubanHistorical === true && typeof data.doubanUpdatedAt === 'string') {
          hint += ` · 历史快照 ${data.doubanUpdatedAt.slice(0,10)}`;
        } else if (score && data.doubanStale === true) hint += ' · 缓存评分，更新暂未完成';
        const aria = score ? `在新标签页打开豆瓣条目，评分 ${score}${season ? `，第${season}季` : ''}` : '在新标签页打开豆瓣条目';
        if (item.doubanLink.href !== href) item.doubanLink.href = href;
        if (item.doubanLink.textContent !== label) item.doubanLink.textContent = label;
        if (item.doubanLink.title !== hint) item.doubanLink.title = hint;
        if (item.doubanLink.getAttribute?.('aria-label') !== aria) item.doubanLink.setAttribute?.('aria-label',aria);
        if (item.doubanLink.hidden !== false) item.doubanLink.hidden = false;
      } else {
        if (item.doubanLink.href) item.doubanLink.removeAttribute('href');
        if (item.doubanLink.textContent !== '豆瓣') item.doubanLink.textContent = '豆瓣';
        if (item.doubanLink.title !== '打开豆瓣条目') item.doubanLink.title = '打开豆瓣条目';
        if (item.doubanLink.getAttribute?.('aria-label') !== '在新标签页打开豆瓣条目') item.doubanLink.setAttribute?.('aria-label','在新标签页打开豆瓣条目');
        if (item.doubanLink.hidden !== true) item.doubanLink.hidden = true;
      }
      if (item.correction.textContent !== '手动输入 IMDb') item.correction.textContent = '手动输入 IMDb';
      if (data && item.card.classList.contains('mini-modal')) {
        title = `${data.title} · ${data.votes} 人评分\n点击打开 IMDb；纠正请展开完整详情`;
      }
    }
    if (data?.source === 'automatic' && item.card.classList.contains('mini-modal')) title += '\n详情自动确认（已保存）';
    if (data?.source === 'manual' && item.card.classList.contains('mini-modal')) title += '\n手动确认';
    if (data?.provider === 'ratings') title += '\n评分来源：IMDb 官方每日数据集' + (data.stale ? '\n服务器保留的旧数据，更新暂未完成' : '');
    if (data?.source === 'detail') title += '\n来自此作品已确认的详情匹配';
    if (scoped) title += '\n这是父剧集整体的 IMDb 评分，不是当前 Netflix 分季或单集的评分';
    if (item.badge.title !== title) item.badge.title = title;
  }
  async function load(item) {
    if (!ratingsToken || halted) {
      item.needsSelection = false;
      paint(item,identityCache(item.id)?.data || item.baseData || item.data || null);
      item.loaded = false; cards.defer(item,false); return;
    }
    const route = identityRoute(item.id);
    if (!route && titleRecords.get(item.id)?.detail && !detailRatings.has(item.id)) refreshDetailRatings();
    if (route?.source === 'automatic') wakeAuthorityChecks();
    if (item.detailKey && !route) return;
    if (route) item.detailKey = null;
    if (item.loading || item.loaded) return;
    const revision = revisions.get(item.id) || 0;
    const cached = identityCache(item.id,route);
    const usable = !!cached;
    if (usable) {
      paint(item,cached.data);
      if (cacheFresh(cached)) { item.loaded = true; return; }
      if (cached.data) item.badge.title += '\n缓存评分，正在后台更新';
    }
    if (!usable && !route && detailRatings.get(item.id)?.until > Date.now()) {
      paint(item,null); item.loaded = true; return;
    }
    if (pending.size >= CARDS_MAX && !pending.has(`${item.id}:${revision}`) && !settled.has(`${item.id}:${revision}`)) {
      cards.defer(item,true);
      if (!usable) paint(item,null,'IMDb 等待查询');
      pumpRequests();
      return;
    }
    cards.defer(item,false);
    item.loading = true;
    item.error = '';
    item.retryable = false;
    item.needsSelection = false;
    if (!usable) paint(item,null,'IMDb 等待查询');
    pumpRequests();
    try {
      const result = resolve(item);
      const context = pending.get(`${item.id}:${revision}`)?.requestContext;
      if (context) paintRequestStates(context);
      const data = await result;
      if ((revisions.get(item.id) || 0) !== revision) return;
      item.needsSelection = false;
      if (cards.get(item.card) === item && !item.detailKey) paint(item,data);
      item.loaded = true;
    } catch (error) {
      if ((revisions.get(item.id) || 0) !== revision) return;
      if (item.detailKey) return;
      item.error = error.message; lastError = error.message;
      item.retryable = !!error.retryable && !error.stopRequests;
      item.needsSelection = !!error.needsSelection;
      if (cards.get(item.card) === item) {
        if (error.provider) item.error += `；来源 ${error.provider} / ${error.reason}`;
        if (error.needsSelection && !item.detail) item.error += '；点击角标可直接输入 IMDb，或展开详情继续自动匹配';
        if (item.retryable) item.error += item.detail
          ? (error.pending || error.waiting ? '；点击继续查询，可手动输入 IMDb' : '；点击重试，可手动输入 IMDb')
          : (error.pending || error.waiting ? '；展开详情后可继续查询或手动输入 IMDb' : '；展开详情后可重试或手动输入 IMDb');
        if (item.baseData) { item.error += '；保留缓存评分'; paint(item,item.baseData); }
        else paint(item,null,error.needsSelection ? 'IMDb 待匹配' : error.pending || error.waiting ? (item.detail ? 'IMDb 仍在处理 · 点击继续' : 'IMDb 仍在处理') : item.retryable ? (item.detail ? 'IMDb 暂时不可用 · 点击重试' : 'IMDb 暂时不可用') : 'IMDb 查询失败');
      }
      item.loaded = !error.cancelled;
      if (error.cancelled) cards.defer(item,true);
    }
    finally {
      if ((revisions.get(item.id) || 0) === revision) { item.loading = false; item.retrying = false; }
      resumeLoads();
    }
  }
  // Keep each poster's progress stable across shared cooldowns; unchanged turns never mutate DOM.
  function paintRequestStates(changed = null) {
    const work = changed ? [[`${changed.id}:${changed.revision}`,{requestContext:changed}]] : pending;
    for (const [key,job] of work) {
      const split = key.lastIndexOf(':'), id = key.slice(0,split);
      const context = job.requestContext;
      if (!context || key !== `${id}:${revisions.get(id) || 0}` || (changed && pending.get(key)?.requestContext !== context)) continue;
      clearTimeout(context.progressTimer); context.progressTimer = null;
      let nextProgress = Infinity;
      for (const item of cards.forId(id)) {
        if (!item.loading || item.detailKey || !item.card.isConnected || item.data || item.baseData || item.detailMessage) continue;
        const retrying = context.state === 'retrying', polling = context.state === 'polling', querying = context.state === 'querying';
        const sourceWait = context.state === 'waiting' && context.waitReason === 'source';
        if (querying && Number.isFinite(context.queryStartedAt)) {
          const delay = context.queryStartedAt+120-performance.now();
          if (delay > 0) { nextProgress = Math.min(nextProgress,delay); continue; }
        }
        const visibleRetry = retrying && (context.failures || 0) >= 2;
        const label = visibleRetry ? 'IMDb 自动重试中' : sourceWait ? 'IMDb 等待数据源' : retrying || polling || querying ? 'IMDb 查询中' : 'IMDb 等待查询';
        const hint = (context.responseHint ? context.responseHint+'\n' : '')
          +(visibleRetry ? '此作品连续遇到临时故障，遵守服务等待后自动重试；本轮最多8次临时失败'
            : retrying ? '发生一次临时故障，正在自动恢复；若连续失败将显示重试状态'
            : sourceWait ? '上游数据源处于冷却期；到期后自动继续，不影响已有评分'
            : polling ? '服务器已受理，正在排队或查询；自动更新，无需点击'
            : context.state === 'waiting' ? '服务队列繁忙，正在等待受理；自动继续，无需点击'
            : querying ? '正在查询评分' : '等待查询，优先处理当前可见作品');
        // Detail decisions are results too; do not overwrite them with stale GET progress.
        if (item.data || item.baseData || item.detailMessage) continue;
        if (item.badge.textContent !== label) paint(item,null,label);
        if (item.data || item.detailMessage) continue;
        if (item.badge.title !== hint) item.badge.title = hint;
      }
      if (Number.isFinite(nextProgress)) context.progressTimer = setTimeout(() => paintRequestStates(context),nextProgress);
    }
  }
  function resumeLoads() {
    if (resumeTimer || !cards.deferred.size) return;
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      const priorities = prioritySnapshot([...cards.deferred].map(item=>({context:item})));
      for (const level of [2,1,0.5]) for (const item of cards.deferred) {
        if (!item.card.isConnected) { cards.defer(item,false); continue; }
        if (pending.size >= CARDS_MAX) { pumpRequests(); return; }
        if (item.deferred && item.card.isConnected && priorities.get(item.id) === level) load(item);
      }
    },0);
  }
  function interest(event) {
    const card = event.target.closest?.('a'), item = cards.get(card);
    if (card && event.relatedTarget && card.contains(event.relatedTarget)) return;
    if (!item && !hoverCandidate && !hoverItem && !focusItem) return;
    if (event.type === 'pointerout') {
      if (hoverCandidate === item) { clearTimeout(hoverTimer); hoverCandidate = null; }
      if (hoverItem === item) hoverItem = null;
    } else if (event.type === 'pointerover') {
      clearTimeout(hoverTimer); hoverItem = null; hoverCandidate = item;
      if (item) hoverTimer = setTimeout(() => {
        if (hoverCandidate === item && item.card.isConnected && cards.get(card) === item) {
          hoverItem = item; load(item); pumpRequests();
        }
      },200);
    } else if (event.type === 'focusin') {
      focusItem = item;
      if (item) load(item);
    } else if (focusItem === item) focusItem = null;
    pumpRequests();
  }
  // Persist the whole manual decision atomically, then retire obsolete in-page requests.
  async function saveMapping(item, data) {
    await withIdentityLock(() => {
      importIdentityStorage(item.id);
      const record = readTitleRecord(item.id);
      if (record.invalid || record.epoch >= Number.MAX_SAFE_INTEGER) throw new Error('作品版本异常，人工匹配未保存');
      const id = data?.id;
      writeTitleRecord(item.id,{...record,epoch:record.epoch+1,manual:id || null,automatic:null,detail:null,
        score:data ? {time:Date.now(),mapping:id,data:{...data,source:'manual'}} : null});
      revisions.set(item.id,(revisions.get(item.id) || 0)+1);
      detailRatings.delete(item.id);
    });
    syncIdentity(item.id);
  }
  async function edit(item, correction = false) {
    if (!ratingsToken || halted) { configure(); return; }
    if (editing.has(item.id)) return;
    if (!correction && item.retrying) return;
    if (!correction && item.retryable && !item.detailKey && !item.detailMessage) {
      const key = `${item.id}:${revisions.get(item.id) || 0}`;
      if (pending.has(key) || halted) return;
      settled.delete(key);
      for (const other of cards.forId(item.id)) if (!other.detailKey) {
        other.loaded = false; other.retryable = false; other.retrying = true; other.error = '';
        if (other.card.isConnected) load(other);
      }
      return;
    }
    const input = prompt(`${item.title}\n输入 IMDb tt 编号或完整链接。\n输入 open 打开当前 IMDb；输入 reset 清除作品匹配。`,mappings[item.id] || '');
    if (!input?.trim()) return;
    const query = input.trim();
    if (query === 'open') {
      if (item.data?.id) window.open(`https://www.imdb.com/title/${item.data.id}/`,'_blank','noopener,noreferrer');
      return;
    }
    if (editing.size >= 24) { alert('请先完成已有的匹配操作'); return; }
    editing.add(item.id);
    try {
      let data, id;
      if (query !== 'reset') {
        id = /^tt\d{7,10}$/.test(query) ? query : query.match(/^https:\/\/(?:www\.)?imdb\.com\/title\/(tt\d{7,10})(?:\/|\?|$)/)?.[1];
        if (!id) { alert('请输入 IMDb tt 编号或链接，不支持片名搜索。'); return; }
        data = (await api({i:id})).data;
        if (!confirm(`确认对应关系？\nNetflix：${item.title}\nIMDb：${data.title} · ${id}\n类型：${data.type}；评分：${data.rating || '暂未获取'}`)) return;
      }
      await saveMapping(item,data);
    } catch (error) { lastError = error.message; alert(error.message); }
    finally { editing.delete(item.id); }
  }
  function refreshId(id) {
    for (const item of cards.forId(id)) { item.loaded = false; item.loading = false; item.retryable = false; item.retrying = false; load(item); }
  }
  function updatePosterProximity(item, near) {
    if (item.near === near) return false;
    item.near = near;
    if (near) {
      // Reuse the DOM, not the loaded flag: re-entry must still check TTL and current identity.
      if (retainedPosters.delete(item.card)) item.loaded = false;
      observer.observe(item.card); prefetchObserver.observe(item.card);
    }
    else { observer.unobserve(item.card); prefetchObserver.unobserve(item.card); item.visible = false; item.prefetch = false; }
    return true;
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const item = cards.get(entry.target);
      // A queued old exact-visibility entry cannot reactivate a card that already left the coarse margin.
      if (item) { item.visible = !!item.near && entry.isIntersecting; if (item.visible) load(item); }
    }
    pumpRequests();
  }, {rootMargin:'0px', threshold:0.01});
  const prefetchObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const item = cards.get(entry.target);
      if (!item || item.detail) continue;
      item.prefetch = !!item.near && entry.isIntersecting;
      if (item.prefetch && !item.loaded && !item.loading) load(item);
    }
    pumpRequests();
  }, {rootMargin:'200px 0px', threshold:0.01});
  for (const type of ['pointerover','pointerout','focusin','focusout']) {
    document.addEventListener(type,interest,{passive:true});
  }
  // Discover changed subtrees in bounded turns; never rescan the page for routine mutations.
  const scanRoots = new Set();
  const ownBadges = new WeakSet();
  let scanWalk = null;
  const posterCandidates = new Map(), pendingMounts = new Set(), pendingRetires = new Set();
  const RETAINED_POSTERS_MAX = 192, retainedPosters = new Set();
  let mountTimer = null, cleanupWalk = null, cleanupNeeded = false;
  const discoveryObserver = new IntersectionObserver(entries => {
    // Process only changed intersections. Never disconnect/re-observe the whole page on scroll.
    // Apply the entire visibility batch before recycling; a newly near incumbent must not be evicted.
    let proximityChanged = false;
    for (const entry of entries) {
      const candidate = posterCandidates.get(entry.target);
      if (!candidate) continue;
      candidate.near = entry.isIntersecting;
      const item = cards.get(entry.target);
      if (item) proximityChanged = updatePosterProximity(item,candidate.near) || proximityChanged;
      if (candidate.near) {
        pendingRetires.delete(entry.target);
        if (!item || !entry.target.contains(item.badge)) pendingMounts.add(entry.target);
      } else {
        pendingMounts.delete(entry.target);
        if (item && item !== hoverItem && item !== focusItem) pendingRetires.add(entry.target);
      }
    }
    if (proximityChanged) pumpRequests();
    schedulePosterMount();
  },{rootMargin:'600px 0px',threshold:0});
  function syncDetail(root) {
    const metadata = readDetail(root), previous = cards.get(root);
    if (previous && (!metadata || previous.id !== metadata.id)) {
      previous.row.remove(); cards.delete(root);
    }
    if (!metadata) return;
    let item = cards.get(root);
    if (!item) {
      const row = document.createElement('div'); row.className = 'nli-detail'; ownBadges.add(row);
      const badge = document.createElement('a'); badge.className = 'nli-badge'; badge.tabIndex = 0;
      badge.target = '_blank'; badge.rel = 'noopener noreferrer';
      const doubanLink = document.createElement('a'); doubanLink.className = 'nli-douban-link';
      doubanLink.textContent = '豆瓣'; doubanLink.title = '打开豆瓣条目';
      doubanLink.setAttribute('aria-label','在新标签页打开豆瓣条目');
      doubanLink.target = '_blank'; doubanLink.rel = 'noopener noreferrer'; doubanLink.hidden = true;
      const correction = document.createElement('button'); correction.type = 'button';
      item = {card:root,id:metadata.id,title:metadata.title,badge,doubanLink,correction,row,detail:true,visible:true,loaded:false,loading:false};
      badge.addEventListener('click',event => {
        event.stopPropagation();
        if (!item.data) { event.preventDefault(); if (item.detailKey) detailAction(item); else edit(item); }
      });
      doubanLink.addEventListener('click',event => event.stopPropagation());
      badge.addEventListener('keydown',event => {
        if (!item.data && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); if (item.detailKey) detailAction(item); else edit(item); }
      });
      correction.addEventListener('click',event => { event.preventDefault(); event.stopPropagation(); edit(item,true); });
      row.append(badge,doubanLink,correction); cards.set(root,item); paint(item,null,'IMDb 等待查询');
    }
    item.title = metadata.title;
    if (!item.matchButton) {
      item.matchButton = document.createElement('button'); item.matchButton.type = 'button'; item.matchButton.hidden = true;
      item.matchButton.addEventListener('click',event => { event.preventDefault(); event.stopPropagation(); detailAction(item); });
      item.row.append(item.matchButton);
    }
    const changedMode = item.row.classList.contains('nli-mini') !== metadata.mini;
    item.row.classList.toggle('nli-mini',metadata.mini);
    if (item.row.parentElement !== metadata.mount) metadata.mount.append(item.row);
    if (changedMode && item.data) paint(item,item.data);
    const hints = readHints(root,metadata);
    if (hints && !identityRoute(item.id)) {
      const base = hintKey(item.id,hints);
      if (base !== item.detailBase || (!item.detailBusy && item.detailUntil <= Date.now())) startDetail(item,hints);
    } else {
      if (item.detailKey) { item.detailKey = null; item.detailBase = null; item.detailRun = null; item.loaded = false; }
      item.matchButton.hidden = true; load(item);
    }
  }
  // Scoped observers coalesce text/attribute changes; own UI never schedules another update.
  function scheduleDetails(root) {
    for (const [current,local] of detailRoots) if (!current.isConnected) {
      local.disconnect(); detailRoots.delete(current); dirtyDetails.delete(current);
      cards.get(current)?.row.remove(); cards.delete(current);
    }
    if (root?.isConnected) {
      if (!detailRoots.has(root)) {
        if (detailRoots.size >= 4) return;
        const local = new MutationObserver(records => {
          const removed = records.some(record => record.type === 'childList'
            && [...record.removedNodes].includes(cards.get(root)?.row));
          if (removed || records.some(record => !(record.type === 'attributes' && record.attributeName === 'class' && record.target !== root)
            && !record.target.parentElement?.closest('.nli-detail')
            && !record.target.closest?.('.nli-detail')
            && (record.type !== 'childList' || [...record.addedNodes,...record.removedNodes].some(node => !ownBadges.has(node))))) scheduleDetails(root);
        });
        detailRoots.set(root,local);
        local.observe(root,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['href','alt','class']});
      }
      dirtyDetails.add(root);
    }
    if (detailTimer || !detailRoots.size) return;
    detailTimer = setTimeout(() => {
      detailTimer = null;
      for (const [current,local] of detailRoots) if (!current.isConnected) {
        local.disconnect(); detailRoots.delete(current); dirtyDetails.delete(current);
        cards.get(current)?.row.remove(); cards.delete(current);
      }
      for (const current of dirtyDetails) syncDetail(current);
      dirtyDetails.clear(); updateConnectionUi();
    },50);
  }
  function posterCount() {
    return cards.size - [...detailRoots.keys()].filter(root => cards.get(root)?.detail).length;
  }
  // Keep only stable offscreen scores, oldest departure first. No detached DOM or second data cache.
  function retainPoster(item) {
    if (item.detail || item.near || item.visible || item.loading || !item.data?.rating
      || item.data.source === 'detail' || item.detailKey || item.detailMessage || item.posterSelectable
      || item.retryable || item.error || item.deferred || !item.card.isConnected || !item.card.contains(item.badge)) return false;
    retainedPosters.add(item.card);
    if (retainedPosters.size > RETAINED_POSTERS_MAX) for (const card of retainedPosters) {
      const previous = cards.get(card);
      if (previous && (previous === hoverItem || previous === focusItem || previous.near || previous.visible)) continue;
      retirePoster(card); break;
    }
    return true;
  }
  // Drop script-owned registrations only. Candidate observation survives capacity recycling.
  function retirePoster(card, forget = false) {
    retainedPosters.delete(card);
    const item = cards.get(card);
    if (item && !item.detail) {
      // Virtualization is not cancellation: preserve a live DOM identity for any in-flight/retry context.
      if (!forget) {
        const context = pending.get(`${item.id}:${revisions.get(item.id) || 0}`)?.requestContext;
        if (context) context.parkedCard = card;
      }
      observer.unobserve(card); prefetchObserver.unobserve(card); cards.delete(card);
      item.badge.remove(); card.classList.remove('nli-host','nli-static');
      pumpRequests();
    }
    pendingRetires.delete(card);
    if (forget) {
      discoveryObserver.unobserve(card); posterCandidates.delete(card); pendingMounts.delete(card);
      schedulePosterMount();
    }
  }
  function reservePosterSlot(card) {
    if (posterCount() < CARDS_MAX) return true;
    if (!posterCandidates.get(card)?.near) return false;
    let victim = null;
    for (const item of cards.values()) {
      if (item.detail || item === hoverItem || item === focusItem || item.near || item.visible) continue;
      if (!victim) victim = item;
      if (!item.loading) { victim = item; break; }
    }
    if (!victim) return false;
    const context = pending.get(`${victim.id}:${revisions.get(victim.id) || 0}`)?.requestContext;
    if (context) context.parkedCard = victim.card;
    retirePoster(victim.card);
    return true;
  }
  // Discovery does not read computed styles or attach badges to distant posters.
  function scan(root) {
    const card = root?.closest?.('a');
    if (!card?.isConnected) return;
    const previous = cards.get(card), known = posterCandidates.get(card);
    const img = card.querySelector('img'), href = card.getAttribute('href');
    const id = netflixId(href);
    const title = [card.getAttribute('aria-label'),img?.alt,card.querySelector('.fallback-text')?.textContent,id]
      .map(value => (value || '').trim()).find(Boolean) || '';
    if (!img || !id || !title) {
      if (previous || known) retirePoster(card,true);
      return;
    }
    if (previous && previous.id !== id) retirePoster(card,true);
    let candidate = posterCandidates.get(card);
    if (!candidate) {
      candidate = {id,title,href,near:false}; posterCandidates.set(card,candidate);
      discoveryObserver.observe(card);
    } else { candidate.id = id; candidate.title = title; candidate.href = href; }
    const item = cards.get(card);
    if (item) item.title = title;
    if (candidate.near && (!item || !card.contains(item.badge))) {
      pendingMounts.add(card); schedulePosterMount();
    }
  }
  function mountPoster(card, candidate, position) {
    const existing = cards.get(card);
    if (existing) {
      if (!card.contains(existing.badge)) card.append(existing.badge);
      return true;
    }
    if (!reservePosterSlot(card)) return false;
    const {id,title} = candidate;
    const badge = document.createElement('span'); badge.className = 'nli-badge';
    ownBadges.add(badge);
    // Poster badges start inert; paint() enables interaction only for explicit selection states.
    const item = {card,id,title,badge,near:true,visible:false,loaded:false,loading:false,posterSelectable:false};
    let initial = null;
    try { initial = identityCache(id)?.data || null; }
    catch (error) { lastError = error.message; }
    paint(item,initial,initial ? undefined : 'IMDb 等待查询');
    if (position === 'static') card.classList.add('nli-static');
    card.classList.add('nli-host'); cards.set(card,item); card.append(badge);
    observer.observe(card); prefetchObserver.observe(card);
    return true;
  }
  const POSTER_MOUNT_BATCH_MAX = 72, POSTER_MOUNT_READ_BUDGET_MS = 2, POSTER_MOUNT_TASK_BUDGET_MS = 8;
  function schedulePosterMount() {
    if (mountTimer || (!pendingMounts.size && !pendingRetires.size)) return;
    mountTimer = setTimeout(() => {
      mountTimer = null;
      const batch = [], started = performance.now();
      // Read every style in this small batch before the first class/node write.
      for (const card of pendingMounts) {
        if (batch.length >= POSTER_MOUNT_BATCH_MAX || performance.now()-started >= POSTER_MOUNT_READ_BUDGET_MS) break;
        pendingMounts.delete(card);
        const candidate = posterCandidates.get(card);
        if (!card.isConnected) { cleanupNeeded = true; queueScan(null); continue; }
        if (!candidate?.near) continue;
        if (card.getAttribute('href') !== candidate.href || !card.querySelector('img')) { queueScan(card); continue; }
        batch.push({card,candidate,position:cards.has(card) ? null : getComputedStyle(card).position});
      }
      let progressed = false, blocked = false;
      // Delay removals until after style reads; inserts/removals share this bounded write phase.
      let retired = 0;
      for (const card of pendingRetires) {
        if (retired && performance.now()-started >= POSTER_MOUNT_TASK_BUDGET_MS) break;
        pendingRetires.delete(card);
        const item = cards.get(card);
        if (item && !posterCandidates.get(card)?.near && item !== hoverItem && item !== focusItem) {
          if (!retainPoster(item)) retirePoster(card);
          retired++;
        }
      }
      for (let index=0; index<batch.length; index++) {
        const {card,candidate,position} = batch[index];
        // Bound the complete mount turn, not only the style-read phase. Unused reads are safely discarded.
        if ((index || retired) && performance.now()-started >= POSTER_MOUNT_TASK_BUDGET_MS) {
          for (let rest=index; rest<batch.length; rest++) pendingMounts.add(batch[rest].card);
          break;
        }
        if (mountPoster(card,candidate,position)) progressed = true;
        else { pendingMounts.add(card); blocked = true; }
      }
      // Full registries sleep until an intersection/removal frees a slot, rather than spinning.
      if (pendingRetires.size || (pendingMounts.size && (!blocked || progressed))) schedulePosterMount();
      updateConnectionUi();
    },0);
  }
  function queueScan(root) {
    if (root?.nodeType === 1 && root.isConnected && !ownBadges.has(root)) {
      // Coalesce nested pending roots and cap retained DOM references during mutation storms.
      let covered = false;
      for (const pendingRoot of scanRoots) {
        if (pendingRoot.contains(root)) { covered = true; break; }
      }
      if (!covered) {
        for (const pendingRoot of scanRoots) if (root.contains(pendingRoot)) scanRoots.delete(pendingRoot);
        scanRoots.add(root);
        if (scanRoots.size > 100) { scanRoots.clear(); scanRoots.add(document.body); }
      }
    }
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      const started = performance.now(), seen = new Set();
      if (cleanupNeeded && !cleanupWalk) { cleanupWalk = posterCandidates.keys(); cleanupNeeded = false; }
      let visited = 0;
      while (visited < 100 && performance.now()-started < 4) {
        if (cleanupWalk) {
          const next = cleanupWalk.next();
          if (next.done) { cleanupWalk = null; schedulePosterMount(); continue; }
          visited++;
          if (!next.value.isConnected) retirePoster(next.value,true);
          continue;
        }
        if (scanWalk && !scanWalk.root.isConnected) scanWalk = null;
        if (!scanWalk) {
          const nextRoot = scanRoots.values().next().value;
          if (!nextRoot) break;
          scanRoots.delete(nextRoot);
          if (!nextRoot.isConnected) continue;
          // Let the browser filter candidates natively instead of invoking JS for every decorative descendant.
          scanWalk = {root:nextRoot,nodes:nextRoot.querySelectorAll('a, .previewModal--container'),index:0,first:true};
        }
        const first = scanWalk.first;
        const node = first ? scanWalk.root : scanWalk.nodes[scanWalk.index++];
        scanWalk.first = false;
        if (!node) { scanWalk = null; continue; }
        visited++;
        if (!node.isConnected || !scanWalk.root.contains(node) || ownBadges.has(node) || node.closest('.nli-badge,.nli-detail')) continue;
        if (node.classList.contains('previewModal--container')) scheduleDetails(node);
        const card = node.localName === 'a' ? node : first ? node.closest('a') : null;
        if (card && !seen.has(card)) { seen.add(card); scan(card); }
      }
      if (scanWalk || scanRoots.size || cleanupWalk || cleanupNeeded) queueScan(null);
      updateConnectionUi();
    },16);
  }
  function mutations(records) {
    let cleanup = false;
    for (const record of records) {
      if (record.target.closest?.('.nli-badge,.nli-detail')) continue;
      const card = record.target.closest?.('a');
      if (record.type === 'attributes') {
        if (card) queueScan(card);
        continue;
      }
      for (const node of record.addedNodes) {
        if (ownBadges.has(node)) continue;
        if (card) queueScan(card);
        else if (node.nodeType === 1) queueScan(node);
      }
      for (const node of record.removedNodes) {
        if (ownBadges.has(node)) {
          // Obsolete badges removed by scan are ignored; externally removed live badges are repaired.
          if (card && cards.get(card)?.badge === node && !card.contains(node)) queueScan(card);
          continue;
        }
        if (node.nodeType === 1) cleanup = true;
        if (card) queueScan(card);
      }
    }
    if (cleanup) { cleanupNeeded = true; queueScan(null); scheduleDetails(null); }
  }
  window.addEventListener('popstate',() => { for (const root of detailRoots.keys()) scheduleDetails(root); });
  new MutationObserver(mutations).observe(document.body,{
    childList:true,subtree:true,attributes:true,attributeFilter:['href','aria-label','alt']
  });

  document.addEventListener('visibilitychange',() => { updateConnectionUi(); if (!document.hidden) { clearTimeout(authorityTimer); authorityTimer = null; wakeAuthorityChecks(); pumpRequests(); } });
  window.addEventListener('pageshow',() => { updateConnectionUi(); clearTimeout(authorityTimer); authorityTimer = null; wakeAuthorityChecks(); pumpRequests(); });
  installConnectionListeners();
  if (!ratingsToken) initConnectionUi();
  wakeAuthorityChecks();
  GM_registerMenuCommand('连接 / 设置评分服务 Token',configure);
  GM_registerMenuCommand('查看运行状态',() => alert(`IMDb · 本页${requests}次请求\n${networkState()}\n历史错误：${lastError || '无'}`));
  GM_registerMenuCommand('重试失败查询',() => location.reload());
  GM_registerMenuCommand('查看最近错误详情',() => alert(`${networkState()}\n${diagnostic || '本页无服务请求错误'}`));
  GM_registerMenuCommand('清空评分缓存（保留作品匹配）',async () => { try { await clearScoreCachePreservingMappings(); location.reload(); } catch (error) { alert(error.message); } });
  refreshDetailRatings();
  queueScan(document.body);
})();
