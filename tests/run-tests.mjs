// dsh-group-chat-room 全流程测试：真 core + 真 route + 临时 data/凭据 + 真 HTTP
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL, fileURLToPath } from "node:url";

// 与 cwd 无关：从脚本位置推插件根，clone 到哪都能跑
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "gc-test-"));
const DATA = path.join(TMP, "data");
const WS = path.join(TMP, "ws");
const PLUGIN = path.join(TMP, "plugin");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(WS, { recursive: true });
fs.mkdirSync(path.join(WS, "sub"), { recursive: true });
fs.mkdirSync(path.join(PLUGIN, "web"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "web", "index.html"), path.join(PLUGIN, "web", "index.html"));
fs.writeFileSync(path.join(WS, "SOUL_测试人格.md"), "# 测试人格\n\n假人格。\n", "utf8");

const coreMod = await import(pathToFileURL(path.join(ROOT, "lib", "core.js")).href);
const routeMod = await import(pathToFileURL(path.join(ROOT, "lib", "route.js")).href);

const GID = "gtest1";
fs.writeFileSync(path.join(DATA, "config.json"), JSON.stringify({ workspaces: [WS], groups: [{ id: GID, name: "测试群", desc: "", members: [], createdAt: Date.now() }], active: GID }, null, 2), "utf8");
const core = coreMod.createCore({ pluginDir: PLUGIN, dataDir: DATA, credPath: path.join(TMP, "no-creds.yaml") });
const handler = routeMod.createRouter({ core, pluginDir: PLUGIN });
const server = http.createServer((req, res) => { handler(req, res).catch((e) => { try { res.writeHead(500); res.end(String(e)); } catch {} }); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + server.address().port;

const rows = [];
const check = (n, ok, d) => rows.push({ n, ok: Boolean(ok), d: d === undefined ? "" : String(d).slice(0, 220) });
async function get(p) { const r = await fetch(BASE + p, { redirect: "manual" }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, h: r.headers, t, j }; }
async function post(p, b) { const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { s: r.status, h: r.headers, t, j }; }

// 1 页面与跳转
const rd = await get("/groupchat");
check("302 跳 /groupchat/", rd.s === 302 && String(rd.h.get("location")).indexOf("/groupchat/") >= 0, rd.s);
const page = await get("/groupchat/");
check("页面 200 + text/html", page.s === 200 && (page.h.get("content-type") || "").indexOf("text/html") >= 0, page.s);
check("页面是真 HTML 且够长", page.t.indexOf("<html") >= 0 && page.t.length > 5000, page.t.length + "B");

// 2 基础接口
const ping = await get("/groupchat/api/ping");
check("ping 版本+路由表", ping.s === 200 && ping.j.ok === true && ping.j.routes.indexOf("say") >= 0 && ping.j.routes.indexOf("prompt") >= 0, ping.j.version);
const st = await get("/groupchat/api/state");
check("state groups/active/roster", st.s === 200 && Array.isArray(st.j.groups) && typeof st.j.active === "string" && Array.isArray(st.j.roster), "groups=" + st.j.groups.length);
const disc = await get("/groupchat/api/discover");
check("discover 扫到 1 个人格", disc.s === 200 && Array.isArray(disc.j.personas) && disc.j.personas.length === 1, "n=" + disc.j.personas.length);
const bots = await get("/groupchat/api/bots");
check("bots 返回 bots+skills", bots.s === 200 && Array.isArray(bots.j.bots) && Array.isArray(bots.j.skills), "n=" + bots.j.bots.length);
const personaId = disc.j.personas[0].id;
const pr404 = await get("/groupchat/api/prompt");
check("空群 prompt 404（无成员）", pr404.s === 404, pr404.t.slice(0, 30));

// 3 browse
const br0 = await get("/groupchat/api/browse?path=");
check("browse 空路径给盘符", br0.s === 200 && br0.j.atDrives === true, "drives=" + br0.j.dirs.length);
const brWs = await get("/groupchat/api/browse?path=" + encodeURIComponent(WS));
check("browse 指定目录列子目录", brWs.s === 200 && brWs.j.path === path.resolve(WS) && brWs.j.dirs.some((d) => d.name === "sub"), "dirs=" + brWs.j.dirs.length);
const brBad = await get("/groupchat/api/browse?path=" + encodeURIComponent(path.join(TMP, "nope")));
check("browse 不存在目录给 error 不崩", brBad.s === 200 && typeof brBad.j.error === "string", brBad.j.error);
const trav = await get("/groupchat/api/browse?path=" + encodeURIComponent("../../../../../../"));
check("browse 穿越无堆栈泄露", trav.s === 200 && trav.t.indexOf("at Object") < 0 && trav.t.indexOf("Error:") < 0, trav.s);

// 4 workspaces 去重/替换
const A = path.join(TMP, "wsA"), B = path.join(TMP, "wsB");
fs.mkdirSync(A); fs.mkdirSync(B);
const w1 = await post("/groupchat/api/workspaces", { text: A + ";" + B + "\n" + A });
check("workspaces 追加+去重（A;B;A→3）", w1.j.workspaces.length === 3, w1.j.workspaces.length);
const w2 = await post("/groupchat/api/workspaces", { text: A });
check("重复提交不增长", w2.j.workspaces.length === 3, w2.j.workspaces.length);
const w3 = await post("/groupchat/api/workspaces", { workspaces: [WS] });
check("workspaces 整体替换", w3.j.workspaces.length === 1 && w3.j.workspaces[0] === WS, w3.j.workspaces.length);
check("workspaces 已落盘", JSON.parse(fs.readFileSync(path.join(DATA, "config.json"), "utf8")).workspaces.length === 1);

// 5 群 CRUD
const cr = await post("/groupchat/api/groups", { action: "create", name: "第二群", members: [] });
const gid = cr.j.group.id;
check("create 建群", cr.s === 200 && cr.j.ok === true && typeof gid === "string", gid);
check("列表 +1 且成为 active", cr.j.groups.length === 2 && JSON.parse(fs.readFileSync(path.join(DATA, "config.json"), "utf8")).active === gid);
const up = await post("/groupchat/api/groups", { action: "update", id: gid, name: "改过的群", desc: "d" });
check("update 改名", up.s === 200 && up.j.group.name === "改过的群", up.j.group.name);
const upMissing = await post("/groupchat/api/groups", { action: "update", id: "nope", name: "x" });
check("update 不存在 → 404", upMissing.s === 404, upMissing.s);
const act = await post("/groupchat/api/groups", { action: "activate", id: GID });
check("activate 切回主群", act.s === 200 && act.j.active === GID, act.j.active);
const del = await post("/groupchat/api/groups", { action: "delete", id: gid });
check("delete 删群", del.s === 200 && del.j.ok === true && del.j.groups.length === 1);
const del2 = await post("/groupchat/api/groups", { action: "delete", id: gid });
check("delete 不存在 → 404", del2.s === 404, del2.s);
const unk = await post("/groupchat/api/groups", { action: "explode" });
check("未知 action → 400", unk.s === 400, unk.s);

// 6 加成员后 prompt / say
const addMem = await post("/groupchat/api/groups", { action: "update", id: GID, members: [personaId] });
check("update 加成员生效", addMem.s === 200 && addMem.j.group, addMem.s);
const pr = await get("/groupchat/api/prompt?who=" + encodeURIComponent(personaId));
check("prompt 含人格名与 roster", pr.s === 200 && String(pr.j.prompt).indexOf("测试人格") >= 0 && pr.j.roster.length === 1, pr.s);

// 7 history 初始
const h0 = await get("/groupchat/api/history?g=" + GID);
check("history 返回数组", h0.s === 200 && Array.isArray(h0.j.history), "len=" + h0.j.history.length);

// 8 say：SSE 无凭据不崩
const sayRes = await fetch(BASE + "/groupchat/api/say", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "测试一句话", group: GID }) });
const sse = await sayRes.text();
check("say 200 + SSE 类型", sayRes.status === 200 && (sayRes.headers.get("content-type") || "").indexOf("text/event-stream") >= 0, sayRes.status);
check("SSE 有 user_msg", sse.indexOf("user_msg") >= 0);
check("SSE 有 error 事件", sse.indexOf("error") >= 0);
check("SSE 正常 done", sse.indexOf("done") >= 0);
const h1 = await get("/groupchat/api/history?g=" + GID);
check("用户消息进历史并落盘", h1.j.history.some((m) => m.who === "user" && m.text === "测试一句话") && fs.existsSync(path.join(DATA, "history", GID + ".json")), "len=" + h1.j.history.length);

// 9 reset
const rs = await post("/groupchat/api/reset?g=" + GID, {});
const h2 = await get("/groupchat/api/history?g=" + GID);
check("reset 清空历史", rs.s === 200 && h2.j.history.length === 0, "len=" + h2.j.history.length);

// 10 空群 say 409
await post("/groupchat/api/groups", { action: "update", id: GID, members: [] });
const sayEmpty = await post("/groupchat/api/say", { text: "有人吗" });
check("无成员 say → 409", sayEmpty.s === 409 && sayEmpty.t.indexOf("没选成员") >= 0, sayEmpty.s);

// 11 错误路径
const nf = await get("/groupchat/api/nope");
check("未知路由 404", nf.s === 404 && nf.t.indexOf("not found") >= 0, nf.s);
const wrong = await get("/groupchat/api/groups");
check("GET /api/groups → 404 不是 500", wrong.s === 404, wrong.s);
const badJson = await fetch(BASE + "/groupchat/api/groups", { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
check("坏 JSON → 400", badJson.status === 400, badJson.status);
const postHist = await fetch(BASE + "/groupchat/api/history", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check("POST /api/history 不 500（记录实际）", postHist.status !== 500, "status=" + postHist.status);
await post("/groupchat/api/groups", { action: "update", id: GID, members: [personaId] });
const both = await Promise.all([0, 1].map(async (i) => { const r = await fetch(BASE + "/groupchat/api/say", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "并发" + i, group: GID }) }); return r.status; }));
check("并发 say 无 500", both.every((s) => s !== 500), both.join("/"));

// 12 前端 XSS 静态检查
const html = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
const assigns = html.split("\n").filter((line) => line.indexOf("innerHTML") >= 0).map((line) => { const at = line.indexOf("innerHTML"); const rest = line.slice(at + 9); const eq = rest.indexOf("="); return eq < 0 ? "?" : rest.slice(eq + 1).replace(/;\s*$/, ""); });
const Q1 = String.fromCharCode(39), Q2 = String.fromCharCode(34);
const onlyQuotes = (s) => { const x = s.slice(s.indexOf("=") + 1).trim(); return x.length === 0 || x.split("").every((c) => c === Q1 || c === Q2 || c === " " || c === ";"); };
const dirty = assigns.filter((s) => !onlyQuotes(s));
check("innerHTML 只用于清空", dirty.length === 0, dirty.slice(0, 2).join(" | "));
check("渲染走 el()+textContent", html.indexOf("function el(tag, cls, text)") >= 0 && html.indexOf("e.textContent = text") >= 0);

// 13 敏感信息验证（测试流程固定一环）
const { scanSecrets, scrubText } = await import("../../dsh-acceptance-gate/lib/secrets.js");
const secrets = scanSecrets({ roots: [ROOT], limit: 2000 });
check("插件源码无 key/手机号/私钥等字面量", secrets.hits.length === 0, secrets.hits.slice(0, 2).map((h) => h.rule + "@" + h.line).join(" | "));
check("插件目录无敏感文件（历史/凭据/库）", secrets.sensitiveFiles.length === 0, secrets.sensitiveFiles.map((f) => f.rule).join(","));
const homeSample = os.homedir();
const userSeg = homeSample.split(path.sep).filter(Boolean).pop() || "";
check("报告脱敏函数会打掉用户目录", userSeg.length > 0 && scrubText(homeSample).indexOf(userSeg) < 0, scrubText(homeSample));

// 14 表情包 + 按描述生成成员/群
const stRes = await fetch(BASE + "/groupchat/api/stickers");
const stJson = await stRes.json().catch(() => ({}));
check("stickers 接口 200 且给 packs", stRes.status === 200 && Array.isArray(stJson.packs), "packs=" + ((stJson.packs || []).length));

const saySticker = await fetch(BASE + "/groupchat/api/say", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "", sticker: "st_eb6a55121eaa", group: GID }) });
const stText = await saySticker.text();
check("只发表情也能进 SSE", saySticker.status === 200 && stText.indexOf("user_msg") >= 0 && stText.indexOf("st_eb6a55121eaa") >= 0, "status=" + saySticker.status);

const histAfter = await (await fetch(BASE + "/groupchat/api/history?g=" + GID)).json();
const lastUser = (histAfter.history || []).filter((m) => m.who === "user").pop() || {};
check("表情消息落库带着 sticker", lastUser.sticker === "st_eb6a55121eaa", JSON.stringify(lastUser).slice(0, 60));

// 14b 全员都想跳过时，表情不能石沉大海（用户会看到空白回复）
const realStream = core.streamChat;
core.streamChat = async (p, roster, hist, onDelta, info) => {
  const t = (info && info.force) ? "行，我接一句。" : "<SKIP>";
  if (onDelta) onDelta(t);
  return t;
};
let forceText = "";
try {
  const fr = await fetch(BASE + "/groupchat/api/say", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "", sticker: "st_eb6a55121eaa", group: GID }) });
  forceText = await fr.text();
} finally {
  core.streamChat = realStream;
}
check("全员想跳过时仍有成员接话（不空白）", forceText.indexOf('"type":"msg_end"') >= 0, forceText.slice(0, 200));
check("排队试错不把『没接话』甩给用户", forceText.indexOf('"type":"skipped"') < 0, forceText.slice(0, 200));

const forgeEmpty = await fetch(BASE + "/groupchat/api/forge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ desc: "" }) });
check("空描述被拒（非 200）", forgeEmpty.status !== 200, "status=" + forgeEmpty.status);

const forgeNoKey = await fetch(BASE + "/groupchat/api/forge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ desc: "一个程序开发组：产品 前端 后端 测试 设计" }) });
const fj = await forgeNoKey.json().catch(() => ({}));
check("无凭据时给 error 不崩", forgeNoKey.status !== 200 && typeof fj.error === "string", "status=" + forgeNoKey.status + " err=" + String(fj.error || "").slice(0, 40));

const coreSrc = fs.readFileSync(path.join(ROOT, "lib", "core.js"), "utf8");
check("core 有 STICKER 解析与 forge", coreSrc.indexOf("STICKER") >= 0 && coreSrc.indexOf("async function forge") >= 0 && coreSrc.indexOf("chatOnce") >= 0);

const htmlSrc = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
check("右上角是齿轮菜单，清空收进去了", htmlSrc.indexOf('id="gearBtn"') >= 0 && htmlSrc.indexOf('id="menuReset"') >= 0 && htmlSrc.indexOf('id="reset"') < 0);
check("页面有表情按钮与生成入口", htmlSrc.indexOf("stickerBtn") >= 0 && htmlSrc.indexOf("api/forge") >= 0 && htmlSrc.indexOf("img.sticker") >= 0);

// 页面脚本必须真的能跑：语法可解析 + 里面有可执行的 SSE 解析，防止整段写进注释或括号写坏
const scriptM = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
let scriptErr = scriptM ? "" : "没有内联脚本";
if (scriptM) { try { new Function(scriptM[1]); } catch (e) { scriptErr = e.message; } }
check("页面脚本语法可解析", scriptErr === "", scriptErr);
const scriptLines = (scriptM ? scriptM[1] : "").split(/\r?\n/).filter((l) => { const t = l.trim(); return t && t.indexOf("//") !== 0; });
check("页面读完响应后重拉历史渲染", scriptLines.some((l) => l.indexOf("await res.text()") >= 0) && scriptLines.some((l) => l.indexOf("await loadHistory()") >= 0), scriptLines.length + " 行可执行");
check("页面等回复时有可见提示", htmlSrc.indexOf("等他们回话") >= 0);
check("发送按钮不把 Event 当参数传入 send", htmlSrc.indexOf("sendBtn.addEventListener('click', send)") < 0 && htmlSrc.indexOf("payload instanceof Event") >= 0);

server.close();
const failed = rows.filter((r) => !r.ok);
const w = Math.max.apply(null, rows.map((r) => r.n.length));
console.log("TMP=" + TMP);
rows.forEach((r) => console.log((r.ok ? "PASS " : "FAIL ") + r.n.padEnd(w) + "  " + r.d));
console.log("\n" + (rows.length - failed.length) + "/" + rows.length + " passed");
if (failed.length) process.exit(1);