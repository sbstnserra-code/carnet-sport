// Carnet Sport : estimations (repas, sommeil) via l'API Anthropic. La clé reste côté serveur (secret ANTHROPIC_API_KEY).
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const MODEL = Deno.env.get("AI_MODEL") || "claude-haiku-4-5";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST attendu" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "JSON invalide" }, 400); }
  if (!KEY) return json({ error: "Clé IA non configurée" }, 503);
  if (body.ping) return json({ ok: true, images: true, model: MODEL });

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Non connecté" }, 401);
  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: { user }, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !user) return json({ error: "Session invalide" }, 401);

  const prompt = String(body.prompt || "").slice(0, 12000);
  if (!prompt) return json({ error: "prompt requis" }, 400);
  const content: any[] = [];
  if (body.image && body.image.data) content.push({ type: "image", source: { type: "base64", media_type: body.image.media_type || "image/jpeg", data: String(body.image.data) } });
  content.push({ type: "text", text: prompt });

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, temperature: 0, messages: [{ role: "user", content }] }),
  });
  if (r.status === 429) return json({ error: "Trop de demandes" }, 429);
  if (!r.ok) { const t = await r.text(); return json({ error: "API IA : " + t.slice(0, 300) }, 502); }
  const out = await r.json();
  const text = (out.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
  let parsed: unknown = null;
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { parsed = JSON.parse(m[0]); } catch { parsed = null; } }
  return json({ text, json: parsed, model: MODEL });
});
