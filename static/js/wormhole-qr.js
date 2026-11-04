/* qr.js — minimal QR Code encoder, byte mode, versions 1-40, ECC L/M/Q/H.
   ISO/IEC 18004. No dependencies, no network. Public domain within this artifact.
   Exposes: QR.encode(bytesOrString, {ecl:'L'|'M'|'Q'|'H', minVersion:n}) -> {version, ecl, size, modules}
*/
var QR = (function () {
  'use strict';

  /* ECC blocks: ECCTAB[version][eclIndex] = [[numBlocks, totalCodewords, dataCodewords], ...]  */
  var ECCTAB = {1:[[[1,26,19]],[[1,26,16]],[[1,26,13]],[[1,26,9]]],2:[[[1,44,34]],[[1,44,28]],[[1,44,22]],[[1,44,16]]],3:[[[1,70,55]],[[1,70,44]],[[2,35,17]],[[2,35,13]]],4:[[[1,100,80]],[[2,50,32]],[[2,50,24]],[[4,25,9]]],5:[[[1,134,108]],[[2,67,43]],[[2,33,15],[2,34,16]],[[2,33,11],[2,34,12]]],6:[[[2,86,68]],[[4,43,27]],[[4,43,19]],[[4,43,15]]],7:[[[2,98,78]],[[4,49,31]],[[2,32,14],[4,33,15]],[[4,39,13],[1,40,14]]],8:[[[2,121,97]],[[2,60,38],[2,61,39]],[[4,40,18],[2,41,19]],[[4,40,14],[2,41,15]]],9:[[[2,146,116]],[[3,58,36],[2,59,37]],[[4,36,16],[4,37,17]],[[4,36,12],[4,37,13]]],10:[[[2,86,68],[2,87,69]],[[4,69,43],[1,70,44]],[[6,43,19],[2,44,20]],[[6,43,15],[2,44,16]]],11:[[[4,101,81]],[[1,80,50],[4,81,51]],[[4,50,22],[4,51,23]],[[3,36,12],[8,37,13]]],12:[[[2,116,92],[2,117,93]],[[6,58,36],[2,59,37]],[[4,46,20],[6,47,21]],[[7,42,14],[4,43,15]]],13:[[[4,133,107]],[[8,59,37],[1,60,38]],[[8,44,20],[4,45,21]],[[12,33,11],[4,34,12]]],14:[[[3,145,115],[1,146,116]],[[4,64,40],[5,65,41]],[[11,36,16],[5,37,17]],[[11,36,12],[5,37,13]]],15:[[[5,109,87],[1,110,88]],[[5,65,41],[5,66,42]],[[5,54,24],[7,55,25]],[[11,36,12],[7,37,13]]],16:[[[5,122,98],[1,123,99]],[[7,73,45],[3,74,46]],[[15,43,19],[2,44,20]],[[3,45,15],[13,46,16]]],17:[[[1,135,107],[5,136,108]],[[10,74,46],[1,75,47]],[[1,50,22],[15,51,23]],[[2,42,14],[17,43,15]]],18:[[[5,150,120],[1,151,121]],[[9,69,43],[4,70,44]],[[17,50,22],[1,51,23]],[[2,42,14],[19,43,15]]],19:[[[3,141,113],[4,142,114]],[[3,70,44],[11,71,45]],[[17,47,21],[4,48,22]],[[9,39,13],[16,40,14]]],20:[[[3,135,107],[5,136,108]],[[3,67,41],[13,68,42]],[[15,54,24],[5,55,25]],[[15,43,15],[10,44,16]]],21:[[[4,144,116],[4,145,117]],[[17,68,42]],[[17,50,22],[6,51,23]],[[19,46,16],[6,47,17]]],22:[[[2,139,111],[7,140,112]],[[17,74,46]],[[7,54,24],[16,55,25]],[[34,37,13]]],23:[[[4,151,121],[5,152,122]],[[4,75,47],[14,76,48]],[[11,54,24],[14,55,25]],[[16,45,15],[14,46,16]]],24:[[[6,147,117],[4,148,118]],[[6,73,45],[14,74,46]],[[11,54,24],[16,55,25]],[[30,46,16],[2,47,17]]],25:[[[8,132,106],[4,133,107]],[[8,75,47],[13,76,48]],[[7,54,24],[22,55,25]],[[22,45,15],[13,46,16]]],26:[[[10,142,114],[2,143,115]],[[19,74,46],[4,75,47]],[[28,50,22],[6,51,23]],[[33,46,16],[4,47,17]]],27:[[[8,152,122],[4,153,123]],[[22,73,45],[3,74,46]],[[8,53,23],[26,54,24]],[[12,45,15],[28,46,16]]],28:[[[3,147,117],[10,148,118]],[[3,73,45],[23,74,46]],[[4,54,24],[31,55,25]],[[11,45,15],[31,46,16]]],29:[[[7,146,116],[7,147,117]],[[21,73,45],[7,74,46]],[[1,53,23],[37,54,24]],[[19,45,15],[26,46,16]]],30:[[[5,145,115],[10,146,116]],[[19,75,47],[10,76,48]],[[15,54,24],[25,55,25]],[[23,45,15],[25,46,16]]],31:[[[13,145,115],[3,146,116]],[[2,74,46],[29,75,47]],[[42,54,24],[1,55,25]],[[23,45,15],[28,46,16]]],32:[[[17,145,115]],[[10,74,46],[23,75,47]],[[10,54,24],[35,55,25]],[[19,45,15],[35,46,16]]],33:[[[17,145,115],[1,146,116]],[[14,74,46],[21,75,47]],[[29,54,24],[19,55,25]],[[11,45,15],[46,46,16]]],34:[[[13,145,115],[6,146,116]],[[14,74,46],[23,75,47]],[[44,54,24],[7,55,25]],[[59,46,16],[1,47,17]]],35:[[[12,151,121],[7,152,122]],[[12,75,47],[26,76,48]],[[39,54,24],[14,55,25]],[[22,45,15],[41,46,16]]],36:[[[6,151,121],[14,152,122]],[[6,75,47],[34,76,48]],[[46,54,24],[10,55,25]],[[2,45,15],[64,46,16]]],37:[[[17,152,122],[4,153,123]],[[29,74,46],[14,75,47]],[[49,54,24],[10,55,25]],[[24,45,15],[46,46,16]]],38:[[[4,152,122],[18,153,123]],[[13,74,46],[32,75,47]],[[48,54,24],[14,55,25]],[[42,45,15],[32,46,16]]],39:[[[20,147,117],[4,148,118]],[[40,75,47],[7,76,48]],[[43,54,24],[22,55,25]],[[10,45,15],[67,46,16]]],40:[[[19,148,118],[6,149,119]],[[18,75,47],[31,76,48]],[[34,54,24],[34,55,25]],[[20,45,15],[61,46,16]]]};
  /* Alignment pattern centre coordinates, ALIGN[version] (version >= 2) */
  var ALIGN = {2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34],7:[6,22,38],8:[6,24,42],9:[6,26,46],10:[6,28,50],11:[6,30,54],12:[6,32,58],13:[6,34,62],14:[6,26,46,66],15:[6,26,48,70],16:[6,26,50,74],17:[6,30,54,78],18:[6,30,56,82],19:[6,30,58,86],20:[6,34,62,90],21:[6,28,50,72,94],22:[6,26,50,74,98],23:[6,30,54,78,102],24:[6,28,54,80,106],25:[6,32,58,84,110],26:[6,30,58,86,114],27:[6,34,62,90,118],28:[6,26,50,74,98,122],29:[6,30,54,78,102,126],30:[6,26,52,78,104,130],31:[6,30,56,82,108,134],32:[6,34,60,86,112,138],33:[6,30,58,86,114,142],34:[6,34,62,90,118,146],35:[6,30,54,78,102,126,150],36:[6,24,50,76,102,128,154],37:[6,28,54,80,106,132,158],38:[6,32,58,84,110,136,162],39:[6,26,54,82,110,138,166],40:[6,30,58,86,114,142,170]};
  var ECL = { L: 0, M: 1, Q: 2, H: 3 };
  var ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 }; /* format-information field values */

  /* ---- GF(256), primitive polynomial 0x11D ---- */
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11D;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  function rsGenerator(degree) {
    var poly = [1];
    for (var i = 0; i < degree; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= gmul(poly[j], 1);
        next[j + 1] ^= gmul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly; /* length degree+1, leading coefficient 1 */
  }

  function rsRemainder(data, degree) {
    var gen = rsGenerator(degree);
    var rem = new Uint8Array(degree);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ rem[0];
      rem.copyWithin(0, 1); rem[degree - 1] = 0;
      for (var j = 0; j < degree; j++) rem[j] ^= gmul(gen[j + 1], factor);
    }
    return rem;
  }

  /* ---- raw module capacity, used to derive remainder bits ---- */
  function rawDataModules(v) {
    var result = (16 * v + 128) * v + 64;
    if (v >= 2) {
      var n = ALIGN[v].length;
      result -= (25 * n - 10) * n - 55;
      if (v >= 7) result -= 36;
    }
    return result;
  }

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    var s = String(input), out = [], i, cp;
    for (i = 0; i < s.length; i++) {
      cp = s.codePointAt(i);
      if (cp > 0xFFFF) i++;
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xC0 | (cp >> 6), 0x80 | (cp & 63));
      else if (cp < 0x10000) out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      else out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    return new Uint8Array(out);
  }

  function dataCapacity(v, e) {
    var groups = ECCTAB[v][e], total = 0;
    for (var i = 0; i < groups.length; i++) total += groups[i][0] * groups[i][2];
    return total;
  }

  function buildCodewords(bytes, v, e) {
    var capacity = dataCapacity(v, e);
    var ccBits = v <= 9 ? 8 : 16;
    var bits = [];
    function push(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    push(4, 4);                     /* byte mode */
    push(bytes.length, ccBits);
    for (var i = 0; i < bytes.length; i++) push(bytes[i], 8);
    var room = capacity * 8;
    if (bits.length > room) return null;
    push(0, Math.min(4, room - bits.length));            /* terminator */
    while (bits.length % 8 !== 0) bits.push(0);
    var pad = [0xEC, 0x11], p = 0;
    while (bits.length < room) { push(pad[p], 8); p ^= 1; }
    var cw = new Uint8Array(capacity);
    for (var b = 0; b < capacity; b++) {
      var byteVal = 0;
      for (var k = 0; k < 8; k++) byteVal = (byteVal << 1) | bits[b * 8 + k];
      cw[b] = byteVal;
    }
    return cw;
  }

  function interleave(cw, v, e) {
    var groups = ECCTAB[v][e];
    var dataBlocks = [], eccBlocks = [], off = 0, maxData = 0, eccLen = 0;
    for (var g = 0; g < groups.length; g++) {
      var nb = groups[g][0], total = groups[g][1], nd = groups[g][2];
      eccLen = total - nd;
      for (var b = 0; b < nb; b++) {
        var d = cw.subarray(off, off + nd); off += nd;
        dataBlocks.push(d);
        eccBlocks.push(rsRemainder(d, total - nd));
        if (nd > maxData) maxData = nd;
      }
    }
    var out = [];
    for (var i = 0; i < maxData; i++)
      for (var j = 0; j < dataBlocks.length; j++)
        if (i < dataBlocks[j].length) out.push(dataBlocks[j][i]);
    for (var i2 = 0; i2 < eccLen; i2++)
      for (var j2 = 0; j2 < eccBlocks.length; j2++) out.push(eccBlocks[j2][i2]);
    return new Uint8Array(out);
  }

  /* ---- matrix ---- */
  function newGrid(size, fill) {
    var g = new Array(size);
    for (var i = 0; i < size; i++) { g[i] = new Array(size); g[i].fill(fill); }
    return g;
  }

  /* the 31 format-information module positions, as [x, y]; excludes the dark module */
  function formatPositions(size) {
    var p = [], i;
    for (i = 0; i <= 5; i++) p.push([8, i]);
    p.push([8, 7], [8, 8], [7, 8]);
    for (i = 9; i < 15; i++) p.push([14 - i, 8]);
    for (i = 0; i < 8; i++) p.push([size - 1 - i, 8]);
    for (i = 8; i < 15; i++) p.push([8, size - 15 + i]);
    return p;
  }

  function drawFunctionPatterns(m, fn, v) {
    var size = m.length, i;
    function setF(x, y, dark) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      m[y][x] = dark; fn[y][x] = true;
    }
    /* timing */
    for (i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
    /* finders + separators */
    var corners = [[0, 0], [size - 7, 0], [0, size - 7]];
    for (var c = 0; c < 3; c++) {
      var ox = corners[c][0], oy = corners[c][1];
      for (var dy = -1; dy <= 7; dy++)
        for (var dx = -1; dx <= 7; dx++) {
          var x = ox + dx, y = oy + dy;
          var inner = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          setF(x, y, inner !== 2 && inner <= 3);
        }
    }
    /* alignment */
    if (v >= 2) {
      var pos = ALIGN[v];
      for (var a = 0; a < pos.length; a++)
        for (var b = 0; b < pos.length; b++) {
          if ((a === 0 && b === 0) || (a === 0 && b === pos.length - 1) || (a === pos.length - 1 && b === 0)) continue;
          for (var yy = -2; yy <= 2; yy++)
            for (var xx = -2; xx <= 2; xx++)
              setF(pos[b] + xx, pos[a] + yy, Math.max(Math.abs(xx), Math.abs(yy)) !== 1);
        }
    }
    /* format-information modules reserved (exact positions only, so timing survives) */
    var fp = formatPositions(size);
    for (i = 0; i < fp.length; i++) setF(fp[i][0], fp[i][1], false);
    setF(8, size - 8, true); /* dark module */
    /* version information, v >= 7 */
    if (v >= 7) {
      var rem = v;
      for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var bitsV = (v << 12) | rem;
      for (i = 0; i < 18; i++) {
        var bit = ((bitsV >>> i) & 1) === 1;
        var r = Math.floor(i / 3), cc = i % 3;
        setF(size - 11 + cc, r, bit);
        setF(r, size - 11 + cc, bit);
      }
    }
  }

  function drawFormat(m, eclBits, mask) {
    var size = m.length;
    var data = (eclBits << 3) | mask, rem = data, i;
    for (i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;
    var p = formatPositions(size);
    /* p[0..14] is the first copy in bit order 0..14; p[15..30] is the second copy */
    for (i = 0; i < 15; i++) m[p[i][1]][p[i][0]] = ((bits >>> i) & 1) === 1;
    for (i = 0; i < 8; i++) m[p[15 + i][1]][p[15 + i][0]] = ((bits >>> i) & 1) === 1;
    for (i = 8; i < 15; i++) m[p[15 + i][1]][p[15 + i][0]] = ((bits >>> i) & 1) === 1;
  }

  function placeData(m, fn, cw) {
    var size = m.length, i = 0, upward = true;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var y = upward ? size - 1 - vert : vert;
          if (fn[y][x]) continue;
          var bit = false;
          if (i < cw.length * 8) bit = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          m[y][x] = bit; i++;
        }
      }
      upward = !upward;
    }
    return i;
  }

  function applyMask(m, fn, mask) {
    var size = m.length;
    for (var y = 0; y < size; y++)
      for (var x = 0; x < size; x++) {
        if (fn[y][x]) continue;
        var invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
          case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
          case 7: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
        }
        if (invert) m[y][x] = !m[y][x];
      }
  }

  function penalty(m) {
    var size = m.length, score = 0, x, y, i, j;
    /* rule 1: runs of five or more same-colour modules, rows then columns */
    for (y = 0; y < size; y++) {
      var run = 1;
      for (x = 1; x < size; x++) {
        if (m[y][x] === m[y][x - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; }
        else run = 1;
      }
    }
    for (x = 0; x < size; x++) {
      var runC = 1;
      for (y = 1; y < size; y++) {
        if (m[y][x] === m[y - 1][x]) { runC++; if (runC === 5) score += 3; else if (runC > 5) score += 1; }
        else runC = 1;
      }
    }
    /* rule 2: 2x2 blocks of one colour */
    for (y = 0; y < size - 1; y++)
      for (x = 0; x < size - 1; x++) {
        var c0 = m[y][x];
        if (c0 === m[y][x + 1] && c0 === m[y + 1][x] && c0 === m[y + 1][x + 1]) score += 3;
      }
    /* rule 3: 1:1:3:1:1 finder-like pattern with four light modules on one side */
    var patA = [true, false, true, true, true, false, true, false, false, false, false];
    var patB = [false, false, false, false, true, false, true, true, true, false, true];
    var getRow = function (a, b) { return m[a][b]; };
    var getCol = function (a, b) { return m[b][a]; };
    function matches(get, a, b, pat) {
      for (var k = 0; k < pat.length; k++) if (get(a, b + k) !== pat[k]) return false;
      return true;
    }
    for (i = 0; i < size; i++)
      for (j = 0; j <= size - 11; j++) {
        if (matches(getRow, i, j, patA)) score += 40;
        if (matches(getRow, i, j, patB)) score += 40;
        if (matches(getCol, i, j, patA)) score += 40;
        if (matches(getCol, i, j, patB)) score += 40;
      }
    /* rule 4: deviation of dark-module proportion from 50% */
    var dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (m[y][x]) dark++;
    var total = size * size;
    score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
    return score;
  }

  function encode(input, opts) {
    opts = opts || {};
    var eclName = (opts.ecl || 'M').toUpperCase();
    if (!(eclName in ECL)) throw new Error('unknown ECC level ' + eclName);
    var e = ECL[eclName];
    var bytes = toBytes(input);
    var minV = Math.max(1, Math.min(40, opts.minVersion || 1));
    var v = -1, cw = null;
    for (var vv = minV; vv <= 40; vv++) {
      cw = buildCodewords(bytes, vv, e);
      if (cw) { v = vv; break; }
    }
    if (v < 0) throw new Error('payload too large for a QR symbol at ECC ' + eclName + ' (' + bytes.length + ' bytes)');

    var totalCw = 0, groups = ECCTAB[v][e];
    for (var g = 0; g < groups.length; g++) totalCw += groups[g][0] * groups[g][1];
    if (totalCw * 8 > rawDataModules(v)) throw new Error('internal table inconsistency at version ' + v);

    var all = interleave(cw, v, e);
    var size = v * 4 + 17;
    var m = newGrid(size, false), fn = newGrid(size, false);
    drawFunctionPatterns(m, fn, v);
    placeData(m, fn, all);

    var best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      applyMask(m, fn, mask);
      drawFormat(m, ECL_BITS[eclName], mask);
      var s = penalty(m);
      if (s < bestScore) { bestScore = s; best = mask; }
      applyMask(m, fn, mask); /* undo */
    }
    applyMask(m, fn, best);
    drawFormat(m, ECL_BITS[eclName], best);
    return { version: v, ecl: eclName, mask: best, size: size, modules: m, bytes: bytes.length };
  }

  function toSVG(qr, opts) {
    opts = opts || {};
    var quiet = opts.quiet == null ? 4 : opts.quiet;
    var scale = opts.scale || 4;
    var dim = (qr.size + quiet * 2);
    var path = [];
    for (var y = 0; y < qr.size; y++)
      for (var x = 0; x < qr.size; x++)
        if (qr.modules[y][x]) path.push('M' + (x + quiet) + ',' + (y + quiet) + 'h1v1h-1z');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" width="' + dim * scale +
      '" height="' + dim * scale + '" shape-rendering="crispEdges" role="img" aria-label="' +
      (opts.label || 'QR code') + '">' +
      '<rect width="100%" height="100%" fill="' + (opts.light || '#ffffff') + '"/>' +
      '<path d="' + path.join('') + '" fill="' + (opts.dark || '#000000') + '"/></svg>';
  }

  return { encode: encode, toSVG: toSVG };
})();
