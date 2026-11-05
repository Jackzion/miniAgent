// 加载与卸载技能
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerTool, setVisibleTools, unregisterTool, type Tool } from './tools.js';
import { ensureToolPolicy } from './permissions.js';

// meta.url 当前模块的 url，用于获取 skills 目录的路径
const SKILLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'skills');

let skills: Skill[] = [];
let active: Skill | null = null;

export interface Skill {
    name: string;
    description: string;
    instructions: string;
    /** 技能自带工具：加载时注册、卸载时移除，只在技能生效期间可调用。 */
    tools: Tool[];
    /** SKILL.md 头部声明的内置工具白名单；空数组 = 不收敛工具。 */
    /** 技能生效期间， 只保留名单内这些内置工具可见 ，其余的隐藏掉 */
    builtinTools: string[];
}

/** 解析 SKILL.md：头部 `---` 块里放 description / tools，两条 `---` 之间是指令正文。 */
function parseSkill(dir: string, name: string, raw: string): Skill {
    const lines = raw.split('\n');
    let description = '';
    const builtinTools: string[] = [];
    if (lines[0]?.trim() === '---') {
        let end = 1;
        while (end < lines.length && lines[end]?.trim() !== '---') {
            const line = lines[end].trim();
            // get description / tools
            if (line.startsWith('description:')) description = line.slice('description:'.length).trim();
            else if (line.startsWith('-')) builtinTools.push(line.replace(/^-\s*/, '').trim());
            end++;
        }
        lines.splice(0, end + (lines[end]?.trim() === '---' ? 1 : 0));
    }
    return { name, description, instructions: lines.join('\n').trim(), tools: [], builtinTools };
}

/** 技能目录里可选 tools.ts：导出 tools: Tool[]，作为该技能的自带工具。 */
async function loadSkillTools(dir: string): Promise<Tool[]> {
    // 转换为 node file path 用来 import tools.ts
    const file = pathToFileURL(join(dir, 'tools.ts')).href;
    try {
        // 直接 import tools.ts，获取 export const tools 数组
        const mod = await import(file);
        return (Array.isArray(mod.tools) && mod.tools) ?? [];
    } catch {
        return [];
    }
}

/** 扫描 skills/ 目录，每个子目录一个技能；解析 / 加载失败的技能直接跳过。 */
export async function loadSkills(): Promise<Skill[]> {
    skills = [];
    let entries;
    try {
        // readdir 读取 skills 目录下的所有子目录，返回目录项数组
        entries = await readdir(SKILLS_DIR, { withFileTypes: true });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return skills;
        throw err;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = join(SKILLS_DIR, entry.name);
        const name = entry.name;
        try {
            // read skill md file
            const raw = await readFile(join(dir, 'SKILL.md'), 'utf8');
            // parse skill md file and get skill info
            const skill = parseSkill(dir, name, raw);
            // load skill tools
            skill.tools = await loadSkillTools(dir);
            // register skill
            skills.push(skill);
        } catch (err) {
            console.error(`技能 ${name} 加载失败：${(err as Error).message}`);
        }
    }
    return skills;
}

export function listSkills(): readonly Skill[] {
    return skills;
}

export function activeSkill(): Skill | null {
    return active;
}

/** 卸载当前技能自带工具并恢复默认工具可见性；active 置空。 */
export function deactivateSkill(): void {
    if (!active) return;
    // 移除 active skill tools 中的所有工具
    for (const tool of active.tools) unregisterTool(tool);
    // active and visibleTools 置空
    active = null;
    setVisibleTools(null);
}

/** 激活技能 */
export function activateSkill(name: string): void {
    const activeSkill = skills.find((s) => s.name === name);
    if (!activeSkill) throw new Error(`技能 ${name} 不存在`);
    // 先卸载当前技能自带工具
    deactivateSkill();
    // 注册 active skill tools 中的所有工具
    for (const tool of activeSkill.tools) {
        // 技能工具默认 ask，用户可自行在配置里改 allow
        ensureToolPolicy(tool.name, 'ask');
        // 注册工具
        registerTool(tool);
    }
    // 设置可见工具
    setVisibleTools(activeSkill.builtinTools.length > 0 ? [...activeSkill.builtinTools, ...activeSkill.tools.map((tool) => tool.name)] : null);
    // active 置为 active skill
    active = activeSkill;
}


/** 描述当前技能带什么工具：自带工具 + 内置工具收敛的白名单，都展示出来。 */
export function describeActiveSkill(): string {
    const skill = activeSkill();
    if (!skill) return '无';
    const parts: string[] = [];
    if (skill.tools.length) parts.push(`自带工具：${skill.tools.map((t) => t.name).join('、')}`);
    if (skill.builtinTools.length) parts.push(`内置工具：${skill.builtinTools.join('、')}`);
    return parts.length ? `${skill.name}（${parts.join('；')}）` : skill.name;
}
