#!/usr/bin/env python3
"""Synthesize the hard-set voice notes with macOS `say` (synthetic test input), louder noise than the base set.

Every note is noisy. The noise is mixed at an exact signal-to-noise ratio measured on the voice (RMS over the voiced
samples), rotating 12, 8 and 5 dB, with three noise profiles:
  shop        pink noise + 60 Hz hum
  compressor  brown noise (low rumble) + a little pink noise
  phone       a phone mic in the shop: voice and noise both band-limited to 300-3400 Hz; pink noise + a 2.4 kHz air-tool whine
16 English voices and speaking rates of 200 to 240 words a minute rotate; 0.4 s of noise before and after the voice.
Writes audio/<id>.wav (16 kHz mono, 16-bit) and audio/manifest.json. Runs one process at a time.
Usage: python3 eval/hard/make_audio.py   (needs macOS `say`, ffmpeg and numpy)"""
import json
import os
import subprocess
import tempfile
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "audio")
RATE = 16000
PAD_S = 0.4
# 16 voices: with 3 noise profiles every voice meets different noise across its notes (16 mod 3 = 1).
VOICES = ["Eddy (English (US))", "Flo (English (US))", "Reed (English (UK))", "Rocko (English (US))", "Grandpa (English (US))",
          "Fred", "Kathy", "Ralph", "Albert", "Karen", "Moira", "Tessa", "Rishi", "Aman (English (India))", "Daniel (English (UK))",
          "Samantha"]
RATES_WPM = [200, 215, 230, 240, 210]
SNRS_DB = [12, 8, 5]
PROFILES = ["shop", "compressor", "phone"]
NOISE = {
    "shop": ["-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.5:sample_rate=16000",
             "-f", "lavfi", "-i", "sine=frequency=60:sample_rate=16000",
             "-filter_complex", "[0:a]volume=1.0[n];[1:a]volume=0.3[h];[n][h]amix=inputs=2:duration=first:normalize=0"],
    "compressor": ["-f", "lavfi", "-i", "anoisesrc=color=brown:amplitude=0.5:sample_rate=16000",
                   "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.5:sample_rate=16000",
                   "-filter_complex", "[0:a]volume=1.0[b];[1:a]volume=0.25[p];[b][p]amix=inputs=2:duration=first:normalize=0"],
    "phone": ["-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.5:sample_rate=16000",
              "-f", "lavfi", "-i", "sine=frequency=2400:sample_rate=16000",
              "-filter_complex", "[0:a]volume=1.0[w];[1:a]volume=0.15[s];[w][s]amix=inputs=2:duration=first:normalize=0,highpass=f=300,lowpass=f=3400"],
}


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def read_wav(path):
    with wave.open(path, "rb") as w:
        assert w.getframerate() == RATE and w.getnchannels() == 1 and w.getsampwidth() == 2, path
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768.0


def write_wav(path, x):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((np.clip(x, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes())


def rms(x):
    return float(np.sqrt(np.mean(np.square(x)))) if x.size else 0.0


def main():
    os.makedirs(OUT, exist_ok=True)
    data = json.load(open(os.path.join(HERE, "findings.json")))
    manifest = []
    for i, f in enumerate(data["findings"]):
        voice, wpm = VOICES[i % len(VOICES)], RATES_WPM[i % len(RATES_WPM)]
        profile, snr = PROFILES[i % len(PROFILES)], SNRS_DB[(i // len(PROFILES)) % len(SNRS_DB)]
        with tempfile.TemporaryDirectory() as tmp:
            aiff, vwav, nwav = (os.path.join(tmp, n) for n in ("v.aiff", "v.wav", "n.wav"))
            run(["say", "-v", voice, "-r", str(wpm), "-o", aiff, f["note"]])
            band = ["-af", "highpass=f=300,lowpass=f=3400"] if profile == "phone" else []
            run(["ffmpeg", "-y", "-i", aiff, *band, "-ac", "1", "-ar", str(RATE), "-sample_fmt", "s16", vwav])
            voice_x = read_wav(vwav)
            pad = np.zeros(int(PAD_S * RATE))
            speech = np.concatenate([pad, voice_x, pad])
            run(["ffmpeg", "-y", *NOISE[profile], "-t", f"{speech.size / RATE:.3f}", "-ac", "1", "-ar", str(RATE), "-sample_fmt", "s16", nwav])
            noise = read_wav(nwav)
            noise = np.resize(noise, speech.size)
        voiced = voice_x[np.abs(voice_x) > 0.02 * np.max(np.abs(voice_x))]
        gain = rms(voiced) / (rms(noise) * 10 ** (snr / 20))
        mix = speech + gain * noise
        peak = float(np.max(np.abs(mix)))
        if peak > 0.89:  # -1 dBFS
            mix *= 0.89 / peak
        measured = 20 * np.log10(rms(voiced) / rms(gain * noise))
        write_wav(os.path.join(OUT, f"{f['id']}.wav"), mix)
        manifest.append({"id": f["id"], "file": f"audio/{f['id']}.wav", "voice": voice, "rate_wpm": wpm, "noise": profile,
                         "snr_db": snr, "snr_db_measured": round(measured, 2), "seconds": round(mix.size / RATE, 2)})
        print(f["id"], voice, wpm, profile, snr, round(measured, 2))
    json.dump({"synthetic": True, "tool": "macOS say + ffmpeg + numpy", "snr": "RMS of the voiced samples over RMS of the noise",
               "items": manifest}, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
