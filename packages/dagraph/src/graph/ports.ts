/** The SHA256 hex of a file's content: what a `file()` input joins its node's key with. */
export type HashFile = (path: string) => Promise<string>;
