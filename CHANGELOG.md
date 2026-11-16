# Changelog

## 0.1.1

此前 0.1.0 – 0.3.0 为内部迭代，能力已并入本版本。

### 群聊

- 群组 CRUD、成员管理、人格发现（读 workspace 里的 `SOUL_*.md`）。
- SSE 流式回复：`/groupchat/api/say` 逐条推送 `user_msg` / `typing` / `msg_start` / `delta` / `msg_end`。
- 页面点「发送」实时渲染回复；刷新走 `/api/history` 全量重绘。

### 成员与人格

- 按一句描述生成整个群和成员（`POST /api/forge`）。
- 成员级覆盖配置（模型、温度、人设）。
- 人格插话策略：被 @ 时直接回答，主动插话时带「我觉得」「我这边看是」这类缓冲。

### 贴纸

- `/api/stickers` 代理宿主表情服务，输入框有贴纸选择器，消息持久化 `sticker` 字段。
- 人格回复里的 `[STICKER:st_xxx]` 会被解析成贴纸。

### 可移植性

- 不写死路径：workspace 根与凭据目录都从 env / `os.homedir()` 推导。
- MIT 许可、中英双 README、插件元数据、本地 `check:publish` 自检。

### 测试

- `tests/run-tests.mjs`：58 条断言，跑真实 router + 临时数据目录。
- `tests/live-browser-test.mjs`：无头 Edge + CDP 真跑「打开页面 → 填字 → 点发送 → 等回复 → 截图」。
- 回归项：发送按钮不得把 MouseEvent 当参数传进 `send()`，否则 payload 会变成 `{"isTrusted":false}`，服务端回 `{"error":"empty"}`，页面永远等不到回复。
