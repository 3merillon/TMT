import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
export const meshyKey = () => process.env.MESHY_API_KEY || null;

/** Stdio bridge to the official Meshy MCP. Credentials never enter arguments or logs. */
export class MeshyMcp {
    pending = new Map(); next = 1; buffer = ''; stderr = '';
    async connect() {
        const key = meshyKey();
        if (!key) throw new Error('MESHY_API_KEY is missing; set it in the environment or use node --env-file');
        const cwd = resolve('artifacts/workshop-mcp'); mkdirSync(cwd, { recursive: true });
        const args = ['-y', '@meshy-ai/meshy-mcp-server@0.5.1'];
        this.proc = spawn(process.platform === 'win32' ? 'cmd.exe' : 'npx', process.platform === 'win32' ? ['/d', '/c', 'npx', ...args] : args,
            { cwd, env: { ...process.env, MESHY_API_KEY: key, TRANSPORT: 'stdio' }, stdio: ['pipe','pipe','pipe'], windowsHide: true });
        this.proc.stdout.on('data', chunk => {
            this.buffer += chunk;
            let end;
            while ((end = this.buffer.indexOf('\n')) >= 0) {
                const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
                let msg; try { msg = JSON.parse(line); } catch { continue; }
                const task = this.pending.get(msg.id); if (!task) continue;
                this.pending.delete(msg.id); clearTimeout(task.timer);
                if (msg.error) task.reject(new Error(this.redact(JSON.stringify(msg.error)))); else task.resolve(msg.result);
            }
        });
        this.proc.stderr.on('data', d => { this.stderr = this.redact((this.stderr + d).slice(-2000)); });
        this.proc.on('error', e => this.fail(e));
        this.proc.on('exit', code => this.fail(new Error(`Meshy MCP exited ${code}: ${this.stderr}`)));
        this.server = await this.request('initialize', { protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{name:'tmt-workshop-assets',version:'1.0'} });
        this.proc.stdin.write(JSON.stringify({ jsonrpc:'2.0', method:'notifications/initialized' }) + '\n');
        this.schemas = (await this.request('tools/list', {})).tools;
        return this;
    }
    redact(s) { const key = meshyKey(); return (key ? s.replaceAll(key, '[redacted]') : s).replace(/msy[A-Za-z0-9_-]+/g, '[redacted]'); }
    fail(e) { for (const t of this.pending.values()) { clearTimeout(t.timer); t.reject(e); } this.pending.clear(); }
    request(method, params, timeout = 90000) {
        return new Promise((resolve, reject) => {
            const id = this.next++, timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Meshy ${method} timed out; do not resubmit a creation until its status is reconciled`)); }, timeout);
            this.pending.set(id, {resolve,reject,timer});
            this.proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
        });
    }
    async call(name, args = {}) {
        const result = await this.request('tools/call', {name, arguments:args}, 180000);
        const body = (result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
        if (result.isError) throw new Error(this.redact(body));
        if (result.structuredContent) return result.structuredContent;
        try { return JSON.parse(body); } catch { return {text:body}; }
    }
    close() { this.proc?.stdin.end(); this.proc?.kill(); this.fail(new Error('MCP client closed')); }
}
