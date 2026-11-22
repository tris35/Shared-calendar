// 排程：每 5 分钟检查一次，前一天下午 4 点自动用 WhatsApp 发讯息给客户
import type { Config } from "@netlify/functions";
import { sendDueCustomerMessages } from "../lib/whatsapp.mts";

export default async () => {
  const r = await sendDueCustomerMessages();
  console.log("[WhatsApp] ", JSON.stringify(r));
};

export const config: Config = { schedule: "*/5 * * * *" };
