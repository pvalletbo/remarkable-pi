import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function samplePdf(label = "Plan: share notes locally", count = 1, stamp = "20260101000000") {
  const objects: string[] = [];
  const add = (text: string) => { objects.push(text); return objects.length; };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const info = add(`<< /CreationDate (D:${stamp}) /ModDate (D:${stamp}) >>`);
  const kids: number[] = [];
  const escape = (s: string) => s.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  for (let page = 1; page <= count; page++) {
    const stream = `BT /F1 22 Tf 45 750 Td (${escape(label)}) Tj 0 -35 Td /F1 14 Tf (Notebook page ${page}) Tj ET\n0.12 0.3 0.5 RG 2 w 50 650 24 24 re S 54 660 m 61 652 l 72 671 l S\nBT /F1 16 Tf 90 652 Td (USB tablet -> PDF -> pi session) Tj ET\n50 540 m 160 510 l 220 560 l 330 520 l S\n330 520 m 315 520 l 325 535 l S\n50 450 m 70 475 90 425 110 450 c 130 475 150 425 170 450 c 190 475 210 425 230 450 c S\n`;
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
    const id = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
    kids.push(id);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map(n => `${n} 0 R`).join(" ")}] /Count ${count} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

export async function isolatedHome() {
  const home = await mkdtemp(join(tmpdir(), "rmpi-test-"));
  const previous = process.env.REMARKABLE_PI_HOME;
  process.env.REMARKABLE_PI_HOME = home;
  return { home, async close() { if (previous === undefined) delete process.env.REMARKABLE_PI_HOME; else process.env.REMARKABLE_PI_HOME = previous; await rm(home, { recursive: true, force: true }); } };
}

export async function mockTablet() {
  const requests: string[] = [];
  let version = 1;
  let pdf: Buffer = samplePdf();
  let metadata = true;
  let status = 200;
  let missing = false;
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (status !== 200) { res.writeHead(status); res.end("Unavailable"); return; }
    const revision = metadata ? { Version: version, LastModified: String(version) } : {};
    if (req.method === "POST" && req.url === "/documents/") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ ID: "folder-1", VissibleName: "Agent notes", Type: "CollectionType" }]));
    } else if (req.method === "POST" && req.url === "/documents/folder-1") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(missing ? [] : [{ ID: "notebook-1", VissibleName: "Demo notebook", Type: "DocumentType", ...revision }]));
    } else if (req.method === "GET" && req.url === "/download/notebook-1/placeholder") {
      res.setHeader("content-type", "application/pdf"); res.end(pdf);
    } else { res.writeHead(405); res.end("Read-only mock: route not allowed"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests,
    update(label: string) { version++; pdf = samplePdf(label); },
    setPdf(bytes: Buffer) { pdf = bytes; },
    metadata(value: boolean) { metadata = value; },
    status(value: number) { status = value; },
    missing(value: boolean) { missing = value; },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
