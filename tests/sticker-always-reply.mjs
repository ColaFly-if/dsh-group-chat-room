// 发表情包必须有人接话：连发 N 个表情，每个都要出现成员回复（msg_end）。
// 用法：node tests/sticker-always-reply.mjs   （TRIES=4 可调）
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.GROUPCHAT_BASE || "http://127.0.0.1:11807/groupchat";
const TRIES = Number(process.env.TRIES || 4);

const cfgPath = path.join(os.homedir(), ".dsh", "group-chat", "config.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const gid = cfg.active;
if (!gid) {
  console.log("NO_ACTIVE_GROUP");
  process.exit(1);
}

const catRes = await fetch(BASE + "/api/stickers", { headers: { accept: "application/json" } });
const cat = await catRes.json();
const ids = [];
for (const p of cat.packs || []) for (const s of p.stickers || []) ids.push(s.id);
if (!ids.length) {
  console.log("NO_STICKERS");
  process.exit(1);
}

let noReply = 0;
for (let i = 0; i < TRIES; i += 1) {
  const id = ids[(i * 7 + 3) % ids.length];
  const res = await fetch(BASE + "/api/say", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group: gid, sticker: id }),
  });
  if (!res.ok) {
    console.log(id + " HTTP_" + res.status);
    noReply += 1;
    continue;
  }
  const body = await res.text();
  const ends = (body.match(/"type":"msg_end"/g) || []).length;
  const skips = (body.match(/"type":"skipped"/g) || []).length;
  console.log(id + " msg_end=" + ends + " skipped=" + skips);
  if (!ends) noReply += 1;
}

if (noReply) {
  console.log("STICKER_NO_REPLY " + noReply + "/" + TRIES);
  process.exit(1);
}
console.log("STICKER_ALWAYS_REPLY_OK " + TRIES + "/" + TRIES);
