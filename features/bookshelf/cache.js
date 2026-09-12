// features/bookshelf/cache.js
// 聊天列表缓存：按角色 avatar 维度缓存「聊天列表拉取 Promise」，带 TTL。

const DEFAULT_TTL = 60_000; // 1 分钟

/**
 * 创建聊天列表缓存核心。
 * @param {object} deps 依赖注入
 * @param {Function} deps.fetcher (avatar) => Promise<Array> 实际的聊天列表拉取函数
 * @param {number} [deps.ttl=60000] 缓存有效期（毫秒）
 * @returns {{ get: Function, invalidate: Function, clear: Function }}
 */
export function createChatCacheCore(deps) {
  const { fetcher, ttl = DEFAULT_TTL } = deps;
  /** @type {Map<string, { promise: Promise, ts: number }>} */
  const store = new Map();

  /**
   * 取某角色的聊天列表（带缓存）。
   * @param {string} avatar 角色头像文件名
   * @returns {Promise<Array>} 聊天数组（不含 .jsonl 判断由上层处理）
   */
  function get(avatar) {
    if (!avatar) return Promise.resolve([]);
    const hit = store.get(avatar);
    const now = Date.now();
    if (hit && now - hit.ts < ttl) {
      return hit.promise;
    }
    const promise = Promise.resolve()
      .then(() => fetcher(avatar))
      .catch((err) => {
        // 失败时移除缓存，允许下次重试
        store.delete(avatar);
        console.warn("[NovelReader] 拉取聊天列表失败:", avatar, err);
        return [];
      });
    store.set(avatar, { promise, ts: now });
    return promise;
  }

  /** 使某角色缓存失效 */
  function invalidate(avatar) {
    if (avatar) store.delete(avatar);
  }

  /** 清空全部缓存 */
  function clear() {
    store.clear();
  }

  return { get, invalidate, clear };
}
