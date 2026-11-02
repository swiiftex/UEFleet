export interface PairCode { a: string[]; p: number; t: string; f: string }

export const encodePairCode = (c: PairCode) => Buffer.from(JSON.stringify(c)).toString('base64url');

export function decodePairCode(s: string): PairCode {
  const bad = new Error("That isn't a pairing code. Copy it again from Machines on the master.");
  let c: any;
  try { c = JSON.parse(Buffer.from(s.trim(), 'base64url').toString('utf8')); } catch { throw bad; }
  if (!Array.isArray(c?.a) || !c.p || !c.t || !c.f) throw bad;
  return c;
}
