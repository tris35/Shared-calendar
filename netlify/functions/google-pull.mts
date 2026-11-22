// 排程：每 10 分钟从每个人的 Google「共享日历」读回变更（双向同步）
import type { Config } from "@netlify/functions";
import { pullAll } from "../lib/gcal.mts";
import { env } from "../lib/env.mts";

export default async () => {
  const siteUrl = (env("URL") || "").replace(/\/$/, "");
  if (!siteUrl) return;
  await pullAll(siteUrl);
};

export const config: Config = { schedule: "*/10 * * * *" }; // UTC，每 10 分钟
