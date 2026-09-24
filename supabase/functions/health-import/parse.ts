// Analyse des exports Santé reçus par health-import. Deux formats :
//  - JSON de Health Auto Export : { data: { metrics: [{ name, units, data: [{ date, qty | sleep... }] }] } }
//  - texte du Raccourci iOS : une ligne par échantillon « début|fin|valeur|unité|type|source » (type et source facultatifs)
// Résultat : un objet par jour avec les clés du Carnet (steps, akcal, bkcal, exmin, km, weight, fat, lean, rhr, sleep, inbed, deep, rem, awake, bed, wake).

export type Day = Record<string, number | string>;
export type Parsed = { days: Record<string, Day>; fields: Set<string>; samples: number; ignored: string[] };

const r1 = (x: number) => Math.round(x * 10) / 10;
const INT = new Set(["steps", "akcal", "bkcal", "exmin", "rhr", "sscore"]);
const MODE: Record<string, "sum" | "last"> = { steps: "sum", akcal: "sum", bkcal: "sum", exmin: "sum", km: "sum", weight: "last", fat: "last", lean: "last", rhr: "last", sscore: "last" };

export const num = (x: unknown): number | null => {
  if (typeof x === "number") return isFinite(x) ? x : null;
  if (typeof x !== "string") return null;
  const t = x.replace(/[\s  ]/g, "").replace(/,/g, ".").replace(/[^0-9.\-]/g, "");
  return t !== "" && isFinite(+t) ? +t : null;
};
const kcal = (v: number, u: string) => /kj/i.test(u) ? v / 4.184 : /^cal$/i.test(u.trim()) ? v / 1000 : v;
const kg = (v: number, u: string) => /lb/i.test(u) ? v * 0.45359237 : v;
const km = (v: number, u: string) => /mi/i.test(u) ? v * 1.609344 : /(^m$|m[eè]tre)/i.test(u.trim()) ? v / 1000 : v;
const hours = (v: number, u: string) => /min/i.test(u) ? v / 60 : /sec|^s$/i.test(u) ? v / 3600 : v;
const pct = (v: number) => v <= 1 ? v * 100 : v;

// Conversion vers l'unité du Carnet, par clé
const CONV: Record<string, (v: number, u: string) => number> = {
  steps: (v) => v, akcal: kcal, bkcal: kcal, exmin: (v, u) => /hr|hour|heure/i.test(u) ? v * 60 : v, km, weight: kg, fat: pct, lean: kg, rhr: (v) => v, sscore: (v) => v,
};

// Noms Health Auto Export -> clé
const HAE: Record<string, string> = {
  step_count: "steps", active_energy: "akcal", basal_energy_burned: "bkcal", apple_exercise_time: "exmin", walking_running_distance: "km",
  weight_body_mass: "weight", body_fat_percentage: "fat", lean_body_mass: "lean", resting_heart_rate: "rhr",
};

// Noms de type Raccourci (anglais et français) -> clé
export function keyFromType(t: string): string | null {
  const s = t.toLowerCase();
  if (/score/.test(s) && /sleep|sommeil/.test(s)) return "sscore";
  if (/sleep|sommeil/.test(s)) return "sleep";
  if (/step|\bpas\b|marche.*nombre/.test(s)) return "steps";
  if (/basal|repos.*[ée]nergie|[ée]nergie.*repos|basale/.test(s)) return "bkcal";
  if (/active energy|[ée]nergie active|calories actives/.test(s)) return "akcal";
  if (/exercise|exercice/.test(s)) return "exmin";
  if (/distance/.test(s)) return "km";
  if (/body mass|weight|poids|masse corporelle/.test(s)) return "weight";
  if (/fat|grasse/.test(s)) return "fat";
  if (/lean|maigre/.test(s)) return "lean";
  if (/resting|repos/.test(s)) return "rhr";
  return null;
}
// Sans type : déduction par l'unité
export function keyFromUnit(u: string, v: string): string | null {
  const s = u.toLowerCase().trim();
  if (sleepLabel(v)) return "sleep";
  if (/count\/min|bpm|\/min/.test(s)) return "rhr";
  if (/^(count|nombre|steps|pas)$/.test(s) && num(v) != null) return "steps";
  if (/kcal|kj|^cal/.test(s)) return "akcal";
  if (/kg|lb/.test(s)) return "weight";
  if (/%/.test(s)) return "fat";
  if (/km|mi|^m$/.test(s)) return "km";
  if (/min|hr|hour|heure/.test(s)) return "exmin";
  return null;
}
export function sleepLabel(v: string): string | null {
  const t = (v || "").toLowerCase();
  if (/in ?bed|au lit/.test(t)) return "inbed";
  if (/awake|[ée]veil/.test(t)) return "awake";
  if (/\brem\b|paradox/.test(t)) return "rem";
  if (/deep|profond/.test(t)) return "deep";
  if (/core|l[ée]ger/.test(t)) return "core";
  if (/asleep|endormi|unspecified|sp[ée]cifi/.test(t)) return "asleep";
  return null;
}

const MONTHS_FR = ["janv", "févr", "mars", "avr", "mai", "juin", "juil", "août", "sept", "oct", "nov", "déc"];
const MONTHS_EN = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// Date -> minutes « murales » (heure locale de l'iPhone, sans fuseau) ; les dates avec fuseau sont ramenées en heure de Paris.
export function parseDT(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+\-]\d{2}:?\d{2})?$/);
  if (m) {
    if (m[7]) { const tz = m[7] === "Z" ? "Z" : m[7].replace(/^([+\-]\d{2}):?(\d{2})$/, "$1:$2"); const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4] || "00"}:${m[5] || "00"}:${m[6] || "00"}${tz}`); if (isNaN(+d)) return null; return wallParis(d); }
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) / 60000;
  }
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,àa]+(\d{1,2}):(\d{2}))?/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)) / 60000;
  m = t.match(/^(?:[a-zéû]+\.?,?\s+)?(\d{1,2})\s+([a-zéû]+)\.?\s+(\d{4})(?:[ ,àa]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+\-]\d{2}:?\d{2})?$/i);
  if (m) {
    const mo = m[2].toLowerCase().slice(0, 4).replace(/\.$/, "");
    let i = MONTHS_FR.findIndex((x) => mo.startsWith(x.slice(0, 3)) || x.startsWith(mo));
    if (i < 0) i = MONTHS_EN.findIndex((x) => mo.startsWith(x));
    if (i < 0) return null;
    return withTz(+m[3], i, +m[1], +(m[4] || 0), +(m[5] || 0), m[7]);
  }
  m = t.match(/^([a-z]+) (\d{1,2}), (\d{4})(?:[ ,at]+(\d{1,2}):(\d{2})\s*([AP]M)?)?/i);
  if (m) {
    const i = MONTHS_EN.findIndex((x) => m![1].toLowerCase().startsWith(x)); if (i < 0) return null;
    let h = +(m[4] || 0); if (m[6]) { if (/pm/i.test(m[6]) && h < 12) h += 12; if (/am/i.test(m[6]) && h === 12) h = 0; }
    return Date.UTC(+m[3], i, +m[2], h, +(m[5] || 0)) / 60000;
  }
  return null;
}
function withTz(y: number, mo: number, d: number, h: number, mi: number, tz?: string): number {
  if (!tz) return Date.UTC(y, mo, d, h, mi) / 60000;
  const z = tz === "Z" ? "Z" : tz.replace(/^([+\-]\d{2}):?(\d{2})$/, "$1:$2");
  const dt = new Date(`${y}-${pad(mo + 1)}-${pad(d)}T${pad(h)}:${pad(mi)}:00${z}`);
  return isNaN(+dt) ? Date.UTC(y, mo, d, h, mi) / 60000 : wallParis(dt);
}
function wallParis(d: Date): number {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (k: string) => +(p.find((x) => x.type === k)?.value || 0);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute")) / 60000;
}
const pad = (n: number) => String(n).padStart(2, "0");
export const dayOfMin = (mn: number) => { const d = new Date(mn * 60000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
export const hhmmOfMin = (mn: number) => { const d = new Date(mn * 60000); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };

type Sample = { key: string; start: number; end: number; value: number; label: string | null; unit: string; source: string };

// Agrégation commune : quantités par jour (somme ou dernière valeur, une source à la fois pour éviter les doublons montre + iPhone), sommeil par nuit.
export function aggregate(samples: Sample[]): Parsed {
  const days: Record<string, Day> = {}; const fields = new Set<string>(); const ignored: string[] = [];
  const q: Record<string, Record<string, Record<string, { sum: number; last: number; lastT: number }>>> = {};
  const sleep: Sample[] = [];
  for (const s of samples) {
    if (s.key === "sleep") { sleep.push(s); continue; }
    const d = dayOfMin(s.start); const conv = CONV[s.key]; if (!conv) { ignored.push(s.key); continue; }
    const v = conv(s.value, s.unit);
    const bySrc = ((q[d] ||= {})[s.key] ||= {}); const a = (bySrc[s.source || ""] ||= { sum: 0, last: v, lastT: -1 });
    a.sum += v; if (s.start >= a.lastT) { a.lastT = s.start; a.last = v; }
  }
  for (const d of Object.keys(q)) for (const key of Object.keys(q[d])) {
    const srcs = Object.values(q[d][key]); let v: number;
    if (MODE[key] === "sum") v = Math.max(...srcs.map((a) => a.sum));
    else { const best = srcs.reduce((p, a) => a.lastT >= p.lastT ? a : p); v = best.last; }
    (days[d] ||= {})[key] = INT.has(key) ? Math.round(v) : r1(v); fields.add(key);
  }
  // Sommeil : segments triés, une nuit = segments séparés de moins de 3 h ; la nuit est rattachée au jour du réveil ; si plusieurs sources, on garde celle qui a le plus de sommeil.
  sleep.sort((a, b) => a.start - b.start);
  const nights: Record<string, Record<string, Sample[]>> = {};
  const lastEnd: Record<string, number> = {}; const curKey: Record<string, string> = {};
  for (const s of sleep) {
    const src = s.source || "";
    if (lastEnd[src] == null || s.start - lastEnd[src] > 180) curKey[src] = String(s.start);
    lastEnd[src] = Math.max(lastEnd[src] ?? 0, s.end);
    ((nights[curKey[src]] ||= {})[src] ||= []).push(s);
  }
  const byWake: Record<string, { asleep: number; deep: number; rem: number; awake: number; inbed: number; bed: number; wake: number; hasPhase: boolean }> = {};
  for (const nk of Object.keys(nights)) {
    let best: ReturnType<typeof nightStats> | null = null;
    for (const src of Object.keys(nights[nk])) { const st = nightStats(nights[nk][src]); if (!best || better(st, best)) best = st; }
    if (!best) continue;
    const wd = dayOfMin(best.wake); const prev = byWake[wd];
    if (!prev || better(best, prev)) byWake[wd] = best;
  }
  for (const wd of Object.keys(byWake)) {
    const n = byWake[wd]; const D = (days[wd] ||= {});
    if (n.asleep > 0) { D.sleep = r1(n.asleep / 60); fields.add("sleep"); }
    else if (n.inbed > 0) { D.sleep = r1(n.inbed / 60); fields.add("sleep"); }
    if (n.inbed > 0) D.inbed = r1(n.inbed / 60);
    if (n.hasPhase) { D.deep = r1(n.deep / 60); D.rem = r1(n.rem / 60); fields.add("deep"); fields.add("rem"); }
    if (n.awake > 0) D.awake = r1(n.awake / 60);
    D.bed = hhmmOfMin(n.bed); D.wake = hhmmOfMin(n.wake); fields.add("bed"); fields.add("wake");
  }
  return { days, fields, samples: samples.length, ignored };
}
// Entre deux sources pour une même nuit : celle qui a des phases, sinon celle qui a le plus de sommeil
const better = (a: { hasPhase: boolean; asleep: number }, b: { hasPhase: boolean; asleep: number }) => a.hasPhase !== b.hasPhase ? a.hasPhase : a.asleep > b.asleep;
// Durée totale d'un ensemble d'intervalles, chevauchements comptés une seule fois (montre + matelas sur la même nuit)
function unionMin(iv: [number, number][]): number {
  if (!iv.length) return 0;
  const a = iv.slice().sort((x, y) => x[0] - y[0]); let tot = 0, s = a[0][0], e = a[0][1];
  for (let i = 1; i < a.length; i++) { if (a[i][0] > e) { tot += e - s; s = a[i][0]; e = a[i][1]; } else e = Math.max(e, a[i][1]); }
  return tot + (e - s);
}
function nightStats(segs: Sample[]) {
  const by: Record<string, [number, number][]> = { inbed: [], awake: [], deep: [], rem: [], core: [], asleep: [] };
  const st = { asleep: 0, deep: 0, rem: 0, awake: 0, inbed: 0, bed: Infinity, wake: -Infinity, hasPhase: false };
  for (const s of segs) {
    if (s.end <= s.start) continue;
    if (s.label && by[s.label]) by[s.label].push([s.start, s.end]);
    st.bed = Math.min(st.bed, s.start); st.wake = Math.max(st.wake, s.end);
  }
  st.hasPhase = by.deep.length + by.rem.length + by.core.length > 0;
  st.deep = unionMin(by.deep); st.rem = unionMin(by.rem); st.awake = unionMin(by.awake); st.inbed = unionMin(by.inbed);
  st.asleep = st.hasPhase ? unionMin([...by.deep, ...by.rem, ...by.core, ...by.asleep]) : unionMin(by.asleep); // sans phases (ex. Withings ancien format) : « endormi » cumulé
  return st;
}

// Format Raccourci : « début|fin|valeur|unité|type|source »
export function parseLines(text: string): Parsed {
  const samples: Sample[] = []; const bad: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const f = line.split("|").map((x) => x.trim());
    if (f.length < 3) { bad.push(line.slice(0, 60)); continue; }
    const start = parseDT(f[0]); const end = parseDT(f[1]) ?? start; const vs = f[2], unit = f[3] || "", type = f[4] || "", source = f[5] || "";
    if (start == null) { bad.push(line.slice(0, 60)); continue; }
    const label = sleepLabel(vs);
    const key = (type && keyFromType(type)) || keyFromUnit(unit, vs);
    if (!key) { bad.push(line.slice(0, 60)); continue; }
    const value = label ? 0 : num(vs); if (!label && value == null) { bad.push(line.slice(0, 60)); continue; }
    samples.push({ key, start, end: end ?? start, value: value ?? 0, label, unit, source });
  }
  const p = aggregate(samples); p.ignored.push(...bad); return p;
}

// Format Health Auto Export
export function parseHae(body: any): Parsed {
  const metrics: any[] = Array.isArray(body?.data?.metrics) ? body.data.metrics : Array.isArray(body?.metrics) ? body.metrics : [];
  const samples: Sample[] = []; const days: Record<string, Day> = {}; const fields = new Set<string>(); const ignored: string[] = [];
  for (const m of metrics) {
    const name = String(m?.name || ""), units = String(m?.units || ""), rows: any[] = Array.isArray(m?.data) ? m.data : [];
    if (name === "sleep_analysis") {
      for (const r of rows) {
        const endT = parseDT(r.sleepEnd || r.endDate || r.end), startT = parseDT(r.sleepStart || r.startDate || r.start);
        const d = endT != null ? dayOfMin(endT) : (parseDT(r.date) != null ? dayOfMin(parseDT(r.date)!) : null); if (!d) continue;
        const D = (days[d] ||= {});
        const asleep = num(r.asleep ?? r.totalSleep ?? r.total), inBed = num(r.inBed ?? r.in_bed), deep = num(r.deep), rem = num(r.rem), core = num(r.core), awake = num(r.awake);
        const u = units || "hr";
        if (asleep != null) { D.sleep = r1(hours(asleep, u)); fields.add("sleep"); }
        else if (deep != null || rem != null || core != null) { D.sleep = r1(hours((deep || 0) + (rem || 0) + (core || 0), u)); fields.add("sleep"); }
        if (inBed != null) D.inbed = r1(hours(inBed, u));
        if (deep != null) { D.deep = r1(hours(deep, u)); fields.add("deep"); }
        if (rem != null) { D.rem = r1(hours(rem, u)); fields.add("rem"); }
        if (awake != null) D.awake = r1(hours(awake, u));
        if (startT != null) { D.bed = hhmmOfMin(startT); fields.add("bed"); }
        if (endT != null) { D.wake = hhmmOfMin(endT); fields.add("wake"); }
      }
      continue;
    }
    const key = HAE[name]; if (!key) { if (name) ignored.push(name); continue; }
    for (const r of rows) {
      const t = parseDT(r.date); const q = num(r.qty ?? r.Avg ?? r.avg ?? r.value); if (t == null || q == null) continue;
      samples.push({ key, start: t, end: t, value: q, label: null, unit: units, source: "" });
    }
  }
  const agg = aggregate(samples);
  for (const d of Object.keys(days)) agg.days[d] = { ...(agg.days[d] || {}), ...days[d] };
  for (const f of fields) agg.fields.add(f);
  agg.ignored.push(...ignored);
  return agg;
}
