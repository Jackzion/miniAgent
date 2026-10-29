import { createInterface } from "readline";
import { Chat } from "./chat.js";
import { loadConfig } from "./config.js";
import { err, out, paint } from './color.js';

const config = loadConfig();
const chat = new Chat(config.baseURL, config.apiKey, config.model);

const rl = createInterface({ input: process.stdin, output: process.stdout });
// 用彩色提示符标注「用户输入」这一侧。
// setPrompt 设置提示符内容（只是设置，还没打印）
rl.setPrompt(paint('user' , 'YOU >'))

let busy = false;

function printHelp(): void {
    out('sys', `可用命令：
  /help   显示帮助
  /reset  清空本轮对话记忆
  /exit   退出（等价于 Ctrl+C / Ctrl+D）
输入任意内容即可与模型对话。`, true);
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
            switch (line) {
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
                default:
                    out('sys', `未知命令：${line}（输入 /help 查看）`, true);
            }
        } else {
            try {
                out('sys', '\n'); // 模型回复另起一行
                // 获得 chat res stream -> asyncGenerator —> 流式输出
                for await (const delta of chat.streamReply(line)) {
                    out('model', delta);
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
    process.exit(0);
});

// start with chat
out('sys', `GeekAgent Day 1 —— 最简单的 Agent（模型：${config.model}，输入 /help 查看命令）`, true);
rl.prompt();
