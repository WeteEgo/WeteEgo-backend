import { Redis } from "ioredis"

let _redis: Redis | null = null

export function getRedis(): Redis {
  if (!_redis) {
    const url = process.env.REDIS_URL ?? "redis://localhost:6379"
    _redis = new Redis(url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    })
    _redis.on("error", (err: Error) => {
      // Log but don't crash — rate limiting degrades gracefully
      console.error("[redis] connection error", err.message)
    })
  }
  return _redis
}
