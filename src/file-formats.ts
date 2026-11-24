const documentLimit = 256;
const textLimit = 10;
const xmlLimit = 30;

const formats = new Map<string, { mimeType: string; limitMb: number }>([
  ["md", { mimeType: "text/markdown", limitMb: textLimit }],
  ["pdf", { mimeType: "application/pdf", limitMb: documentLimit }],
  ["doc", { mimeType: "application/msword", limitMb: documentLimit }],
  ["docx", { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", limitMb: documentLimit }],
  ["dotx", { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.template", limitMb: documentLimit }],
  ["ppt", { mimeType: "application/vnd.ms-powerpoint", limitMb: documentLimit }],
  ["pptx", { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", limitMb: documentLimit }],
  ["potx", { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.template", limitMb: documentLimit }],
  ["txt", { mimeType: "text/plain", limitMb: textLimit }],
  ["html", { mimeType: "text/html", limitMb: documentLimit }],
  ["json", { mimeType: "application/json", limitMb: textLimit }],
  ["vtt", { mimeType: "text/vtt", limitMb: textLimit }],
  ["xml", { mimeType: "application/xml", limitMb: xmlLimit }],
  ["xlf", { mimeType: "application/xliff+xml", limitMb: xmlLimit }],
  ["xdp", { mimeType: "application/vnd.adobe.xdp+xml", limitMb: xmlLimit }],
  ["aspx", { mimeType: "text/html", limitMb: documentLimit }],
  ["msg", { mimeType: "application/vnd.ms-outlook", limitMb: documentLimit }],
  ["fna", { mimeType: "text/plain", limitMb: documentLimit }],
  ["gbk", { mimeType: "text/plain", limitMb: documentLimit }],
  ["dxf", { mimeType: "image/vnd.dxf", limitMb: documentLimit }],
]);

export const supportedAttachmentExtensions = [...formats.keys()].filter((extension) => extension !== "md");

export function fileExtension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function uploadFormat(name: string) {
  return formats.get(fileExtension(name));
}
