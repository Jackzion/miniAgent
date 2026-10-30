import { error } from "console";
import { randomUUID } from "crypto";
import OpenAI from "openai";

export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const ROLES = new Set(['system', 'user', 'assistant', 'tool', 'developer', 'function']);

export interface SessionData {
    current: string
    sessions: Record<string, Message[]>
}

/** 多会话集合；增加整个集合的序列化与恢复。 */
export class Sessions {

    private items = new Map<string, Message[]>([['default', []]]);
    private current = 'default';

    currentId(): string {
        return this.current;
    }

    nameDefault(currentMessages: Message[]): string | undefined {
        // 已有名字的会话返回 undefined，退出提示也就不额外打印 ID
        if (this.current !== 'default') return undefined;
        let id: string;
        // UUID 生成一个不重复的 session id
        do id = randomUUID().slice(0, 8); while (this.items.has(id));
        // remove default in map
        this.items.delete('default');
        // save new session with sessionId 
        this.items.set(id, currentMessages);
        this.current = id;
        return id;
    }

    // save current session and creat a new session with empty messages
    create(id: string, currentMessages: Message[]): Message[] {
        checkId(id);
        if (this.items.has(id)) throw new Error(`会话 ${id} 已存在`);
        this.items.set(this.current, currentMessages);
        this.items.set(id, []);
        this.current = id;
        return [];
    }

    // save current and list messages with id
    open(id: string, currentMessages: Message[]): Message[] {
        checkId(id)
        if (id === this.current) {
            this.items.set(id, currentMessages)
            return currentMessages
        }
        const message = this.items.get(id)
        if (!message) throw new Error(`会话 ${id} 不存在`)
        this.items.set(this.current, currentMessages)
        this.current = id
        return message
    }

    // save current and list current messages
    list(currentMessages: Message[]): { id: string; count: number; current: boolean }[] {
        this.items.set(this.current, currentMessages)
        return [...this.items]
            .map(([id, message]) => ({ id, count: message.length, current: id === this.current }))
            .sort((a, b) => a.id.localeCompare(b.id))
    }

    // dump to SessionData
    dump(currentMessages: Message[]): SessionData {
        // save current
        this.items.set(this.current, currentMessages)
        return { current: this.current, sessions: Object.fromEntries(this.items) }
    }

    // load sessionData from data 
    restore(data: unknown): Message[] {
        // 校验 sessionData 是否符合格式
        if (!isSessionData(data)) throw new Error('存档不是有效的多会话数据');
        // load 
        this.items = new Map(Object.entries(data.sessions));
        this.current = data.current;
        return this.items.get(this.current)!;
    }
}

// 校验 id 格式
function checkId(id: string): void {
    if (!ID_PATTERN.test(id)) throw new Error('会话 ID 只能包含字母、数字、短横线和下划线');
}

// 判断是否 is sessionData type ， value is SessionData 后续可通过校验
function isSessionData(value: unknown): value is SessionData {
    // null return false
    if (!value || typeof value !== 'object') return false;
    // 类型断言
    const data = value as Partial<SessionData>;
    if (typeof data.current !== 'string' || !data.sessions || typeof data.sessions !== 'object') return false;
    // 校验 id 格式 ， message type and is Message ？ 
    return Object.entries(data.sessions).every(([id, messages]) =>
        ID_PATTERN.test(id) && Array.isArray(messages) && messages.every(isMessage)
    ) && Object.hasOwn(data.sessions, data.current);
}

// 校验 message 格式
function isMessage(value: unknown): boolean {
    // null return false
    if (!value || typeof value !== 'object') return false;
    const role = (value as { role?: unknown }).role;
    return typeof role === 'string' && ROLES.has(role);
}