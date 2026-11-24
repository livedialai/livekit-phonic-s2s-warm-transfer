import { AudioSource, AudioFrame, LocalAudioTrack } from '@livekit/rtc-node';
import { RoomServiceClient } from 'livekit-server-sdk';
import fs from 'node:fs';

const OUT_RATE = 48000;
const FRAME_MS = 20;

// PCM (s16le, mono) von srcRate auf 48 kHz linear resampeln
function resample(pcm, srcRate, dstRate = OUT_RATE) {
  if (srcRate === dstRate) return pcm;
  const ratio = dstRate / srcRate;
  const inSamples = Math.floor(pcm.length / 2);
  const outSamples = Math.floor(inSamples * ratio);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, inSamples - 1);
    const frac = pos - i0;
    const s0 = pcm.readInt16LE(i0 * 2);
    const s1 = pcm.readInt16LE(i1 * 2);
    const v = Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * frac)));
    out.writeInt16LE(v, i * 2);
  }
  return out;
}


// Der Anrufer darf das Briefing NICHT hoeren - nur der Mitarbeiter.
async function muteCallerForTrack(room, trackSid) {
  try {
    const svc = new RoomServiceClient(
      (process.env.LIVEKIT_URL || '').replace(/^ws/, 'http'),
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
    );
    for (const p of room.remoteParticipants.values()) {
      const id = String(p.identity || '');
      if (id.startsWith('transfer_')) continue; // Mitarbeiter
      if (id.startsWith('sip') || /\+\d{6,}/.test(id)) {
        await svc.updateSubscriptions(room.name, id, [trackSid], false);
        console.log('BRIEFING-MUTE-CALLER', id);
      }
    }
  } catch (e) {
    console.log('BRIEFING-MUTE-FAIL', String(e?.message || e).slice(0, 160));
  }
}

async function publishPcm(room, name, pcm, srcRate) {
  const buf = resample(pcm, srcRate, OUT_RATE);
  const source = new AudioSource(OUT_RATE, 1);
  const track = LocalAudioTrack.createAudioTrack(name, source);
  const pub = await room.localParticipant.publishTrack(track, {});
  await muteCallerForTrack(room, pub.trackSid);
  await new Promise((r) => setTimeout(r, 350));
  const samplesPerFrame = Math.round(OUT_RATE * (FRAME_MS / 1000));
  const bytesPerFrame = samplesPerFrame * 2;
  for (let off = 0; off + 2 <= buf.length; off += bytesPerFrame) {
    const slice = buf.subarray(off, Math.min(off + bytesPerFrame, buf.length));
    const n = Math.floor(slice.length / 2);
    if (n < 1) break;
    const data = new Int16Array(n);
    for (let k = 0; k < n; k++) data[k] = slice.readInt16LE(k * 2);
    await source.captureFrame(new AudioFrame(data, OUT_RATE, 1, n));
  }
  // Warten, bis die Queue wirklich abgespielt ist (Echtzeit), sonst wird der
  // Track zu frueh unpublished und der Teilnehmer hoert nichts.
  const durationMs = Math.round((buf.length / 2 / OUT_RATE) * 1000);
  console.log('BRIEFING-DURATION-MS', durationMs);
  await new Promise((r) => setTimeout(r, durationMs + 500));
  try {
    await room.localParticipant.unpublishTrack(pub.trackSid, true);
  } catch {}
}

// Briefing (Zusammenfassung) in den Raum spielen - PCM 24k von Phonic
export async function playBriefing(room, pcm24k) {
  await publishPcm(room, 'briefing', pcm24k, 24000);
}

// MOH als Endlosschleife starten (raw PCM 48k, mono)
export function startMoh(room, wavPath) {
  const file = fs.readFileSync(wavPath);
  // RIFF/WAVE -> PCM-Daten ab Header-Ende lesen (sonst raw PCM)
  let raw = file;
  if (file.slice(0, 4).toString() === 'RIFF') {
    let off = 12;
    while (off + 8 <= file.length) {
      const id = file.slice(off, off + 4).toString();
      const size = file.readUInt32LE(off + 4);
      if (id === 'data') { raw = file.subarray(off + 8, off + 8 + size); break; }
      off += 8 + size + (size % 2);
    }
    console.log('MOH-WAV-PCM', raw.length);
  }
  let state = { stopped: false, done: null };
  const source = new AudioSource(OUT_RATE, 1);
  const samplesPerFrame = Math.round(OUT_RATE * (FRAME_MS / 1000));

  state.done = (async () => {
    const track = LocalAudioTrack.createAudioTrack('moh', source);
    const pub = await room.localParticipant.publishTrack(track, {});
    state.pub = pub;
    const bytesPerFrame = samplesPerFrame * 2;
    let off = 0;
    while (!state.stopped) {
      if (off + 2 > raw.length) off = 0; // loop
      const slice = raw.subarray(off, Math.min(off + bytesPerFrame, raw.length));
      off += bytesPerFrame;
      const n = Math.floor(slice.length / 2);
      if (n < 1) continue;
      const data = new Int16Array(n);
      for (let k = 0; k < n; k++) data[k] = slice.readInt16LE(k * 2);
      try {
        await source.captureFrame(new AudioFrame(data, OUT_RATE, 1, n));
      } catch {
        break;
      }
    }
    try {
      await room.localParticipant.unpublishTrack(pub.trackSid, true);
    } catch {}
  })().catch(() => {});

  state.stop = async () => {
    state.stopped = true;
    try {
      await source.close();
    } catch {}
    try {
      await state.done;
    } catch {}
  };
  return state;
}

// Gespraechszusammenfassung (reines LLM)
export async function summarizeTranscript(transcript, { apiKey, baseUrl, model }) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'Du fasst Telefongespraeche fuer einen Mitarbeiter zusammen. ' +
            'Antworte auf Deutsch in zwei bis drei kurzen Saetzen. ' +
            'Nur Fakten: worum es geht und was der Anrufer moechte. ' +
            'Keine Begruessung, keine Floskeln, keine Anrede.',
        },
        { role: 'user', content: `Transkript:\n${transcript}` },
      ],
      temperature: 0.2,
      max_tokens: 220,
    }),
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`llm: HTTP ${res.status}`);
  const d = await res.json();
  return (d.choices?.[0]?.message?.content || '').trim();
}

// Zusammenfassung als Audio (Phonic TTS, PCM 24 kHz)
export async function phonicTtsPcm(text, { apiKey, voice = 'sabrina', language = 'de' }) {
  const res = await fetch('https://api.phonic.ai/v1/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      text,
      voice_id: voice,
      languages: [language],
      output_format: 'pcm_24000',
      speed: 1.0,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`tts: HTTP ${res.status}`);
  // Phonic liefert JSON: {"audio": "<base64-PCM>"} - NICHT rohes PCM!
  const body = await res.text();
  let b64 = '';
  try {
    const d = JSON.parse(body);
    b64 = d.audio || d.audio_base64 || d.data || '';
  } catch {
    return Buffer.from(body, 'binary');
  }
  if (!b64) throw new Error('tts: no audio field');
  return Buffer.from(b64, 'base64');
}
