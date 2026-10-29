import 'dotenv/config'; // 把 .env 注入 process.env（Node 不会自动读取 .env，必须由此加载）

export interface Config {
    baseURL: string;
    apiKey: string;
    model: string;
}

// 从 .env 加载配置
export function loadConfig(): Config {
    const baseURL = process.env.OPENAI_BASE_URL?.trim() || 'https://api.deepseek.com'
    const apiKey = process.env.OPENAI_API_KEY?.trim() || ''
    const model = process.env.OPENAI_MODEL?.trim() || 'deepseek-v4-flash'

    if (!apiKey) {
        console.error('缺少 OPENAI_API_KEY：请复制 .env.example 为 .env 并填写。');
        process.exit(1);
    }
    return { baseURL, apiKey, model };
}