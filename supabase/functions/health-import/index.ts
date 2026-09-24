// Carnet Sport : réception des données de l'app Santé iPhone.
// Deux émetteurs possibles, même adresse, même jeton :
//  - le Raccourci iOS « Carnet Santé auto » (gratuit) : corps texte, une ligne par échantillon « début|fin|valeur|unité|type|source »
//  - l'app « Health Auto Export » (REST API) : corps JSON { data: { metrics: [...] } }
// Auth : en-tête X-API-Key = jeton du compte (table import_tokens). Écrit dans public.docs (col health).
import { createClient } from "npm:@supabase/supabase-js@2";
import { parseHae, parseLines } from "./parse.ts";
import { SLEEP_KEYS, syncUserIfConnected } from "./withings.ts";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST attendu" }, 405);
  const token = (req.headers.get("x-api-key") || req.headers.get("X-API-Key") || "").trim();
  if (!token) return json({ error: "Jeton manquant (en-tête X-API-Key)" }, 401);
  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: tok } = await admin.from("import_tokens").select("user_id").eq("token", token).maybeSingle();
  if (!tok) return json({ error: "Jeton inconnu" }, 401);
  const uid = tok.user_id as string;

  let raw = "";
  const ctype = req.headers.get("content-type") || "";
  if (/multipart\/form-data/i.test(ctype)) {
    // Raccourci envoyé en « Formulaire » : champ lignes (ou premier champ texte)
    try { const fd = await req.formData(); const v = fd.get("lignes") ?? fd.get("lines") ?? [...fd.values()][0]; raw = typeof v === "string" ? v : v ? await (v as File).text() : ""; } catch { raw = ""; }
  } else raw = await req.text();
  raw = raw.replace(/^﻿/, "");
  let body: any = null; let format = "raccourci";
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) { try { body = JSON.parse(trimmed); format = "hae"; } catch { body = null; } }
  // Le Raccourci peut aussi envoyer { "lignes": "..." } ou un formulaire lignes=...
  let text = raw;
  if (body && typeof body === "object" && !Array.isArray(body) && typeof (body.lignes ?? body.lines ?? body.text) === "string") { text = String(body.lignes ?? body.lines ?? body.text); format = "raccourci"; }
  else if (!body && /^lignes=/.test(trimmed)) { text = decodeURIComponent(trimmed.slice(7).replace(/\+/g, " ")); }
  const parsed = format === "hae" ? parseHae(body) : parseLines(text);
  const days = parsed.days;
  const dates = Object.keys(days).filter((d) => Object.keys(days[d]).length).sort();
  const sample = format === "hae"
    ? { format, metrics: (body?.data?.metrics || body?.metrics || []).slice(0, 40).map((m: any) => ({ name: m?.name, units: m?.units, n: (m?.data || []).length, sample: (m?.data || []).slice(-1)[0] })) }
    : { format, lines: text.split(/\r?\n/).length, head: text.split(/\r?\n/).slice(0, 12), ignored: parsed.ignored.slice(0, 12) };
  if (!dates.length) {
    await admin.from("import_tokens").update({ last_import_at: new Date().toISOString(), last_status: "vide", last_summary: { format, samples: parsed.samples, ignored: parsed.ignored.slice(0, 10) }, last_payload: sample }).eq("user_id", uid);
    return json({ ok: true, days: 0, note: "aucune donnée reconnue", format, ignored: parsed.ignored.slice(0, 10) });
  }

  // Fusion avec les documents existants : les valeurs importées remplacent les mêmes clés, le reste est conservé
  const { data: existing } = await admin.from("docs").select("doc_id,data").eq("user_id", uid).eq("col", "health").in("doc_id", dates);
  const cur: Record<string, any> = {}; for (const r of existing || []) cur[r.doc_id] = r.data || {};
  const now = Date.now();
  const rows = dates.map((d) => {
    const base = cur[d] || { date: d };
    const vals = { ...days[d] };
    // Le sommeil mesuré par Withings (score compris) a priorité sur la version passée par l'app Santé
    if (base.sleepsrc === "withings") for (const k of SLEEP_KEYS) delete (vals as any)[k];
    const merged = { ...base, ...vals, date: d, src: base.src && base.src !== "hae" ? "mixte" : "hae", updatedAt: now };
    return { user_id: uid, col: "health", doc_id: d, data: merged };
  });
  const { error } = await admin.from("docs").upsert(rows, { onConflict: "user_id,col,doc_id" });
  if (error) return json({ error: error.message }, 500);
  // Dans la foulée, rafraîchit Withings si le compte est relié (au plus une fois par heure)
  let withings: unknown = null;
  try { withings = await Promise.race([syncUserIfConnected(admin, uid, { days: 3, minGapMin: 60 }), new Promise((r) => setTimeout(() => r({ timeout: true }), 12_000))]); } catch (e) { withings = { error: String(e) }; }
  const summary = { format, days: dates.length, from: dates[0], to: dates[dates.length - 1], fields: [...parsed.fields], samples: parsed.samples, ignored: parsed.ignored.length, withings };
  await admin.from("import_tokens").update({ last_import_at: new Date().toISOString(), last_status: "ok", last_summary: summary, last_payload: sample }).eq("user_id", uid);
  return json({ ok: true, ...summary });
});
