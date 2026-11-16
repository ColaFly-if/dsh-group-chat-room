// 端到端：对线上实例真发一次 /api/forge，验证人格文件落地 + 群建立，然后回收
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const BASE = process.argv[2] || "http://127.0.0.1:11807";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "forge-e2e-"));
const j = async (p, o) => { const r = await fetch(BASE + p, o); const t = await r.text(); let b = null; try { b = JSON.parse(t); } catch {} return { s: r.status, b, t }; };
const before = await j("/groupchat/api/state");
const oldWs = (await j("/groupchat/api/discover")).b.workspaces;
console.log("before groups=" + (before.b.groups || []).length + " workspaces=" + oldWs.length);
const res = await j("/groupchat/api/forge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ desc: "一个程序开发组，要有产品经理、前端、后端、测试、设计", mode: "group", workspace: TMP } ) });
console.log("forge status=" + res.s);
if (res.s !== 200) { console.log("FAIL " + res.t.slice(0, 300)); process.exit(1); }
const out = res.b;
const files = fs.readdirSync(TMP).filter((f) => f.startsWith("SOUL_"));
console.log("group=" + JSON.stringify(out.group));
console.log("members=" + (out.members || []).map((m) => (m.fullName || m.name) + "(" + (m.id || "?") + ")").join(" "));
console.log("files=" + files.join(", "));
const state = await j("/groupchat/api/state");
const inState = (state.b.groups || []).some((g) => out.group && g.id === out.group.id);
const rosterOk = (state.b.roster || []).length >= 2;
console.log("inState=" + inState + " roster=" + (state.b.roster || []).length);
// 回收
if (out.group && out.group.id) await j("/groupchat/api/groups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "delete", id: out.group.id }) });
await j("/groupchat/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaces: oldWs }) });
fs.rmSync(TMP, { recursive: true, force: true });
const after = await j("/groupchat/api/state");
console.log("after groups=" + (after.b.groups || []).length);
const ok = (out.members || []).length >= 3 && files.length >= 3 && inState;
console.log(ok ? "E2E PASS" : "E2E FAIL");
process.exit(ok ? 0 : 1);
