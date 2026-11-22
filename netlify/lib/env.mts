// 读取环境变量（Netlify 线上用 Netlify.env，本地测试回退到 process.env）
export const env = (key: string): string | undefined =>
  ((globalThis as any).Netlify?.env?.get(key) ?? process.env[key]) || undefined;
