import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// Minimal pure Node PNG generator
function createPNG(size, bgR, bgG, bgB, bgA) {
  const width = size;
  const height = size;
  
  // Create raw RGBA buffer
  const raw = Buffer.alloc((width * 4 + 1) * height);
  
  const cx = width / 2;
  const cy = height / 2;
  const scale = size / 200;

  // Pre-calculate 5 star arms
  const angles = [0, 72, 144, 216, 288].map(a => (a - 90) * Math.PI / 180);
  
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (width * 4 + 1);
    raw[rowOffset] = 0; // Filter type: None
    
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      const dx = (x - cx) / scale;
      const dy = (y - cy) / scale;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);
      
      // Determine if point is inside any of the 5 star arms
      let inside = false;
      
      for (const a of angles) {
        // Rotate point back by -a
        const cos = Math.cos(-a - Math.PI / 2);
        const sin = Math.sin(-a - Math.PI / 2);
        const rx = dx * cos - dy * sin;
        const ry = dx * sin + dy * cos;
        
        // Arm bounds:
        // ry from -95 to -26
        // rx width linearly interpolates from 12 (at -95) to 8 (at -26)
        if (ry >= -95 && ry <= -26) {
          const t = (ry - (-95)) / (-26 - (-95)); // 0 at outer, 1 at inner
          const halfWidth = 17 - t * 6; // ~17 outer to ~11 inner
          if (Math.abs(rx) <= halfWidth) {
            inside = true;
            break;
          }
        }
      }
      
      if (inside) {
        // Vibrant orange #FF662A
        raw[pxOffset] = 0xFF;     // R
        raw[pxOffset + 1] = 0x66; // G
        raw[pxOffset + 2] = 0x2A; // B
        raw[pxOffset + 3] = 0xFF; // A
      } else {
        // Background
        raw[pxOffset] = bgR;
        raw[pxOffset + 1] = bgG;
        raw[pxOffset + 2] = bgB;
        raw[pxOffset + 3] = bgA;
      }
    }
  }

  // Deflate image data
  const compressed = zlib.deflateSync(raw);

  // PNG structure
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // RGBA
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  const ihdrChunk = createChunk('IHDR', ihdr);
  const idatChunk = createChunk('IDAT', compressed);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const len = data.length;
  const chunk = Buffer.alloc(12 + len);
  chunk.writeUInt32BE(len, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  
  // Calculate CRC
  const crcData = chunk.subarray(4, 8 + len);
  const crc = crc32(crcData);
  chunk.writeInt32BE(crc, 8 + len);
  return chunk;
}

// Standard CRC32 table
const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ -1);
}

// Generate icons
const pub = path.resolve('public');
fs.writeFileSync(path.join(pub, 'icon-192.png'), createPNG(192, 0x12, 0x24, 0x3a, 0xFF)); // Deep navy background for maskable
fs.writeFileSync(path.join(pub, 'icon-512.png'), createPNG(512, 0x12, 0x24, 0x3a, 0xFF));
fs.writeFileSync(path.join(pub, 'apple-touch-icon.png'), createPNG(180, 0x12, 0x24, 0x3a, 0xFF));
fs.writeFileSync(path.join(pub, 'favicon.png'), createPNG(64, 0x00, 0x00, 0x00, 0x00));

console.log('Generated PNG icons successfully.');
