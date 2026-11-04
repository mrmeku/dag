export {
  commitEntry,
  discard,
  isCacheEntry,
  lookupEntry,
  newStagingDir,
  pruneCache,
  type CacheEntry,
  type PruneOptions,
} from "./cache.ts";
export { hashBytes } from "./content-addressing.ts";
export { isMissingFileError, type FileSystem, type Stats } from "./ports.ts";
