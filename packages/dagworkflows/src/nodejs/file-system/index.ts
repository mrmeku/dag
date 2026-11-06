import { createNodeFileSystem } from "@mrmeku/dagraph/fs/node";
import * as fs from "node:fs";
import type { SyncFileSystem } from "../../wiring/index.ts";
import type { WorkflowFileSystem } from "../../workflow/index.ts";

/** dagraph's Node file system, and `access` for whether a path exists. */
export function createNodeWorkflowFileSystem(): WorkflowFileSystem {
  return {
    ...createNodeFileSystem(),
    exists: (path) =>
      fs.promises.access(path).then(
        () => true,
        () => false,
      ),
  };
}

/** `node:fs`'s synchronous writes, as they are. */
export const syncFs: SyncFileSystem = fs;
