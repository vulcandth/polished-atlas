export function decodeBase64(data: string): Uint8Array {
  if (!data) {
    return new Uint8Array();
  }
  if (typeof atob === "function") {
    const binary = atob(data);
    const buffer = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      buffer[index] = binary.charCodeAt(index);
    }
    return buffer;
  }
  const globalBuffer = (
    globalThis as unknown as { Buffer?: { from(data: string, encoding: string): Uint8Array } }
  ).Buffer;
  if (globalBuffer) {
    const decoded = globalBuffer.from(data, "base64");
    if (decoded instanceof Uint8Array) {
      return Uint8Array.from(decoded);
    }
    return Uint8Array.from(decoded as unknown as number[]);
  }
  throw new Error("No base64 decoder available in this environment.");
}
