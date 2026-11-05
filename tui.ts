// day7/tui.ts
// Author: hjz
// Date: 2026-11-02
import {
    HStack,
    Input,
    Key,
    matchesKey,
    ProcessTerminal,
    ScrollView,
    setKeybindings,
    sliceByColumn,
    Text,
    TuiAltScreen,
    truncateToWidth,
    visibleWidth,
    VStack,
    KeybindingsManager,
    TUI_KEYBINDINGS,
    type Component,
    type Focusable,
} from '@earendil-works/pi-tui';
import { paint } from './color.js';

// 默认 lineUp/lineDown 没有键位；补上 ↑/↓ 单行滚动（PageUp/PageDown、滚轮仍可用）。
// 必须在任何 getKeybindings() 之前设置。
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, {
    'tui.altScreen.lineUp': ['up'],
    'tui.altScreen.lineDown': ['down'],
}));

/**
 * pi-tui 用法速览（本文件所有组件都围绕这几个概念）：
 * - Component 契约：实现 render(width): string[]（产出若干行文本）与 invalidate()（清内部缓存）。
 *   组件从不直接写终端，只产出文本行，由 screen 统一做差量绘制。
 * - Focusable 契约：实现 focused 属性；只有 setFocus 到的组件才会收到按键事件。
 * - 布局契约：VStack / HStack 子项用 { basis, grow, shrink, minSize, visible } 描述伸缩——
 *   basis=初始占位，grow=瓜分剩余空间，shrink=空间不足时的可压缩量，visible=按宽度条件隐藏。
 * - 渲染触发：改完数据调 screen.requestRender()，pi-tui 在下一帧对比新旧行做局部刷新。
 */
export type Color = 'user' | 'model' | 'tool' | 'sys';

/** 简易 token 估算：中文 1 字约 1 token、英文约 4 字符 1 token，混合取 2 字符 1 token。 */
export function estimateTokens(text: string): number {
    return Math.ceil([...text].length / 2);
}

interface Line {
    text: string;
    color: Color;
}

const PANEL_WIDTH = 28;
const MAX_LINES = 1000;

/**
 * 固定宽度的右侧信息栏；窄终端下由 HStack 自动隐藏。
 * 实现 Component 只需两件事：render 产出文本行、invalidate 置空（本组件无缓存，故为空实现）。
 */
class Panel implements Component {
    constructor(private getLines: () => string[]) {}

    render(width: number): string[] {
        return this.getLines().map((line) => paint('sys', `│ ${truncateToWidth(line, Math.max(1, width - 2))}`));
    }

    invalidate(): void {}
}

/**
 * 输入区把提示符和 pi-tui 的单行 Input 拼在一起，并把焦点传给 Input 以支持中文输入法。
 * 实现 Focusable 只为把 focused / handleInput 原样转发给内部 Input：
 * 键盘事件只路由给聚焦组件，转发后输入法的组合（composition）序列才能落到 Input 上处理。
 */
class InputRow implements Component, Focusable {
    private input = new Input();
    private prompt: Color = 'user';
    private promptText = 'You › ';

    constructor(onSubmit: (value: string) => void) {
        this.input.onSubmit = onSubmit;
    }

    get focused(): boolean {
        return this.input.focused;
    }

    set focused(value: boolean) {
        this.input.focused = value;
    }

    setPrompt(color: Color, text: string): void {
        this.prompt = color;
        this.promptText = text;
    }

    takeValue(): string {
        const value = this.input.getValue().trim();
        this.input.setValue('');
        return value;
    }

    clear(): void {
        this.input.setValue('');
    }

    handleInput(data: string): void {
        this.input.handleInput(data);
    }

    render(width: number): string[] {
        const prompt = paint(this.prompt, this.promptText);
        const inputWidth = Math.max(1, width - visibleWidth(prompt));
        // Input 自带 "> "，这里切掉后换成项目沿用的提示符。
        const value = sliceByColumn(this.input.render(inputWidth + 2)[0] ?? '', 2, inputWidth, true);
        // 把 prompt 与 Input 合并成一行，宽度占满全屏，You › input.render()
        return [paint('sys', '─'.repeat(width)), `${prompt}${value}`];
    }

    invalidate(): void {
        this.input.invalidate();
    }
}

/**
 * 轻量 TUI：左侧滚动消息流，右侧常驻面板，底部单行输入。
 * 全屏切换、局部刷新、中文宽度、输入编辑与窗口大小变化交给 pi-tui。
 *
 * 对外用法（上层驱动）：
 *   start() / stop()   进入 / 退出备用屏幕，start 后焦点自动落在输入框
 *   append / appendInline  向消息流追加一行 / 续写最后一行（流式输出用后者）
 *   setPanel(lines)    更新右侧信息栏（token 数、模型名等）
 *   setBusy(true)      模型生成期间忽略回车；生成完成后 ready() 恢复焦点
 *   confirm(prompt)    打印问题并 await 用户 y/N，工具执行危险操作前调用
 *   onLine(text)       用户回车后的回调，由上层发给模型
 */
export class TUI {
    private terminal = new ProcessTerminal();
    // screen entity
    private screen = new TuiAltScreen(this.terminal, true, undefined, { mouse: true });
    private log = new Text('', 1, 0);
    // 输入框 prompt + input
    private input: InputRow;
    private lines: Line[] = [];
    private panelLines: string[] = [];
    private busy = false;
    private exiting = false;
    private confirmQuestion: string | null = null;
    private confirmResolve: ((ok: boolean) => void) | null = null;

    constructor(
        private onLine: (line: string) => void,
        private onExit: () => void,
    ) {
        this.input = new InputRow(() => this.submit());
        // [Plan] 布局树：垂直方向 = 消息体（吃满剩余高度）+ 输入行（固定 2 行）；
        //        消息体水平方向 = ScrollView 消息流（grow 吃掉剩余宽度）+ 右侧面板（固定 28 列）；
        //        visible 条件让面板在窄终端（<60 列）自动隐藏，消息流随之占满全宽。
        const body = new HStack([
            {
                component: new ScrollView(this.log, { follow: 'end', primary: true, scrollbar: 'auto' }),
                basis: 0,
                grow: 1,
                minSize: 20,
            },
            {
                component: new Panel(() => this.panelLines),
                basis: PANEL_WIDTH,
                shrink: 0,
                visible: ({ width }) => width >= 60,
            },
        ], { gap: 1 });
        this.screen.setLayoutRoot(new VStack([
            { component: body, basis: 0, grow: 1, minSize: 1 },
            { component: this.input, basis: 2, shrink: 0 },
        ]));
        // 全局按键监听先于焦点组件收到事件；返回 { consume: true } 表示吞掉，不再透传给 Input。
        this.screen.addInputListener((data) => {
            if (matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.ctrl('d'))) {
                void this.onExit();
                return { consume: true };
            }
        });
    }

    start(): void {
        // start() 切到备用屏幕（alt screen）并开始接管渲染与按键；setFocus 让输入框收到按键。
        this.screen.start();
        this.screen.setFocus(this.input);
    }

    stop(): void {
        // exiting 防止 Ctrl+C 与 onExit 重复触发；preserveScreen 退出后保留屏幕内容。
        if (this.exiting) return;
        this.exiting = true;
        this.screen.stop({ preserveScreen: true });
    }

    append(text: string, color: Color): void {
        // 只往内存 lines 里存（超 MAX_LINES 丢弃最旧的），实际绘制统一在 render() 触发。
        for (const line of text.replace(/\r\n/g, '\n').split('\n')) this.lines.push({ text: line, color });
        if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
        this.render();
    }

    appendInline(text: string, color: Color): void {
        // 把增量接到上一行同色文本末尾
        const last = this.lines[this.lines.length - 1];
        if (last && last.color === color) last.text += text;
        else this.lines.push({ text, color });
        this.render();
    }

    setPanel(lines: string[]): void {
        this.panelLines = lines;
        this.screen.requestRender();
    }

    setBusy(busy: boolean): void {
        this.busy = busy;
    }

    ready(): void {
        if (!this.busy && this.confirmQuestion === null) this.screen.setFocus(this.input);
    }

    confirm(prompt: string): Promise<boolean> {
        // [Plan] 打印问题 → 提示符切成 [y/N] → 把 resolve 暂存；用户回车进 submit() 时才 resolve，
        //        调用方只需 await tui.confirm(...) 即可拿到结果（tools.ts 注入的 confirm 走这里）。
        const parts = prompt.replace(/\r\n/g, '\n').split('\n').map((s) => s.trimEnd()).filter(Boolean);
        const question = parts.pop() ?? '确认';
        for (const part of parts) this.append(part, 'tool');
        this.append(question, 'tool');
        this.confirmQuestion = question;
        this.input.setPrompt('tool', '[y/N] ');
        this.input.clear();
        this.screen.setFocus(this.input);
        this.screen.requestRender();
        return new Promise((resolve) => {
            this.confirmResolve = resolve;
        });
    }

    private submit(): void {
        // 输入分两态：confirm 待答时本次回车算 y/N 并 resolve 掉 Promise；
        // 平时（非 confirm、非 busy）回车才把消息经 onLine 交给上层。
        const line = this.input.takeValue();
        if (this.confirmQuestion !== null) {
            const ok = line.toLowerCase() === 'y';
            const question = this.confirmQuestion;
            const resolve = this.confirmResolve;
            this.confirmQuestion = null;
            this.confirmResolve = null;
            this.input.setPrompt('user', 'You › ');
            const last = this.lines[this.lines.length - 1];
            if (last?.color === 'tool' && last.text === question) {
                last.text += ` → ${ok ? 'y' : 'n'}`;
                this.render();
            } else {
                this.append(`${question} → ${ok ? 'y' : 'n'}`, 'tool');
            }
            resolve?.(ok);
            return;
        }
        if (!line || this.busy) return;
        this.append(`You › ${line}`, 'user');
        this.onLine(line);
    }

    private render(): void {
        // 把带颜色的行拼成整段文本 setText 给 Text 组件，再 requestRender() 请求一帧差量刷新，
        // 由 pi-tui 对比新旧行只重绘变化部分。
        this.log.setText(this.lines.map((line) => paint(line.color, line.text)).join('\n'));
        this.screen.requestRender();
    }
}