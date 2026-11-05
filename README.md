# dsh-agent-deck

[English](README.en.md) · 中文

## 截图

![Agent Deck 浅色模式](docs/screenshot-light.jpg)

![Agent Deck 深色模式](docs/screenshot-dark.jpg)

## 简介

Agent Deck 是 DSH Web GUI 的只读多智能体监控面板：把每个正在运行的会话画成办公室工位和鲸鱼娘，实时汇总状态、思考、工具调用、输出、上下文与吞吐，并提供 OFFICE / RADAR / NET 三种舞台和单 agent 的 ANALYZE 解剖视图。它只读取 Host 的会话遥测，不向会话写回任何内容。

## 使用方法

1. 打开 DSH Web GUI，在左侧选择「监控室」。
2. 舞台默认是 `OFFICE`；底部 `RADAR / NET` 切换视图。
3. 单击左侧 TUI 卡或办公室工位聚焦该 agent；`× RELEASE` 或 `Esc` 返回。
4. 点卡片右上 `↗` 打开对应会话。
5. `C` 或 `CINEMA` 进入铺满舞台的布局；`Esc` 退出。
6. `PREFS` 可调访客开关、串访节奏、最多访客数和桌面动作开关，偏好仅保存在当前浏览器。

面板跟随 DSH 的浅色/深色主题；没有活跃会话时，办公室和左栏会保留一位值班鲸鱼娘，避免空场。

## 安装

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

### 让 agent 自行安装

> 请把 https://github.com/windsor8890/dsh-agent-deck 用 `dsh plugin --profile <profile> add <仓库绝对路径>` 安装到当前 DSH profile，然后刷新 Web GUI。
