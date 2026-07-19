const memoryArtifacts = new Map<string, ArrayBuffer>();

export async function putArtifact(
  bucket: R2Bucket | undefined,
  key: string,
  data: ArrayBuffer,
  contentType: string,
): Promise<void> {
  memoryArtifacts.set(key, data);
  if (bucket) {
    await bucket.put(key, data, {
      httpMetadata: { contentType },
    });
  }
}

export async function getArtifact(
  bucket: R2Bucket | undefined,
  key: string,
): Promise<ArrayBuffer | null> {
  if (bucket) {
    const object = await bucket.get(key);
    if (object) return object.arrayBuffer();
  }
  return memoryArtifacts.get(key) ?? null;
}
