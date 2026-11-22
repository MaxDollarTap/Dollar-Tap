// Dollar Tap : serveur du jeu + sauvegarde des joueurs + paiements PayPal
const express = require("express"), crypto = require("crypto"), path = require("path"), fs = require("fs");
const Database = require("better-sqlite3");
const { BOT_TOKEN = "", PAYPAL_CLIENT_ID = "", PAYPAL_SECRET = "", PAYPAL_ENV = "sandbox", PAYPAL_WEBHOOK_ID = "",
  BASE_URL = "http://localhost:3000", DATA_DIR = ".", ALLOW_GUESTS = "1", PORT = 3000 } = process.env;
const PP = PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "dollartap.db"));
db.exec(`
CREATE TABLE IF NOT EXISTS players(uid TEXT PRIMARY KEY, state TEXT, updated INTEGER);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, uid TEXT, item TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS payments(order_id TEXT PRIMARY KEY, uid TEXT, item TEXT, amount TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS credits(id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, item TEXT, applied INTEGER DEFAULT 0, created INTEGER);
`);

// Catalogue : les PRIX sont fixés ici, côté serveur (le jeu ne peut pas les modifier)
const CATALOG = {
  p0: { eur: "0.50", name: "Dollar Tap - Pack 0,50 EUR" },
  p1: { eur: "2.00", name: "Dollar Tap - Pack 2 EUR" },
  p2: { eur: "5.00", name: "Dollar Tap - Pack 5 EUR" },
  p3: { eur: "10.00", name: "Dollar Tap - Pack 10 EUR" },
  p4: { eur: "20.00", name: "Dollar Tap - Pack 20 EUR" },
  so: { eur: "1.00", name: "Dollar Tap - Offre de depart" },
  pass: { eur: "4.99", name: "Dollar Tap - Pass de saison (30 jours)" },
  sk_gold: { eur: "1.99", name: "Dollar Tap - Apparence Or" },
  sk_neon: { eur: "2.99", name: "Dollar Tap - Apparence Neon" },
  sk_diamond: { eur: "4.99", name: "Dollar Tap - Apparence Diamant" },
};

// ---- Identité du joueur : Telegram (signature vérifiée) ou invité (navigateur) ----
function who(a) {
  a = a || {};
  if (a.init) {
    if (!BOT_TOKEN) return null;
    const p = new URLSearchParams(a.init), hash = p.get("hash");
    p.delete("hash");
    const data = [...p.entries()].map(([k, v]) => k + "=" + v).sort().join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const h = crypto.createHmac("sha256", secret).update(data).digest("hex");
    if (!hash || h.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash))) return null;
    if (Date.now() / 1000 - Number(p.get("auth_date") || 0) > 3 * 86400) return null;
    try { return "tg:" + JSON.parse(p.get("user")).id; } catch (e) { return null; }
  }
  if (ALLOW_GUESTS === "1" && /^[a-f0-9]{16,64}$/.test(a.guest || "")) return "g:" + a.guest;
  return null;
}
const needUser = (req, res, next) => {
  const u = who(req.body && req.body.auth);
  if (!u) return res.status(401).json({ error: "auth" });
  req.uid = u; next();
};

const app = express();
app.use(express.json({ limit: "200kb", verify: (req, _res, buf) => { req.raw = buf.toString(); } }));
app.use(express.text({ type: "text/plain", limit: "200kb" }));

// ---- API du jeu ----
app.post("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/load", needUser, (req, res) => {
  const r = db.prepare("SELECT state FROM players WHERE uid=?").get(req.uid);
  res.json({ state: r ? JSON.parse(r.state) : null });
});

app.post("/api/save", needUser, (req, res) => {
  const s = req.body.state;
  if (!s || typeof s !== "object" || JSON.stringify(s).length > 150000) return res.status(400).json({ error: "state" });
  db.prepare("INSERT INTO players(uid,state,updated) VALUES(?,?,?) ON CONFLICT(uid) DO UPDATE SET state=excluded.state, updated=excluded.updated")
    .run(req.uid, JSON.stringify(s), Date.now());
  res.json({ ok: true });
});

app.post("/api/credits", needUser, (req, res) => {
  res.json({ credits: db.prepare("SELECT id,item FROM credits WHERE uid=? AND applied=0 ORDER BY id LIMIT 50").all(req.uid) });
});

app.post("/api/ack", needUser, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(Number.isInteger) : [];
  const st = db.prepare("UPDATE credits SET applied=1 WHERE id=? AND uid=?");
  ids.forEach((id) => st.run(id, req.uid));
  res.json({ ok: true });
});

// ---- PayPal ----
async function ppToken() {
  const r = await fetch(PP + "/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(PAYPAL_CLIENT_ID + ":" + PAYPAL_SECRET).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("PayPal token refusé : vérifie PAYPAL_CLIENT_ID / PAYPAL_SECRET / PAYPAL_ENV");
  return j.access_token;
}

// Crédite UNE seule fois par commande PayPal (anti double-crédit)
function creditOnce(orderId, uid, item, amount) {
  const c = CATALOG[item];
  if (!c || Number(amount) !== Number(c.eur)) { console.warn("Montant/article inattendu", orderId, item, amount); return false; }
  const r = db.prepare("INSERT OR IGNORE INTO payments(order_id,uid,item,amount,created) VALUES(?,?,?,?,?)").run(orderId, uid, item, String(amount), Date.now());
  if (r.changes !== 1) return false;
  db.prepare("INSERT INTO credits(uid,item,created) VALUES(?,?,?)").run(uid, item, Date.now());
  notifyTg(uid, "paid");
  return true;
}

app.post("/api/order", needUser, async (req, res) => {
  try {
    const item = req.body.item, c = CATALOG[item];
    if (!c) return res.status(400).json({ error: "item" });
    if (item === "so" && db.prepare("SELECT 1 FROM payments WHERE uid=? AND item='so'").get(req.uid)) return res.status(400).json({ error: "already" });
    const tok = await ppToken();
    const r = await fetch(PP + "/v2/checkout/orders", {
      method: "POST",
      headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json", "PayPal-Request-Id": crypto.randomUUID() },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ reference_id: item, custom_id: req.uid + "|" + item, description: c.name, amount: { currency_code: "EUR", value: c.eur } }],
        payment_source: { paypal: { experience_context: {
          return_url: BASE_URL + "/paypal/return", cancel_url: BASE_URL + "/paypal/cancel",
          user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING", brand_name: "Dollar Tap" } } },
      }),
    });
    const j = await r.json();
    const link = (j.links || []).find((l) => l.rel === "payer-action" || l.rel === "approve");
    if (!j.id || !link) { console.error("PayPal order error", JSON.stringify(j)); return res.status(502).json({ error: "paypal" }); }
    db.prepare("INSERT INTO orders(id,uid,item,created) VALUES(?,?,?,?)").run(j.id, req.uid, item, Date.now());
    res.json({ url: link.href });
  } catch (e) { console.error(e); res.status(500).json({ error: "server" }); }
});

const page = (msg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="3;url=${BASE_URL}"><body style="font-family:system-ui;text-align:center;padding:48px 20px"><h2>${msg}</h2><p><a href="${BASE_URL}">Retour au jeu</a></p></body>`;

// Le joueur revient de PayPal : on capture le paiement et on crédite
app.get("/paypal/return", async (req, res) => {
  try {
    const orderId = String(req.query.token || ""), o = db.prepare("SELECT * FROM orders WHERE id=?").get(orderId);
    if (!o) return res.status(404).send(page("Commande inconnue"));
    const tok = await ppToken(), H = { Authorization: "Bearer " + tok, "Content-Type": "application/json" };
    let r = await fetch(`${PP}/v2/checkout/orders/${orderId}/capture`, { method: "POST", headers: { ...H, "PayPal-Request-Id": "cap-" + orderId } });
    let j = await r.json();
    if (j.status !== "COMPLETED") { r = await fetch(`${PP}/v2/checkout/orders/${orderId}`, { headers: H }); j = await r.json(); }
    const cap = j.purchase_units && j.purchase_units[0] && j.purchase_units[0].payments && j.purchase_units[0].payments.captures && j.purchase_units[0].payments.captures[0];
    if (j.status === "COMPLETED" && cap) { creditOnce(orderId, o.uid, o.item, cap.amount.value); return res.send(page("Paiement validé ✅ Tes bonus arrivent dans le jeu.")); }
    res.send(page("Paiement non terminé. Rien n’a été débité."));
  } catch (e) { console.error(e); res.status(500).send(page("Erreur, réessaie dans un instant.")); }
});
app.get("/paypal/cancel", (_req, res) => res.send(page("Paiement annulé.")));

// Webhook PayPal (filet de sécurité si le joueur ferme la page avant le retour)
app.post("/paypal/webhook", async (req, res) => {
  try {
    const tok = await ppToken();
    const v = await fetch(PP + "/v1/notifications/verify-webhook-signature", {
      method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_algo: req.get("paypal-auth-algo"), cert_url: req.get("paypal-cert-url"), transmission_id: req.get("paypal-transmission-id"),
        transmission_sig: req.get("paypal-transmission-sig"), transmission_time: req.get("paypal-transmission-time"),
        webhook_id: PAYPAL_WEBHOOK_ID, webhook_event: JSON.parse(req.raw),
      }),
    });
    const vj = await v.json();
    if (vj.verification_status !== "SUCCESS") return res.sendStatus(400);
    const ev = req.body;
    if (ev.event_type === "PAYMENT.CAPTURE.COMPLETED") {
      const r = ev.resource || {}, [uid, item] = String(r.custom_id || "").split("|");
      const orderId = (r.supplementary_data && r.supplementary_data.related_ids && r.supplementary_data.related_ids.order_id) || r.id;
      if (uid && item && r.amount && r.amount.currency_code === "EUR") creditOnce(orderId, uid, item, r.amount.value);
    }
    res.sendStatus(200);
  } catch (e) { console.error(e); res.sendStatus(500); }
});

// ================= BOT TELEGRAM =================
db.exec(`
CREATE TABLE IF NOT EXISTS users(tg INTEGER PRIMARY KEY, name TEXT, lang TEXT, parent INTEGER, snap REAL DEFAULT 0, created INTEGER);
CREATE TABLE IF NOT EXISTS notif_log(uid TEXT, kind TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
`);
const { TG_SECRET = "change-me", ADMIN_ID = "", CHANNEL_ID = "" } = process.env;
let BOT_USERNAME = process.env.BOT_USERNAME || "";
const COMM = 0.05;
const tgApi = (m, b) => fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${m}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }).then((r) => r.json()).catch(() => ({ ok: false }));
const openBtn = (l) => ({ inline_keyboard: [[{ text: l === "fr" ? "▶️ Ouvrir Dollar Tap" : "▶️ Open Dollar Tap", web_app: { url: BASE_URL } }]] });
// Messages du bot (FR / EN). Aucun message ne promet d'argent réel : les $ du jeu sont virtuels.
const TX = {
  fr: {
    welcome: "💲 Tape le dollar, monte de niveau et grimpe au classement !\n\nAppuie sur le bouton ci-dessous pour ouvrir Dollar Tap 👇",
    friend: (n) => "🎉 Un nouvel ami a rejoint via ton lien !\n\n" + (n < 5 ? `👥 ${n}/5 amis : encore ${5 - n} pour gagner +400 ⚡` : n === 5 ? "⚡ +400 énergies offertes !" : "⚡ +60 énergies offertes !") + "\n💰 Et 5 % de ce qu’il gagne chaque jour est à toi (rien n’est retiré à ton ami)",
    commission: (c) => `💰 Commission du jour : +${c} $ (monnaie du jeu)\n5 % des gains de tes amis, sans rien leur retirer.`,
    level: (n) => `🏆 Niveau ${n} atteint ! Va réclamer ta récompense 🎁`,
    top: (p) => `🥇 Tu es dans le top 10 ${p === "day" ? "du jour" : "de la semaine"} ! Une récompense t’attend ⚡`,
    paid: () => "✅ Paiement reçu ! Ton achat est dans le jeu.",
    energy: () => "⚡ Tes énergies sont rechargées ! Viens taper 💲",
  },
  en: {
    welcome: "💲 Tap the dollar, level up and climb the ranking!\n\nPress the button below to open Dollar Tap 👇",
    friend: (n) => "🎉 A new friend joined with your link!\n\n" + (n < 5 ? `👥 ${n}/5 friends: ${5 - n} more to win +400 ⚡` : n === 5 ? "⚡ +400 energy gifted!" : "⚡ +60 energy gifted!") + "\n💰 And 5% of what they earn each day is yours (nothing is taken from your friend)",
    commission: (c) => `💰 Daily commission: +${c} $ (in-game currency)\n5% of your friends’ earnings, nothing taken from them.`,
    level: (n) => `🏆 Level ${n} reached! Go claim your reward 🎁`,
    top: (p) => `🥇 You’re in the ${p === "day" ? "daily" : "weekly"} top 10! A reward is waiting ⚡`,
    paid: () => "✅ Payment received! Your purchase is in the game.",
    energy: () => "⚡ Your energy is refilled! Come tap 💲",
  },
};
async function sendTo(id, kind, a) {
  const u = db.prepare("SELECT lang FROM users WHERE tg=?").get(id);
  if (!u) return; // le joueur n'a jamais démarré le bot : on ne peut pas lui écrire
  const l = u.lang || "en";
  await tgApi("sendMessage", { chat_id: id, text: TX[l][kind](a), reply_markup: openBtn(l) });
}
function notifyTg(uid, kind, a) {
  if (!BOT_TOKEN || !String(uid).startsWith("tg:")) return;
  sendTo(Number(String(uid).slice(3)), kind, a).catch(() => {});
}
// Anti-spam : écart minimum entre deux messages du même type + plafond par jour
function canSend(uid, kind, gapMs, maxDay) {
  const now = Date.now();
  const last = db.prepare("SELECT MAX(ts) t FROM notif_log WHERE uid=? AND kind=?").get(uid, kind).t || 0;
  const day = db.prepare("SELECT COUNT(*) c FROM notif_log WHERE uid=? AND ts>?").get(uid, now - 864e5).c;
  if (now - last < gapMs || day >= maxDay) return false;
  db.prepare("INSERT INTO notif_log VALUES(?,?,?)").run(uid, kind, now);
  return true;
}
app.post("/api/config", (_req, res) => res.json({ bot: BOT_USERNAME }));
app.post("/api/notify", needUser, (req, res) => {
  res.json({ ok: true });
  const k = req.body.kind, d = req.body.data || {};
  if (k === "level" && Number.isInteger(d.n) && d.n > 0 && d.n <= 100 && canSend(req.uid, "level", 5 * 60e3, 10)) notifyTg(req.uid, "level", d.n);
  if (k === "top" && ["day", "week"].includes(d.p) && canSend(req.uid, "top" + d.p, 6 * 3600e3, 4)) notifyTg(req.uid, "top", d.p);
});
app.post("/api/friends", needUser, (req, res) => {
  if (!req.uid.startsWith("tg:")) return res.json({ friends: [] });
  const rows = db.prepare("SELECT u.name, p.state FROM users u LEFT JOIN players p ON p.uid='tg:'||u.tg WHERE u.parent=?").all(Number(req.uid.slice(3)));
  res.json({ friends: rows.map((r) => { let s = {}; try { s = JSON.parse(r.state || "{}"); } catch (e) {} return { n: r.name || "?", t: Number(s.total) || 0, e: Number((s.m || {}).earned) || 0, md: (s.m || {}).d || "" }; }) });
});

async function referral(child, parent) {
  if (child === parent || !db.prepare("SELECT 1 FROM users WHERE tg=?").get(parent)) return;
  db.prepare("UPDATE users SET parent=? WHERE tg=?").run(parent, child);
  const n = db.prepare("SELECT COUNT(*) c FROM users WHERE parent=?").get(parent).c;
  db.prepare("INSERT INTO credits(uid,item,created) VALUES(?,?,?)").run("tg:" + parent, "friend:" + n, Date.now());
  await sendTo(parent, "friend", n);
}
async function handleUpdate(u) {
  if (u.callback_query) {
    const q = u.callback_query, m = /^lang:(fr|en)$/.exec(q.data || "");
    if (m) {
      db.prepare("UPDATE users SET lang=? WHERE tg=?").run(m[1], q.from.id);
      await tgApi("answerCallbackQuery", { callback_query_id: q.id });
      await tgApi("sendMessage", { chat_id: q.from.id, text: TX[m[1]].welcome, reply_markup: openBtn(m[1]) });
    }
    return;
  }
  const msg = u.message;
  if (!msg || !msg.text || msg.chat.type !== "private") return;
  const f = msg.from, text = msg.text.trim();
  if (text.startsWith("/channel") && ADMIN_ID && String(f.id) === String(ADMIN_ID) && CHANNEL_ID) {
    await tgApi("sendMessage", { chat_id: CHANNEL_ID, text: "💲 Dollar Tap\n\nTape le dollar, monte de niveau, invite tes amis et grimpe au classement !\n\nTap the dollar, level up, invite friends and climb the ranking!",
      reply_markup: { inline_keyboard: [[{ text: "▶️ Jouer / Play", url: `https://t.me/${BOT_USERNAME}?start=channel` }]] } });
    await tgApi("sendMessage", { chat_id: f.id, text: "✅ Publié sur le canal / Posted to the channel" });
    return;
  }
  if (text.startsWith("/start")) {
    const param = text.split(/\s+/)[1] || "";
    const ins = db.prepare("INSERT OR IGNORE INTO users(tg,name,created) VALUES(?,?,?)").run(f.id, f.first_name || "", Date.now());
    db.prepare("UPDATE users SET name=? WHERE tg=?").run(f.first_name || "", f.id);
    if (ins.changes === 1 && /^ref_\d+$/.test(param)) await referral(f.id, Number(param.slice(4)));
    const u2 = db.prepare("SELECT lang FROM users WHERE tg=?").get(f.id);
    if (!u2.lang) {
      await tgApi("sendMessage", { chat_id: f.id, text: "🌍 Choisis une langue / Choose a language",
        reply_markup: { inline_keyboard: [[{ text: "🇫🇷 Français", callback_data: "lang:fr" }], [{ text: "🇬🇧 English", callback_data: "lang:en" }]] } });
    } else await tgApi("sendMessage", { chat_id: f.id, text: TX[u2.lang].welcome, reply_markup: openBtn(u2.lang) });
  }
}
app.post("/telegram/webhook", (req, res) => {
  if (req.get("x-telegram-bot-api-secret-token") !== TG_SECRET) return res.sendStatus(401);
  res.sendStatus(200);
  handleUpdate(req.body).catch((e) => console.error("bot", e));
});

// ---- Tâches automatiques : commissions de parrainage (chaque jour) et rappels d'énergie (chaque heure) ----
const getMeta = (k) => (db.prepare("SELECT v FROM meta WHERE k=?").get(k) || {}).v;
const setMeta = (k, v) => db.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v));
function commissions() {
  db.prepare("SELECT tg,parent,snap FROM users WHERE parent IS NOT NULL").all().forEach((u) => {
    const p = db.prepare("SELECT state FROM players WHERE uid=?").get("tg:" + u.tg);
    if (!p) return;
    let s; try { s = JSON.parse(p.state); } catch (e) { return; }
    const total = Number(s.total) || 0, delta = total - u.snap, c = +(delta * COMM).toFixed(3);
    if (delta > 0 && c > 0) {
      db.prepare("INSERT INTO credits(uid,item,created) VALUES(?,?,?)").run("tg:" + u.parent, "commission:" + c, Date.now());
      notifyTg("tg:" + u.parent, "commission", c);
    }
    db.prepare("UPDATE users SET snap=? WHERE tg=?").run(total, u.tg);
  });
  db.prepare("DELETE FROM notif_log WHERE ts<?").run(Date.now() - 7 * 864e5);
}
function energyReminders() {
  db.prepare("SELECT uid,state,updated FROM players WHERE uid LIKE 'tg:%'").all().forEach((r) => {
    let s; try { s = JSON.parse(r.state); } catch (e) { return; }
    if (!s.notif || Date.now() - r.updated < 50 * 60e3) return;
    if (canSend(r.uid, "energy", 6 * 3600e3, 3)) notifyTg(r.uid, "energy");
  });
}
function runJobs() {
  const iso = new Date().toISOString();
  if (getMeta("commDay") !== iso.slice(0, 10)) { setMeta("commDay", iso.slice(0, 10)); commissions(); }
  if (getMeta("hour") !== iso.slice(0, 13)) { setMeta("hour", iso.slice(0, 13)); energyReminders(); }
}
setInterval(runJobs, 60000);
async function setupBot() {
  if (!BOT_TOKEN) return console.log("BOT_TOKEN absent : bot désactivé");
  const me = await tgApi("getMe");
  if (me.ok) BOT_USERNAME = me.result.username;
  if (BASE_URL.startsWith("https://")) {
    await tgApi("setWebhook", { url: BASE_URL + "/telegram/webhook", secret_token: TG_SECRET, allowed_updates: ["message", "callback_query"] });
    await tgApi("setChatMenuButton", { menu_button: { type: "web_app", text: "Dollar Tap", web_app: { url: BASE_URL } } });
  }
  await tgApi("setMyCommands", { commands: [{ command: "start", description: "Démarrer / Start" }] });
  console.log("Bot prêt : @" + BOT_USERNAME);
}

// ---- Le jeu lui-même (page web) ----
app.use(express.static(path.join(__dirname, "public")));
app.listen(PORT, () => { console.log(`Dollar Tap prêt sur le port ${PORT} (PayPal: ${PAYPAL_ENV})`); setupBot(); runJobs(); });
