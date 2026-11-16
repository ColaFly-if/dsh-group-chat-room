// 人流程实测：全新打开页面 → 等历史加载完 → 输入一句话 → 点发送 → 等回复出现 → 截图
import fs from "node:fs";
const CDP = process.env.CDP_URL || "http://127.0.0.1:9333";
const PAGE_URL = process.env.GROUPCHAT_URL || "http://127.0.0.1:8733/groupchat/";
const OUT = process.env.SHOT_PATH || "plugins/dsh-group-chat-room/tests/_live-shot.png";

async function j(url, o) { for (let i = 0; i < 40; i++) { try { const r = await fetch(url, o); if (r.ok) return await r.json(); } catch {} await sleep(500); } return null; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 关掉旧页面，开一个全新的
for (const t of (await j(CDP + "/json/list")) || []) {
  if ((t.url || "").indexOf("groupchat") >= 0) await j(CDP + "/json/close/" + t.id);
}
const created = await j(CDP + "/json/new?" + encodeURIComponent(PAGE_URL), { method: "PUT" });
if (!created || !created.webSocketDebuggerUrl) { console.log("CANNOT_OPEN_PAGE"); process.exit(1); }

const ws = new WebSocket(created.webSocketDebuggerUrl);
let seq = 0; const pend = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
await new Promise((r) => ws.addEventListener("open", r));
const send = (method, params = {}) => { const i = ++seq; return new Promise((res) => { pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }); };
const ex = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.result && r.result.exceptionDetails) return { __error: String(r.result.exceptionDetails.text) }; return r.result && r.result.result ? r.result.result.value : undefined; };

await send("Page.enable"); await send("Runtime.enable");
await sleep(1500);

// 等历史渲染完
let ready = null;
for (let i = 0; i < 40; i++) {
  ready = await ex("(function(){var n=document.querySelectorAll('#list .row').length;var t=document.getElementById('ta');return {rows:n, ta:!!t, send:!!document.getElementById('send')}})()");
  if (ready && ready.rows > 0 && ready.ta && ready.send) break;
  await sleep(500);
}
console.log("PAGE " + JSON.stringify(ready));

const text = "人流程实测：这条能实时看到回复吗";
const act = await ex("(async function(){var ta=document.getElementById('ta');var btn=document.getElementById('send');var before=[].slice.call(document.querySelectorAll('#list .row')).map(function(r){var b=r.querySelector('.bubble');return b?b.textContent:''});ta.focus();ta.value=" + JSON.stringify(text) + ";ta.dispatchEvent(new Event('input',{bubbles:true}));var t0=Date.now();btn.click();var found=null;for(var i=0;i<120;i++){await new Promise(function(r){setTimeout(r,500)});var rows=[].slice.call(document.querySelectorAll('#list .row'));for(var j=rows.length-1;j>=0;j--){var r=rows[j];if(r.classList.contains('me'))continue;var b=r.querySelector('.bubble');var s=r.querySelector('.skipped');if(s)continue;var t=b?b.textContent:'';if(t&&t.trim()&&before.indexOf(t)<0){var w=r.querySelector('.who');found={who:w?w.textContent:'',text:t.trim().slice(0,60),ms:Date.now()-t0,rows:rows.length};break;}}if(found)break;}var tail=[].slice.call(document.querySelectorAll('#list .row')).slice(-3).map(function(r){var b=r.querySelector('.bubble');var s=r.querySelector('.skipped');return (b?b.textContent:(s?s.textContent:'')).slice(0,40)});return {found:found,tail:tail,waitedMs:Date.now()-t0};})()");
console.log("RESULT " + JSON.stringify(act));
const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result && shot.result.data) { fs.writeFileSync(OUT, Buffer.from(shot.result.data, "base64")); console.log("SHOT " + OUT); }
console.log(act && act.found ? "LIVE_REPLY_OK" : "LIVE_REPLY_FAIL");
ws.close(); process.exit(0);
