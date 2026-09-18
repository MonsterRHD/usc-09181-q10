/** 异步互斥：写命令在同一临界区顺序提交，保证事件 seq 严格有序、跨时区并发不丢更新。 */
export class Mutex {
  constructor() {
    this._tail = Promise.resolve();
  }

  run(fn) {
    const prev = this._tail;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    this._tail = prev.then(() => gate);
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }
}
