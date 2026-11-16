# dsh-group-chat-room（侧边栏群聊）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests: 44 passing](https://img.shields.io/badge/tests-44%20passing-brightgreen)](tests/run-tests.mjs)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4a9eff)](https://github.com/deepseek-ai)
[![No external deps](https://img.shields.io/badge/dependencies-none-blueviolet)](package.json)

**给 [DeepSeek Harness](https://github.com/deepseek-ai) 右侧栏加一个群聊页：把工作区里的多个 `SOUL_*.md` 人格拉进同一个房间，一起说话。**

[English](README.md)

---

## 为什么做这个

大多数聊天界面只有一个助手。这个给你一个房间：往任意工作区丢 `SOUL_*.md` 人格文件，勾选成员，它们就在同一个对话里发言——轮流接话、流式输出、没话说时还能主动闭嘴。

## 功能

- **人格发现**：递归扫描每个工作区（最多 4 层）里的 `SOUL_*.md`，第一个 `# 标题` 作为显示名。
- **群管理**：建群 / 改名 / 写简介 / 切当前群 / 删群，成员从列表里勾。
- **真流式**：单条 SSE 接口（`/groupchat/api/say`）依次发 `user_msg`、`typing`、`msg_start`、`delta`、`skipped`、`error`、`done`。
- **像群聊的发言调度**：点名 → 只有被点的人说；说「你们聊会儿」→ 全员两轮；其它情况每人 55% 概率开口（至少留一个），也可以 `<SKIP>` 不接话。
- **按人覆盖**：别名、emoji 头像、简介、启用开关、以及要注入的技能（工作区里的 `SKILL.md`）。
- **表情包**：直接复用宿主的 meme 服务（`/api/memes/catalog`、`/api/memes/assets/:id`）。面板里的表情就是助手能发的那套，消息里存 `sticker` 字段，人格也可以用一行 `[STICKER:st_xxx]` 回个表情。
- **一句话生成成员**：描述一下你要的群（「一个程序开发组：产品、前端、后端、测试、设计」），它会把群建好，并给每个成员写一份 `SOUL_*.md` 再拉进群。
- **纯本地**：配置、人格覆盖、聊天记录都在本机；除了你自己的模型接口，没有任何外部请求。

## 前置条件

装之前先确认下面这些，前三条缺一条就用不了。

### 必需

| 前置 | 为什么需要 | 缺了会怎样 |
|---|---|---|
| DSH 的 **Web 形态**（桌面版，或 `dsh web`） | 插件把 `/groupchat/*` 全部路由挂在宿主的 `webServer` 服务上，自己不监听端口 | 插件能加载但页面打不开；TUI / headless 形态没有这个服务 |
| DeepSeek API 凭据（默认 `~/.dsh/.credentials.yaml`） | 成员回复由插件直接 POST `https://api.deepseek.com/chat/completions` | 页面能开、消息能发出去，但没人回话 |
| 至少一个 `SOUL_*.md` 人格文件 | 群成员就是从工作区里扫出来的 `SOUL_*.md` | 成员列表是空的，没得勾 |

### 可选

| 前置 | 作用 | 缺了会怎样 |
|---|---|---|
| `dsh-better-sidebar`（提供 `betterSidebar` 服务） | 用它注册「聊天群组」侧栏标签 | 群聊照常工作，只是侧栏没有入口，得手动访问 `/groupchat/` |
| 宿主提供的同源表情服务 `/api/memes/catalog` | 贴纸目录（插件代理 + 5 分钟缓存） | 贴纸面板是空的；发文字、收回复都不受影响 |

服务都是机会式获取（`ctx.get('webServer')`、`ctx.get('betterSidebar')`），`cordis.patch.yml` 里 `inject: []`，所以缺服务不会卡住插件启动 —— 功能按上表降级。

## 安装

这是 DSH 宿主插件：挂在 DSH 的 web server 上，**不额外开端口、不起子进程**。

1. 让 profile 能解析到这个目录（用软链/目录联接）：

   ```bash
   # Windows（junction，不需要管理员）
   mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-group-chat-room" "<path-to-repo>\dsh-group-chat-room"
   # macOS / Linux
   ln -s "<path-to-repo>/dsh-group-chat-room" ~/.dsh/profiles/desktop/node_modules/dsh-group-chat-room
   ```

2. 在 profile 补丁层（`~/.dsh/profiles/desktop/cordis.patch.yml`）注册：

   ```yaml
   - insert:
       - id: dsh-group-chat-room
         name: dsh-group-chat-room
   ```

3. 重启 DSH。侧边栏出现「群聊」标签，页面地址 `/groupchat/`。

## 怎么用

| 动作 | 操作 |
|---|---|
| 打开 | 侧边栏标签，或直接访问 `/groupchat/` |
| 选人 | 「成员」→ 勾选扫到的人格 → 保存 |
| 加工作区 | 「设置 → 扫描的工作区」：一次贴多个路径，或逐层浏览 |
| 说话 | 输入发送，回复按人依次流式出现 |
| 点名 | 消息里带上某人名字 |
| 让他们自己聊 | 说「你们聊会儿」之类 |
| 清空 | 「清空记录」（按群） |

## HTTP 接口

全部挂在 DSH web server 的 `/groupchat` 前缀下。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/groupchat/` | 界面 |
| GET | `/groupchat/api/state` | 模型、群列表、当前群、成员 |
| GET | `/groupchat/api/discover?g=` | 工作区、扫到的人格、当前成员 |
| GET | `/groupchat/api/browse?path=` | 目录选择器（空路径在 Windows 返回盘符） |
| POST | `/groupchat/api/workspaces` | `{ text }` 追加解析，`{ workspaces: [] }` 整体替换 |
| POST | `/groupchat/api/groups` | `{ action: create \| update \| activate \| delete }` |
| GET | `/groupchat/api/history?g=` | 最近 200 条 |
| POST | `/groupchat/api/reset?g=` | 清空某个群 |
| POST | `/groupchat/api/say` | `{ text, group }` → SSE 流 |
| GET | `/groupchat/api/prompt?who=` | 某人格拼出来的 system prompt（调试用） |
| GET/POST | `/groupchat/api/bots` | 人格覆盖与技能目录 |
| GET | `/groupchat/api/stickers` | 代理表情目录（缓存 5 分钟，取不到就给空） |
| POST | `/groupchat/api/forge` | `{ desc, mode: group \| member, workspace }` → 写 `SOUL_*.md` 并建群 |
| GET | `/groupchat/api/ping` | 版本 + 路由表（健康检查） |

## 配置

`~/.dsh/group-chat/config.json` 存 `workspaces`、`groups`、`active`；人格覆盖在 `bots.json`，历史在 `history/<群id>.json`。

| 环境变量 | 默认 | 含义 |
|---|---|---|
| `GROUPCHAT_WS_ROOT` | `~` | 还没配置任何工作区时扫描的默认根目录 |
| `GROUPCHAT_DATA_DIR` | `~/.dsh/group-chat` | 数据目录 |
| `CHAT_MODEL` | `deepseek-flash` | 发给服务商的模型名 |

API key 在调用时从 `~/.dsh/.credentials.yaml` 读（`DEEPSEEK_API_KEY: ...`），代码里不留任何密钥。

## 实现结构

```text
web/index.html  ──fetch/SSE──▶  lib/route.js  ──▶  lib/core.js  ──▶  模型接口
               （侧边栏 UI）      （HTTP、调度）      （人格、配置、历史）
```

- `lib/index.js`：把路由挂到 DSH web server，并按 mtime 热加载 `core.js` / `route.js`，改代码多数不用重启。
- `lib/core.js`：不含 HTTP。人格发现、配置、历史缓存、prompt 组装、流式客户端。
- `lib/route.js`：调度（谁说、顺序）、SSE 帧、JSON 接口。
- `lib/client.js`：注册侧边栏标签。

## 隐私

- 全部本地：配置、人格覆盖、聊天记录。
- 没有埋点、没有第三方请求；唯一外部请求是你配的模型接口。
- `data/` 与 `~/.dsh/group-chat` 已加入 gitignore。发布前建议跑一遍敏感信息门禁：

  ```bash
  node ../dsh-acceptance-gate/tests/publish-check.mjs .
  ```

## 开发与测试

```bash
node tests/run-tests.mjs   # 44 条断言，临时数据目录，不联网
```

测试会在 `127.0.0.1:0` 起真实路由，`dataDir` 指向临时目录、凭据路径指向不存在的文件——不会碰你真实的群和历史。覆盖：路由、CRUD、去重、SSE 帧、404/400、并发、前端 XSS 安全、敏感信息扫描。

## 限制

- 单进程同一时刻只允许一个 `/say` 在跑（第二个请求返回 `429 busy`）。
- 没有鉴权：由本机 DSH web server 提供，请当作仅本机可用。
- 人格身份基于文件：改 `SOUL_*.md` 文件名等于换人格 id。
- 群成员是扁平列表：没有角色、没有按人指定模型。

## 许可

[MIT](LICENSE)
