import { promisify } from "node:util";
import { ChatCompletionTool } from "openai/resources/index.mjs";
import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ReadLine } from "node:readline";
import { out } from "./color.js";

const execAsync = promisify(exec);

const SHELL_TIMEOUT_MS = 10_000;   // 单条命令最长运行时间，超时杀进程
const MAX_OUTPUT_CHARS = 2000;     // 输出超此字符数截断，避免撑爆上下文

/** Windows 上优先 Git Bash（能跑 ls -la），否则退回 PowerShell。 */
const GIT_BASH_PATHS = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];

function resolveShell(): string {
    if (process.platform !== 'win32') return process.env.SHELL ?? '/bin/sh';
    return GIT_BASH_PATHS.find((p) => existsSync(p)) ?? 'powershell.exe';
}

/**
 * 工具的最小抽象：一个名字 + 描述 + 参数 JSON Schema + 一个 run 函数。
 */
export interface Tool {
    name: string
    description: string
    /** OpenAI function 的 parameters 层（如 { type: 'object', properties, additionalProperties }） */
    // `Record<K,V>`：TS 工具类型，描述普通对象
    parameters: Record<string, unknown>
    run(args: Record<string, unknown>): Promise<string> | string
}

/** 全部已接入工具。模型只会拿到这份清单里声明的函数。 */
export const TOOLS: Tool[] = [
    {
        name: 'get_current_time',
        description: '获取当前本地时间（Asia/Shanghai）。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    },
    {
        name: 'run_shell',
        description: '在本地执行一条 shell 命令，返回合并后的标准输出/错误。Windows优先 PowerShell；其它系统走 sh。执行前会向用户确认。',
        // openai format
        parameters: {
            type: 'object',
            properties: { command: { type: 'string', description: '要执行的 shell 命令' } }, // args name and type define
            required: ['command'],
            additionalProperties: false,
        },
        run: async (args) => {
            const command = String(args.command ?? '').trim();
            if (!command) return '缺少参数 command';

            if (!(await confirm(`即将执行命令：${command}`))) {
                return '已取消执行';
            }

            try {
                const { stdout, stderr } = await execAsync(command, {
                    timeout: SHELL_TIMEOUT_MS,
                    maxBuffer: MAX_OUTPUT_CHARS * 4,
                    shell: resolveShell(),
                });
                // 把 stdout ，stderr 拼一起塞数组
                // `filter(Boolean)` 一次把 `''`、`undefined`、`null`
                return truncate([stdout, stderr].filter(Boolean).join('\n') || '(无输出)');
            } catch (err) {
                const e = err as { message: string; stdout?: string; stderr?: string };
                const partial = [e.stdout, e.stderr].filter(Boolean).join('\n');
                return truncate(`命令执行失败（${e.message}）\n${partial}`);
            }
        },
    }
];

/** 超出阈值就截断输出，并附上原长度提示。 */
function truncate(text: string): string {
    if (text.length <= MAX_OUTPUT_CHARS) return text;
    return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...(输出已截断，原共 ${text.length} 字符)`;
}

type ConfirmFn = (prompt: string) => Promise<boolean>;

let confirm: ConfirmFn = async () => false;   // 未注入时一律拒绝，命令不会在无人确认下执行

/** 注入交互式确认逻辑（后续权限模型可在此替换）。 */
export function setConfirmFn(fn: ConfirmFn): void {
    confirm = fn;
}

// 基于「唯一的那一个」readline 接口构造 CLI 确认：临时挂一个 line 监听器读一次回答，
// 读完即移除，主 rl 始终不 close。默认 CLI 实现，属于 tools 内部细节，不单独导出。
function buildCliConfirm(rl: ReadLine): ConfirmFn {
    return (prompt) =>
        // promise define
        new Promise<boolean>((resolve) => {
            const onLine = (raw: string) => {
                rl.removeListener('line', onLine);
                const ans = raw.trim().toLowerCase();
                // complete the promise and return the value
                resolve(ans === 'y' || ans === 'yes');
            };
            // 临时挂一个 line 监听器读一次回答
            rl.on('line', onLine);
            rl.resume();
            out('tool', `${prompt} [y/N] `);   // 确认提示染黄色，一眼认出是危险操作
        });
}

/** 用主 REPL 的 readline 接口安装 CLI 确认（index.ts 调用这一行即可）。 */
export function installCliConfirm(rl: ReadLine): void {
    setConfirmFn(buildCliConfirm(rl));
}

/** 把内部 Tool 转成 OpenAI Chat Completions 的 tools 参数格式。 */
export function toOpenAITools(): ChatCompletionTool[] {
    return TOOLS.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }));
}

// execTool , 根据 llm 返回的 tool_calls 带来的 function name and argument(json) 执行本地 method 返回 string result
export async function execTool(name: string, argsJson: string): Promise<string> {
    // find tool
    const tool = TOOLS.find((t) => t.name === name)
    if (!tool) return `未知工具：${name}`;

    // 解析 argsJson 用 Record<string,json>接收
    let args: Record<string, unknown> = {};
    try {
        args = argsJson ? JSON.parse(argsJson) : {};
    } catch {
        return `参数不是合法 JSON：${argsJson}`;
    }

    // 执行 tool.run(args) return string to llm
    try {
        return await tool.run(args);
    } catch (err) {
        return `工具执行失败：${(err as Error).message}`;
    }
}