import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { clone } from './util.mjs';

/**
 * 极简 JSON 文档存储。
 * - 整库一个文件，写时序列化到临时文件再 rename（进程崩溃不会留下半截文件）
 * - 所有变更先在内存状态上完成，再由 service 层显式 save()，保证“程序再次运行后仍能接续”
 * - 路径传 ':memory:' 时为纯内存库（测试用）
 */
export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.memory = filePath === ':memory:';
    this.state = this.memory ? emptyState() : this.#load();
  }

  #load() {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return emptyState();
      throw new Error(`无法解析状态文件 ${this.filePath}: ${err.message}`);
    }
  }

  save() {
    if (this.memory) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.filePath);
  }

  get() {
    return this.state;
  }

  /** 供测试快照使用。 */
  snapshot() {
    return clone(this.state);
  }
}

export function emptyState() {
  return {
    schemaVersion: 1,
    countries: [], // {code,name,createdAt}
    roles: [], // {key,name}
    entities: [], // {id,name,countryCode,timeZone,status,createdAt}
    rulebooks: [], // {id,version,activities,effectiveFrom,publishedAt,publishedBy,note,digest}
    activeRulebookId: null,
    enrollments: [], // {id,entityId,rulebookId,activityKey,createdAt,migratedAt}
    exemptions: [], // {id,entityId,activityKey,materialKey,reason,expiresAt,grantedBy,grantedAt,revokedAt,revokedBy,revokeReason}
    evidence: [], // {id,entityId,activityKey,materialKey,source,documentRef,issuedAt,expiresAt,uploadedAt,uploadedBy,fingerprint,status,replacedBy,supersededAt,metadata}
    imports: [], // {id,source,entityId,startedAt,finishedAt,added,duplicated,superseded,rejected,stats}
    reviews: [], // {id,entityId,openedAt,openedBy,openedFromTimeZone,status,decision,checkedBlockers,closedAt,...}
    tasks: [], // {id,entityId,taskKey,kind,status,assigneeRole,detail,createdAt,updatedAt,resolvedAt,resolvedBy,resolution}
    notifications: [], // {id,dedupeKey,entityId,kind,payload,status,createdAt,deliveredAt}
    audit: [], // {seq,ts,actor,action,entityId,details,prevHash,hash}
    auditTailHash: 'GENESIS',
    counters: { auditSeq: 0 },
  };
}
