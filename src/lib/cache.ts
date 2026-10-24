import { LRUCache } from 'lru-cache';

/**
 * In-memory LRU cache for frequently accessed data
 * - Max 10,000 items
 * - 15 minute TTL by default, counted from the write: reads do not extend it,
 *   otherwise a short-lived entry that keeps being read would never refresh
 */
const memoryCache = new LRUCache<string, any>({
  max: 10000,
  ttl: 1000 * 60 * 15, // 15 minutes
  updateAgeOnGet: false,
  updateAgeOnHas: false,
});

/**
 * Cache key generators for consistent key naming
 */
export const CACHE_KEYS = {
  word: (word: string) => `word:${word}`,
  wordMarkdown: (word: string) => `word:markdown:${word}`,
  wordEnriched: (word: string) => `word:enriched:${word}`,
  fissionGraph: (word: string) => `graph:${word}`,
  allWords: () => 'words:all',
  scoredArticles: (userId: string) => `articles:scored:${userId}`,
};

/**
 * Cache service for managing in-memory cache operations
 */
export class CacheService {
  /**
   * Get a value from cache
   */
  async get<T>(key: string): Promise<T | null> {
    const value = memoryCache.get(key);
    return value !== undefined ? (value as T) : null;
  }

  /**
   * Set a value in cache
   */
  async set(key: string, value: any, ttl?: number): Promise<void> {
    if (ttl) {
      memoryCache.set(key, value, { ttl });
    } else {
      memoryCache.set(key, value);
    }
  }

  /**
   * Delete a value from cache
   */
  async delete(key: string): Promise<void> {
    memoryCache.delete(key);
  }

  /**
   * Clear all cache entries
   */
  async clear(): Promise<void> {
    memoryCache.clear();
  }

  /**
   * Check if a key exists in cache
   */
  async has(key: string): Promise<boolean> {
    return memoryCache.has(key);
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      size: memoryCache.size,
      max: memoryCache.max,
      calculatedSize: memoryCache.calculatedSize,
    };
  }
}

/**
 * Singleton cache instance
 */
export const cache = new CacheService();
