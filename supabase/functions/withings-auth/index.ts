// Carnet Sport : connexion d'un compte Withings (OAuth2).
//  POST /withings-auth/start     (Authorization: Bearer <jeton utilisateur>) -> { url } vers laquelle rediriger
//  GET  /withings-auth/callback?code&state   (appelé par Withings) -> page HTML de confirmation
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeUrl, configured, exchangeCode, syncUserIfConnected } from "./withings.ts";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL = "https://sbstnserra-code.github.io/carnet-sport/";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
// Le domaine supabase.co ne sert pas de HTML (renvoyé en text/plain) : on redirige vers l'app avec le résultat dans l'URL
const page = (title: string, text: string, ok: boolean) => {
  const q = new URLSearchParams({ withings: ok ? "ok" : "err", title, msg: text });
  return new Response(null, { status: 302, headers: { Location: `${APP_URL}?${q}`, "cache-control": "no-store" } });
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const u = new URL(req.url); const path = u.pathname.replace(/\/+$/, "");
  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

  if (path.endsWith("/start")) {
    if (!configured()) { const miss = ["WITHINGS_CLIENT_ID", "WITHINGS_CLIENT_SECRET"].filter((k) => !Deno.env.get(k)); return json({ error: `Withings n’est pas encore configuré côté serveur (secret manquant : ${miss.join(", ")}).`, missing: miss, present: Object.keys(Deno.env.toObject()).filter((k) => /WITHINGS/i.test(k)) }, 503); }
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user }, error } = await admin.auth.getUser(jwt);
    if (error || !user) return json({ error: "Non connecté" }, 401);
    const state = crypto.randomUUID().replace(/-/g, "") + Math.random().toString(36).slice(2, 10);
    await admin.from("withings_oauth_states").delete().lt("created_at", new Date(Date.now() - 1_800_000).toISOString());
    const { error: e2 } = await admin.from("withings_oauth_states").insert({ state, user_id: user.id });
    if (e2) return json({ error: e2.message }, 500);
    return json({ url: authorizeUrl(state) });
  }

  // Lien direct (état créé à l'avance côté serveur) : évite d'avoir l'app sous la main pour lancer la connexion
  if (path.endsWith("/link")) {
    const state = u.searchParams.get("state") || "";
    const { data: st } = await admin.from("withings_oauth_states").select("created_at").eq("state", state).maybeSingle();
    if (!st || Date.now() - new Date(st.created_at).getTime() > 1_800_000) return page("Lien expiré", "Ce lien de connexion n’est plus valable. Relance la connexion depuis le Carnet, Réglages > Withings.", false);
    if (!configured()) return page("Withings non configuré", "Les secrets WITHINGS_CLIENT_ID et WITHINGS_CLIENT_SECRET ne sont pas encore renseignés côté serveur.", false);
    return new Response(null, { status: 302, headers: { Location: authorizeUrl(state) } });
  }

  if (path.endsWith("/callback")) {
    const code = u.searchParams.get("code"), state = u.searchParams.get("state"), err = u.searchParams.get("error");
    if (err) return page("Connexion refusée", `Withings a répondu : ${err}. Tu peux réessayer depuis le Carnet, Réglages > Withings.`, false);
    if (!code || !state) return page("Lien incomplet", "Il manque le code ou l’état de la demande. Relance la connexion depuis le Carnet.", false);
    const { data: st } = await admin.from("withings_oauth_states").select("user_id,created_at").eq("state", state).maybeSingle();
    if (!st) return page("Demande expirée", "Cette demande de connexion n’est plus valable (10 minutes). Relance-la depuis le Carnet, Réglages > Withings.", false);
    await admin.from("withings_oauth_states").delete().eq("state", state);
    if (Date.now() - new Date(st.created_at).getTime() > 1_800_000) return page("Demande expirée", "Plus de 30 minutes se sont écoulées. Relance la connexion depuis le Carnet.", false);
    let tok;
    try { tok = await exchangeCode(code); }
    catch (e) { return page("Échec de la connexion", `Withings n’a pas accepté le code : ${e instanceof Error ? e.message : String(e)}. Relance la connexion depuis le Carnet.`, false); }
    const row = { user_id: st.user_id, withings_userid: String(tok.userid ?? ""), access_token: tok.access_token, refresh_token: tok.refresh_token, expires_at: new Date(Date.now() + (tok.expires_in || 10800) * 1000).toISOString(), scope: tok.scope || null, connected_at: new Date().toISOString(), last_status: "connecté", last_summary: null };
    const { error: e3 } = await admin.from("withings_accounts").upsert(row, { onConflict: "user_id" });
    if (e3) return page("Erreur d’enregistrement", e3.message, false);
    const res = await syncUserIfConnected(admin, st.user_id, { days: 30, force: true });
    const n = res && typeof res === "object" && "days" in res ? Number((res as any).days) : 0;
    const detail = res && (res as any).error ? ` La première synchronisation a échoué (${(res as any).error}) ; elle sera retentée automatiquement.` : n ? ` ${n} jour${n > 1 ? "s" : ""} de sommeil et de pesées viennent d’être importés.` : "";
    return page("Withings connecté", `Ton compte Withings est relié au Carnet.${detail} Tu peux fermer cette page et revenir au Carnet : les données arrivent toutes seules chaque matin.`, true);
  }
  return json({ error: "Route inconnue" }, 404);
});
