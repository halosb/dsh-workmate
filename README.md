# dsh-workmate（工作搭档）

> DeepSeek Harness 工作搭档插件：**任务完成通知** + **私有知识库**。
> A workmate for DeepSeek Harness: task-completion notifications and a private knowledge base.

以官方插件机制安装，**不修改任何 DSH 源码**，不需要重新构建前端。

## 特性

### 🔔 任务完成通知
- 监听 Agent 状态（`agent/status` idle ⇄ running）计时，**长任务**（超过阈值）结束/失败时提醒
- 通道一：**Windows 原生 Toast**（标题=会话标题/工作区名，正文=耗时与状态）
- 通道二：**Webhook 推送**（POST JSON，可接企业微信/Telegram/自建服务/邮箱网关）
- **音效反馈**：任务完成"叮"、失败低音、审批出现提醒音、**提问表单出现提示音**（PowerShell Beep，零依赖）
- 「仅后台通知」：浏览器标签页在前台时不打扰

### 📚 私有知识库
- 索引本地文档目录（txt/md/json/yaml/js/ts 等文本格式），**完全离线**
- 提问时模型自动调用 **`kb_search` 工具**检索（BM25 词频打分），返回文件+片段+分数
- **`web_capture` 工具**：给个 URL → 抓取正文 → 直接入库；返回**索引文件位置**与取回方式
- **`kb_recent` 工具**：**直接列出**最近捕获的网页（标题/URL/块数/时间/索引路径），无需盲搜
- **重建不丢网页库**：本地目录"重新索引"时自动合并保留所有网页捕获，互不覆盖
- 文档不离开本机，不依赖 embedding 模型

## 效果预览

![设置页 - 任务通知](docs/screenshots/settings-1.png)

![设置页 - 私有知识库](docs/screenshots/settings-2.png)

## 工作原理（30 秒）

1. 本插件是 DSH **组合包（bundle）**：`package.json` 声明 `dsh.bundle` + `dsh.client`。
2. host 半边监听 `agent/status`（计时通知）+ 索引知识库 + 注册 `kb_search`/`web_capture`/`kb_recent` 模型工具 + 提供 `/wf/*` 路由；浏览器半边是设置页。
3. 配置持久化在 `config.json`（`GET/POST /wf/settings`），索引数据在 `kb-index.json`；两者都在 DSH 数据目录 `<DSH_HOME>\plugin-data\<profile>\dsh-workmate\`，**不在 pnpm 管理的插件目录里**（更新/重装不会清空）。

## 环境要求

- DeepSeek Harness（源码运行 Node ≥ 22 + pnpm，或已安装的 `dsh` CLI）
- Windows 系统通知需要允许 PowerShell/应用通知权限

## 安装

> 🖥️ **桌面版（Windows x64 安装包）用户看这里** → **[安装教程-桌面版.md](./安装教程-桌面版.md)**
> 桌面版不需要你自己装 Node / pnpm，也不需要源码目录，但 profile 要用 `desktop` 而不是 `web`，且装完要**完全退出桌面版（含托盘）再打开**。下面是源码运行 / `dsh web` 的装法。

```powershell
# 从 GitHub 安装（已安装 CLI）
dsh plugin --profile web add github:halosb/dsh-workmate

# 从 GitHub 安装（源码运行环境）
pnpm dsh plugin --profile web add github:halosb/dsh-workmate

# 或本地目录
dsh plugin --profile web add ./dsh-workmate
pnpm dsh plugin --profile web add ./dsh-workmate

# 装完必须重启
dsh web          # 默认端口 3080
pnpm dsh web     # 源码运行环境
```

卸载：

```powershell
dsh plugin --profile web remove dsh-workmate
pnpm dsh plugin --profile web remove dsh-workmate
```

> 纯 JS、无构建步骤，git 安装不需要 pnpm 的 prepare/allowBuilds 授权。

## 使用与配置

打开 Web UI → **设置 → 工作搭档**，全部可视化配置（详细说明见 [`使用与配置文档.md`](./使用与配置文档.md)）：

**任务通知**：启用开关 / 时长阈值（默认 60 秒）/ 系统通知 / Webhook URL / 失败通知 / 仅后台通知 / **音效反馈**。

**私有知识库**：索引目录 / 支持格式 / 分块大小与重叠 / 重新索引按钮 / 索引统计；模型可用 `kb_search` 检索、`web_capture` 抓网页入库、`kb_recent` 直接列出已存网页。

出厂默认：通知开、阈值 60s、Toast 开、仅后台开、音效开；知识库未配置（填目录并点"重新索引"即启用）。

## 模型工具一览

| 工具 | 用途 |
|---|---|
| `kb_search(query)` | 检索知识库，返回匹配块（文件/片段/分数） |
| `web_capture(url)` | 抓取网页正文入库，返回索引文件位置与取回方式 |
| `kb_recent(limit?)` | 直接列出最近捕获的网页（标题/URL/块数/时间），最新在前 |

## Webhook 请求体

任务结束时 `POST` 到配置的 URL（`Content-Type: application/json`）：

```json
{
  "sessionId": "…",
  "title": "会话标题或工作区名",
  "status": "done" | "error",
  "durationMs": 132000,
  "message": "任务完成，用时 2 分 12 秒"
}
```

## 仓库结构

```
dsh-workmate/
├── package.json          # dsh.bundle + dsh.client 声明
├── cordis.patch.yml      # 组合层：插入 workmate 行
├── index.js              # host 半边：通知监听 + 知识库索引/检索 + kb_search/web_capture/kb_recent 工具 + /wf/* 路由
├── client.js             # 浏览器半边：设置页 UI
├── docs/
│   └── screenshots/      # 设置页效果预览截图
├── tests/                # host 半边冒烟测试：node tests/host-smoke.mjs
├── README.md
├── 使用与配置文档.md      # 完整使用与配置说明
├── 安装教程-桌面版.md     # DeepSeek Harness 桌面版（Windows）安装教程
└── LICENSE
```

运行时数据不在本目录，而在 DSH 数据目录：

```
<DSH_HOME>\plugin-data\<profile>\dsh-workmate\
├── config.json      # 你的设置
└── kb-index.json    # 知识库索引（含 web_capture 抓取的网页正文）
```

## 测试

```powershell
node tests/host-smoke.mjs
```

零依赖：把 `@deepseek-ai/dsh-tools` 换成桩后直接加载 host 半边，用临时 `DSH_HOME`
真实跑索引 / 中文检索 / 路由准入 / 通知去重 / 启动顺序。数据全落在系统临时目录，
不会碰你已安装的副本。

## 反馈

有问题或建议，欢迎通过邮箱联系作者：

- 📮 **反馈邮箱**：i@halosb.com
- 作者：芝麻 (halosb)

## 许可证

[MIT](./LICENSE)
