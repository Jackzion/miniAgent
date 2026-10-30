import { createInterface } from "readline";
import { Chat } from "./chat.js";
import { loadConfig } from "./config.js";
import { err, out, paint } from './color.js';
import { installCliConfirm } from "./tools.js";
import { Sessions } from "./session.js";
import { loadSessions, saveSessions } from "./storage.js";

const config = loadConfig();
const chat = new Chat(config.baseURL, config.apiKey, config.model);
const sessions = new Sessions();

const rl = createInterface({ input: process.stdin, output: process.stdout });

installCliConfirm(rl);   // 把主 REPL 的 rl 注入为确认实现

// 用彩色提示符标注「用户输入」这一侧。
// setPrompt 设置提示符内容（只是设置，还没打印）
rl.setPrompt(paint('user', 'YOU >'))

let busy = false;

function printHelp(): void {
    out('sys', `可用命令：
  /help   显示帮助
  /reset  清空本轮对话记忆
  /exit   退出（等价于 Ctrl+C / Ctrl+D）
  /compact 立即压缩旧对话摘要（不等自动触发）
    已接入工具：get_current_time（当前时间）、run_shell（执行 shell 命令，执行前需确认）、ls（列目录）、read（读文件）、glob（通配符查文件）——三者只读、免确认；write（写文件）、patch（按片段精确修改）——后两者写入前会展示 diff 并确认。模型需要时会自动调用。
    历史保护：history 累积过久时自动压缩——让模型把旧对话摘要成一条「此前对话摘要」，保留最近几条消息原样，腾出上下文（压缩进度以黄色行提示）。
    输入任意内容即可与模型对话。`, true);
}

async function saveAll(): Promise<{ count: number; file: string }> {
    const data = sessions.dump(chat.exportHistory())
    const file = await saveSessions(data)
    return { count: Object.keys(data.sessions).length, file }
}

// listen userInput
// 用户按回车 → 拿到一整行 → 喂给 chat.streamReply
rl.on('line', async (raw) => {
    if (busy) return; // 上一轮还在流式输出，忽略连发输入
    busy = true;

    // 解析 userinput 
    const line = raw.trim();
    if (line) {
        if (line.startsWith('/')) {
            const [command, id] = line.split(/\s+/, 2);
            switch (command) {
                case '/help':
                    printHelp();
                    break;
                case '/reset':
                    chat.reset();
                    out('sys', '（已清空对话记忆）', true);
                    break;
                case '/exit':
                    rl.close();
                    return;
                // 压缩上下文 history - 主动
                case '/compact':
                    out('sys', '\n');
                    out('tool', `[${await chat.compact()}]`, true);
                    break;
                case '/save':
                    try {
                        const { count, file } = await saveAll();
                        out('sys', `（已保存 ${count} 个会话到 ${file}）`, true);
                    } catch (e) {
                        err('sys', `保存失败：${(e as Error).message}`);
                    }
                    break;
                case '/load':
                    try {
                        const { data, file } = await loadSessions();
                        const messages = sessions.restore(data);
                        chat.importHistory(messages);
                        out('sys', `（已从 ${file} 恢复 ${sessions.list(messages).length} 个会话，当前：${sessions.currentId()}）`, true);
                    } catch (e) {
                        err('sys', `读取失败：${(e as Error).message}`);
                    }
                    break;
                case '/new':
                    if (!id) {
                        err('sys', '用法：/new <id>');
                        break;
                    }
                    try {
                        chat.importHistory(sessions.create(id, chat.exportHistory()));
                        out('sys', `（已新建并切换到会话 ${id}）`, true);
                    } catch (e) {
                        err('sys', `新建失败：${(e as Error).message}`);
                    }
                    break;
                case '/sessions': {
                    const list = sessions.list(chat.exportHistory());
                    const lines = list.map((item) => `${item.current ? '*' : ' '} ${item.id}（${item.count} 条消息）`);
                    out('sys', `会话：\n${lines.join('\n')}`, true);
                    break;
                }
                case '/open':
                    if (!id) {
                        err('sys', '用法：/open <id>');
                        break;
                    }
                    try {
                        const messages = sessions.open(id, chat.exportHistory());
                        chat.importHistory(messages);
                        out('sys', `（已切换到会话 ${id}，${messages.length} 条消息）`, true);
                    } catch (e) {
                        err('sys', `打开失败：${(e as Error).message}`);
                    }
                    break;
                case '/exit':
                    rl.close();
                    return;
                default:
                    out('sys', `未知命令：${line}（输入 /help 查看）`, true);
            }
        } else {
            try {
                out('sys', '\n'); // 模型回复另起一行
                // 获得 chat res stream -> asyncGenerator —> 流式输出
                for await (const delta of chat.streamReply(line)) {
                    // 调用工具 ， 历史压缩用其他颜色显示
                    const isProgress = delta.startsWith('\n[调用工具') || delta.startsWith('\n[历史压缩');
                    out(isProgress ? 'tool' : 'model', delta);
                }
                out('sys', '\n');
            } catch (e) {
                err('sys', `\n请求失败：${(e as Error).message}`);
            }
        }
    }

    busy = false;
    // 弹出用户提示 
    rl.prompt();
});

// 监听 stdout 事件
rl.on('close', () => {
    // output bye
    out('sys', 'bye', true);
    saveAll()
    process.exit(0);
});

// start with chat
out('sys', `GeekAgent Day 1 —— 最简单的 Agent（模型：${config.model}，输入 /help 查看命令）`, true);
rl.prompt();
