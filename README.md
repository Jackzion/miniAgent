# miniAgent

用 TypeScript + Node.js 写的本地终端 Agent：全屏 TUI、流式对话、工具调用、会话持久化与权限沙箱。默认对接 OpenAI 兼容接口（如 DeepSeek）。

## 功能

- **流式对话**：边生成边输出，工具调用 / 历史压缩用黄色进度行区分
- **全屏 TUI**（pi-tui）：左侧消息流 + 右侧信息面板 + 底部输入框
- **工具调用**：时间、shell、文件读写等；模型按需自动调用，写操作需确认
- **权限沙箱**：`.geekagent/GeekAgent.json` 配置 `allow / ask / deny`，路径限制在 root 内
- **写前备份 + `/undo`**：`write` / `patch` 落盘前保存快照，可撤销最近一次写入
- **多会话**：内存多会话切换，退出或 `/save` 写入 `.geekagent/sessions.json`
- **历史自动压缩**：上下文过长时把旧消息摘要成一条，也可 `/compact` 手动触发
- **TODO 规划**：`todo_write` 维护任务清单，面板实时显示；复杂任务可 `delegate_task` 交给子 Agent
- **用量面板**：本轮 / 累计 tokens、上下文占用比例实时刷新

## 环境要求

- Node.js 20+（开发环境验证过 Node 24）
- 真实终端（TTY）；管道 / 重定向下无法启动 TUI

## 快速开始

```bash
npm install
cp .env.example .env
# 编辑 .env，填入 API Key
npm run dev
```

### 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `OPENAI_API_KEY` | API Key（必填） | — |
| `OPENAI_BASE_URL` | 接口地址 | `https://api.deepseek.com` |
| `OPENAI_MODEL` | 模型名 | `deepseek-v4-flash` |
| `GEEKAGENT_MAX_HISTORY` | 触发历史压缩的字符阈值 | `4000` |

## 命令

| 命令 | 说明 |
|---|---|
| `/help` | 显示帮助 |
| `/reset` | 清空当前会话记忆 |
| `/compact` | 立即压缩旧对话摘要 |
| `/save` | 保存全部会话到 `.geekagent/sessions.json` |
| `/load` | 从存档恢复全部会话 |
| `/new <id>` | 新建并切换到会话 |
| `/open <id>` | 切换到已有会话 |
| `/sessions` | 列出内存中的会话 |
| `/todos` | 查看 TODO 列表 |
| `/undo` | 撤销最近一次文件写入 |
| `/exit` | 保存会话并退出（Ctrl+C / Ctrl+D 同） |

## 滚动与搜索

| 操作 | 作用 |
|---|---|
| `↑` / `↓` | 单行滚动 |
| `PageUp` / `PageDown` | 翻页 |
| 鼠标滚轮 | 滚动消息流 |
| `Ctrl+↑` / `Ctrl+↓` | 跳到上/下一条 prompt |
| `Ctrl+Shift+F` | 搜索消息流 |

往上滚会暂停「跟随底部」；滚回最底恢复流式跟随。

## 内置工具

| 工具 | 默认策略 | 说明 |
|---|---|---|
| `get_current_time` | allow | 当前本地时间（Asia/Shanghai） |
| `ls` / `read` / `glob` | allow | 只读：列目录、读文件、通配符查路径 |
| `run_shell` | ask | 执行 shell（Windows 优先 Git Bash）；执行前确认 |
| `write` / `patch` | ask | 写文件 / 按片段改文件；展示 diff 并确认，写前备份 |
| `todo_write` | allow | 写入完整 TODO 列表 |
| `delegate_task` | allow | 把子任务交给隔离上下文的子 Agent |

策略可在 `.geekagent/GeekAgent.json` 中改为 `allow` / `ask` / `deny`。

## 权限配置示例

`.geekagent/GeekAgent.json`（首次运行自动生成）：

```json
{
  "root": "..",
  "tools": {
    "get_current_time": "allow",
    "run_shell": "ask",
    "ls": "allow",
    "read": "allow",
    "glob": "allow",
    "write": "ask",
    "patch": "ask"
  }
}
```

- `root`：工作区根目录（相对配置文件所在目录解析）；文件工具与 undo 的路径都在此沙箱内
- 环境变量中的 `KEY` / `TOKEN` / `SECRET` / `PASSWORD` 真实值在确认提示中会被脱敏

## 项目结构

```
miniAgent/
├── index.ts          # TUI 入口：命令分发、流式回复、面板刷新
├── chat.ts           # 会话：history、流式请求、工具循环、历史压缩、usage
├── tui.ts            # pi-tui 界面：消息流、侧栏、输入与确认
├── tools.ts          # 工具注册表 + 内置工具（shell / 文件读写）
├── todo.ts           # todo_write / delegate_task
├── permissions.ts    # 权限策略、路径沙箱、脱敏
├── undo.ts           # 写前备份与撤销
├── session.ts        # 多会话模型与校验
├── storage.ts        # 会话 JSON 落盘
├── config.ts         # 加载 .env 配置
├── color.ts          # 终端颜色
├── instructions.ts   # 读取 AGENTS.md 项目指令
└── .geekagent/       # 运行时数据（不入库）
    ├── GeekAgent.json
    ├── sessions.json
    └── undo.json
```

## 技术栈

- `typescript` + `tsx`（ESM，strict）
- `openai` — OpenAI 兼容 Chat Completions（含 stream + tools）
- `dotenv` — 环境变量
- `@earendil-works/pi-tui` — 全屏 TUI

## 脚本

```bash
npm run dev    # tsx index.ts
npm run start  # 同上
npx tsc --noEmit   # 类型检查
```
