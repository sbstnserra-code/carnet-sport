// Carnet Sport : réception des exports automatiques de l'app iPhone « Health Auto Export » (REST API).
// Auth : en-tête X-API-Key = jeton du compte (table import_tokens). Écrit dans public.docs (col health).
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Day = Record<string, number | string>;
const r1 = (x: number) => Math.round(x * 10) / 10;
const dayOf = (s: unknown) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s)) ? s.slice(0, 10) : null;
const hhmm = (s: unknown) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) ? s.slice(11, 16) : null;
const num = (x: unknown) => (typeof x === "number" && isFinite(x)) ? x : (typeof x === "string" && x.trim() !== "" && isFinite(+x)) ? +x : null;
const kcal = (v: number, units: string) => /kj/i.test(units) ? v / 4.184 : v;
const kg = (v: number, units: string) => /lb/i.test(units) ? v * 0.45359237 : v;
const km = (v: number, units: string) => /mi/i.test(units) ? v * 1.609344 : /(^m$|meter)/i.test(units) ? v / 1000 : v;
const hours = (v: number, units: string) => /min/i.test(units) ? v / 60 : /sec|^s$/i.test(units) ? v / 3600 : v;

// nom HAE -> [clé Carnet, conversion, cumul (somme) ou dernière valeur]
const MAP: Record<string, [string, (v: number, u: string) => number, "sum" | "last" | "max"]> = {
  step_count: ["steps", (v) => v, "sum"],
  active_energy: ["akcal", kcal, "sum"],
  basal_energy_burned: ["bkcal", kcal, "sum"],
  apple_exercise_time: ["exmin", (v, u) => /hr|hour/i.test(u) ? v * 60 : v, "sum"],
  walking_running_distance: ["km", km, "sum"],
  weight_body_mass: ["weight", kg, "last"],
  body_fat_percentage: ["fat", (v) => v <= 1 ? v * 100 : v, "last"],
  lean_body_mass: ["lean", kg, "last"],
  resting_heart_rate: ["rhr", (v) => v, "last"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST attendu" }, 405);
  const token = (req.headers.get("x-api-key") || req.headers.get("X-API-Key") || "").trim();
  if (!token) return json({ error: "Jeton manquant (en-tête X-API-Key)" }, 401);
  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: tok } = await admin.from("import_tokens").select("user_id").eq("token", token).maybeSingle();
  if (!tok) return json({ error: "Jeton inconnu" }, 401);
  const uid = tok.user_id as string;

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "JSON invalide" }, 400); }
  const metrics: any[] = Array.isArray(body?.data?.metrics) ? body.data.metrics : Array.isArray(body?.metrics) ? body.metrics : [];
  const days: Record<string, Day> = {};
  const acc: Record<string, Record<string, { sum: number; last: number; lastDate: string; max: number }>> = {};
  const modeOf: Record<string, "sum" | "last" | "max"> = {};
  const fields = new Set<string>();

  for (const m of metrics) {
    const name = String(m?.name || ""), units = String(m?.units || ""), rows: any[] = Array.isArray(m?.data) ? m.data : [];
    if (name === "sleep_analysis") {
      for (const r of rows) {
        const end = hhmm(r.sleepEnd || r.endDate || r.end), start = hhmm(r.sleepStart || r.startDate || r.start);
        const d = dayOf(r.sleepEnd || r.endDate || r.end) || dayOf(r.date); if (!d) continue;
        const D = (days[d] ||= {});
        const asleep = num(r.asleep ?? r.totalSleep ?? r.total), inBed = num(r.inBed ?? r.in_bed), deep = num(r.deep), rem = num(r.rem), core = num(r.core), awake = num(r.awake);
        const u = units || "hr";
        if (asleep != null) { D.sleep = r1(hours(asleep, u)); fields.add("sleep"); }
        else if (deep != null || rem != null || core != null) { D.sleep = r1(hours((deep || 0) + (rem || 0) + (core || 0), u)); fields.add("sleep"); }
        if (inBed != null) D.inbed = r1(hours(inBed, u));
        if (deep != null) { D.deep = r1(hours(deep, u)); fields.add("deep"); }
        if (rem != null) { D.rem = r1(hours(rem, u)); fields.add("rem"); }
        if (awake != null) D.awake = r1(hours(awake, u));
        if (start) { D.bed = start; fields.add("bed"); }
        if (end) { D.wake = end; fields.add("wake"); }
      }
      continue;
    }
    const spec = MAP[name]; if (!spec) continue;
    const [key, conv, mode] = spec;
    for (const r of rows) {
      const d = dayOf(r.date); const q = num(r.qty ?? r.Avg ?? r.avg ?? r.value); if (!d || q == null) continue;
      const v = conv(q, units);
      const a = (acc[d] ||= {}); const k = (a[key] ||= { sum: 0, last: v, lastDate: "", max: -Infinity });
      k.sum += v; k.max = Math.max(k.max, v); const t = String(r.date); if (t >= k.lastDate) { k.lastDate = t; k.last = v; }
      (days[d] ||= {}); fields.add(key); modeOf[key] = mode;
    }
  }
  for (const d of Object.keys(acc)) for (const key of Object.keys(acc[d])) {
    const k = acc[d][key], mode = modeOf[key] || "last";
    const v = mode === "sum" ? k.sum : mode === "max" ? k.max : k.last;
    days[d][key] = ["steps", "akcal", "bkcal", "exmin", "rhr"].includes(key) ? Math.round(v) : r1(v);
  }
  const dates = Object.keys(days).filter((d) => Object.keys(days[d]).length).sort();
  if (!dates.length) {
    await admin.from("import_tokens").update({ last_import_at: new Date().toISOString(), last_status: "vide", last_summary: { metrics: metrics.map((m: any) => m?.name) }, last_payload: { keys: Object.keys(body || {}), data_keys: Object.keys(body?.data || {}), metrics: metrics.slice(0, 40).map((m: any) => ({ name: m?.name, units: m?.units, n: (m?.data || []).length, sample: (m?.data || []).slice(-1)[0] })) } }).eq("user_id", uid);
    return json({ ok: true, days: 0, note: "aucune donnée reconnue", metrics: metrics.map((m: any) => m?.name) });
  }

  // Fusion avec les documents existants (les valeurs importées remplacent les mêmes clés, le reste est conservé)
  const { data: existing } = await admin.from("docs").select("doc_id,data").eq("user_id", uid).eq("col", "health").in("doc_id", dates);
  const cur: Record<string, any> = {}; for (const r of existing || []) cur[r.doc_id] = r.data || {};
  const now = Date.now();
  const rows = dates.map((d) => {
    const base = cur[d] || { date: d };
    const merged = { ...base, ...days[d], date: d, src: base.src && base.src !== "hae" ? "mixte" : "hae", updatedAt: now };
    return { user_id: uid, col: "health", doc_id: d, data: merged };
  });
  const { error } = await admin.from("docs").upsert(rows, { onConflict: "user_id,col,doc_id" });
  if (error) return json({ error: error.message }, 500);
  let payloadSnippet: unknown = null;
  try { payloadSnippet = { metrics: metrics.slice(0, 40).map((m: any) => ({ name: m?.name, units: m?.units, n: (m?.data || []).length, sample: (m?.data || []).slice(-1)[0] })) }; } catch { payloadSnippet = null; }
  await admin.from("import_tokens").update({ last_import_at: new Date().toISOString(), last_status: "ok", last_summary: { days: dates.length, from: dates[0], to: dates[dates.length - 1], fields: [...fields] }, last_payload: payloadSnippet }).eq("user_id", uid);
  return json({ ok: true, days: dates.length, from: dates[0], to: dates[dates.length - 1], fields: [...fields] });
});
