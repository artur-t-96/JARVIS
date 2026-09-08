/** Encode browser audio as PCM16, mono, 16kHz for the local transcription adapter. */
export function pcmWav(
  channels: Float32Array[],
  sourceRate: number,
): ArrayBuffer {
  const length = channels[0]?.length ?? 0;
  if (!length || !channels.length || sourceRate <= 0)
    throw new Error("Nagranie jest puste.");
  const samples = Math.round((length / sourceRate) * 16000);
  if (samples > 480000)
    throw new Error("Nagranie może trwać najwyżej 30 sekund.");
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    const position = (i * sourceRate) / 16000;
    const lower = Math.floor(position);
    const fraction = position - lower;
    let sum = 0;
    for (const channel of channels)
      sum +=
        (channel[lower] ?? 0) * (1 - fraction) +
        (channel[Math.min(lower + 1, length - 1)] ?? 0) * fraction;
    const value = Math.max(-1, Math.min(1, sum / channels.length));
    view.setInt16(
      44 + i * 2,
      Math.round(value * (value < 0 ? 32768 : 32767)),
      true,
    );
  }
  return buffer;
}
export async function browserAudioToWav(blob: Blob): Promise<Blob> {
  const audioContext = new AudioContext();
  try {
    const decoded = await audioContext.decodeAudioData(
      await blob.arrayBuffer(),
    );
    const channels = Array.from(
      { length: decoded.numberOfChannels },
      (_, index) => decoded.getChannelData(index),
    );
    return new Blob([pcmWav(channels, decoded.sampleRate)], {
      type: "audio/wav",
    });
  } finally {
    await audioContext.close();
  }
}
