import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * 对话会话：持有上下文记忆（history），以流式方式请求 OpenAI 兼容接口。
 * history 直接用 OpenAI 的消息类型，与接口零转换（Day 2+ 的工具消息同样适用）。
 */
export class Chat {
    private client: OpenAI; // openai client
    private model: string;  // model config name
    private history: ChatCompletionMessageParam[] = []; // ChatCompletionMessageParam -> [{role:string,input/output:string}]

  constructor(baseURL: string, apiKey: string, model: string) {
    this.client = new OpenAI({ baseURL, apiKey });
    this.model = model;
  }

    /** 携带 history 发送用户输入，逐段产出回复增量；结束后把完整回答写入 history。 */
    async *streamReply(userInput: string): AsyncGenerator<string> {
        // push userInput to history
        this.history.push({ role: 'user', content: userInput });
        try {
            // 请求 ， 返回 Stream<OpenAI.Chat.Completions.ChatCompletionChunk>
            const stream = await this.client.chat.completions.create({
                model: this.model,
                messages: this.history, // 每轮全量携带历史
                stream: true,
            });

            let answer = '';
            // for await ChatCompletionChunk , 对每个 chunk 异步等待，完成才 append 到 answer
            for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta?.content ?? '';
                if (delta) {
                    // append to answer
                    answer += delta;
                    // 对应 asyncGenerator , 调用方能不间断收到 output
                    yield delta; // 边收边吐
                }
            }
            // push answer to history
            this.history.push({ role: 'assistant', content: answer });
        } catch (err) {
            this.history.pop(); // 出错回滚，保持「有来有回」
            throw err;
        }
    }

    // reset history
    reset(): void {
        this.history = []
    }
}
