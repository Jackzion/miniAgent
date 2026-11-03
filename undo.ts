// 新增模块负责写入快照和消费快照
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { permissionRoot, safePath } from './permissions.js';

const UNDO_FILE = resolve('.geekagent/undo.json');

interface UndoRecord {
    path: string;   // 上一次写入的文件路径     
    content: string | null; // 上一次写入前的文件内容
}

/** 写盘前保存最近一次文件状态；null 表示文件原先不存在。 */
export async function backup(file: string, content: string | null): Promise<void> {
    const record: UndoRecord = {
        path: relative(permissionRoot(), file).replaceAll('\\', '/'),
        content,
    };
    await mkdir(dirname(UNDO_FILE), { recursive: true });
    await writeFile(UNDO_FILE, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/** 恢复最近一次写入前的状态，成功后删除快照，避免重复撤销。 */
export async function undo(): Promise<string> {
    let record: UndoRecord;
    try {
        // read backup record
        record = JSON.parse(await readFile(UNDO_FILE, 'utf8')) as UndoRecord;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '没有可撤销的写入';
        throw new Error(`撤销记录读取失败：${(err as Error).message}`);
    }
    // check field
    if (typeof record.path !== 'string' || (record.content !== null && typeof record.content !== 'string')) {
        throw new Error('撤销记录格式无效');
    }

    const file = await safePath(record.path);
    if (record.content === null) {
        try {
            // content 为空 delete file 
            await unlink(file);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
    } else {
        // write file 
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, record.content, 'utf8');
    }
    await unlink(UNDO_FILE);
    return `已撤销对 ${record.path} 的最近一次写入`;
}