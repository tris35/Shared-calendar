// 公开照片链接（放进 Google 日历的活动说明里）：/p/:id?s=签名
// 只有带正确签名的链接能看到那一张照片，不会泄露其他资料。
import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import * as db from "../lib/db.mts";
import { verifyPhotoSignature } from "../lib/settings.mts";

export default async (req: Request, context: Context) => {
  const id = Number(context.params.id);
  const sig = new URL(req.url).searchParams.get("s") || "";
  if (!id || !(await verifyPhotoSignature(id, sig))) return new Response("链接无效", { status: 403 });
  const p = await db.getPhoto(id);
  if (!p) return new Response("照片已删除", { status: 404 });
  const data = await getStore("photos").get(p.blob_key, { type: "arrayBuffer" });
  if (!data) return new Response("照片已删除", { status: 404 });
  return new Response(data, { headers: { "Content-Type": p.mime, "Cache-Control": "private, max-age=3600" } });
};

export const config: Config = { path: "/p/:id" };
