/* ═══════════════════════════════════════════
   PipelineOS — Parser
   ═══════════════════════════════════════════ */

const PRESETS = {
  raw: `ADD R1, R2, R3
SUB R4, R1, R5
AND R6, R1, R7
OR  R8, R4, R7`,

  'load-use': `LW  R1, 0(R2)
ADD R3, R1, R4
SUB R5, R3, R6
AND R7, R5, R1`,

  branch: `BEQ R1, R2, done
ADD R3, R4, R5
SUB R6, R7, R8
LW  R9, 0(R1)`,

  forwarding: `ADD R1, R2, R3
SUB R4, R1, R5
AND R6, R4, R7
OR  R8, R1, R6
XOR R9, R8, R4`,

  struct: `MUL R1, R2, R3
MUL R4, R5, R6
ADD R7, R1, R4
LW  R8, 0(R1)
LW  R9, 4(R1)`,

  cache: `LW  R1, 0(R2)
LW  R3, 64(R2)
ADD R4, R1, R3
SW  R4, 128(R2)
LW  R5, 192(R2)`,

  combined: `LW  R1, 0(R2)
ADD R3, R1, R4
BEQ R3, R5, done
MUL R6, R3, R7
AND R8, R6, R1
SW  R8, 0(R2)
OR  R9, R8, R3`
};

/**
 * Parse a single instruction line into a structured object.
 * Returns null for empty/comment lines.
 */
function parseInst(line) {
  line = line.trim();
  if (!line || line.startsWith('//') || line.startsWith('#') || line.startsWith(';')) return null;
  // Remove inline comments
  line = line.split('//')[0].split('#')[0].trim();
  if (!line) return null;

  const isBranch = /^(BEQ|BNE|BLT|BGT|BLE|BGE|J\b|JR|JAL)\b/i.test(line);
  const isLoad   = /^(LW|LB|LH|LD)\b/i.test(line);
  const isStore  = /^(SW|SB|SH|SD)\b/i.test(line);
  const isMul    = /^(MUL|MULT|DIV)\b/i.test(line);

  const mnemMatch = line.match(/^([A-Z]+)/i);
  if (!mnemMatch) return null;
  const mnem = mnemMatch[1].toUpperCase();

  // Collect all register tokens (R0..R31 or $0..$31)
  const regs = [];
  const regPattern = /\b(?:[Rr]|(?<!\w)\$)(\d+)\b/g;
  let m;
  while ((m = regPattern.exec(line)) !== null) {
    regs.push(`R${m[1]}`);
  }

  // Collect memory offset (e.g., "64(R2)" → addrOffset=64)
  const offMatch = line.match(/(-?\d+)\s*\(/);
  const addrOffset = offMatch ? parseInt(offMatch[1], 10) : 0;

  let dest = null, src1 = null, src2 = null;

  if (isStore) {
    // SW Rsrc, offset(Rbase) → src1=Rsrc, src2=Rbase (no dest)
    dest = null;
    src1 = regs[0] || null;
    src2 = regs[1] || null;
  } else if (isBranch) {
    // BEQ Rs1, Rs2, label
    dest = null;
    src1 = regs[0] || null;
    src2 = regs[1] || null;
  } else if (isLoad) {
    // LW Rdest, offset(Rbase) → dest=Rdest, src1=Rbase
    dest = regs[0] || null;
    src1 = regs[1] || null;
    src2 = null;
  } else {
    // R-type: OP Rdest, Rs1, Rs2
    dest = regs[0] || null;
    src1 = regs[1] || null;
    src2 = regs[2] || null;
  }

  return {
    text: line,
    mnem,
    isBranch,
    isLoad,
    isStore,
    isMul,
    dest,
    src1,
    src2,
    addrOffset
  };
}

/**
 * Parse multiple lines; returns array of valid instructions.
 */
function parseProgram(text) {
  return text.split('\n').map(parseInst).filter(Boolean);
}
