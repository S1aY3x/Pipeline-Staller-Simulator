/* ═══════════════════════════════════════════
   PipelineOS — Pipeline Simulator Core
   Correctly models 5-stage MIPS pipeline:
   IF → ID → EX → MEM → WB

   Hazard detection:
   - RAW data hazards (with/without forwarding)
   - Load-use hazard (always 1 stall with forwarding)
   - Control hazards (branch penalties)
   - Structural hazards (MEM port, multiplier)
   - Cache miss penalties
   ═══════════════════════════════════════════ */

const STAGES = ['IF', 'ID', 'EX', 'MEM', 'WB'];
const MUL_LATENCY = 3; // MUL/DIV take 3 EX cycles

/**
 * Run the full pipeline simulation.
 * Returns a comprehensive result object used by the UI.
 */
function runPipeline(insts, opts, cacheModel) {
  const {
    forwarding  = true,
    branchPred  = false,
    structural  = false,
    cacheEnable = false,
    cachePenalty = 4
  } = opts;

  const N = insts.length;

  // startCycle[i] = cycle when instruction i enters IF stage
  const startCycle = new Array(N).fill(0);
  // stallsBefore[i] = total stall cycles inserted before instruction i starts
  const stallsBefore = new Array(N).fill(0);

  const dataHazards  = [];
  const ctrlHazards  = [];
  const structHazards = [];
  const cacheHazards  = [];
  const fwdPaths      = [];

  // Track which pipeline stages are occupied in each cycle
  // memBusy[cycle] = true if MEM port occupied
  // mulBusy[cycle] = true if multiplier occupied
  const memBusy = {};
  const mulBusy = {};

  // Compute start cycle for each instruction
  for (let i = 0; i < N; i++) {
    // Start after previous instruction's IF, plus any stalls
    let earliest = i === 0 ? 1 : startCycle[i - 1] + 1;
    let extraStalls = 0;

    // ── DATA HAZARDS ──────────────────────────────────
    // Check all prior instructions for RAW dependencies
    for (let j = Math.max(0, i - 4); j < i; j++) {
      const prod = insts[j];
      const cons = insts[i];

      // Producer must write to a register (have dest)
      if (!prod.dest) continue;

      // Consumer must read that register
      const readsReg =
        cons.src1 === prod.dest ||
        cons.src2 === prod.dest;

      if (!readsReg) continue;

      // When does producer's result become available?
      // Without forwarding: after WB (startCycle[j] + 4)
      // With EX→EX fwd:    after EX (startCycle[j] + 2)
      // With MEM→EX fwd:   after MEM (startCycle[j] + 3)
      // Load-use special:  after MEM (startCycle[j] + 3), consumer needs result at EX (startCycle[i] + 2)

      // Consumer reads registers at ID stage: startCycle[i] + 1
      // Consumer needs value at EX stage: startCycle[i] + 2 (with forwarding)
      //                                   startCycle[i] + 1 (without — reads at ID)

      const prodEX  = startCycle[j] + 2; // cycle producer is in EX
      const prodMEM = startCycle[j] + 3; // cycle producer is in MEM
      const prodWB  = startCycle[j] + 4; // cycle producer completes WB

      // Distance in instructions
      const distance = i - j;

      let stalls = 0;
      let forwarded = false;
      let hazType = 'RAW';

      if (prod.isLoad) {
        // LOAD-USE hazard
        hazType = 'Load-Use';
        if (forwarding) {
          // With forwarding: load result available after MEM (prodMEM)
          // Consumer needs it at EX: max(earliest, prodMEM - 1) ... let's calculate
          // Consumer EX happens at: consStart + 2
          // We need: consStart + 2 >= prodMEM
          // i.e., consStart >= prodMEM - 2 = startCycle[j] + 1
          // But consumer also can't start before earliest
          const minStart = startCycle[j] + 2; // load-use always needs 1 stall
          if (earliest < minStart) {
            stalls = minStart - earliest;
          }
          forwarded = stalls === 0 && distance >= 2;
          // Can forward MEM→EX if distance >= 2 with no stall
          if (stalls > 0) forwarded = false;
        } else {
          // Without forwarding: need prodWB before consumer's ID
          // consumer ID: consStart + 1; need prodWB <= consStart + 1
          // i.e., consStart >= prodWB - 1 = startCycle[j] + 3
          const minStart = startCycle[j] + 3;
          if (earliest < minStart) {
            stalls = minStart - earliest;
          }
        }
      } else {
        // Regular ALU instruction
        if (forwarding) {
          // With EX→EX forwarding: result available after EX (prodEX)
          // Consumer needs it at EX: consStart + 2
          // Need: consStart + 2 >= prodEX i.e. consStart >= prodEX - 2 = startCycle[j]
          // With MEM→EX forwarding: result available after MEM (prodMEM)
          // Need: consStart + 2 >= prodMEM i.e. consStart >= prodMEM - 2 = startCycle[j] + 1
          // Best case with forwarding: no stalls for distance >= 1 (EX→EX covers distance=1)
          // No stalls needed for distance >= 1 with full forwarding
          stalls = 0;
          forwarded = distance <= 2; // forwarding paths exist
          if (forwarded) {
            // Record forwarding path
            const fromStage = distance === 1 ? 'EX/MEM' : 'MEM/WB';
            fwdPaths.push({
              from: j,
              to: i,
              reg: prod.dest,
              fromStage,
              toStage: 'EX'
            });
          }
        } else {
          // Without forwarding: need result written at WB, read at ID
          // consumer ID: earliest + 1; need prodWB <= earliest + 1
          // i.e., earliest >= prodWB - 1 = startCycle[j] + 3
          const minStart = startCycle[j] + 3;
          if (earliest < minStart) {
            stalls = minStart - earliest;
          }
        }
      }

      if (stalls > 0 || (forwarded && distance <= 2)) {
        // Only record if not already covered by a closer producer
        const alreadyRecorded = dataHazards.find(
          h => h.consumer === i && h.reg === prod.dest && h.stalls >= stalls
        );
        if (!alreadyRecorded) {
          dataHazards.push({
            producer: j,
            consumer: i,
            reg: prod.dest,
            type: hazType,
            stalls: forwarding ? (prod.isLoad ? stalls : 0) : stalls,
            forwarded: forwarding && !prod.isLoad && distance <= 2
          });
        }
      }

      if (stalls > 0 && stalls > extraStalls) {
        extraStalls = stalls;
      }
    }

    earliest += extraStalls;

    // ── CONTROL HAZARDS ───────────────────────────────
    if (insts[i].isBranch) {
      // Branch resolves at end of EX stage (cycle = startCycle[i] + 2)
      const penalty = branchPred ? 1 : 2;
      ctrlHazards.push({
        inst: i,
        penalty,
        predicted: branchPred
      });
      // Instructions after branch get their start shifted
      // (handled by adjusting startCycle of subsequent instructions)
    }

    // Apply branch penalty from previous branches
    for (const bh of ctrlHazards) {
      if (bh.inst >= i) continue;
      // Branch resolves at: startCycle[bh.inst] + 2 (EX stage)
      // First valid instruction after branch must wait until resolution
      const branchResolve = startCycle[bh.inst] + 2 + 1; // +1: next cycle after resolve
      const instOffset = i - bh.inst; // how many instructions after branch
      if (instOffset <= bh.penalty) {
        // This instruction falls within the penalty window
        const minStart = branchResolve + (instOffset - 1);
        if (earliest < minStart) earliest = minStart;
      }
    }

    // ── STRUCTURAL HAZARDS ────────────────────────────
    if (structural) {
      // MEM port conflict: LW/SW share memory bus with IF stage
      if (insts[i].isLoad || insts[i].isStore) {
        const myMEMcycle = earliest + 3;
        // Check if another instruction is in MEM at same cycle
        for (let j = 0; j < i; j++) {
          const jMEM = startCycle[j] + 3;
          if (jMEM === myMEMcycle && (insts[j].isLoad || insts[j].isStore)) {
            // Conflict: stall until next available slot
            const conflict = {
              inst1: j, inst2: i,
              cycle: myMEMcycle,
              type: 'MEM Port Conflict',
              stalls: 1
            };
            structHazards.push(conflict);
            earliest += 1;
            break;
          }
        }
      }

      // Multiplier conflict: MUL/DIV takes MUL_LATENCY cycles
      if (insts[i].isMul) {
        // Check if multiplier is busy at our EX cycle
        const myEXcycle = earliest + 2;
        let mulConflict = false;
        for (let j = 0; j < i; j++) {
          if (!insts[j].isMul) continue;
          const jEX = startCycle[j] + 2;
          // Multiplier busy from jEX to jEX + MUL_LATENCY - 1
          if (myEXcycle >= jEX && myEXcycle < jEX + MUL_LATENCY) {
            mulConflict = true;
            const waitUntil = jEX + MUL_LATENCY;
            const newStart = waitUntil - 2;
            if (earliest < newStart) {
              const stallsNeeded = newStart - earliest;
              structHazards.push({
                inst1: j, inst2: i,
                cycle: myEXcycle,
                type: 'Multiplier Conflict',
                stalls: stallsNeeded
              });
              earliest = newStart;
            }
            break;
          }
        }
      }
    }

    startCycle[i] = earliest;
    stallsBefore[i] = earliest - (i === 0 ? 1 : startCycle[i - 1] + 1);
    if (stallsBefore[i] < 0) stallsBefore[i] = 0;
  }

  // ── CACHE HAZARDS ─────────────────────────────────
  // Apply cache miss penalties AFTER basic scheduling
  if (cacheEnable && cacheModel) {
    for (let i = 0; i < N; i++) {
      if (!insts[i].isLoad && !insts[i].isStore) continue;
      const addr = Math.abs(insts[i].addrOffset) >> 2; // word address
      const result = cacheModel.access(addr, insts[i].isStore);
      if (!result.hit) {
        cacheHazards.push({
          inst: i,
          address: addr,
          type: result.type || 'Cache Miss',
          penalty: cacheModel.penalty
        });
        // Shift all subsequent instructions
        for (let j = i + 1; j < N; j++) {
          startCycle[j] += cacheModel.penalty;
        }
      }
    }
  }

  // Compute total cycles: last instruction's WB completes at startCycle[N-1] + 4
  const totalCycles = N > 0 ? startCycle[N - 1] + 4 : 4;

  // Count stalls
  let stallCount = 0;
  let ctrlStalls = 0;
  for (const h of dataHazards) stallCount += h.stalls;
  for (const h of ctrlHazards) ctrlStalls += h.penalty;

  return {
    insts,
    startCycle,
    stallsBefore,
    totalCycles,
    dataHazards,
    ctrlHazards,
    structHazards,
    cacheHazards,
    fwdPaths,
    stallCount,
    ctrlStalls,
    forwarding,
    structural,
    cacheEnabled: cacheEnable
  };
}

/* ═══════════════════════════════════════════
   CACHE MODEL
   ═══════════════════════════════════════════ */
class CacheModel {
  constructor(numLines = 16, assoc = 1, penalty = 4, mode = 'auto') {
    this.numSets = Math.max(1, Math.floor(numLines / assoc));
    this.assoc   = assoc;
    this.penalty = penalty;
    this.mode    = mode;
    this.hits    = 0;
    this.misses  = 0;
    this.accessLog = [];

    // Initialize sets
    this.sets = Array.from({ length: this.numSets }, () =>
      Array.from({ length: assoc }, () => ({ valid: false, tag: -1, lruAge: 0 }))
    );
    this._lruClock = 0;
  }

  access(wordAddr, isStore = false) {
    const setIdx = wordAddr % this.numSets;
    const tag    = Math.floor(wordAddr / this.numSets);
    const set    = this.sets[setIdx];

    // Check for hit
    for (const way of set) {
      if (way.valid && way.tag === tag) {
        this.hits++;
        way.lruAge = ++this._lruClock;
        const entry = { set: setIdx, tag, hit: true };
        this.accessLog.push(entry);
        return { hit: true };
      }
    }

    // Miss: determine if we should actually miss based on mode
    if (this.mode !== 'auto') {
      const missRate = parseInt(this.mode, 10) / 100;
      const shouldMiss = Math.random() < missRate;
      if (!shouldMiss) {
        this.hits++;
        this.accessLog.push({ set: setIdx, tag, hit: true });
        return { hit: true };
      }
    }

    // Miss: find LRU victim
    this.misses++;
    let victim = set[0];
    for (const way of set) {
      if (!way.valid) { victim = way; break; }
      if (way.lruAge < victim.lruAge) victim = way;
    }
    victim.valid  = true;
    victim.tag    = tag;
    victim.lruAge = ++this._lruClock;

    this.accessLog.push({ set: setIdx, tag, hit: false });
    return { hit: false, type: 'D-Cache Miss' };
  }

  get hitRate() {
    const total = this.hits + this.misses;
    return total === 0 ? '—' : ((this.hits / total) * 100).toFixed(1) + '%';
  }
}

/* ═══════════════════════════════════════════
   REGISTER COMPUTATION
   ═══════════════════════════════════════════ */
function makeInitialRegs() {
  const regs = {};
  for (let i = 0; i <= 31; i++) regs[`R${i}`] = i; // R0=0, R1=1, ... R31=31
  return regs;
}

function computeResult(inst, regs) {
  const a = regs[inst.src1] ?? 0;
  const b = regs[inst.src2] ?? 0;
  const imm = inst.addrOffset ?? 0;

  switch (inst.mnem) {
    case 'ADD': case 'ADDI': return (a + b) | 0;
    case 'SUB': case 'SUBI': return (a - b) | 0;
    case 'AND': case 'ANDI': return (a & b) | 0;
    case 'OR':  case 'ORI':  return (a | b) | 0;
    case 'XOR': case 'XORI': return (a ^ b) | 0;
    case 'NOR':              return (~(a | b)) | 0;
    case 'SLT':              return a < b ? 1 : 0;
    case 'SLL':              return (a << (b & 31)) | 0;
    case 'SRL':              return (a >>> (b & 31)) | 0;
    case 'SRA':              return (a >> (b & 31)) | 0;
    case 'MUL': case 'MULT': return Math.imul(a, b);
    case 'DIV':              return b !== 0 ? Math.trunc(a / b) : 0;
    case 'LW':               return (a + imm) | 0; // simulated: load = base + offset
    default:                 return 0;
  }
}
