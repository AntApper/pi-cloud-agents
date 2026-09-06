/**
 * Deterministic in-memory ZIP archive generator.
 * Zero external dependencies, pure Node.js (zlib + Buffer).
 * Ensures reproducible builds and deterministic content hashes.
 */

import { deflateRawSync } from "node:zlib";

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c;
}

export function computeCrc32(buf: Uint8Array): number {
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] ?? 0;
    const tableVal = CRC_TABLE[(crc ^ byte) & 0xff] ?? 0;
    crc = (crc >>> 8) ^ tableVal;
  }
  return (crc ^ -1) >>> 0;
}

function dateToDosTimeAndDate(d: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hour = d.getUTCHours();
  const min = d.getUTCMinutes();
  const sec = Math.floor(d.getUTCSeconds() / 2);

  const dosTime = (hour << 11) | (min << 5) | sec;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

export interface ZipEntry {
  name: string;
  content: string | Uint8Array;
  mode?: number;
  mtime?: Date;
}

/**
 * Creates a deterministic ZIP archive from entries.
 * Default mtime is 2026-01-01 00:00:00 UTC for determinism.
 */
export function createDeterministicZip(
  entries: ZipEntry[],
  options?: { defaultMtime?: Date },
): Buffer {
  const defaultMtime = options?.defaultMtime ?? new Date("2026-01-01T00:00:00Z");
  const { dosTime, dosDate } = dateToDosTimeAndDate(defaultMtime);

  // Sort entries by name for determinism
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

  const localHeaders: Buffer[] = [];
  const centralDirectoryHeaders: Buffer[] = [];
  let offset = 0;

  for (const entry of sorted) {
    const rawData =
      typeof entry.content === "string"
        ? Buffer.from(entry.content, "utf-8")
        : Buffer.from(entry.content);

    const compressed = deflateRawSync(rawData);
    // Use compressed if smaller, else store
    const useCompression = compressed.length < rawData.length;
    const fileData = useCompression ? compressed : rawData;
    const compressionMethod = useCompression ? 8 : 0;
    const crc = computeCrc32(rawData);

    const nameBuf = Buffer.from(entry.name, "utf-8");
    const nameLen = nameBuf.length;

    const entryDos = entry.mtime ? dateToDosTimeAndDate(entry.mtime) : { dosTime, dosDate };

    // Local file header (30 bytes + nameLen + dataLen)
    const localHeader = Buffer.alloc(30 + nameLen);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed (2.0)
    localHeader.writeUInt16LE(0, 6); // general purpose bit flag
    localHeader.writeUInt16LE(compressionMethod, 8); // compression method
    localHeader.writeUInt16LE(entryDos.dosTime, 10);
    localHeader.writeUInt16LE(entryDos.dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(fileData.length, 18); // compressed size
    localHeader.writeUInt32LE(rawData.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameLen, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    nameBuf.copy(localHeader, 30);

    localHeaders.push(localHeader, fileData);

    const localOffset = offset;
    offset += localHeader.length + fileData.length;

    // Central directory header (46 bytes + nameLen)
    const unixMode = entry.mode ?? (entry.name.endsWith("/") ? 0o755 : 0o644);
    const externalAttr = ((unixMode << 16) | (entry.name.endsWith("/") ? 0x10 : 0)) >>> 0;

    const cdHeader = Buffer.alloc(46 + nameLen);
    cdHeader.writeUInt32LE(0x02014b50, 0); // signature
    cdHeader.writeUInt16LE(0x0314, 4); // version made by (UNIX 2.0)
    cdHeader.writeUInt16LE(20, 6); // version needed (2.0)
    cdHeader.writeUInt16LE(0, 8); // bit flag
    cdHeader.writeUInt16LE(compressionMethod, 10);
    cdHeader.writeUInt16LE(entryDos.dosTime, 12);
    cdHeader.writeUInt16LE(entryDos.dosDate, 14);
    cdHeader.writeUInt32LE(crc, 16);
    cdHeader.writeUInt32LE(fileData.length, 20);
    cdHeader.writeUInt32LE(rawData.length, 24);
    cdHeader.writeUInt16LE(nameLen, 28);
    cdHeader.writeUInt16LE(0, 30); // extra field len
    cdHeader.writeUInt16LE(0, 32); // comment len
    cdHeader.writeUInt16LE(0, 34); // disk num
    cdHeader.writeUInt16LE(0, 36); // internal attr
    cdHeader.writeUInt32LE(externalAttr, 38);
    cdHeader.writeUInt32LE(localOffset, 42);
    nameBuf.copy(cdHeader, 46);

    centralDirectoryHeaders.push(cdHeader);
  }

  const cdOffset = offset;
  const cdBuf = Buffer.concat(centralDirectoryHeaders);
  const cdSize = cdBuf.length;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(sorted.length, 8); // entries on this disk
  eocd.writeUInt16LE(sorted.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12); // size of CD
  eocd.writeUInt32LE(cdOffset, 16); // offset of CD
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...localHeaders, cdBuf, eocd]);
}
