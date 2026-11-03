// 权限、路径与脱敏集中到一个文件
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type Policy = 'ask' | 'allow' | 'deny';

// json entity
export interface PermissionConfig {
    root: string;
    // record a type , key - string ,  value - policy 
    tools: Record<string, Policy>;
}

const DEFAULT_TOOLS: Record<string, Policy> = {
    get_current_time: 'allow',
    run_shell: 'ask',
    ls: 'allow',
    read: 'allow',
    glob: 'allow',
    write: 'ask',
    patch: 'ask',
    todo_write: 'allow',
    delegate_task: 'allow',
};

// default PermissionConfig
let config: PermissionConfig = { root: process.cwd(), tools: DEFAULT_TOOLS };
// 权限确认 confirm
let confirmFn: (prompt: string) => Promise<boolean> = async () => false;

/** 加载权限，配置不存在时写入默认权限；存在但写错时直接报错，不静默放宽。 */
export async function loadPermissions(file = '.geekagent/GeekAgent.json'): Promise<PermissionConfig> {
    let raw: string;
    try {
        // read json file
        raw = await readFile(file, 'utf8');
    } catch (err) {
        // if not exit , use default permission config
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        const defaults = { root: '..', tools: { ...DEFAULT_TOOLS } };
        // write default permission config into file path
        await mkdir(dirname(resolve(file)), { recursive: true });
        await writeFile(file, `${JSON.stringify(defaults, null, 2)}\n`);
        raw = JSON.stringify(defaults);
    }
    // parse json
    const value = JSON.parse(raw) as { root?: unknown; tools?: unknown };
    // check the field
    if (typeof value.root !== 'string' || !value.root.trim()) throw new Error('GeekAgent.json 的 root 必须是非空字符串');
    if (!value.tools || typeof value.tools !== 'object' || Array.isArray(value.tools)) {
        throw new Error('GeekAgent.json 的 tools 必须是对象');
    }
    const tools = { ...DEFAULT_TOOLS };
    for (const [name, policy] of Object.entries(value.tools)) {
        if (policy !== 'ask' && policy !== 'allow' && policy !== 'deny') {
            throw new Error(`工具 ${name} 的策略必须是 ask / allow / deny`);
        }
        tools[name] = policy;
    }
    return { root: resolve(dirname(resolve(file)), value.root), tools };
}

export function setupPermissions(next: PermissionConfig, fn: (prompt: string) => Promise<boolean>): void {
    config = next;
    confirmFn = fn;
}

export function permissionRoot(): string {
    return config.root;
}

export function policyFor(tool: string): Policy {
    return config.tools[tool] ?? 'deny';
}

/**
 * 查看 tool 是否被授权，若需要 ask 则需要 await user input , 因此需要 promise
 * @param tool 
 * @param prompt 
 * @returns 
 */
export async function authorize(tool: string, prompt = `工具 ${tool} 请求执行`): Promise<boolean> {
    const policy = policyFor(tool);
    if (policy === 'allow') return true;
    if (policy === 'deny') return false;
    return confirmFn(redact(prompt));
}

/** 返回根目录内的绝对路径，并用 realpath 挡住借符号链接越界。 */
export async function safePath(input: string): Promise<string> {
    const root = resolve(config.root);
    const target = resolve(root, input);
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`路径越界：${input}`);

    let existing = target;
    while (true) {
        try {
            existing = await realpath(existing);
            break;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            const parent = dirname(existing);
            if (parent === existing) throw err;
            existing = parent;
        }
    }
    const realRoot = await realpath(root);
    const realRel = relative(realRoot, existing);
    if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw new Error(`路径越界：${input}`);
    return target;
}

/** glob 固定以 root 为 cwd；模式本身只允许根目录内的相对写法。 */
export function safeGlob(pattern: string): string {
    if (isAbsolute(pattern) || pattern.split(/[\\/]+/).includes('..')) throw new Error(`路径越界：${pattern}`);
    return pattern;
}

/** 只屏蔽敏感环境变量的真实值，普通输出保持原样。 */
export function redact(text: string): string {
    let result = text;
    for (const [name, value] of Object.entries(process.env)) {
        if (!/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name) || !value) continue;
        // text string 要询问 user 的字符串，在展示前先屏蔽关键词
        // `// → '执行命令 curl -H "Authorization: Bearer [REDACTED:API_KEY]" https://...'`
        result = result.replaceAll(value, `[REDACTED:${name}]`);
    }
    return result;
}
