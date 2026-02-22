const MAX_WHATSAPP_LENGTH = 4096;

export function splitMessage(text: string): string[] {
  if (text.length <= MAX_WHATSAPP_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_WHATSAPP_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf("\n", MAX_WHATSAPP_LENGTH);
    if (splitIdx === -1 || splitIdx < MAX_WHATSAPP_LENGTH / 2) {
      splitIdx = remaining.lastIndexOf(" ", MAX_WHATSAPP_LENGTH);
    }
    if (splitIdx <= 0 || splitIdx < MAX_WHATSAPP_LENGTH / 2) {
      splitIdx = MAX_WHATSAPP_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks.filter(c => c.length > 0);
}
