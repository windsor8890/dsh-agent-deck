# dsh-agent-deck

[English](#english) · [中文](#中文)

## Screenshots / 截图

![Agent Deck — light mode](docs/screenshot-light.jpg)

![Agent Deck — dark mode](docs/screenshot-dark.jpg)

## English

Agent Deck is a read-only multi-agent telemetry console for the DSH Web GUI. It turns each running session into an office desk and a whale-girl, showing live status, thinking, tool calls, output, context usage and throughput, with OFFICE / RADAR / NET stages and a single-agent ANALYZE view. It only reads Host session telemetry and never writes back to a session.

### Usage

1. Open the DSH Web GUI and choose **Control Room** in the left sidebar.
2. `OFFICE` is the default stage; use `RADAR / NET` to switch views.
3. Click a TUI card or an office desk to focus an agent; press `Esc` or click `× RELEASE` to return.
4. Click `↗` on a card to open that session.
5. Press `C` or click `CINEMA` for the full-width stage; `Esc` exits.
6. `PREFS` controls visits, visit pace, max visitors and desk actions; preferences are stored in the current browser.

The panel follows DSH's light/dark theme. When no session is active, a resident whale-girl stays in the left panel and at desk `#00` so the room does not look empty.

### Installation

Requires a DSH installation with plugin support (Web GUI).

```bash
dsh plugin --profile <profile> add <absolute-repo-path>
```

Examples:

```bash
# Windows
dsh plugin --profile desktop add D:\code\dsh-agent-deck

# macOS / Linux
dsh plugin --profile desktop add /path/to/dsh-agent-deck
```

No `npm install` or build step is needed; refresh the DSH Web GUI after installing.

#### Let an agent install it

Send this one-line prompt to an agent with shell access:

> Clone or use a local copy of https://github.com/windsor8890/dsh-agent-deck, install it into the active DSH profile with `dsh plugin --profile <profile> add <absolute-repo-path>`, then refresh the DSH Web GUI and verify the Control Room panel.

## 中文

Agent Deck 是 DSH Web GUI 的只读多智能体监控面板：把每个正在运行的会话画成办公室工位和鲸鱼娘，实时汇总状态、思考、工具调用、输出、上下文与吞吐，并提供 OFFICE / RADAR / NET 三种舞台和单 agent 的 ANALYZE 解剖视图。它只读取 Host 的会话遥测，不向会话写回任何内容。

### 使用方法

1. 打开 DSH Web GUI，在左侧选择「监控室」。
2. 舞台默认是 `OFFICE`；底部 `RADAR / NET` 切换视图。
3. 单击左侧 TUI 卡或办公室工位聚焦该 agent；`× RELEASE` 或 `Esc` 返回。
4. 点卡片右上 `↗` 打开对应会话。
5. `C` 或 `CINEMA` 进入铺满舞台的布局；`Esc` 退出。
6. `PREFS` 可调访客开关、串访节奏、最多访客数和桌面动作开关，偏好仅保存在当前浏览器。

面板跟随 DSH 的浅色/深色主题；没有活跃会话时，办公室和左栏会保留一位值班鲸鱼娘，避免空场。

### 安装

要求：已安装带插件能力的 DSH（使用 Web GUI）。

```bash
dsh plugin --profile <profile> add <本仓库绝对路径>
```

例如：

```bash
# Windows
dsh plugin --profile desktop add D:\code\dsh-agent-deck

# macOS / Linux
dsh plugin --profile desktop add /path/to/dsh-agent-deck
```

无需 `npm install` 或构建步骤；安装后刷新 Web GUI 即生效。

#### 让 agent 自行安装

把这句话发给能在本机执行命令的 agent：

> 请把 https://github.com/windsor8890/dsh-agent-deck 克隆或使用本地目录，并通过 `dsh plugin --profile <profile> add <仓库绝对路径>` 安装到当前 DSH profile，刷新 Web GUI 后在「监控室」验证。
