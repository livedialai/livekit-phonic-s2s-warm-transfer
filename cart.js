// cart.js — Warenkorb, Lieferdaten und Bestellung über den jambonz-Endpunkt.
//
// Nutzt NICHT den lokalen State, sondern /s2s/cart auf jambonz.example.de.
// Vorteil: derselbe Warenkorb wie im Cascade-Stack, Bestellungen landen in
// derselben Tabelle (store_orders) und die Bestellbestaetigung per E-Mail
// (Brevo, Funktion bestell_mail) wird vom Endpunkt bei action=close versendet.
//
// Die Session-ID ist der LiveKit-Raumname: call_sid = "livekit:<room>".

const CART_URL = process.env.CART_URL || "https://your-host.example.com/s2s/cart";

/** Tenant-ID fuer den Markt-Mail-Fallback (store_settings.order_email) */
const TENANT = Number(process.env.STORE_TENANT || 1);

/** LiveKit-Raumname -> call_sid des Endpunkts */
export function callSid(room) {
  return `livekit:${room}`;
}

async function cartCall(room, payload = {}) {
  const body = { call_sid: callSid(room), tenant: TENANT, ...payload };
  const res = await fetch(CART_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`cart: ungueltige Antwort (HTTP ${res.status}): ${raw.slice(0, 120)}`);
  }
  if (!res.ok || data?.ok === false) {
    throw new Error(`cart: ${data?.error || `HTTP ${res.status}`}`);
  }
  return data;
}

/** Position hinzufuegen (nur nach Bestaetigung durch den Kunden). */
export async function cartAdd(room, { artikel, menge, preis } = {}) {
  return cartCall(room, {
    action: "add",
    artikel: String(artikel || ""),
    menge: Math.max(1, Number(menge) || 1),
    preis: Number(preis) || 0,
  });
}

/** Warenkorb lesen (Positionen + Summe). */
export async function cartView(room) {
  return cartCall(room, { action: "list" });
}

/** Lieferdaten speichern — nur die genannten Felder, inkl. E-Mail. */
export async function lieferSpeichern(room, args = {}) {
  const felder = {};
  for (const k of ["name", "strasse", "hausnummer", "plz", "ort", "etage", "email"]) {
    const v = args?.[k];
    if (v !== undefined && String(v).trim() !== "") felder[k] = String(v).trim();
  }
  return cartCall(room, { action: "address", ...felder });
}

/** Bestellung abschliessen — der Endpunkt versendet dabei die Bestellmail. */
export async function abschluss(room) {
  return cartCall(room, { action: "close" });
}
