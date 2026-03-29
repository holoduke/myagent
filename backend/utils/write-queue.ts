/**
 * Serialized file write queue to prevent concurrent writes to the same file.
 * Each file path gets its own queue -- writes to different files run in parallel.
 */
const queues = new Map<string, Promise<void>>();

export function serializedWrite(filePath: string, writeFn: () => void): void {
  const prev = queues.get(filePath) || Promise.resolve();
  const next = prev.then(() => {
    try {
      writeFn();
    } catch {
      // Write error -- caller is responsible for error handling via atomicWriteJSON
    }
  });
  queues.set(filePath, next);
}
