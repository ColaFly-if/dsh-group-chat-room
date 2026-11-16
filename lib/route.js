// 路由与对话编排。每次代码变更后由 index.js 重新加载，所以改这个文件不用重启 DSH。
import fs from 'node:fs';
import path from 'node:path';

export function createRouter({ core, pluginDir }) {
  const HTML_FILE = path.join(pluginDir, 'web', 'index.html');

  function sseInit(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    return {
      send(o) { try { res.write('data: ' + JSON.stringify(o) + '\n\n'); } catch {} },
      end() { try { res.write('data: {"type":"done"}\n\n'); res.end(); } catch {} },
    };
  }

  function writeJson(res, code, obj) {
    try {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    } catch {}
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
      req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
      req.on('error', reject);
    });
  }

  // 宿主 meme 服务的目录：同源代理 + 5 分钟缓存（拿不到就给空，不影响群聊）
  let stickerCache = { at: 0, data: null };
  async function loadStickers(req) {
    const now = Date.now();
    if (stickerCache.data && now - stickerCache.at < 300000) return stickerCache.data;
    const host = (req && req.headers && req.headers.host) || "127.0.0.1";
    try {
      const r = await fetch("http://" + host + "/api/memes/catalog", { signal: AbortSignal.timeout(4000) });
      if (!r.ok) throw new Error("catalog " + r.status);
      const j = await r.json();
      stickerCache = { at: now, data: j };
      return j;
    } catch {
      return stickerCache.data || { packs: [] };
    }
  }

  // 返回 { order, addressed, broadcast }
  // addressed: 有人被点名，只有被点到的开口，且不需要「我觉得」缓冲
  // broadcast: 「你们聊会儿」之类，全员两轮
  // 其它情况：全员都有资格，但各自随机，没必要每次都齐刷刷回答
  function pickOrder(text, roster) {
    if (!roster.length) return { order: [], addressed: false, broadcast: false };
    const t = text || '';
    const mentioned = roster.filter((p) => p.name && t.indexOf(p.name) >= 0);
    if (mentioned.length) return { order: mentioned.map((p) => p.id), addressed: true, broadcast: false };
    if (/你们聊|你们几个聊|互相聊|接着聊|聊会儿|你俩聊/.test(t)) {
      const seq = roster.map((p) => p.id);
      return { order: seq.concat(seq), addressed: false, broadcast: true };
    }
    return { order: roster.map((p) => p.id), addressed: false, broadcast: false };
  }

  // 没被点名时的参与概率：不是每次都回答，但也不会整群哑掉
  const VOLUNTEER_RATE = 0.55;
  function thinOut(order) {
    if (order.length <= 1) return order;
    const keep = order.filter(() => Math.random() < VOLUNTEER_RATE);
    if (keep.length) return keep;
    return [order[Math.floor(Math.random() * order.length)]];
  }

  async function speak(groupId, p, roster, sse, opts) {
    const hist = core.histOf(groupId);
    sse.send({ type: 'typing', who: p.id, on: true });
    let acc = '', decided = false, skip = false;

    function push(t) {
      acc += t;
      if (decided) { if (!skip) sse.send({ type: 'delta', who: p.id, text: t }); return; }
      const s = acc.trimStart();
      if (s.length === 0) return;
      if (s.length < 6 && '<SKIP>'.startsWith(s)) return;
      if (s.indexOf('<SKIP') === 0) { decided = true; skip = true; return; }
      decided = true;
      sse.send({ type: 'msg_start', who: p.id });
      sse.send({ type: 'delta', who: p.id, text: acc });
    }

    const ginfo = core.getGroup(groupId);
    const stickers = (opts && opts.stickers) || null;
    const quiet = !!(opts && opts.quiet);
    let full = '';
    try {
      full = await core.streamChat(p, roster, hist, push, { name: ginfo && ginfo.name, desc: ginfo && ginfo.desc, addressed: !!(opts && opts.addressed), stickers, force: !!(opts && opts.force) });
    } catch (e) {
      sse.send({ type: 'typing', who: p.id, on: false });
      sse.send({ type: 'error', who: p.id, text: String((e && e.message) || e) });
      return null;
    }

    if (!decided) {
      const s = acc.trim();
      if (s.length === 0 || s.indexOf('<SKIP') === 0) skip = true;
      else { decided = true; sse.send({ type: 'msg_start', who: p.id }); sse.send({ type: 'delta', who: p.id, text: acc }); }
    }
    sse.send({ type: 'typing', who: p.id, on: false });
    if (skip) { if (!quiet) sse.send({ type: 'skipped', who: p.id }); return null; }

    let text = full.replace(/<SKIP>/g, '').trim();
    text = text.replace(/^[^\s:：]{1,12}\s*[:：]\s*/, '').trim();
    text = text.replace(/\*\*/g, '').replace(/^#+\s*/gm, '').trim();
    // 模型想发表情时会给一行 [STICKER:st_xxx]，剥出来单独存
    let sticker = null;
    const sm = text.match(/\[\s*STICKER\s*[:：]\s*(st_[0-9a-f]{6,})\s*\]/i);
    if (sm) {
      sticker = sm[1].toLowerCase();
      text = text.replace(sm[0], "").replace(/\n{2,}/g, "\n").trim();
    }
    if (!text && !sticker) { if (!quiet) sse.send({ type: "skipped", who: p.id }); return null; }

    const msg = { who: p.id, text: text, ts: Date.now() };
    if (sticker) { msg.sticker = sticker; const sn = stickerNameOf(stickers, sticker); if (sn) msg.stickerName = sn; }
    hist.push(msg);
    core.saveHist(groupId);
    sse.send({ type: 'msg_end', who: p.id, text: text, sticker: msg.sticker || null, ts: msg.ts });
    return msg;
  }

  function stickerNameOf(catalog, id) {
    const packs = (catalog && Array.isArray(catalog.packs)) ? catalog.packs : [];
    for (const pack of packs) {
      for (const s of (pack && pack.stickers) || []) {
        if (s && s.id === id) return s.name || "";
      }
    }
    return "";
  }

  function memberMap(roster) {
    const m = {};
    for (const p of roster) m[p.id] = { name: p.name, avatar: p.avatar, color: p.color };
    return m;
  }

  function serveHtml(res) {
    try {
      const html = fs.readFileSync(HTML_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('group-chat page missing: ' + HTML_FILE);
    }
  }

  let busy = false;

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://dsh.internal');
    const p = url.pathname;

    if (p === '/groupchat') { res.writeHead(302, { Location: '/groupchat/' }); return res.end(); }
    if (p === '/groupchat/' || p === '/groupchat/index.html') return serveHtml(res);

    // 版本信息：前端可用来确认加载的是哪份后端
    if (p === '/groupchat/api/ping') {
      return writeJson(res, 200, {
        ok: true,
        version: core.version,
        dataDir: core.dataDir,
        group: (function () { const g = core.getGroup(null); return g ? { id: g.id, name: g.name } : null; })(),
        roster: core.rosterOf(null).map((x) => x.name),
        routes: ['state','discover','browse','workspaces','groups','history','reset','say','prompt'],
      });
    }

    // 看某个成员此刻的 system prompt 长什么样
    if (p === '/groupchat/api/prompt') {
      const gid = url.searchParams.get('g') || null;
      const g = core.getGroup(gid);
      const roster = core.rosterOf(gid);
      const who = url.searchParams.get('who');
      const target = roster.find((x) => x.id === who) || roster[0];
      if (!target) return writeJson(res, 404, { error: '这个群还没有成员' });
      return writeJson(res, 200, {
        group: g ? { id: g.id, name: g.name, desc: g.desc || '' } : null,
        member: { id: target.id, name: target.name, soul: target.soul },
        roster: roster.map((x) => x.name),
        prompt: core.promptOf(target, roster, g),
      });
    }

    // 人格库（bots）：扫到的人格 + 用户改动
    if (p === '/groupchat/api/bots' && req.method !== 'POST') {
      const cfg = core.getConfig();
      const all = core.discover(cfg.workspaces);
      const g = core.getGroup(url.searchParams.get('g'));
      const members = new Set(g ? g.members : []);
      const bots = all.map((x) => {
        const ov = core.botOf(x.id);
        return {
          id: x.id,
          name: x.name,
          alias: ov.alias || '',
          avatar: ov.avatar || '',
          desc: ov.desc || '',
          enabled: ov.enabled !== false,
          skills: Array.isArray(ov.skills) ? ov.skills : [],
          workspace: x.workspace,
          soul: x.soul,
          excerpt: x.excerpt,
          inGroup: members.has(x.id),
        };
      });
      return writeJson(res, 200, { bots: bots, skills: core.scanSkills(cfg.workspaces) });
    }

    if (p === '/groupchat/api/bots' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch { return writeJson(res, 400, { error: 'bad json' }); }
      const id = String(body.id || '');
      if (!id) return writeJson(res, 400, { error: 'id required' });
      const saved = core.patchBot(id, body.patch && typeof body.patch === 'object' ? body.patch : {});
      return writeJson(res, 200, { ok: true, bot: saved });
    }

    if (p === '/groupchat/api/browse') {
      const target = url.searchParams.get('path') || '';
      return writeJson(res, 200, core.browseDir(target));
    }

    if (p === "/groupchat/api/stickers") {
      const cat = await loadStickers(req);
      return writeJson(res, 200, cat);
    }

    // 按描述生成群 / 成员：写 SOUL_*.md，必要时建群
    if (p === "/groupchat/api/forge" && req.method === "POST") {
      let body;
      try { body = await readBody(req); } catch { return writeJson(res, 400, { error: "bad json" }); }
      try {
        const out = await core.forge(body);
        return writeJson(res, 200, out);
      } catch (e) {
        return writeJson(res, 500, { error: String((e && e.message) || e) });
      }
    }

    if (p === '/groupchat/api/state') {
      const cfg = core.getConfig();
      const roster = core.rosterOf(cfg.active);
      return writeJson(res, 200, {
        model: core.MODEL,
        groups: core.listGroups(),
        active: cfg.active,
        group: (function () {
          const g = cfg.groups.find((x) => x.id === cfg.active);
          return g ? { id: g.id, name: g.name, desc: g.desc || '', members: g.members } : null;
        })(),
        roster: roster.map((x) => ({ id: x.id, name: x.name })),
        members: memberMap(roster),
      });
    }

    if (p === '/groupchat/api/discover') {
      const cfg = core.getConfig();
      const personas = core.discover(cfg.workspaces);
      const g = core.getGroup(url.searchParams.get('g'));
      return writeJson(res, 200, {
        workspaces: cfg.workspaces,
        status: core.workspaceStatus(cfg.workspaces),
        defaultRoot: core.DEFAULT_WS_ROOT,
        personas: personas,
        selected: g ? g.members : [],
        group: g ? { id: g.id, name: g.name } : null,
        groups: core.listGroups(),
      });
    }

    if (p === '/groupchat/api/workspaces' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch { return writeJson(res, 400, { error: 'bad json' }); }
      const cfg = core.getConfig();
      let list;
      if (Array.isArray(body.workspaces)) list = core.normalizeWorkspaces(body.workspaces);
      else if (typeof body.text === 'string') list = core.normalizeWorkspaces(cfg.workspaces.concat(core.splitPaths(body.text)));
      else if (Array.isArray(body.add)) list = core.normalizeWorkspaces(cfg.workspaces.concat(body.add));
      else list = cfg.workspaces;
      cfg.workspaces = list;
      core.saveConfig();
      return writeJson(res, 200, {
        ok: true,
        workspaces: cfg.workspaces,
        status: core.workspaceStatus(cfg.workspaces),
        personas: core.discover(cfg.workspaces),
      });
    }

    if (p === '/groupchat/api/groups' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch { return writeJson(res, 400, { error: 'bad json' }); }
      const action = String(body.action || '');
      if (action === 'create') {
        const g = core.createGroup(body.name, body.members);
        return writeJson(res, 200, { ok: true, group: { id: g.id, name: g.name }, groups: core.listGroups() });
      }
      if (action === 'update') {
        const g = core.updateGroup(String(body.id || ''), { name: body.name, desc: body.desc, members: body.members });
        return writeJson(res, g ? 200 : 404, g ? { ok: true, group: { id: g.id, name: g.name }, groups: core.listGroups() } : { error: 'group not found' });
      }
      if (action === 'delete') {
        const ok = core.deleteGroup(String(body.id || ''));
        return writeJson(res, ok ? 200 : 404, { ok: ok, groups: core.listGroups(), active: core.getConfig().active });
      }
      if (action === 'activate') {
        const ok = core.setActive(String(body.id || ''));
        return writeJson(res, ok ? 200 : 404, { ok: ok, active: core.getConfig().active });
      }
      return writeJson(res, 400, { error: 'unknown action' });
    }

    if (p === '/groupchat/api/history') {
      const gid = url.searchParams.get('g') || core.getConfig().active;
      return writeJson(res, 200, { history: core.histOf(gid).slice(-200), group: gid });
    }

    if (p === '/groupchat/api/reset' && req.method === 'POST') {
      const gid = url.searchParams.get('g') || core.getConfig().active;
      core.resetHist(gid);
      return writeJson(res, 200, { ok: true });
    }

    if (p === '/groupchat/api/say' && req.method === 'POST') {
      if (busy) return writeJson(res, 429, { error: 'busy' });
      let body;
      try { body = await readBody(req); } catch { return writeJson(res, 400, { error: 'bad json' }); }
      const stickerId = String(body.sticker || "").trim();
      const text = String(body.text || "").trim();
      if (!text && !stickerId) return writeJson(res, 400, { error: "empty" });
      const catalog = await loadStickers(req);
      const onlySticker = !text && !!stickerId;

      const gid = String(body.group || url.searchParams.get('g') || core.getConfig().active);
      const roster = core.rosterOf(gid);
      if (!roster.length) return writeJson(res, 409, { error: '这个群还没选成员' });

      busy = true;
      const sse = sseInit(res);
      req.on('close', () => { busy = false; });
      try {
        const hist = core.histOf(gid);
        const userMsg = { who: 'user', text: text, ts: Date.now() };
        if (stickerId) { userMsg.sticker = stickerId; const sn = stickerNameOf(catalog, stickerId); if (sn) userMsg.stickerName = sn; }
        hist.push(userMsg);
        core.saveHist(gid);
        sse.send({ type: 'user_msg', who: 'user', text: text, sticker: stickerId || null, ts: userMsg.ts });
        const pick = pickOrder(text, roster);
        let order;
        if (onlySticker) {
          // 只发表情时：全员随机排队，谁先接住算谁的（只挑 1~2 人，一旦都 SKIP 用户就看到空白）
          const ids = roster.map((x) => x.id);
          for (let i = ids.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            const t = ids[i]; ids[i] = ids[j]; ids[j] = t;
          }
          order = ids;
        } else {
          order = (pick.addressed || pick.broadcast) ? pick.order : thinOut(pick.order);
        }
        let spoke = 0;
        for (const id of order) {
          if (res.writableEnded) break;
          const p2 = roster.find((x) => x.id === id);
          if (!p2) continue;
          const m = await speak(gid, p2, roster, sse, { addressed: onlySticker || pick.addressed, stickers: catalog, quiet: onlySticker });
          if (m) spoke += 1;
          if (onlySticker && spoke >= 2) break;
        }
        // 全员都想跳过：表情不能石沉大海，强制一个人接一句
        if (!spoke && onlySticker) {
          const p2 = roster.find((x) => x.id === order[0]) || roster[0];
          if (p2 && !res.writableEnded) {
            await speak(gid, p2, roster, sse, { addressed: true, stickers: catalog, force: true, quiet: true });
          }
        }
      } catch (e) {
        sse.send({ type: 'error', who: 'system', text: String((e && e.message) || e) });
      } finally {
        busy = false;
        sse.end();
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }

  return handle;
}
