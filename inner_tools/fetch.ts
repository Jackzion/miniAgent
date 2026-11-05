/** 抓取网页并转成纯文本，让模型看到仓库之外的信息。默认 ask 策略，执行前需要确认；只支持 http/https。 
 * 后续考虑 使用 cheerio 解析 DOM，或用 turndown 转成 Markdown
*/
import { authorize } from "../permissions.js";
import { Tool, truncate } from "../tools.js";

/** fetch 最长的等待时间，超时按失败处理。 */
const FETCH_TIMEOUT_MS = 15_000;

export const fetchTool: Tool[] = [
    {
        name: 'fetch',
        description: '抓取一个网页并转成纯文本，让模型看到仓库之外的信息（文档、博文、报错页等）。默认 ask 策略，执行前需要确认；只支持 http/https。',
        parameters: {
            type: 'object',
            properties: { url: { type: 'string', description: '要访问的完整网址，以 http:// 或 https:// 开头。' } },
            required: ['url'],
            additionalProperties: false,
        },
        run: async (args) => {
            const input = String(args.url ?? '').trim();
            if (!input) return '缺少参数 url';
            let target: URL;
            try {
                target = new URL(input);
            } catch {
                return `URL 不合法：${input}`;
            }
            if (target.protocol !== 'http:' && target.protocol !== 'https:') return '只支持 http/https 链接';
            if (!(await authorize('fetch', `\n即将访问网页：\n${input}\n确认抓取？`))) return '已取消抓取';
            try {
                const res = await fetch(target, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
                if (!res.ok) return `请求失败：HTTP ${res.status} ${res.statusText}`;
                const text = await res.text();
                const contentType = res.headers.get('content-type') ?? '';
                const body = /\bhtml\b/.test(contentType) ? htmlToText(text) : text;
                return truncate(body);
            } catch (err) {
                const e = err as Error;
                return e.name === 'TimeoutError' ? `抓取超时（${FETCH_TIMEOUT_MS / 1000}s），可稍后重试` : `抓取失败：${e.message}`;
            }
        },
        authorizes: true,
    },
]

/**
 * 极简 HTML → 纯文本：剥掉脚本/样式/注释，块级标签换行，解码常见实体。
 * 不追求完整解析，够把文档、博文读成模型能用的文本。
 */
function htmlToText(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<\/(?:p|div|h[1-6]|li|ul|ol|tr|td|th|table|pre|blockquote|section|article|header|footer)>/gi, '\n')
        .replace(/<(?:br|hr)[\s\S]*?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&nbsp;/gi, ' ')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n');
}