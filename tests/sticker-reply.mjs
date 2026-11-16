// 判据：对线上实例只发一个表情，必须至少有一个成员真的开口（msg_end/delta）
const BASE = process.argv[2] || "http://127.0.0.1:11807";
const state = await (await fetch(BASE + "/groupchat/api/state")).json();
const gid = state.active;
if (!(state.roster || []).length) { console.log("SKIP 群里没有成员"); process.exit(0); }
const r = await fetch(BASE + "/groupchat/api/say", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ sticker: "st_eb6a55121eaa", group: gid }),
});
const text = await r.text();
const events = text.split("\n\n").filter((c) => c.startsWith("data:")).map((c) => { try { return JSON.parse(c.slice(5).trim()); } catch { return {}; } });
const said = events.filter((e) => e.type === "msg_end" || e.type === "delta");
const skipped = events.filter((e) => e.type === "skipped");
console.log("status=" + r.status + " 说话=" + said.length + " 跳过=" + skipped.length);
for (const e of events) if (e.type === "msg_end") console.log("  " + e.who + "：" + String(e.text || "").slice(0, 40) + (e.sticker ? " [+表情]" : ""));
console.log(said.length ? "STICKER_REPLY_OK" : "STICKER_REPLY_NONE");
process.exit(said.length ? 0 : 1);
