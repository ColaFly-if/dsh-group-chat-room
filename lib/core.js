// 群聊内核：人格发现 / 配置 / 历史 / 模型调用。不含 HTTP。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

export const DEFAULT_WS_ROOT = process.env.GROUPCHAT_WS_ROOT || os.homedir();
export const MODEL = process.env.CHAT_MODEL || 'deepseek-flash';
export const VERSION = '2026-11-15.1';
const API = 'https://api.deepseek.com/chat/completions';
const HTTP_TIMEOUT_MS = 120000;
const MAX_SCAN_DEPTH = 4;
const AVATARS = ['🐳','🎹','🦊','🐱','🌙','🍀','⭐','🔥','🌊','🎧','🧋','🕯️','🎐','🪐','🐧','🌵'];
const COLORS  = ['#4a9eff','#c78bf0','#f0a35e','#5fd0a0','#e5707e','#8f9bf0','#d4b15e','#5ec8d0'];

export function defaultDataDir() {
  if (process.env.GROUPCHAT_DATA_DIR) return process.env.GROUPCHAT_DATA_DIR;
  return path.join(os.homedir(), '.dsh', 'group-chat');
}

export function createCore({ pluginDir, credPath, dataDir }) {
  const DATA_DIR = dataDir || defaultDataDir();
  const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
  const HIST_DIR = path.join(DATA_DIR, 'history');
  const BOTS_FILE = path.join(DATA_DIR, 'bots.json');

  // 老版本把数据存在插件目录里，这里搬一次
  (function migrateLegacy() {
    const legacy = path.join(pluginDir, 'data');
    if (legacy === DATA_DIR) return;
    try {
      if (!fs.existsSync(legacy)) return;
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const cfgOld = path.join(legacy, 'config.json');
      if (fs.existsSync(cfgOld) && !fs.existsSync(CONFIG_FILE)) {
        fs.copyFileSync(cfgOld, CONFIG_FILE);
      }
      const histOld = path.join(legacy, 'history');
      if (fs.existsSync(histOld)) {
        fs.mkdirSync(HIST_DIR, { recursive: true });
        for (const f of fs.readdirSync(histOld)) {
          const to = path.join(HIST_DIR, f);
          if (!fs.existsSync(to)) {
            try { fs.copyFileSync(path.join(histOld, f), to); } catch {}
          }
        }
      }
      const flat = path.join(legacy, 'history.json');
      if (fs.existsSync(flat)) {
        try {
          const raw = JSON.parse(fs.readFileSync(flat, 'utf8'));
          const g = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
          const first = g && Array.isArray(g.groups) && g.groups[0] ? g.groups[0].id : null;
          if (first && Array.isArray(raw)) {
            const to = path.join(HIST_DIR, first + '.json');
            if (!fs.existsSync(to)) fs.writeFileSync(to, JSON.stringify(raw, null, 1), 'utf8');
          }
        } catch {}
      }
    } catch (e) {
      console.error('[dsh-group-chat-room] 迁移旧数据失败（忽略）:', e && e.message);
    }
  })();
  const CRED = credPath || path.join(os.homedir(), '.dsh', '.credentials.yaml');

  // ---------- 工作区 / 人格 ----------
  function listWorkspaceDirs(root) {
    const out = [];
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        out.push(path.join(root, e.name));
      }
    } catch {}
    return out;
  }

  function findSouls(root) {
    const out = [];
    (function walk(p, d) {
      if (d > MAX_SCAN_DEPTH) return;
      let ents = [];
      try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const fp = path.join(p, e.name);
        if (e.isDirectory()) walk(fp, d + 1);
        else if (/^SOUL_.*\.md$/i.test(e.name)) out.push(fp);
      }
    })(root, 0);
    return out;
  }

  function personaNameFromFile(file) {
    let txt = '';
    try { txt = fs.readFileSync(file, 'utf8').slice(0, 5000); } catch {}
    const m = txt.match(/^#\s+(.+)$/m);
    if (m) {
      const n = m[1].replace(/[（(][^）)]*[）)]/g, '').split(/[—–\-|、,，]/)[0].trim();
      if (n) return n;
    }
    return path.basename(path.dirname(path.dirname(file))) || '未命名';
  }

  function personaExcerpt(file) {
    try {
      const t = fs.readFileSync(file, 'utf8');
      const body = t.replace(/^---[\s\S]*?---/, '').replace(/^#.*$/m, '').replace(/\s+/g, ' ').trim();
      return body.slice(0, 90);
    } catch { return ''; }
  }

  function idOf(file) {
    return crypto.createHash('sha1').update(file.toLowerCase()).digest('hex').slice(0, 10);
  }

  function discover(workspaces) {
    const list = [];
    const seen = new Set();
    for (const ws of workspaces || []) {
      if (typeof ws !== 'string' || !ws) continue;
      for (const soul of findSouls(ws)) {
        const key = soul.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({
          id: idOf(soul),
          name: personaNameFromFile(soul),
          soul: soul,
          workspace: path.basename(ws),
          workspacePath: ws,
          excerpt: personaExcerpt(soul),
        });
      }
    }
    return list;
  }

  // ---------- 工作区批量处理 ----------
  // 输入可以是一段黏在一起的文本：换行、分号、逗号、竖线都算分隔。
  function splitPaths(input) {
    return String(input == null ? '' : input)
      .split(/[\r\n;；,，|]+/)
      .map((s) => s.trim().replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, '').trim())
      .filter(Boolean);
  }

  function normalizeWorkspaces(list) {
    const out = [];
    const seen = new Set();
    for (const raw of list || []) {
      for (const p of splitPaths(raw)) {
        const key = p.toLowerCase().replace(/[\\/]+$/, '');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(p.replace(/[\\/]+$/, ''));
      }
    }
    return out;
  }

  function workspaceStatus(workspaces) {
    return (workspaces || []).map((w) => {
      let exists = false;
      let personas = 0;
      try {
        exists = fs.statSync(w).isDirectory();
        if (exists) personas = findSouls(w).length;
      } catch {}
      return { path: w, exists: exists, personas: personas };
    });
  }

  // ---------- 目录浏览 ----------
  function drives() {
    const out = [];
    for (let i = 65; i <= 90; i++) {
      const letter = String.fromCharCode(i);
      const p = letter + ':\\';
      try { if (fs.statSync(p).isDirectory()) out.push({ name: letter + ':', path: p }); } catch {}
    }
    return out;
  }

  // 浅扫：只看到两层，用来在目录浏览器里标记"这里有人格"
  function shallowPersonaCount(dir, depth) {
    let n = 0;
    const max = depth == null ? 2 : depth;
    (function walk(p, d) {
      if (d > max) return;
      let ents = [];
      try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        if (e.isDirectory()) walk(path.join(p, e.name), d + 1);
        else if (/^SOUL_.*\.md$/i.test(e.name)) n++;
      }
    })(dir, 0);
    return n;
  }

  function browseDir(target) {
    const p = String(target || '').trim();
    if (!p) {
      return { path: '', parent: null, dirs: drives(), atDrives: true };
    }
    let norm;
    try { norm = path.resolve(p); } catch { return { error: '路径不合法', path: p }; }
    let ents = [];
    try { ents = fs.readdirSync(norm, { withFileTypes: true }); }
    catch (e) { return { error: '打不开这个目录', path: norm }; }

    const dirs = [];
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules') continue;
      const full = path.join(norm, e.name);
      dirs.push({
        name: e.name,
        path: full,
        hidden: e.name.startsWith('.'),
        personas: shallowPersonaCount(full, 2),
      });
    }
    dirs.sort((a, b) => {
      if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    const parent = path.dirname(norm);
    return {
      path: norm,
      parent: parent === norm ? '' : parent,
      dirs: dirs,
      atDrives: false,
      selfPersonas: shallowPersonaCount(norm, 2),
    };
  }

  // ---------- 人格库（bots） ----------
  // 扫出来的人格是"原始 bot"，bots.json 里存用户改动：别名、头像、简介、启用、挂的技能。
  let bots = null;
  function loadBots() {
    if (bots) return bots;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8')); } catch {}
    bots = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return bots;
  }
  function saveBots() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(BOTS_FILE, JSON.stringify(loadBots(), null, 2), 'utf8');
    } catch {}
  }
  function botOf(id) {
    const b = loadBots()[id];
    return b && typeof b === 'object' ? b : {};
  }
  function patchBot(id, patch) {
    if (!id) return null;
    const all = loadBots();
    const cur = Object.assign({}, all[id] || {});
    if (typeof patch.alias === 'string') cur.alias = patch.alias.trim().slice(0, 24);
    if (typeof patch.avatar === 'string') cur.avatar = patch.avatar.trim().slice(0, 8);
    if (typeof patch.desc === 'string') cur.desc = patch.desc.trim().slice(0, 200);
    if (typeof patch.enabled === 'boolean') cur.enabled = patch.enabled;
    if (Array.isArray(patch.skills)) cur.skills = patch.skills.filter((x) => typeof x === 'string').slice(0, 12);
    all[id] = cur;
    saveBots();
    return cur;
  }

  // ---------- 技能 ----------
  function scanSkills(workspaces) {
    const out = [];
    const seen = new Set();
    const roots = [];
    for (const ws of workspaces || []) {
      if (typeof ws === 'string' && ws) roots.push(path.join(ws, '.dsh', 'skills'));
    }
    roots.push(path.join(os.homedir(), '.dsh', 'skills'));
    for (const root of roots) {
      let ents = [];
      try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (!e.isDirectory()) continue;
        const file = path.join(root, e.name, 'SKILL.md');
        if (!fs.existsSync(file)) continue;
        let body = '';
        try { body = fs.readFileSync(file, 'utf8'); } catch { continue; }
        const name = (body.match(/^name:\s*(.+)$/m) || [])[1] || e.name;
        const desc = (body.match(/^description:\s*(.+)$/m) || [])[1] || '';
        const key = name.trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: name.trim(),
          dir: e.name,
          desc: desc.replace(/^["']|["']$/g, '').slice(0, 160),
          file: file,
          from: path.basename(path.dirname(path.dirname(root))),
        });
      }
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  // ---------- 配置 ----------
  let config = null;

  function newGroupId() {
    return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  }

  function loadConfig() {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
    const workspaces = raw && Array.isArray(raw.workspaces) && raw.workspaces.length
      ? raw.workspaces
      : listWorkspaceDirs(DEFAULT_WS_ROOT);

    let groups = [];
    if (raw && Array.isArray(raw.groups) && raw.groups.length) {
      groups = raw.groups
        .filter((g) => g && g.id)
        .map((g) => ({
          id: g.id,
          name: String(g.name || '未命名群'),
          desc: typeof g.desc === 'string' ? g.desc : '',
          members: Array.isArray(g.members) ? g.members.filter((x) => typeof x === 'string') : [],
        }));
    }
    if (!groups.length) {
      const all = discover(workspaces);
      groups = [{ id: newGroupId(), name: '主群', desc: '', members: all.map((p) => p.id), createdAt: Date.now() }];
    }
    const active = raw && typeof raw.active === 'string' && groups.some((g) => g.id === raw.active)
      ? raw.active
      : groups[0].id;
    return { workspaces, groups, active };
  }

  function getConfig() {
    if (!config) config = loadConfig();
    return config;
  }

  function saveConfig() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(getConfig(), null, 2), 'utf8');
    } catch {}
  }

  // ---------- 群 ----------
  function listGroups() {
    const cfg = getConfig();
    return cfg.groups.map((g) => {
      let messages = 0;
      let lastTs = 0;
      try {
        const h = histOf(g.id);
        messages = h.length;
        for (let i = h.length - 1; i >= 0; i--) {
          if (h[i] && typeof h[i].ts === 'number') { lastTs = h[i].ts; break; }
        }
      } catch {}
      return {
        id: g.id,
        name: g.name,
        desc: g.desc || '',
        members: g.members.length,
        messages: messages,
        lastTs: lastTs,
        createdAt: g.createdAt || 0,
        active: g.id === cfg.active,
      };
    });
  }

  function getGroup(id) {
    const cfg = getConfig();
    return cfg.groups.find((g) => g.id === (id || cfg.active)) || null;
  }

  function createGroup(name, memberIds) {
    const cfg = getConfig();
    const g = { id: newGroupId(), name: String(name || '新群').slice(0, 40), desc: '', members: Array.isArray(memberIds) ? memberIds : [], createdAt: Date.now() };
    cfg.groups.push(g);
    cfg.active = g.id;
    saveConfig();
    return g;
  }

  function updateGroup(id, patch) {
    const cfg = getConfig();
    const g = cfg.groups.find((x) => x.id === id);
    if (!g) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) g.name = patch.name.trim().slice(0, 40);
    if (typeof patch.desc === 'string') g.desc = patch.desc.trim().slice(0, 200);
    if (Array.isArray(patch.members)) {
      const valid = new Set(discover(cfg.workspaces).map((p) => p.id));
      g.members = patch.members.filter((x) => valid.has(x));
    }
    saveConfig();
    return g;
  }

  function deleteGroup(id) {
    const cfg = getConfig();
    const i = cfg.groups.findIndex((x) => x.id === id);
    if (i < 0) return false;
    cfg.groups.splice(i, 1);
    try { fs.unlinkSync(path.join(HIST_DIR, id + '.json')); } catch {}
    histCache.delete(id);
    if (!cfg.groups.length) {
      cfg.groups.push({ id: newGroupId(), name: '主群', desc: '', members: [], createdAt: Date.now() });
    }
    if (!cfg.groups.some((g) => g.id === cfg.active)) cfg.active = cfg.groups[0].id;
    saveConfig();
    return true;
  }

  function setActive(id) {
    const cfg = getConfig();
    if (!cfg.groups.some((g) => g.id === id)) return false;
    cfg.active = id;
    saveConfig();
    return true;
  }

  // ---------- 群成员 ----------
  function rosterOf(groupId) {
    const g = getGroup(groupId);
    if (!g) return [];
    const all = discover(getConfig().workspaces);
    const byId = new Map(all.map((p) => [p.id, p]));
    const out = [];
    g.members.forEach((id, i) => {
      const p = byId.get(id);
      if (!p) return;
      const ov = botOf(id);
      if (ov.enabled === false) return; // 停用的人格不发言
      out.push(Object.assign({}, p, {
        name: (ov.alias && ov.alias.trim()) || p.name,
        avatar: (ov.avatar && ov.avatar.trim()) || AVATARS[i % AVATARS.length],
        color: COLORS[i % COLORS.length],
        desc: ov.desc || '',
        skills: Array.isArray(ov.skills) ? ov.skills : [],
      }));
    });
    return out;
  }

  // ---------- 历史 ----------
  const histCache = new Map();
  function histOf(groupId) {
    if (histCache.has(groupId)) return histCache.get(groupId);
    let h = [];
    try { h = JSON.parse(fs.readFileSync(path.join(HIST_DIR, groupId + '.json'), 'utf8')); } catch { h = []; }
    if (!Array.isArray(h)) h = [];
    histCache.set(groupId, h);
    return h;
  }
  function saveHist(groupId) {
    try {
      fs.mkdirSync(HIST_DIR, { recursive: true });
      fs.writeFileSync(path.join(HIST_DIR, groupId + '.json'), JSON.stringify(histOf(groupId).slice(-400), null, 1), 'utf8');
    } catch {}
  }
  function resetHist(groupId) {
    histCache.set(groupId, []);
    saveHist(groupId);
  }

  // ---------- 模型 ----------
  function readKey() {
    const t = fs.readFileSync(CRED, 'utf8');
    const m = t.match(/DEEPSEEK_API_KEY:\s*(\S+)/);
    if (!m) throw new Error('DEEPSEEK_API_KEY not found in ' + CRED);
    return m[1];
  }

  // ---------- 表情包 ----------
  // 宿主 meme 服务的 catalog 里是 {packs:[{stickers:[{id,name,meaning,tags}]}]}
  // 这里只负责把它压成给模型看的一小段清单，网络请求由 route 做（route 才知道同源 host）。
  function stickerPromptBlock(stickers) {
    const packs = (stickers && Array.isArray(stickers.packs)) ? stickers.packs : [];
    const lines = [];
    let n = 0;
    for (const pack of packs) {
      if (n >= 60) break;
      const list = (pack && Array.isArray(pack.stickers)) ? pack.stickers : [];
      for (const s of list) {
        if (n >= 60) break;
        if (!s || !s.id) continue;
        const meaning = String(s.meaning || "").replace(/\s+/g, " ").slice(0, 36);
        lines.push("· " + s.id + " " + (s.name || "") + (meaning ? "（" + meaning + "…）" : ""));
        n += 1;
      }
    }
    if (!lines.length) return "";
    return "\n\n===== 表情包 =====\n" +
      "想发个表情的时候，在回复最后单独写一行：[STICKER:表情id]，id 只能从下面这张表里选。\n" +
      "一条最多一个表情；不合适就不发，别每句都挂。\n" +
      lines.join("\n");
  }

  function safePersonaName(name) {
    const s = String(name || "").replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    return s || "persona";
  }

  function parseForgePlan(raw) {
    const t = String(raw || "");
    const i = t.indexOf("{");
    const j = t.lastIndexOf("}");
    if (i < 0 || j <= i) throw new Error("模型没有返回 JSON，再点一次");
    let obj;
    try { obj = JSON.parse(t.slice(i, j + 1)); } catch { throw new Error("模型返回的 JSON 解析失败，再点一次"); }
    const group = (obj && obj.group && typeof obj.group === "object") ? obj.group : {};
    const raw2 = Array.isArray(obj && obj.members) ? obj.members : [];
    const members = [];
    for (const m of raw2) {
      if (members.length >= 6) break;
      if (!m || typeof m !== "object") continue;
      const name = String(m.name || "").trim().slice(0, 12);
      const soul = String(m.soul || "").trim();
      if (!name || soul.length < 20) continue;
      members.push({ name, role: String(m.role || "").trim().slice(0, 20), soul: soul.slice(0, 4000) });
    }
    if (!members.length) throw new Error("没生成出可用成员，换个描述再试");
    return {
      groupName: String(group.name || "").trim().slice(0, 20),
      groupDesc: String(group.desc || "").trim().slice(0, 120),
      members,
    };
  }

  function loadPersonaText(p) {
    const parts = [];
    try { parts.push(fs.readFileSync(p.soul, 'utf8')); } catch { parts.push('(人格档案缺失: ' + p.soul + ')'); }
    try {
      const dir = path.dirname(p.soul);
      for (const f of fs.readdirSync(dir)) {
        if (!/完整人格档案.*\.md$/i.test(f)) continue;
        parts.push(fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 4000));
        break;
      }
    } catch {}
    let body = parts.join('\n\n');
    if (body.length > 12000) body = body.slice(0, 12000) + '\n...(已截断)';
    return body;
  }

  function systemPrompt(p, roster, groupName, groupDesc, opts) {
    const addressed = !!(opts && opts.addressed);
    const forceSay = !!(opts && opts.force);
    const stickerBlock = (opts && opts.stickers) ? stickerPromptBlock(opts.stickers) : '';
    let skillBlock = '';
    try {
      const want = Array.isArray(p.skills) ? p.skills.filter(Boolean) : [];
      if (want.length) {
        const avail = scanSkills(getConfig().workspaces);
        const parts = [];
        let budget = 3500;
        for (const sid of want) {
          const s = avail.find((x) => x.id === sid || x.dir === sid);
          if (!s) continue;
          let body = '';
          try { body = fs.readFileSync(s.file, 'utf8'); } catch {}
          body = body.replace(/^---[\s\S]*?---/, '').trim().slice(0, Math.max(400, Math.min(1400, budget)));
          budget -= body.length;
          parts.push('· ' + s.id + (s.desc ? '：' + s.desc : '') + (body ? '\n' + body : ''));
          if (budget <= 400) break;
        }
        if (parts.length) {
          skillBlock = '\n\n===== 你会的技能 =====\n' + parts.join('\n\n') +
            '\n需要时按技能里的说明做；没把握就说不会，别硬编。';
        }
      }
    } catch {}
    const others = roster.filter((x) => x.id !== p.id).map((x) => '· ' + x.name).join('\n') || '（暂时没有别人）';
    const gname = (groupName && String(groupName).trim()) || '群聊';
    const desc = (groupDesc && String(groupDesc).trim()) ? ('\n群简介：' + String(groupDesc).trim()) : '';
    const allNames = ['可乐'].concat(roster.map((x) => x.name)).join('、');
    return loadPersonaText(p) +
      '\n\n===== 现在你在哪 =====\n' +
      '你在一个叫「' + gname + '」的群里。' + desc + '\n' +
      '群成员一共 ' + (roster.length + 1) + ' 个：' + allNames + '。\n' +
      '· 可乐 —— 用户本人，坐在屏幕前打字\n' +
      others + '\n\n' +
      '你就是「' + p.name + '」。' + (p.desc ? '别人对你的印象：' + p.desc + '。' : '') +
      '不是演练，不是提示词测试，就是你在群里正常说话。\n' +
      '你知道这个群叫什么、有几个人、都有谁；问到的时候照实说，不知道就说不知道，别编。\n\n' +
      '===== 群聊说话规则（硬性）=====\n' +
      '1. 像微信：短句，1~3 句，整条不超过 80 字。\n' +
      '2. 禁止 Markdown（不要星号、井号、短横线列表、代码块），禁止分点，禁止写标题。\n' +
      '3. 不要每次都长篇。可以只回一句、一个语气词、一句吐槽。\n' +
      '4. 可以接上一条别人的话，也可以自己起个无关的小话题；可以打趣别人，但不演别人、不替别人说话。\n' +
      '5. 不编事实。不知道就说不知道。\n' +
      '6. 直接说话内容，不要写「' + p.name + '：」这种前缀。\n' +
      '7. 别客套，别说场面话，说人话。\n' +
      '8. 上下文里出现「[表情·名字]」说明对方发了个表情包。那就是在表达情绪或打招呼：接一句、或者也回一个表情都行；别问「你怎么不说话」，也别当成空白消息。\n' +
      skillBlock + stickerBlock + '\n\n' +
      '===== 关于是否开口 =====\n' +
      (forceSay
        ? '可乐刚发了个表情，就等你接一句。这一轮必须开口：不许输出 <SKIP>，别问「你怎么不说话」，直接对那个表情做个反应。\n'
        : (addressed
          ? '这一轮点名的是你，直接说内容，不用先来一句「我觉得」。\n'
          : '这一轮没点你的名字。你可以接，也可以不接——大概一半的轮次开口就够了，别每条都答，别抢话。\n' +
            '要开口、又是自己主动插话的时候，用「我觉得」「我这边看是」「依我看」这类开头，把话标明是你自己的看法，不是定论。\n' +
            '被点名的那位不用这层缓冲，你也别替他说话。\n')) +
      (forceSay ? '' : '如果这一轮确实没你的事、或者你插不上嘴，就只输出 <SKIP> 这六个字符，不要任何别的字。');
  }

  // 给"看提示词"用：某个成员此刻实际拿到的 system prompt
  function promptOf(p, roster, group, opts) {
    return systemPrompt(p, roster, group && group.name, group && group.desc, opts);
  }

  // 表情消息在文本上是空的，但进上下文不能是空串——否则模型看到「可乐：」一脸懵，直接 SKIP。
  function stickerTag(m) {
    if (!m || !m.sticker) return "";
    return "[表情" + (m.stickerName ? "·" + m.stickerName : "") + "]";
  }

  function nameOf(roster, id) {
    if (id === 'user') return '可乐';
    const p = roster.find((x) => x.id === id);
    return p ? p.name : id;
  }

  function buildMessages(p, roster, hist, groupName, groupDesc, opts) {
    const out = [{ role: 'system', content: systemPrompt(p, roster, groupName, groupDesc, opts) }];
    for (const m of hist.slice(-40)) {
      const body = m.text || stickerTag(m);
      if (m.who === "user") out.push({ role: "user", content: "可乐：" + body });
      else if (m.who === p.id) out.push({ role: "assistant", content: body });
      else out.push({ role: "user", content: nameOf(roster, m.who) + "：" + body });
    }
    if (out[out.length - 1].role === 'assistant') out.push({ role: 'user', content: '（接着说）' });
    return out;
  }

  // 非流式调用：给「按描述生成人格」用（要完整 JSON，不能流式）
  async function chatOnce(messages, opts) {
    const o = opts || {};
    const key = readKey();
    const ctl = new AbortController();
    const timer = setTimeout(() => { try { ctl.abort(); } catch {} }, HTTP_TIMEOUT_MS);
    try {
      const r = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify({
          model: MODEL,
          messages,
          stream: false,
          temperature: typeof o.temperature === "number" ? o.temperature : 0.9,
          max_tokens: typeof o.maxTokens === "number" ? o.maxTokens : 2400,
        }),
        signal: ctl.signal,
      });
      if (!r.ok) throw new Error("upstream " + r.status + " " + (await r.text()).slice(0, 300));
      const j = await r.json();
      const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      return String(c || "");
    } finally {
      clearTimeout(timer);
    }
  }

  // 按一段描述生成群 / 成员：写 SOUL_*.md → 重新 discover → 需要时建群
  async function forge(payload) {
    const body = payload || {};
    const desc = String(body.desc || "").trim();
    const mode = body.mode === "member" ? "member" : "group";
    if (desc.length < 2) throw new Error("描述太短：说一句你想要什么样的群或成员");
    const cfg = getConfig();
    let ws = String(body.workspace || "").trim();
    if (!ws) ws = (cfg.workspaces && cfg.workspaces[0]) || DEFAULT_WS_ROOT;
    try { ws = path.resolve(ws); } catch { throw new Error("工作区路径不合法"); }
    if (!fs.existsSync(ws)) throw new Error("工作区不存在：" + ws);
    if (!Array.isArray(cfg.workspaces)) cfg.workspaces = [];
    if (!cfg.workspaces.includes(ws)) { cfg.workspaces = cfg.workspaces.concat([ws]); saveConfig(); }

    const sys = [
      "你是一个群和人格设定生成器。根据用户的一句描述，产出这个群和它的成员。",
      "只输出 JSON，不要解释、不要 ``` 代码块。格式：",
      '{"group":{"name":"群名(≤8字)","desc":"一句话简介"},"members":[{"name":"显示名(≤4字)","role":"角色","soul":"人格档案 Markdown"}]}',
      "规则：",
      "1. 成员 2~6 个（mode=member 时只要 1 个）；各司其职，别都一个样。",
      "2. soul 以 # 名字 开头，写清：你是谁、性格、说话风格、专业习惯、口头禅、边界（不装懂）。",
      "3. soul 用中文，120~300 字，写具体行为，少堆形容词。",
      "4. 名字要像人，别叫「产品经理A」。",
    ].join("\n");
    const user = "需求：" + desc + (mode === "member" ? "\n只要 1 个成员。" : "");
    const raw = await chatOnce([{ role: "system", content: sys }, { role: "user", content: user }], { temperature: 0.8, maxTokens: 2400 });
    const plan = parseForgePlan(raw);

    const written = [];
    for (const m of plan.members) {
      const base = safePersonaName(m.name);
      let file = path.join(ws, "SOUL_" + base + ".md");
      let i = 2;
      while (fs.existsSync(file)) { file = path.join(ws, "SOUL_" + base + "_" + i + ".md"); i += 1; if (i > 50) break; }
      const text = /^#\s/.test(m.soul) ? m.soul : ("# " + m.name + "\n\n" + m.soul);
      fs.writeFileSync(file, text + "\n", "utf8");
      written.push({ name: m.name, role: m.role, file });
    }

    // 重新扫一遍，拿到新成员的 id
    const found = discover(getConfig().workspaces);
    const byFile = new Map(found.map((p) => [String(p.soul).toLowerCase(), p]));
    for (const w of written) {
      const hit = byFile.get(String(w.file).toLowerCase());
      if (hit) { w.id = hit.id; w.fullName = hit.name; }
    }
    const members = written.filter((w) => w.id);
    if (!members.length) throw new Error("写入了人格文件但没扫到，检查工作区路径");

    let group = null;
    if (mode === "group") {
      const gname = plan.groupName || (plan.members[0] && plan.members[0].name) || "新群";
      const g = createGroup(gname, members.map((m) => m.id));
      if (plan.groupDesc) updateGroup(g.id, { desc: plan.groupDesc });
      group = { id: g.id, name: g.name, desc: plan.groupDesc || "" };
    }

    return { ok: true, mode, workspace: ws, group, members, groupDesc: plan.groupDesc || "" };
  }

  async function streamChat(p, roster, hist, onDelta, groupInfo) {
    const key = readKey();
    const ctl = new AbortController();
    const timer = setTimeout(() => { try { ctl.abort(); } catch {} }, HTTP_TIMEOUT_MS);
    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: MODEL, messages: buildMessages(p, roster, hist, groupInfo && groupInfo.name, groupInfo && groupInfo.desc, groupInfo), stream: true, temperature: 1.15, max_tokens: 320 }),
        signal: ctl.signal,
      });
      if (!r.ok) throw new Error('upstream ' + r.status + ' ' + (await r.text()).slice(0, 300));
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '', full = '';
      while (true) {
        const step = await reader.read();
        if (step.done) break;
        buf += dec.decode(step.value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const d = line.slice(5).trim();
          if (d === '[DONE]') continue;
          try {
            const j = JSON.parse(d);
            const t = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || '';
            if (t) { full += t; onDelta(t); }
          } catch {}
        }
      }
      return full;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    MODEL, DEFAULT_WS_ROOT, version: VERSION, dataDir: DATA_DIR,
    getConfig, saveConfig, discover, listWorkspaceDirs,
    splitPaths, normalizeWorkspaces, workspaceStatus, browseDir,
    listGroups, getGroup, createGroup, updateGroup, deleteGroup, setActive,
    rosterOf, histOf, saveHist, resetHist,
    streamChat, promptOf, chatOnce, forge, stickerPromptBlock,
    botOf, patchBot, loadBots, scanSkills,
  };
}
