import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { newId } from './ids.mjs';
import { toIso } from './clock.mjs';

/**
 * 只追加的 JSONL 事件日志 + 内存投影。
 * 程序再次运行时重放全部事件即可接续人工核查，状态不依赖易失内存。
 * 写入采用临时文件原子 rename；每条事件 fsync，行即记录、记录即完整。
 */
export class EventStore {
  constructor({ file, clock = () => new Date() } = {}) {
    this.file = file;
    this.clock = clock;
    this.records = []; // {seq, id, type, data, meta}
    this._writeStream = null;
  }

  async start() {
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this._writeStream = fs.createWriteStream(this.file, { flags: 'a' });
      await new Promise((resolve, reject) => {
        this._writeStream.once('open', resolve);
        this._writeStream.once('error', reject);
      });
    }
    for await (const rec of this._readAll()) {
      this.records.push(rec);
    }
  }

  async *_readAll() {
    if (!this.file || !fs.existsSync(this.file)) return;
    const rl = readline.createInterface({
      input: fs.createReadStream(this.file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    let seq = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line);
      seq = Math.max(seq, rec.seq);
      yield rec;
    }
    this._seq = seq;
  }

  async append(type, data, meta = {}) {
    const seq = (this._seq ??= this.records.length) + 1;
    const rec = {
      seq,
      id: newId('evt'),
      type,
      data,
      meta: { at: meta.at ?? toIso(this.clock()), actor: meta.actor ?? 'system', ...meta },
    };
    const line = JSON.stringify(rec) + '\n';
    if (this._writeStream) {
      if (!this._writeStream.write(line)) {
        await new Promise((r) => this._writeStream.once('drain', r));
      }
    }
    this.records.push(rec);
    this._seq = seq;
    return rec;
  }

  all() {
    return this.records;
  }

  async close() {
    if (!this._writeStream) return;
    await new Promise((resolve, reject) =>
      this._writeStream.end((err) => (err ? reject(err) : resolve())),
    );
    this._writeStream = null;
  }
}
