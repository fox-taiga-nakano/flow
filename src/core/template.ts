export const quote = (value: unknown): string => "'" + String(value).replaceAll("'", "'\\''") + "'";
export function render(source: string, context: Record<string, unknown>, shell = false): string {
  return source.replace(/(?<!\$)\{([A-Za-z_][\w]*(?:\.[\w]+)*)\}/g, (_, key: string) => {
    let value: unknown = context;
    for (const part of key.split(".")) {
      if (value === null || typeof value !== "object" || !Object.hasOwn(value, part))
        throw new Error(`未定義の変数: ${key}`);
      value = (value as Record<string, unknown>)[part];
    }
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean" &&
      typeof value !== "bigint" &&
      typeof value !== "symbol"
    )
      throw new Error(`値を展開できません: ${key}`);
    return shell ? quote(value) : String(value);
  });
}
