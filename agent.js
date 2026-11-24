// the store – LiveKit-Cloud-Worker mit Phonic S2S + Warm Transfer
// Voice: sabrina (Phonic), Sprache: de
import {
  ServerOptions,
  cli,
  defineAgent,
  llm,
  voice,
  workflows,
} from '@livekit/agents';
import * as phonic from '@livekit/agents-plugin-phonic';
import { SipClient, AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { Room } from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { summarizeTranscript, phonicTtsPcm, playBriefing, startMoh } from './warmtransfer.js';
import { cartAdd, cartView, lieferSpeichern, abschluss } from './cart.js';
import { z } from 'zod';

const BACKEND = process.env.BACKEND_URL;
const DID = process.env.CALLED_DID || '<transfer-number>';
const SIP_TRUNK_ID = process.env.LIVEKIT_SIP_OUTBOUND_TRUNK;
const SUPERVISOR = process.env.SUPERVISOR_PHONE_NUMBER || '<transfer-number>';

// --- Tools (Webhook-Adapter, laufen auf s2s.example.de) ---
async function callTool(name, query) {
  const url = `${process.env.TOOLS_BASE_URL}/${name}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  // Adapter liefert {"result":"<text>"} — dem S2S-Modell muss der reine Text
  // uebergeben werden, nicht der JSON-String mit Escapes (sonst findet es keine Artikel).
  const raw = await res.text();
  try {
    const j = JSON.parse(raw);
    const out = j.result ?? j.text ?? j.antwort;
    if (typeof out === 'string') return out;
    if (out != null) return JSON.stringify(out);
    return raw;
  } catch {
    return raw;
  }
}

function parseForwards(raw) {
  try {
    let text = String(raw ?? '');
    // callTool liefert seit dem Parsing-Fix reinen Text. Falls doch noch ein
    // JSON-Objekt ankommt (aeltere Variante), hier auspacken.
    if (text.trim().startsWith('{')) {
      try {
        const d = JSON.parse(text);
        text = typeof d === 'string' ? d : (d.result || d.text || '');
      } catch { /* war kein JSON — Text unveraendert weiterverwenden */ }
    }
    const out = [];
    for (const line of String(text).split('\n')) {
      const m = line.match(/^\s*\d+\)\s*(.+?)\s*(?:→|->)\s*([+0-9][0-9\s\/-]{5,})/);
      if (m) out.push({ name: m[1].trim(), destination: m[2].replace(/[^+0-9]/g, '') });
    }
    return out;
  } catch {
    return [];
  }
}

const preisTool = llm.tool({
  description: 'Fragt den Preis eines Produkts im the store ab.',
  parameters: z.object({ query: z.string().describe('Produktname, z.B. Butter') }),
  execute: async ({ query }) => await callTool('preis_abfrage', query),
});

const angeboteTool = llm.tool({
  description: 'Fragt die aktuellen Angebote im the store ab.',
  parameters: z.object({ query: z.string().describe('Stichwort, z.B. Milch') }),
  execute: async ({ query }) => await callTool('angebote_abfrage', query),
});

const weiterleitungenTool = llm.tool({
  description: 'Listet die Namen der Ansprechpartner des Marktes auf. Keine Nummern.',
  parameters: z.object({}),
  execute: async () => {
    const raw = await callTool('weiterleitungen', '');
    const list = parseForwards(raw);
    const names = list.map((i) => i.name).filter(Boolean);
    return names.length ? 'Ansprechpartner: ' + names.join(', ') : 'Keine Ansprechpartner hinterlegt.';
  },
});

const transferTool = llm.tool({
  description:
    'Leitet den laufenden Anruf an einen Mitarbeiter weiter (Warm Transfer mit Zusammenfassung). ' +
    'Aufrufen, sobald der Anrufer nach einer Person fragt - ohne Rueckfrage. ' +
    'Nur den Namen uebergeben. NIEMALS eine Telefonnummer.',
  parameters: z.object({
    name: z.string().describe('Name des Ansprechpartners, z.B. "Chef" oder "a colleague"'),
  }),
  execute: async ({ name }, opts) => {
    const ctx = opts?.ctx;
    if (!SIP_TRUNK_ID) return 'Weiterleitung ist nicht konfiguriert.';
    const session = ctx?.session || ctx?._executor?.session;
    const roomName = session?.room?.name || globalThis.__roomName;
    const room = globalThis.__room;
    if (!roomName) return 'Weiterleitung ist gerade nicht moeglich.';

    // 1) Nummer serverseitig ermitteln
    let phone = '';
    try {
      const raw = await callTool('weiterleitungen', '');
      const arr = parseForwards(raw);
      const q = (name || '').toLowerCase().trim();
      const match =
        arr.find((i) => (i.name || '').toLowerCase() === q) ||
        arr.find((i) => (i.name || '').toLowerCase().includes(q) || q.includes((i.name || '').toLowerCase()));
      phone = match?.destination || '';
      console.log('TRANSFER-LOOKUP', JSON.stringify(name), '->', phone);
    } catch (e) {
      console.log('TRANSFER-LOOKUP-FAIL', String(e).slice(0, 160));
    }
    if (!phone) return `Keinen Ansprechpartner fuer ${name} gefunden.`;

    // 2) Transkript + Zusammenfassung (reines LLM)
    let summary = '';
    try {
      const items = session?.history?.items || [];
      const transcript = items
        .filter((i) => (i.role === 'user' || i.role === 'assistant') && (i.textContent || '').trim())
        .map((i) => `${i.role}: ${String(i.textContent).trim()}`)
        .slice(-24)
        .join('\n');
      console.log('TRANSFER-TRANSCRIPT-LEN', transcript.length);
      if (transcript.length > 20) {
        summary = await summarizeTranscript(transcript, {
          apiKey: process.env.REQUESTY_KEY,
          baseUrl: process.env.REQUESTY_BASE,
          model: process.env.LLM_MODEL,
        });
      }
    } catch (e) {
      console.log('TRANSFER-SUMMARY-FAIL', (e?.message || String(e)).slice(0, 160));
    }
    console.log('TRANSFER-SUMMARY', JSON.stringify(summary).slice(0, 240));

    // 3) Briefing-Text + optional vorproduziertes Audio (Fallback)
    let pcm = null;
    let ttsText = null;
    if (summary) {
      try {
        ttsText = `${summary} Soll ich Sie mit dem Anrufer verbinden?`;
        pcm = await phonicTtsPcm(ttsText, { apiKey: process.env.PHONIC_API_KEY });
        console.log('TRANSFER-TTS-BYTES', pcm.length);
      } catch (e) {
        console.log('TRANSFER-TTS-FAIL', (e?.message || String(e)).slice(0, 160));
      }
    }

    // 4) Standard-Warmtransfer:
    //    Caller auf Hold + MOH, Chef in Consulting-Raum, Wave (Briefing),
    //    dann Zustimmung/Ablehnung durch den TransferAgent.
    let moh = null;
    try {
      if (room) {
        moh = startMoh(room, new URL('./music_hold.wav', import.meta.url).pathname);
        console.log('TRANSFER-MOH-STARTED');
      }
    } catch (e) {
      console.log('TRANSFER-MOH-FAIL', (e?.message || String(e)).slice(0, 160));
    }

    try {
      session.input.setAudioEnabled(false);
      session.output.setAudioEnabled(false);
      console.log('TRANSFER-CALLER-ON-HOLD');
    } catch (e) {
      console.log('TRANSFER-HOLD-FAIL', (e?.message || String(e)).slice(0, 160));
    }

    (async () => {
      let hroom = null;
      let bsession = null;
      try {
        const url = process.env.LIVEKIT_URL || '';
        const key = process.env.LIVEKIT_API_KEY || '';
        const secret = process.env.LIVEKIT_API_SECRET || '';
        const httpUrl = url.replace(/^ws/, 'http');
        const humanRoom = `${roomName}-human`;
        const chefIdentity = `transfer_${Date.now()}`;
        const svc = new RoomServiceClient(httpUrl, key, secret);

        // a) Consulting-Raum + Briefing-Bot
        const at = new AccessToken(key, secret, { identity: `briefing_${Date.now()}`, ttl: 900 });
        at.addGrant({ roomJoin: true, room: humanRoom, canPublish: true, canSubscribe: true });
        const tok = await at.toJwt();
        hroom = new Room();
        await hroom.connect(url, tok);
        console.log('TRANSFER-HUMAN-ROOM', humanRoom);

        // b) Chef in den Consulting-Raum rufen (warten bis abgenommen)
        const sip = new SipClient(httpUrl, key, secret);
        const participant = await sip.createSipParticipant(SIP_TRUNK_ID, phone, humanRoom, {
          participantIdentity: chefIdentity,
          participantName: name,
          playDialtone: false,
          waitUntilAnswered: true,
          ringingTimeout: 45,
          timeout: 60,
        });
        console.log('TRANSFER-CHEF-ANSWERED', participant?.participantId || '');

        // d) TransferAgent-Session im Consulting-Raum (Zustimmung / Ablehnung)
        const verbindenTool = llm.tool({
          description: 'Nach Zustimmung: verbindet den Anrufer mit dem Mitarbeiter.',
          parameters: z.object({}),
          execute: async () => {
            console.log('TRANSFER-ACCEPT');
            if (moh) { try { await moh.stop(); } catch {} }
            // 400 ms Luft, damit die MOH-Queue leer ist, bevor der Chef umzieht
            await new Promise((r) => setTimeout(r, 400));
            await svc.moveParticipant(humanRoom, chefIdentity, roomName);
            console.log('TRANSFER-MOVED', chefIdentity, '->', roomName);
            // Beide Agenten raus - Anrufer und Mitarbeiter sprechen direkt
            setTimeout(() => { try { hroom.disconnect(); } catch {} }, 1200);
            setTimeout(() => { try { bsession.shutdown(); } catch {} }, 1200);
            setTimeout(() => { try { session.shutdown(); } catch {} }, 2000);
            return 'Verbunden. Sage nichts mehr.';
          },
        });

        const zurueckTool = llm.tool({
          description: 'Bei Ablehnung: beendet den Mitarbeiter-Anruf und gibt den Anrufer zurueck.',
          parameters: z.object({}),
          execute: async () => {
            console.log('TRANSFER-REJECT');
            try { await svc.removeParticipant(humanRoom, chefIdentity); } catch {}
            if (moh) { try { await moh.stop(); } catch {} }
            setTimeout(() => { try { hroom.disconnect(); } catch {} }, 300);
            setTimeout(() => { try { bsession.shutdown(); } catch {} }, 600);
            try {
              session.input.setAudioEnabled(true);
              session.output.setAudioEnabled(true);
            } catch {}
            try {
              await session.generateReply({
                instructions:
                  'Sage genau diesen Satz: Kann ich sonst weiterhelfen oder moechten Sie es spaeter versuchen?',
              });
            } catch {}
            return 'Abgelehnt, Anrufer ist zurueck.';
          },
        });

        bsession = new voice.AgentSession({
          llm: new phonic.realtime.RealtimeModel({
            apiKey: process.env.PHONIC_API_KEY,
            voice: process.env.PHONIC_VOICE || 'sabrina',
            defaultLanguage: 'de',
            additionalLanguages: [],
            // 1 statt 2: Ein einzelnes "Ja" muss als Antwort zaehlen.
            minWordsToInterrupt: 1,
            generateWelcomeMessage: false,
          }),
        });
        await bsession.start({
          agent: new TransferAgent({ tools: { verbinden: verbindenTool, zurueck: zurueckTool } }),
          room: hroom,
        });
        // Briefing ueber DIESELBE Session sprechen. Damit kennt die
        // Turn-Detection den Sprechzustand und hoert direkt danach zu —
        // kein separater Track, kein Timing-Loch.
        if (ttsText) {
          try {
            const speech = bsession.say(ttsText, { allowInterruptions: false });
            await speech.waitForPlayout();
            console.log('TRANSFER-BRIEFING-SAID');
          } catch (e) {
            console.log('TRANSFER-BRIEFING-SAY-FAIL', (e?.message || String(e)).slice(0, 160));
            // Fallback: vorproduziertes Wave ueber einen Track
            if (pcm) {
              try {
                await playBriefing(hroom, pcm);
                console.log('TRANSFER-BRIEFING-PLAYED');
              } catch (e2) {
                console.log('TRANSFER-BRIEFING-FAIL', (e2?.message || String(e2)).slice(0, 160));
              }
            }
          }
        }
        console.log('TRANSFER-AGENT-READY');
      } catch (e) {
        console.log('TRANSFER-FAIL', name, phone, (e?.message || String(e)).slice(0, 200));
        if (moh) { try { await moh.stop(); } catch {} }
        if (hroom) { try { hroom.disconnect(); } catch {} }
        try {
          session.input.setAudioEnabled(true);
          session.output.setAudioEnabled(true);
        } catch {}
      }
    })();

    return `Einen Moment bitte, ich verbinde mit ${name}.`;
  },
});



const INSTRUCTIONS = fs.readFileSync(new URL('./prompt.txt', import.meta.url), 'utf8');

// --- Warenkorb / Lieferdaten / Bestellung (1:1 aus dem jambonz-Cascade-Stack) ---
// State liegt pro LiveKit-Raum, ein Raum = ein Anruf.
const ROOM = () => globalThis.__roomName || 'unknown-room';

/** "6 x 0,33 l" -> 6 ; sonst 1 (Gebinde-Erkennung wie im Cascade-Stack) */
function packSize(artikel) {
  const m = String(artikel).match(/(\d+)\s*[x×]\s*[\d,.]+\s*l/i);
  return m ? Math.max(1, Number(m[1])) : 1;
}

const warenkorbHinzufuegenTool = llm.tool({
  description:
    'Legt eine vom Kunden bestaetigte Position in den Warenkorb. menge = Anzahl Gebinde. ' +
    'Erst aufrufen, nachdem der Kunde den Preis gehoert und bestaetigt hat.',
  parameters: z.object({
    artikel: z.string().describe('Artikelname exakt wie im Suchergebnis, z.B. "the store Bio Suessrahmbutter 250 g"'),
    menge: z.number().describe('Anzahl Gebinde/Packungen'),
    preis: z.number().describe('Einzelpreis pro Gebinde in Euro, z.B. 2.79'),
    einheit: z
      .enum(['gebinde', 'flasche'])
      .optional()
      .describe('flasche, wenn der Kunde Flaschen nennt, sonst gebinde'),
  }),
  execute: async ({ artikel, menge, preis, einheit }) => {
    const pack = packSize(artikel);
    let gebinde = Math.max(1, Number(menge) || 1);
    const willFlaschen =
      String(einheit || '').toLowerCase().startsWith('flasch') || Number(menge) > 1;
    if (pack > 1 && willFlaschen) gebinde = Math.max(1, Math.ceil(Number(menge) / pack));
    const out = await cartAdd(ROOM(), { artikel, menge: gebinde, preis });
    return JSON.stringify({ ...out, erkannte_gebinde: gebinde, packung: pack });
  },
});

const warenkorbLesenTool = llm.tool({
  description: 'Liest den Warenkorb mit Positionen und Summe. Vor jeder Summenansage aufrufen.',
  parameters: z.object({}),
  execute: async () => JSON.stringify(await cartView(ROOM())),
});

const lieferdatenTool = llm.tool({
  description:
    'Speichert Lieferdaten. Nur die Felder senden, die der Kunde genannt hat. ' +
    'Nach einer E-Mail-Adresse wird NICHT gefragt — die Bestaetigung geht an den Markt.',
  parameters: z.object({
    name: z.string().optional(),
    strasse: z.string().optional(),
    hausnummer: z.string().optional(),
    plz: z.string().optional(),
    ort: z.string().optional(),
    etage: z.string().optional(),
  }),
  execute: async (args) => JSON.stringify(await lieferSpeichern(ROOM(), args)),
});

const bestellungTool = llm.tool({
  description:
    'Schliesst die Bestellung ab, vergibt die Bestellnummer und schickt die Bestaetigung per E-Mail. ' +
    'Erst aufrufen, wenn Warenkorb und alle Lieferdaten inklusive E-Mail vorliegen.',
  parameters: z.object({}),
  execute: async () => JSON.stringify(await abschluss(ROOM())),
});

// Datum/Uhrzeit zur Laufzeit — wird bei jedem Session-Start neu erzeugt,
// damit der Agent "Wie spaet ist es?" und "Welcher Tag ist heute?" beantworten kann.
function nowContext() {
  const d = new Date();
  const datum = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(d);
  const zeit = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
  return `

## AKTUELLES DATUM UND UHRZEIT
Es ist jetzt ${datum}, ${zeit} Uhr (Europe/Berlin).
- Nutze diese Angaben fuer alle Fragen nach Datum, Wochentag, Uhrzeit und fuer "heute", "morgen", "gestern".
- Nenne niemals eine Uhrzeit oder ein Datum, das nicht hier steht oder vom Kunden kommt.
- Wenn der Markt geschlossen hat, sage das offen und biete an, die Bestellung fuer die naechste Oeffnung aufzunehmen.
`;
}

class MarketAgent extends voice.Agent {
  constructor() {
    super({
      instructions: INSTRUCTIONS + nowContext(),
      tools: {
        preis_abfrage: preisTool,
        angebote_abfrage: angeboteTool,
        weiterleitungen: weiterleitungenTool,
        weiterleiten: transferTool,
        warenkorb_hinzufuegen: warenkorbHinzufuegenTool,
        warenkorb_lesen: warenkorbLesenTool,
        lieferdaten_speichern: lieferdatenTool,
        bestellung_abschliessen: bestellungTool,
      },
    });
  }
  async onEnter() {
    this.session.generateReply();
  }
}

const TRANSFER_INSTRUCTIONS = `
Du bist die Telefonassistenz und sprichst mit einem Mitarbeiter des Marktes.
Du hast ihm gerade die Zusammenfassung des Anrufers vorgespielt.

WICHTIG: Die Frage "Soll ich Sie mit dem Anrufer verbinden?" wurde bereits im Audio gestellt.
Du fragst NICHT noch einmal. Du wartest ausschliesslich auf die Antwort des Mitarbeiters.

Ablauf:
1. Schweige, bis der Mitarbeiter antwortet.
2. Bei Zustimmung (ja, gerne, verbinden, passt, mache ich): sage genau "Ich verbinde" und rufe SOFORT das Tool verbinden auf. Danach sagst du nichts mehr.
3. Bei Ablehnung (nein, nicht, spaeter, kein Interesse): sage genau "Ok, ich verbinde nicht" und rufe SOFORT das Tool zurueck auf.
4. Kommt keine klare Antwort, frage EINMAL kurz: "Verbinden?"
5. Keine weiteren Saetze, keine Floskeln, keine Erklaerungen.
`.trim();

class TransferAgent extends voice.Agent {
  constructor(opts) {
    super({ instructions: TRANSFER_INSTRUCTIONS, tools: opts.tools });
    this.opts = opts;
  }
  // KEIN generateReply() beim Betreten: Die Frage "Soll ich Sie mit dem Anrufer
  // verbinden?" wurde bereits im Briefing-Audio gestellt. Der Agent muss schweigen
  // und auf die Antwort des Mitarbeiters warten — sonst redet er dazwischen und
  // das erste "Ja" geht als Barge-in verloren.
}

export default defineAgent({
  agentName: 'phonic-agent',
  entry: async (ctx) => {
    const session = new voice.AgentSession({
      llm: new phonic.realtime.RealtimeModel({
        voice: 'sabrina',
        apiKey: process.env.PHONIC_API_KEY,
        defaultLanguage: 'de',
        additionalLanguages: [],
        minWordsToInterrupt: 2,
        enableAssistantBackchannel: false,
        generateWelcomeMessage: false,
        welcomeMessage:
          'Guten Tag! Hier ist the assistant vom the store. Was darf ich für Sie tun?',
      }),
    });
    await session.start({ agent: new MarketAgent(), room: ctx.room });
    await ctx.connect();
    globalThis.__roomName = ctx.room?.name || session.room?.name;
    globalThis.__room = ctx.room;
    console.log('ENTRY room=', ctx.room?.name, 'session.room=', session.room?.name, 'global=', globalThis.__roomName);
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), port: 8095 }));
