import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { registerTool, type Tool } from './tools.js';

const MEMORY_FILE = resolve('.geekagent/memory.json');
let items: string[] = [];

/** 启动时从磁盘恢复长期记忆；文件不存在等同于还没有记忆。 */
export async function loadMemory(): Promise<void> {
    try {
        const value = JSON.parse(await readFile(MEMORY_FILE, 'utf-8'));
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
            throw new Error('memory.json 必须是字符串数组');
        }
        items = value.map((item) => item.trim()).filter(Boolean);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            items = [];
            return;
        }
        throw err;
    }
}

// init memory tools
export function setupMemory(changed: () => void): void {
    const tools: Tool[] = [
        {
            name: 'memory_write',
            description: '把值得跨会话保留的用户偏好、项目事实或重要决定写入长期记忆。不要记录临时任务进度或可随时从文件读到的内容。',
            parameters: {
                type: 'object',
                properties: {
                    content: {
                        type: 'string',
                        description: '要写入长期记忆的内容',
                    },
                },
                required: ['content'],
                additionalProperties: false,
            },
            run: async (params) => {
                const content = params.content as string;
                if (!content) return '缺少参数 content';
                if (items.includes(content)) return '这条记忆已经存在';
                const next = [...items, content];
                await mkdir(dirname(MEMORY_FILE), { recursive: true });
                await writeFile(MEMORY_FILE, JSON.stringify(next, null, 2));
                items = next;
                // 触发 tui changed()
                changed();
                return '已记住：${content}';
            },
        },
        {
            name: 'memory_read',
            description: '按关键词搜索长期记忆。需要回忆用户偏好、项目事实或以前的决定时调用；query 使用一个或多个空格分隔的关键词。',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: '搜索关键词，多个词用空格分隔，如“博客 人称”',
                    },
                },
                required: ['query'],
                additionalProperties: false,
            },
            run: (params) => {
                const keywords = String(params.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
                if (keywords.length === 0) return '缺少参数 query';
                // include(keyword) -> score ++ -> slice 10 
                const matches = items.map((content) => ({
                    content,
                    score: keywords.filter((keyword) => content.toLowerCase().includes(keyword)).length
                })).filter((item) => item.score > 0)
                    .sort((a, b) => b.score - a.score)
                    .slice(0, 10);
                return matches.length > 0
                    ? `找到 ${matches.length} 条记忆：\n${matches.map((item, i) => `${i + 1}. ${item.content}`).join('\n')}`
                    : '没有找到相关记忆';
            }
        },
    ]

    tools.forEach(registerTool);
}

export function listMemory(): string[] {
    return items;
}
