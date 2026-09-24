// Carnet Sport : accès à l'API Withings (OAuth2, sommeil, mesures) et synchronisation vers public.docs (col health).
// Secrets attendus dans Edge Functions > Secrets : WITHINGS_CLIENT_ID, WITHINGS_CLIENT_SECRET.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export const W_AUTH = "https://account.withings.com/oauth2_user/authorize2";
export const W_TOKEN = "https://wbsapi.withings.net/v2/oauth2";
export const W_SLEEP = "https://wbsapi.withings.net/v2/sleep";
export const W_MEAS = "https://wbsapi.withings.net/measure";
export const SCOPE = "user.metrics,user.activity";
const CID = () => Deno.env.get("WITHINGS_CLIENT_ID") || "";
const CSEC = () => Deno.env.get("WITHINGS_CLIENT_SECRET") || "";
export const configured = () => !!(CID() && CSEC());
export const redirectUri = () => `${Deno.env.get("SUPABASE_URL")}/functions/v1/withings-auth/callback`;

export function authorizeUrl(state: string): string {
  const p = new URLSearchParams({ response_type: "code", client_id: CID(), state, scope: SCOPE, redirect_uri: redirectUri() });
  return `${W_AUTH}?${p}`;
}

export class WithingsError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

async function wpost(url: string, params: Record<string, string>, token?: string): Promise<any> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: new URLSearchParams(params) });
  let j: any = null; try { j = await res.json(); } catch { throw new WithingsError(res.status, `Réponse Withings illisible (HTTP ${res.status})`); }
  if (j.status !== 0) throw new WithingsError(j.status, String(j.error || `statut ${j.status}`));
  return j.body;
}
export type TokenBody = { userid: string | number; access_token: string; refresh_token: string; expires_in: number; scope?: string };
export const exchangeCode = (code: string) => wpost(W_TOKEN, { action: "requesttoken", grant_type: "authorization_code", client_id: CID(), client_secret: CSEC(), code, redirect_uri: redirectUri() }) as Promise<TokenBody>;
export const refreshToken = (refresh: string) => wpost(W_TOKEN, { action: "requesttoken", grant_type: "refresh_token", client_id: CID(), client_secret: CSEC(), refresh_token: refresh }) as Promise<TokenBody>;

const r1 = (x: number) => Math.round(x * 10) / 10;
const pad = (n: number) => String(n).padStart(2, "0");
// Horodatage Unix -> jour et heure de Paris
function paris(ts: number): { day: string; hhmm: string } {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ts * 1000));
  const g = (k: string) => p.find((x) => x.type === k)?.value || "00";
  return { day: `${g("year")}-${g("month")}-${g("day")}`, hhmm: `${pad(+g("hour") % 24)}:${g("minute")}` };
}
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export type Account = { user_id: string; access_token: string; refresh_token: string; expires_at: string; withings_userid?: string | null; last_sync_at?: string | null };
type Day = Record<string, number | string>;
const SLEEP_FIELDS = "sleep_score,total_sleep_time,total_timeinbed,asleepduration,deepsleepduration,lightsleepduration,remsleepduration,wakeupduration,wakeupcount,hr_average,hr_min,hr_max,snoring,sleep_efficiency,sleep_latency";
export const SLEEP_KEYS = ["sscore", "sleep", "inbed", "deep", "rem", "light", "awake", "bed", "wake", "hrn", "sleepsrc"];

// Lit sommeil et mesures des `days` derniers jours et écrit dans docs/health. Retourne un résumé.
export async function syncAccount(admin: SupabaseClient, acc: Account, days = 7): Promise<Record<string, unknown>> {
  if (!configured()) throw new WithingsError(503, "Withings non configuré côté serveur");
  let token = acc.access_token;
  const renew = async () => {
    const t = await refreshToken(acc.refresh_token);
    token = t.access_token; acc.access_token = t.access_token; acc.refresh_token = t.refresh_token;
    acc.expires_at = new Date(Date.now() + (t.expires_in || 10800) * 1000).toISOString();
    await admin.from("withings_accounts").update({ access_token: t.access_token, refresh_token: t.refresh_token, expires_at: acc.expires_at, withings_userid: String(t.userid ?? acc.withings_userid ?? "") }).eq("user_id", acc.user_id);
  };
  if (new Date(acc.expires_at).getTime() - Date.now() < 120_000) await renew();
  const call = async (url: string, params: Record<string, string>) => {
    try { return await wpost(url, params, token); }
    catch (e) { if (e instanceof WithingsError && e.status === 401) { await renew(); return await wpost(url, params, token); } throw e; }
  };
  const now = new Date(); const start = new Date(now.getTime() - days * 86400_000);
  const end = new Date(now.getTime() + 86400_000);
  const sleep = await call(W_SLEEP, { action: "getsummary", startdateymd: ymd(start), enddateymd: ymd(end), data_fields: SLEEP_FIELDS });
  const meas = await call(W_MEAS, { action: "getmeas", meastypes: "1,6,76,5,8,77,88", category: "1", startdate: String(Math.floor(start.getTime() / 1000)), enddate: String(Math.floor(end.getTime() / 1000)) });

  const out: Record<string, Day> = {}; const fields = new Set<string>();
  // Sommeil : une nuit par jour de réveil ; si plusieurs séries (montre + matelas), on garde celle qui a un score, sinon la plus longue
  const best: Record<string, any> = {};
  for (const s of (sleep?.series || []) as any[]) {
    const d = s.data || {}; const endTs = +s.enddate, startTs = +s.startdate; if (!endTs || !startTs) continue;
    const total = +(d.total_sleep_time ?? d.asleepduration ?? 0); if (total < 1800) continue; // moins de 30 min : sieste ou bruit
    const wd = paris(endTs).day; const cur = best[wd];
    const score = (x: any) => (x.data?.sleep_score != null ? 1e6 : 0) + (+(x.data?.total_sleep_time ?? 0));
    if (!cur || score(s) > score(cur)) best[wd] = s;
  }
  for (const wd of Object.keys(best)) {
    const s = best[wd], d = s.data || {}; const D: Day = { sleepsrc: "withings" };
    if (d.sleep_score != null) D.sscore = Math.round(+d.sleep_score);
    const total = +(d.total_sleep_time ?? d.asleepduration ?? 0); if (total) D.sleep = r1(total / 3600);
    if (d.total_timeinbed != null) D.inbed = r1(+d.total_timeinbed / 3600); else D.inbed = r1((+s.enddate - +s.startdate) / 3600);
    if (d.deepsleepduration != null) D.deep = r1(+d.deepsleepduration / 3600);
    if (d.remsleepduration != null) D.rem = r1(+d.remsleepduration / 3600);
    if (d.lightsleepduration != null) D.light = r1(+d.lightsleepduration / 3600);
    if (d.wakeupduration != null) D.awake = r1(+d.wakeupduration / 3600);
    if (d.hr_average != null) D.hrn = Math.round(+d.hr_average);
    D.bed = paris(+s.startdate).hhmm; D.wake = paris(+s.enddate).hhmm;
    out[wd] = { ...(out[wd] || {}), ...D }; for (const k of Object.keys(D)) fields.add(k);
  }
  // Mesures : dernière pesée du jour ; masse musculaire convertie en % du poids comme sur la balance
  const lastByDay: Record<string, { ts: number; m: Record<number, number> }> = {};
  for (const g of (meas?.measuregrps || []) as any[]) {
    if (g.category !== 1 || g.attrib === 1) continue; // attrib 1 : mesure attribuée à un utilisateur ambigu
    const ts = +g.date; const day = paris(ts).day; const m: Record<number, number> = {};
    for (const x of (g.measures || []) as any[]) m[+x.type] = +x.value * Math.pow(10, +x.unit);
    if (m[1] == null) continue;
    const cur = lastByDay[day]; if (!cur || ts > cur.ts) lastByDay[day] = { ts, m };
  }
  for (const day of Object.keys(lastByDay)) {
    const m = lastByDay[day].m; const D: Day = {};
    if (m[1] != null) D.weight = r1(m[1]);
    if (m[6] != null) D.fat = r1(m[6]);
    if (m[76] != null && m[1]) D.muscle = r1(m[76] / m[1] * 100);
    if (m[77] != null && m[1]) D.water = r1(m[77] / m[1] * 100);
    out[day] = { ...(out[day] || {}), ...D }; for (const k of Object.keys(D)) fields.add(k);
  }
  const dates = Object.keys(out).sort();
  if (dates.length) {
    const { data: existing } = await admin.from("docs").select("doc_id,data").eq("user_id", acc.user_id).eq("col", "health").in("doc_id", dates);
    const cur: Record<string, any> = {}; for (const r of existing || []) cur[r.doc_id] = r.data || {};
    const nowMs = Date.now();
    const rows = dates.map((d) => {
      const base = cur[d] || { date: d };
      const merged = { ...base, ...out[d], date: d, src: base.src && base.src !== "withings" ? "mixte" : "withings", updatedAt: nowMs };
      return { user_id: acc.user_id, col: "health", doc_id: d, data: merged };
    });
    const { error } = await admin.from("docs").upsert(rows, { onConflict: "user_id,col,doc_id" });
    if (error) throw new Error(error.message);
  }
  const summary = { days: dates.length, from: dates[0] || null, to: dates[dates.length - 1] || null, fields: [...fields], nights: Object.keys(best).length, weighings: Object.keys(lastByDay).length };
  await admin.from("withings_accounts").update({ last_sync_at: new Date().toISOString(), last_status: "ok", last_summary: summary }).eq("user_id", acc.user_id);
  return summary;
}

// Synchronise un compte s'il est connecté (appelé après un import iPhone, ou par l'app). Ne lève jamais.
export async function syncUserIfConnected(admin: SupabaseClient, userId: string, opts: { days?: number; force?: boolean; minGapMin?: number } = {}): Promise<Record<string, unknown> | null> {
  const { data: acc } = await admin.from("withings_accounts").select("*").eq("user_id", userId).maybeSingle();
  if (!acc) return null;
  if (!opts.force && acc.last_sync_at && Date.now() - new Date(acc.last_sync_at).getTime() < (opts.minGapMin ?? 30) * 60_000) return { skipped: true, last_sync_at: acc.last_sync_at };
  try { return await syncAccount(admin, acc as Account, opts.days ?? 7); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = e instanceof WithingsError ? e.status : 0;
    await admin.from("withings_accounts").update({ last_sync_at: new Date().toISOString(), last_status: status === 401 ? "reconnexion nécessaire" : "erreur", last_summary: { error: msg } }).eq("user_id", userId);
    return { error: msg, status };
  }
}

// Diagnostic (appel cron uniquement) : réponse brute de l'API sommeil sur `days` jours, sans écrire en base
export async function debugSleep(admin: SupabaseClient, userId: string, days = 7): Promise<Record<string, unknown>> {
  const { data: acc } = await admin.from("withings_accounts").select("*").eq("user_id", userId).maybeSingle();
  if (!acc) return { error: "non connecté" };
  const now = new Date(); const start = new Date(now.getTime() - days * 86400_000); const end = new Date(now.getTime() + 86400_000);
  const out: Record<string, unknown> = {};
  const attempts: Record<string, Record<string, string>> = {
    ymd_fields: { action: "getsummary", startdateymd: ymd(start), enddateymd: ymd(end), data_fields: SLEEP_FIELDS },
    ymd_nofields: { action: "getsummary", startdateymd: ymd(start), enddateymd: ymd(end) },
    lastupdate: { action: "getsummary", lastupdate: String(Math.floor(start.getTime() / 1000)), data_fields: "sleep_score,total_sleep_time" },
  };
  for (const k of Object.keys(attempts)) {
    try {
      const res = await fetch(W_SLEEP, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${acc.access_token}` }, body: new URLSearchParams(attempts[k]) });
      const j = await res.json();
      out[k] = { status: j.status, error: j.error, series: (j.body?.series || []).length, more: j.body?.more, sample: (j.body?.series || []).slice(0, 2) };
    } catch (e) { out[k] = { exception: String(e) }; }
  }
  return out;
}
