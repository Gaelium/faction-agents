/**
 * Applies per-profile speech quirks on top of a template-chosen line.
 *
 * Reads from profile.voice:
 *   typo_rate         — per-char prob. of a character drop / adjacent swap
 *   caps_when_tilted  — prob. of SHOUTING when dominant mood is "tilted"
 *   signature_rate    — prob. of prepending/appending a catchphrase
 *   catchphrases      — array of signature phrases
 *   punctuation       — "minimal" | "casual" | "formal"
 *                       minimal strips trailing ./!?, casual may add "...",
 *                       formal keeps everything as-written.
 *
 * All knobs optional — sensible defaults below.
 */

const ADJACENT = {
  a:'sq', s:'adw', d:'sfe', f:'dgr', g:'fht', h:'gjy', j:'hku', k:'jli', l:'k',
  q:'wa',  w:'qes', e:'wrd', r:'etf', t:'ryg', y:'tuh', u:'yij', i:'uok', o:'ipl',
  p:'ol',  z:'xs',  x:'zcd', c:'xvf', v:'cbg', b:'vnh', n:'bmj', m:'nk',
};

export class VoiceFilter {
  constructor(profile) {
    const v = profile?.voice ?? {};
    this.typo_rate        = clampProb(v.typo_rate        ?? 0.03);
    this.caps_when_tilted = clampProb(v.caps_when_tilted ?? 0.25);
    this.signature_rate   = clampProb(v.signature_rate   ?? 0.15);
    this.catchphrases     = Array.isArray(v.catchphrases) ? v.catchphrases : [];
    this.punctuation      = v.punctuation ?? 'casual';
  }

  apply(text, { mood, typoScale = 1 } = {}) {
    if (!text) return text;
    let out = String(text);

    // Signature attach (before typos so the phrase itself can get typo'd too).
    if (this.catchphrases.length && Math.random() < this.signature_rate) {
      const phrase = pick(this.catchphrases);
      out = Math.random() < 0.5 ? `${out} ${phrase}` : `${phrase} ${out}`;
    }

    // Tilted shouting.
    if (mood === 'tilted' && Math.random() < this.caps_when_tilted) {
      out = out.toUpperCase();
    }

    out = this._typo(out, typoScale);
    out = this._punctuate(out);

    // Minecraft chat cap at 100 chars.
    if (out.length > 100) out = out.slice(0, 100);
    return out;
  }

  _typo(s, scale = 1) {
    const rate = this.typo_rate * (Number.isFinite(scale) ? Math.max(0, scale) : 1);
    if (rate <= 0) return s;
    let chars = [...s];
    const out = [];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      // Spaces are word boundaries — dropping or swapping them
      // produces "tofind" / "Headin gout" which read as bugs, not
      // human typos. Skip the mutation roll for whitespace.
      if (c === ' ') { out.push(c); continue; }
      if (Math.random() < rate) {
        const roll = Math.random();
        if (roll < 0.5) {
          // drop
          continue;
        } else if (roll < 0.85) {
          // swap with neighbour — but not across a word boundary.
          // Without this, "Connor is" can become "Conno ris" when 'r'
          // swaps with its trailing space, which reads as broken
          // formatting rather than a human typo.
          const next = chars[i + 1];
          if (next && next !== ' ') { out.push(next); out.push(c); i++; continue; }
        } else {
          // replace with adjacent QWERTY key
          const lc = c.toLowerCase();
          const neigh = ADJACENT[lc];
          if (neigh) { out.push(neigh[Math.floor(Math.random() * neigh.length)]); continue; }
        }
      }
      out.push(c);
    }
    return out.join('');
  }

  _punctuate(s) {
    switch (this.punctuation) {
      case 'formal':  return s;
      case 'minimal': return s.replace(/[.!?]+$/, '');
      case 'casual':
      default: {
        // Occasionally append trailing "..." to signal hesitation.
        if (Math.random() < 0.08) return s.replace(/[.!?]+$/, '') + '...';
        // Strip a trailing period sometimes; keep '!' or '?'.
        if (s.endsWith('.') && Math.random() < 0.5) return s.slice(0, -1);
        return s;
      }
    }
  }
}

function clampProb(p) { return Math.max(0, Math.min(1, Number(p) || 0)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
