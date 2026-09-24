// Carnet Sport : synchronisation Withings -> docs/health.
//  POST avec Authorization: Bearer <jeton utilisateur>, corps { force?: bool, days?: number } : synchronise le compte de l'utilisateur
//  POST avec en-tête X-Cron-Key (pg_cron), corps { all: true } : synchronise tous les comptes connectés
import { createClient } from "npm:@supabase/supabase-js@2";
import { debugSleep, syncUserIfConnected } from "./withings.ts";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST attendu" }, 405);
  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  let body: any = {}; try { body = await req.json(); } catch { body = {}; }

  const cronKey = req.headers.get("x-cron-key");
  if (cronKey) {
    const { data: key } = await admin.rpc("withings_cron_key");
    if (!key || key !== cronKey) return json({ error: "Clé cron invalide" }, 401);
    if (body.debug && body.user_id) return json(await debugSleep(admin, String(body.user_id), Number(body.days) || 7));
    const { data: accounts } = await admin.from("withings_accounts").select("user_id");
    const results: Record<string, unknown> = {};
    for (const a of accounts || []) results[a.user_id] = await syncUserIfConnected(admin, a.user_id, { days: Number(body.days) || 7, force: true });
    return json({ ok: true, accounts: (accounts || []).length, results });
  }

  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user }, error } = await admin.auth.getUser(jwt);
  if (error || !user) return json({ error: "Non connecté" }, 401);
  const res = await syncUserIfConnected(admin, user.id, { days: Math.min(Number(body.days) || 7, 90), force: !!body.force, minGapMin: 30 });
  if (res === null) return json({ ok: true, connected: false });
  return json({ ok: !(res as any).error, connected: true, ...res });
});
