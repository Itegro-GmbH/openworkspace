const encoder = new TextEncoder();

type Address = string | { name?: string; email: string };
type AttachmentInput = {
  disposition: "inline" | "attachment";
  contentId?: string;
  filename: string;
  type: string;
  content: string | ArrayBuffer | ArrayBufferView;
};

export type OutgoingEmlInput = {
  messageId: string | null;
  sentAt: Date;
  from: Address;
  to?: Address | Address[];
  cc?: Address | Address[];
  bcc?: Address | Address[];
  replyTo?: Address;
  subject: string;
  text?: string;
  html?: string;
  attachments?: AttachmentInput[];
  headers?: Record<string, string>;
};

function list(value: Address | Address[] | undefined) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function needsEncoding(value: string) {
  // eslint-disable-next-line no-control-regex
  return /[^\x20-\x7e]/u.test(value);
}

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function wrap76(value: string) {
  return value.match(/.{1,76}/gu)?.join("\r\n") ?? "";
}

/** RFC 2047 encoded-word for header values, split to stay within line limits. */
function encodeWord(value: string) {
  if (!needsEncoding(value)) return value;
  const chars = [...value];
  const words: string[] = [];
  let current = "";
  for (const char of chars) {
    if (encoder.encode(current + char).length > 36) {
      words.push(current);
      current = "";
    }
    current += char;
  }
  if (current) words.push(current);
  return words
    .map((word) => `=?UTF-8?B?${base64(encoder.encode(word))}?=`)
    .join("\r\n ");
}

function formatAddress(value: Address) {
  if (typeof value === "string") return value;
  if (!value.name) return value.email;
  const name = needsEncoding(value.name)
    ? encodeWord(value.name)
    : `"${value.name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return `${name} <${value.email}>`;
}

function bytesOf(content: AttachmentInput["content"]) {
  if (typeof content === "string") return encoder.encode(content);
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
}

function textPart(contentType: string, body: string) {
  return [
    `Content-Type: ${contentType}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(base64(encoder.encode(body))),
  ].join("\r\n");
}

function boundary(label: string) {
  return `----=_${label}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Builds an RFC 5322 reproduction of a message submitted through the
 * structured send API. Transport headers added by the relay are not part of
 * it; the content, recipients, Message-ID and threading headers are.
 */
export function buildOutgoingEml(input: OutgoingEmlInput) {
  const headers: string[] = [
    `Date: ${input.sentAt.toUTCString().replace("GMT", "+0000")}`,
    `From: ${formatAddress(input.from)}`,
  ];
  const to = list(input.to).map(formatAddress);
  const cc = list(input.cc).map(formatAddress);
  const bcc = list(input.bcc).map(formatAddress);
  if (to.length) headers.push(`To: ${to.join(", ")}`);
  if (cc.length) headers.push(`Cc: ${cc.join(", ")}`);
  if (bcc.length) headers.push(`Bcc: ${bcc.join(", ")}`);
  if (input.replyTo) headers.push(`Reply-To: ${formatAddress(input.replyTo)}`);
  headers.push(`Subject: ${encodeWord(input.subject.replace(/[\r\n]+/gu, " "))}`);
  if (input.messageId) {
    const id = input.messageId.startsWith("<") ? input.messageId : `<${input.messageId}>`;
    headers.push(`Message-ID: ${id}`);
  }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers.push(`${name}: ${value.replace(/[\r\n]+/gu, " ")}`);
  }
  headers.push("MIME-Version: 1.0");
  headers.push(
    "X-Archive-Note: Reproduction of the message as submitted; transport headers added by the relay are not included",
  );

  const attachments = input.attachments ?? [];
  const body: string[] = [];
  let bodyHeaders: string;

  const alternative = () => {
    if (input.text !== undefined && input.html !== undefined) {
      const b = boundary("alt");
      return {
        header: `Content-Type: multipart/alternative; boundary="${b}"`,
        body: [
          `--${b}`,
          textPart("text/plain", input.text),
          `--${b}`,
          textPart("text/html", input.html),
          `--${b}--`,
        ].join("\r\n"),
      };
    }
    const single = input.html !== undefined
      ? textPart("text/html", input.html)
      : textPart("text/plain", input.text ?? "");
    const lines = single.split("\r\n");
    return { header: lines.slice(0, 2).join("\r\n"), body: lines.slice(3).join("\r\n") };
  };

  const main = alternative();
  if (!attachments.length) {
    bodyHeaders = main.header;
    body.push(main.body);
  } else {
    const b = boundary("mixed");
    bodyHeaders = `Content-Type: multipart/mixed; boundary="${b}"`;
    body.push(
      `--${b}`,
      `${main.header}\r\n\r\n${main.body}`,
    );
    for (const file of attachments) {
      const name = encodeWord(file.filename);
      const lines = [
        `--${b}`,
        `Content-Type: ${file.type}; name="${name}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: ${file.disposition}; filename="${name}"`,
      ];
      if (file.contentId) lines.push(`Content-ID: <${file.contentId}>`);
      lines.push("", wrap76(base64(bytesOf(file.content))));
      body.push(lines.join("\r\n"));
    }
    body.push(`--${b}--`);
  }

  const eml = `${headers.join("\r\n")}\r\n${bodyHeaders}\r\n\r\n${body.join("\r\n")}\r\n`;
  return encoder.encode(eml) as Uint8Array<ArrayBuffer>;
}
