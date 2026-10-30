import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SessionData } from './session.js';
import { read } from 'node:fs';

const SESSION_FILE = resolve('.geekagent/sessions.json');

// save SessionData in json file
export async function saveSessions(data: SessionData): Promise<string> {
    await mkdir(dirname(SESSION_FILE), { recursive: true })
    await writeFile(SESSION_FILE, JSON.stringify(data, null, 2) + '\n', 'utf-8')
    return SESSION_FILE
}

// load SessionData from json file
export async function loadSessions(): Promise<{ data: unknown; file: string }> {
    return { data: JSON.parse(await readFile(SESSION_FILE, 'utf-8')), file: SESSION_FILE }
}