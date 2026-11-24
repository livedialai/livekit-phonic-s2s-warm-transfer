// LiveKit Cloud worker with Phonic S2S + warm transfer
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
import { z } from 'zod';

const BACKEND = process.env.BACKEND_URL;
const DID = process.env.CALLED_DID || '<transfer-number>';
const SIP_TRUNK_ID = process.env.LIVEKIT_SIP_OUTBOUND_TRUNK;
const SUPERVISOR = process.env.SUPERVISOR_PHONE_NUMBER || '<transfer-number>';

// --- Tools (webhook adapter) ---
async function callTool(name, query) {
  const url = `${process.env.TOOLS_BASE_URL}/${name}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return await res.text();
}

function parseForwards(raw) {
  try {
    const d = JSON.parse(raw);
    const text = typeof d === 'string' ? d : (d.result || d.text || '');
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
    name: z.string().describe('Name des Ansprechpartners, z.B. "Chef" oder "Frank Schmidt"'),
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

    // 3) Zusammenfassung als Audio (Phonic TTS)
    let pcm = null;
    if (summary) {
      try {
        const ttsText = `${summary} Soll ich Sie mit dem Anrufer verbinden?`;
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

        // c) Briefing (Wave, Sabrina) - nur im Consulting-Raum
        if (pcm) {
          try {
            await playBriefing(hroom, pcm);
            console.log('TRANSFER-BRIEFING-PLAYED');
          } catch (e) {
            console.log('TRANSFER-BRIEFING-FAIL', (e?.message || String(e)).slice(0, 160));
          }
        }

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
            minWordsToInterrupt: 2,
            generateWelcomeMessage: false,
          }),
        });
        await bsession.start({
          agent: new TransferAgent({ tools: { verbinden: verbindenTool, zurueck: zurueckTool } }),
          room: hroom,
        });
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

class MarketAgent extends voice.Agent {
  constructor() {
    super({
      instructions: INSTRUCTIONS,
      tools: {
        preis_abfrage: preisTool,
        angebote_abfrage: angeboteTool,
        weiterleitungen: weiterleitungenTool,
        weiterleiten: transferTool,
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
  async onEnter() {
    this.session.generateReply();
  }
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
