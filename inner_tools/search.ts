/** search 工具：在仓库内按内容检索代码（忽略大小写）。返回 相对路径:行号: 内容，适合找「哪个文件里出现了某段文字/某个调用」。 */
import { join, relative } from "path";
import { permissionRoot, safePath } from "../permissions";
import { Tool } from "../tools";
import { glob, readFile, stat } from "fs/promises";

/** search 最多返回的命中行数，命中太多说明关键词不够聚焦。 */
const MAX_SEARCH_RESULTS = 50;
/** search 只扫不超过这个字节数的文本文件，跳过体积可疑的大文件。 */
const MAX_SEARCH_FILE_SIZE = 1024 * 1024;

/** code-review 技能自带工具：拿到当前未提交的改动，供审查时逐 diff 阅读。 */
export const searchTool: Tool[] = [
    {
        name: 'search',
        description: '在仓库内按内容检索代码（忽略大小写）。返回 相对路径:行号: 内容，适合找「哪个文件里出现了某段文字/某个调用」。默认跳过 node_modules、隐藏路径、二进制与大于 1MB 的文件。',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: '要检索的关键词，如 "safePath"、一个函数名或一行报错文案。' },
                path: { type: 'string', description: '要检索的相对目录，默认整个仓库根目录；传子目录可加快速度。' },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
        run: async (args) => {
            const pattern = String(args.pattern ?? '').trim();
            if (!pattern) return '缺少参数 pattern';
            const sub = String(args.path ?? '').trim();
            try {
                const dir = sub ? await safePath(sub) : permissionRoot();
                const hits = await searchTree(dir, pattern.toLowerCase());
                if (hits.length === 0) return `没有匹配 "${pattern}"${sub ? `（在 ${sub} 下）` : ''}`;
                const hint = hits.length >= MAX_SEARCH_RESULTS ? `\n...(已达上限 ${MAX_SEARCH_RESULTS} 行，换更聚焦的关键词再搜)` : '';
                return `匹配 "${pattern}" ${hits.length} 行：\n${hits.join('\n')}${hint}`;
            } catch (err) {
                return `search 失败：${(err as Error).message}`;
            }
        },
    },
];

/**
 * 先使用 glob 枚举 + read line 逐行比对 ，后续上 ripgrep
 * 在 dir 目录内按内容检索：用 Node 内置 glob 枚举文件（默认跳过隐藏路径与 node_modules），
 * 跳过二进制（含空字节）与过大的文件，逐行做忽略大小写的包含匹配，凑满上限即停。
 * 返回「相对 root 的路径:行号: 内容」列表，格式照搬 ripgrep。
 */
async function searchTree(dir: string, pattern: string): Promise<string[]> {
    const root = permissionRoot();
    const prefix = relative(root, dir);
    const hits: string[] = [];
    for await (const p of glob('**/*', {
        cwd: dir,
        exclude: (d) => d.split('/').some((seg) => seg === 'node_modules' || seg.startsWith('.')),
    })) {
        if (hits.length >= MAX_SEARCH_RESULTS) break;
        const rel = (prefix ? `${prefix.replaceAll('\\', '/')}/` : '') + p.replaceAll('\\', '/');
        const file = join(dir, p);
        let st;
        try {
            st = await stat(file);
        } catch {
            continue; // 文件可能在被遍历时被删除
        }
        if (!st.isFile() || st.size > MAX_SEARCH_FILE_SIZE) continue;
        let text: string;
        try {
            text = await readFile(file, 'utf8');
        } catch {
            continue;
        }
        if (text.includes('\0')) continue; // 含空字节基本是二进制，跳过
        text.split('\n').forEach((line, i) => {
            if (hits.length >= MAX_SEARCH_RESULTS) return;
            // 逐行搜索
            if (line.toLowerCase().includes(pattern)) hits.push(`${rel}:${i + 1}: ${line.trimEnd()}`);
        });
    }
    return hits;
}