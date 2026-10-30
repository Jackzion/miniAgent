import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { execTool, toOpenAITools } from './tools.js';
import { promises } from 'node:dns';
import { out } from './color.js';

/** 工具调用循环的最多轮数，防止模型陷入「调用工具 → 再调用」的死循环。 */
const MAX_TOOL_TURNS = 5;
/** 压缩上下文时保留原文条数 */
const KEEP_RECENT = 3;
/** 触发历史压缩的字符阈值：history 序列化总长超过即把旧消息压成摘要。可用环境变量调小以便观察触发过程。 */
const MAX_HISTORY_CHARS = Number(process.env.GEEKAGENT_MAX_HISTORY) || 4000;

/** 历史压缩的prompt：把旧对话压成要点，浓缩关键事实、决定与未完成事项。 */
const COMPRESS_SYSTEM = `你是对话压缩器。把用户贴出的历史对话压缩成简洁的中文要点，尽量保留以下信息：
- 用户的目标、需求、做过的决定与偏好；
- 出现过的文件路径、shell 命令、工具调用与关键结论；
- 尚未完成、仍在推进中的事项。
只输出压缩后的要点，不要解释、不要寒暄、不要保留逐字对话。`;

/**
 * 对话会话：持有上下文记忆（history），以流式方式请求 OpenAI 兼容接口。
 * history 直接用 OpenAI 的消息类型，与接口零转换（Day 2+ 的工具消息同样适用）。
 */
export class Chat {
    private client: OpenAI; // openai client
    private model: string;  // model config name
    private history: ChatCompletionMessageParam[] = []; // ChatCompletionMessageParam -> [{role:string,content:string}]
    constructor(baseURL: string, apiKey: string, model: string) {
        this.client = new OpenAI({ baseURL, apiKey });
        this.model = model;
    }

    /** 携带 history 发送用户输入，逐段产出回复增量；结束后把完整回答写入 history。 */
    async *streamReply(userInput: string): AsyncGenerator<string> {
        // push userInput to history
        this.history.push({ role: 'user', content: userInput });
        try {
            // history 超长时，先压缩
            if (this.historySize() > MAX_HISTORY_CHARS) {
                try {
                    const dropped = await this.compactOldMessages()
                    yield dropped > 0
                        ? `\n[历史压缩：${dropped} 条旧消息合并为 1 条摘要]\n`
                        : '\n[历史压缩：模型未产出摘要，保留原历史]\n';
                } catch {
                    yield '\n[历史压缩失败：保留原历史]\n';
                }
            }

            // 设置最大调用 tools 次数 ， 避免进入调用 tools 死循环
            for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
                // 请求 ， 返回 Stream<OpenAI.Chat.Completions.ChatCompletionChunk>
                const stream = await this.client.chat.completions.create({
                    model: this.model,
                    messages: this.history, // 每轮全量携带历史
                    stream: true,
                    tools: toOpenAITools(), // 开始请求时，告知本地 tools
                });
                // 流式边攒内容边聚拢工具调用（delta 按 index 碎片下发）
                let answer = '';
                const calls = new Map<number, { id: string; name: string; args: string }>()
                // for await ChatCompletionChunk , 对每个 chunk 异步等待，完成才 append 到 answer
                for await (const chunk of stream) {
                    const delta = chunk.choices[0]?.delta;
                    if (delta?.content) {
                        // append to answer
                        answer += delta.content;
                        // 对应 asyncGenerator , 调用方能不间断收到 output
                        yield delta.content; // 边收边吐
                    }
                    // 处理 tool_call , 收集起来聚拢到 calls map 中
                    //   { role: 'assistant', content: null,
                    //   tool_calls: [{ id: 'call_0', type: 'function',
                    //   function: { name: 'get_current_time', arguments: '{}' } }] },
                    for (const tc of delta?.tool_calls ?? []) {
                        // calls map 不存在， new 一个
                        let call = calls.get(tc.index);
                        if (!call) {
                            call = { id: '', name: '', args: '' }
                            calls.set(tc.index, call)
                        }
                        // set call value
                        if (tc.id) call.id = tc.id;
                        if (tc.function?.name) call.name += tc.function.name;
                        if (tc.function?.arguments) call.args += tc.function.arguments;
                    }
                }

                const toolCalls = [...calls.values()]

                // calls length 大于 0 ， 并且 every c.name 不为空
                if (toolCalls.length > 0 && toolCalls.every((c) => c.name)) {
                    // 模型要动手：先把这条 assistant 消息（含 tool_calls）记入 history
                    toolCalls.forEach((c, i) => {
                        // 若对不上 id，接口直接 400——这就是要补 id 的原因
                        if (!c.id) c.id = `call_${i}`
                    })
                    // push tool_calls in history
                    this.history.push({
                        role: 'assistant',
                        content: answer || null,
                        tool_calls: toolCalls.map((c) => ({
                            id: c.id,
                            type: 'function' as const,
                            function: { name: c.name, arguments: c.args },
                        })),
                    });
                    // 逐个执行并把结果以 role=tool 消息回传，然后进入下一轮
                    for (const c of toolCalls) {
                        // execTool and get the result
                        const result = await execTool(c.name, c.args);
                        // std output result
                        yield `\n[调用工具 ${c.name} → ${result}]\n`;
                        // push tool_call result to history
                        // { role: 'tool', tool_call_id: 'call_0', content: '2026/8/26 15:42:11' },
                        this.history.push({ role: 'tool', tool_call_id: c.id, content: result });
                    }
                    continue;   // 携带 tool_calls  result 重新提问
                }
                // push answer to history
                this.history.push({ role: 'assistant', content: answer });
                return
            }
            // 轮次用尽仍未停下：兜底收尾，保持 history 有来有回
            yield '\n[工具调用轮次过多，已停止]';
            this.history.push({ role: 'assistant', content: '[工具调用轮次过多，已停止]' });
        } catch (err) {
            this.history.pop(); // 出错回滚，保持「有来有回」
            throw err;
        }
    }

    // reset history
    reset(): void {
        this.history = []
    }


    /** history 的粗略体积：按消息序列化后的字符数估算，超出 MAX_HISTORY_CHARS 即需压缩。 */
    private historySize(): number {
        return this.history.reduce((n, m) => n + JSON.stringify(m).length, 0);
    }

    /**
     * 历史压缩：把除最近 KEEP_RECENT 条以外的旧消息交给模型摘要，
     * 用一条 system 摘要消息替换它们，让上下文变薄。
     * 返回被合并掉的旧消息条数；模型没产出摘要时返回 0，本次不做替换。
     */
    private async compactOldMessages(): Promise<number> {
        const split = this.history.length - KEEP_RECENT;
        if (split <= 0) return 0    // 历史不够长，无旧信息可压
        const old = this.history.slice(0, split)
        const recent = this.history.slice(split)
        // reqeust llm to compact history message
        const res = await this.client.chat.completions.create({
            model: this.model,
            messages: [
                { role: 'system', content: COMPRESS_SYSTEM },
                { role: 'user', content: JSON.stringify(old, null, 2) },
            ]
        })
        const text = res.choices[0]?.message?.content?.trim()
        if (!text) return 0
        // put summary in history
        out('model', `【此前对话摘要】\n${text}`)
        this.history = [{ role: 'system', content: `【此前对话摘要】\n${text}` }, ...recent]
        return old.length
    }

    /**
     * 主动压缩：随时把旧消息摘成一条摘要，不等历史超阈值（/compact 命令调用）。
     * 返回给用户看的提示文案，不带方括号；压缩失败不抛错，返回失败说明。
     */
    async compact(): Promise<string> {
        if (this.history.length <= KEEP_RECENT) return '历史压缩：没有可压缩的旧消息';
        try {
            // 直接调用 compactOldMessages
            const dropped = await this.compactOldMessages();
            return dropped > 0
                ? `历史压缩：${dropped} 条旧消息合并为 1 条摘要`
                : '历史压缩：模型未产出摘要，保留原历史';
        } catch {
            return '历史压缩失败：保留原历史';
        }
    }

    // get history
    exportHistory(): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
        return this.history;
    }

    // set hitstory
    importHistory(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): void {
        this.history = messages;
    }
}
