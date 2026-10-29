import { ChatCompletionTool } from "openai/resources/index.mjs";

/**
 * 工具的最小抽象：一个名字 + 描述 + 参数 JSON Schema + 一个 run 函数。
 */
export interface Tool {
    name: string
    description: string
    /** OpenAI function 的 parameters 层（如 { type: 'object', properties, additionalProperties }） */
    // Record 动态类型 map
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
];

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